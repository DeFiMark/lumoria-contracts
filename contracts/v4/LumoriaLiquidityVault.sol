//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Liquidity Vault

    The sole owner of liquidity in every Lumoria V4 pool, and the only
    address allowed to initialize pools or add liquidity (enforced by
    LumoriaHook.beforeInitialize / beforeAddLiquidity).

    THERE IS NO CODE PATH THAT REMOVES LIQUIDITY. This replaces the old
    "LP tokens to 0x...dEaD" scheme with something strictly stronger: in
    V2 the locked LP tokens still existed; here the removal capability
    itself does not exist, and the hook reverts any third-party
    modifyLiquidity attempt as well.

    `addLiquidityLocked` remains callable only by the LumoriaSwapRouter
    (which implements the legacy `addLiquidityETH` interface on top of it,
    so Generator / FlatCurve / LiquidityModule are untouched). Vault V2 also
    exposes `initializeSingleSided`, callable only by the current Generator,
    to initialize and lock one token-only position for launch mode 2.

      1. First add for a token → compute sqrtPriceX96 from the BNB/token
         ratio and initialize the canonical pool.
      2. Mint full-range liquidity via unlock → modifyLiquidity → settle
         (native BNB by value, token by sync/transfer/settle).
      3. Refund whatever the position math didn't consume (dust on one
         side whenever the provided ratio differs from the pool price)
         to `dustRecipient`.

    Pool LP fee is 0, so the locked position never accrues swap fees —
    there is nothing to collect and nothing to strand. All trading
    economics live in the LumoriaHook.
 */

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {IDatabase} from "../interfaces/IDatabase.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ILumoriaToken} from "../interfaces/ILumoriaToken.sol";
import {ILumoriaLiquidityVault} from "../interfaces/ILumoriaLiquidityVault.sol";
import {TransferHelper} from "../lib/TransferHelper.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

