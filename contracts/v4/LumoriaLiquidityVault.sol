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

    Entry point is `addLiquidityLocked`, callable only by the
    LumoriaSwapRouter (which implements the legacy `addLiquidityETH`
    interface on top of it, so Generator / FlatCurve / LiquidityModule
    are untouched). Flow:

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

    // ─── Core References ────────────────────────────────────────────

    IPoolManager public immutable poolManager;
    IDatabase public immutable database;

    // ─── Analytics ──────────────────────────────────────────────────

    mapping(address => uint128) public lockedLiquidity;   // token => total liquidity locked
    mapping(address => uint256) public totalBnbLocked;    // token => cumulative BNB added
    mapping(address => uint256) public totalTokensLocked; // token => cumulative tokens added

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
    error OnlyPoolManager();
    error ZeroAmounts();
    error PriceOutOfBounds();
    error ZeroLiquidity();

    constructor(address poolManager_, address database_) {
        require(poolManager_ != address(0), "Vault: zero poolManager");
        require(database_ != address(0), "Vault: zero database");
        poolManager = IPoolManager(poolManager_);
        database = IDatabase(database_);
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

        bytes memory result = poolManager.unlock(abi.encode(key, liquidity));
        (amountBnb, amountToken) = abi.decode(result, (uint256, uint256));

        lockedLiquidity[token] += liquidity;
        totalBnbLocked[token] += amountBnb;
        totalTokensLocked[token] += amountToken;

        emit LiquidityLocked(token, amountBnb, amountToken, liquidity, lockedLiquidity[token]);

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

    // ─── PoolManager Unlock Callback ────────────────────────────────

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();

        (PoolKey memory key, uint128 liquidity) = abi.decode(data, (PoolKey, uint128));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_TICK_LOWER,
                tickUpper: FULL_RANGE_TICK_UPPER,
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