contract LumoriaLiquidityVault is ILumoriaLiquidityVault, IUnlockCallback, ReentrancyGuard {
    using StateLibrary for IPoolManager;

    // ─── Constants ──────────────────────────────────────────────────

    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;

    // Full range, rounded to tick spacing: ±887272 → ±887220.
    int24 public constant FULL_RANGE_TICK_LOWER = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
    int24 public constant FULL_RANGE_TICK_UPPER = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

    // Mode-2 protocol bounds. Product-level economic bounds are intentionally
    // not invented here; once §18 values are approved they can be tightened in
    // one place without changing the position or payload format.
    int24 public constant MIN_START_TICK = FULL_RANGE_TICK_LOWER + TICK_SPACING;
    int24 public constant MAX_START_TICK = FULL_RANGE_TICK_UPPER;

    // ─── Core References ────────────────────────────────────────────

    IPoolManager public immutable poolManager;
    IDatabase public immutable database;
    ILumoriaLiquidityVault public immutable legacyVault;

    // ─── Analytics ──────────────────────────────────────────────────

    struct SingleSidedPositionData {
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 tokenAmount;
        uint256 dustBurned;
    }

    mapping(address => uint128) internal _newLockedLiquidity;
    mapping(address => uint256) internal _newTotalBnbLocked;
    mapping(address => uint256) internal _newTotalTokensLocked;
    mapping(address => bool) internal _isSingleSided;
    mapping(address => SingleSidedPositionData) internal _singleSidedPositions;

    // ─── Events ─────────────────────────────────────────────────────

    event PoolInitialized(address indexed token, PoolId indexed poolId, uint160 sqrtPriceX96);
    event LiquidityLocked(
        address indexed token,
        uint256 bnbAmount,
        uint256 tokenAmount,
        uint128 liquidity,
        uint128 totalLocked
    );

    // ─── Errors ─────────────────────────────────────────────────────

    error OnlyRouter();
    error OnlyGenerator();
    error OnlyPoolManager();
    error ZeroAmounts();
    error PriceOutOfBounds();
    error ZeroLiquidity();
    error AdditionalLiquidityDisabled();
    error AlreadySingleSided();
    error PoolAlreadyInitialized();
    error InvalidStartTick();
    error NotLumoriaToken();
    error NonZeroBnbSeed();
    error IncompleteTokenCommitment();
    error SingleSidedBnbConsumed();
    error UnaccountedTokenBalance();

    constructor(address poolManager_, address database_, address legacyVault_) {
        require(poolManager_ != address(0), "Vault: zero poolManager");
        require(database_ != address(0), "Vault: zero database");
        poolManager = IPoolManager(poolManager_);
        database = IDatabase(database_);
        legacyVault = ILumoriaLiquidityVault(legacyVault_);
    }

    /// @dev Accepts native BNB refunds from the PoolManager during settlement
    ///      and the router's forwarded value in addLiquidityLocked.
    receive() external payable {}

    // ─── Pool Identity ──────────────────────────────────────────────

    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(database.hook())
        });
    }

    // ─── Aggregated Analytics ──────────────────────────────────────

    function lockedLiquidity(address token) public view override returns (uint128) {
        uint128 legacy = address(legacyVault) == address(0) ? 0 : legacyVault.lockedLiquidity(token);
        return legacy + _newLockedLiquidity[token];
    }

    function totalBnbLocked(address token) public view override returns (uint256) {
        uint256 legacy = address(legacyVault) == address(0) ? 0 : legacyVault.totalBnbLocked(token);
        return legacy + _newTotalBnbLocked[token];
    }

    function totalTokensLocked(address token) public view override returns (uint256) {
        uint256 legacy = address(legacyVault) == address(0) ? 0 : legacyVault.totalTokensLocked(token);
        return legacy + _newTotalTokensLocked[token];
    }

    function isSingleSided(address token) external view override returns (bool) {
        return _isSingleSided[token];
    }

    function singleSidedPosition(address token)
        external
        view
        override
        returns (
            int24 tickLower,
            int24 tickUpper,
            uint160 sqrtPriceX96,
            uint128 liquidity,
            uint256 tokenAmount,
            uint256 dustBurned
        )
    {
        SingleSidedPositionData storage position = _singleSidedPositions[token];
        return (
            position.tickLower,
            position.tickUpper,
            position.sqrtPriceX96,
            position.liquidity,
            position.tokenAmount,
            position.dustBurned
        );
    }

    // ─── Add Liquidity (router-only; locked forever) ────────────────

    /// @notice Adds permanently-locked full-range liquidity. The pool is
    ///         lazily initialized on the first add at the implied price.
    /// @param token              the Lumoria token (currency1)
    /// @param tokenAmountDesired tokens already transferred to this vault by the router
    /// @param dustRecipient      receives the unconsumed BNB/token remainder
    function addLiquidityLocked(address token, uint256 tokenAmountDesired, address dustRecipient)
        external
        payable
        override
        nonReentrant
        returns (uint256 amountToken, uint256 amountBnb, uint128 liquidity)
    {
        if (msg.sender != database.router()) revert OnlyRouter();
        if (_isSingleSided[token]) revert AdditionalLiquidityDisabled();
        if (msg.value == 0 || tokenAmountDesired == 0) revert ZeroAmounts();

        PoolKey memory key = poolKeyFor(token);
        PoolId poolId = key.toId();

        // Lazy pool initialization at the implied price (first add only).
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 == 0) {
            sqrtPriceX96 = _sqrtPriceX96(msg.value, tokenAmountDesired);
            poolManager.initialize(key, sqrtPriceX96);
            emit PoolInitialized(token, poolId, sqrtPriceX96);
        }

        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(FULL_RANGE_TICK_LOWER),
            TickMath.getSqrtPriceAtTick(FULL_RANGE_TICK_UPPER),
            msg.value,
            tokenAmountDesired
        );
        if (liquidity == 0) revert ZeroLiquidity();

        bytes memory result = poolManager.unlock(
            abi.encode(key, FULL_RANGE_TICK_LOWER, FULL_RANGE_TICK_UPPER, liquidity)
        );
        (amountBnb, amountToken) = abi.decode(result, (uint256, uint256));

        _newLockedLiquidity[token] += liquidity;
        _newTotalBnbLocked[token] += amountBnb;
        _newTotalTokensLocked[token] += amountToken;

        emit LiquidityLocked(token, amountBnb, amountToken, liquidity, lockedLiquidity(token));

        // Refund whatever the position didn't consume.
        uint256 bnbDust = msg.value - amountBnb;
        if (bnbDust > 0) {
            TransferHelper.safeTransferETH(dustRecipient, bnbDust);
        }
        uint256 tokenDust = tokenAmountDesired - amountToken;
        if (tokenDust > 0) {
            TransferHelper.safeTransfer(token, dustRecipient, tokenDust);
        }
    }

    // ─── Permanent Single-Sided Initialization ────────────────────

    function initializeSingleSided(address token, int24 startTick)
        external
        payable
        override
        nonReentrant
        returns (uint256 tokenAmount, uint128 liquidity, uint160 sqrtPriceX96)
    {
        if (msg.sender != database.generator()) revert OnlyGenerator();
        if (msg.value != 0) revert NonZeroBnbSeed();
        if (!database.isLumoriaToken(token)) revert NotLumoriaToken();
        if (_isSingleSided[token]) revert AlreadySingleSided();
        if (
            startTick % TICK_SPACING != 0
                || startTick < MIN_START_TICK
                || startTick > MAX_START_TICK
        ) revert InvalidStartTick();

        PoolKey memory key = poolKeyFor(token);
        PoolId poolId = key.toId();
        (uint160 existingSqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (existingSqrtPriceX96 != 0) revert PoolAlreadyInitialized();

        uint256 available = IERC20(token).balanceOf(address(this));
        if (available == 0) revert ZeroAmounts();
        if (available != IERC20(token).totalSupply()) revert IncompleteTokenCommitment();

        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(startTick);
        uint160 sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(FULL_RANGE_TICK_LOWER);
        liquidity = LiquidityAmounts.getLiquidityForAmount1(
            sqrtPriceLowerX96, sqrtPriceX96, available
        );
        if (liquidity == 0) revert ZeroLiquidity();

        // Store the one-position policy before external calls. A revert rolls
        // it back atomically; a callback cannot observe an unmarked token.
        _isSingleSided[token] = true;
        poolManager.initialize(key, sqrtPriceX96);
        emit PoolInitialized(token, poolId, sqrtPriceX96);

        bytes memory result = poolManager.unlock(
            abi.encode(key, FULL_RANGE_TICK_LOWER, startTick, liquidity)
        );
        (uint256 amountBnb, uint256 amountToken) = abi.decode(result, (uint256, uint256));
        if (amountBnb != 0) revert SingleSidedBnbConsumed();
        tokenAmount = amountToken;

        uint256 dustBurned = available - tokenAmount;
        if (dustBurned > 0) {
            ILumoriaToken(token).burn(dustBurned);
        }
        if (IERC20(token).balanceOf(address(this)) != 0) revert UnaccountedTokenBalance();

        _newLockedLiquidity[token] += liquidity;
        _newTotalTokensLocked[token] += tokenAmount;
        _singleSidedPositions[token] = SingleSidedPositionData({
            tickLower: FULL_RANGE_TICK_LOWER,
            tickUpper: startTick,
            sqrtPriceX96: sqrtPriceX96,
            liquidity: liquidity,
            tokenAmount: tokenAmount,
            dustBurned: dustBurned
        });

        emit SingleSidedPositionLocked(
            token,
            poolId,
            FULL_RANGE_TICK_LOWER,
            startTick,
            sqrtPriceX96,
            tokenAmount,
            liquidity,
            dustBurned
        );
    }

    // ─── PoolManager Unlock Callback ────────────────────────────────

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();

        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint128));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Adding liquidity → both deltas are debts (negative).
        uint256 bnbOwed = uint256(uint128(-delta.amount0()));
        uint256 tokenOwed = uint256(uint128(-delta.amount1()));

        // Settle native BNB by value.
        if (bnbOwed > 0) {
            poolManager.settle{value: bnbOwed}();
        }
        // Settle the token via sync → transfer → settle.
        if (tokenOwed > 0) {
            poolManager.sync(key.currency1);
            TransferHelper.safeTransfer(Currency.unwrap(key.currency1), address(poolManager), tokenOwed);
            poolManager.settle();
        }

        return abi.encode(bnbOwed, tokenOwed);
    }

    // ─── Initial Price Math ─────────────────────────────────────────

    /// @dev sqrtPriceX96 = sqrt(tokenAmount / bnbAmount) * 2^96, computed as
    ///      sqrt((tokenAmount << 96) / bnbAmount) << 48. tokenAmount ≤ 1e27
    ///      (2^90) so the shift cannot overflow. Wei-level precision loss is
    ///      absorbed by the dust refund.
    function _sqrtPriceX96(uint256 bnbAmount, uint256 tokenAmount) internal pure returns (uint160) {
        uint256 priceQ96 = (tokenAmount << 96) / bnbAmount;
        uint256 sqrtPrice = _sqrt(priceQ96) << 48;
        if (sqrtPrice <= TickMath.MIN_SQRT_PRICE || sqrtPrice >= TickMath.MAX_SQRT_PRICE) {
            revert PriceOutOfBounds();
        }
        return uint160(sqrtPrice);
    }

    /// @dev Babylonian square root.
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
