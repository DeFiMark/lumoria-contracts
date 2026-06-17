//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Swap Router (Uniswap V4)

    Thin unlock-callback router over the canonical V4 PoolManager. It
    deliberately keeps the legacy `ILumoriaRouter` function signatures so
    the Generator, FlatCurve, and the Burn/Liquidity/Reward modules work
    unchanged against it.

    Unlike the legacy Router, this contract collects NO fees — the
    entire fee stack (1% platform + token tax) lives in the LumoriaHook
    and is applied by the PoolManager on every swap, no matter which
    router initiates it. What this router adds on top of any third-party
    route is attribution: it passes `hookData = abi.encode(user)` so the
    hook can credit buy rebates and per-user volume.

    Path convention: the modules build `path` with `Database.wbnb()` as
    the BNB marker (legacy V2 convention). This router accepts either
    that address or address(0) on the BNB side. Pools are native-BNB —
    no wrapping happens anywhere.

    addLiquidityETH delegates to the LumoriaLiquidityVault: all
    liquidity is full-range and permanently locked. The `to` parameter
    is ignored (there are no LP tokens to receive). There is no
    removeLiquidity — by design.
 */

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IDatabase} from "../interfaces/IDatabase.sol";
import {ILumoriaRouter} from "../interfaces/ILumoriaRouter.sol";
import {ILumoriaLiquidityVault} from "../interfaces/ILumoriaLiquidityVault.sol";
import {TransferHelper} from "../lib/TransferHelper.sol";

contract LumoriaSwapRouter is ILumoriaRouter, IUnlockCallback {

    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;

    IPoolManager public immutable poolManager;
    IDatabase public immutable database;

    // ─── Errors ─────────────────────────────────────────────────────

    error Expired();
    error InvalidPath();
    error NotLumoriaToken();
    error ZeroAmount();
    error InsufficientOutput();
    error OnlyPoolManager();

    // ─── Modifiers ──────────────────────────────────────────────────

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address poolManager_, address database_) {
        require(poolManager_ != address(0), "Router: zero poolManager");
        require(database_ != address(0), "Router: zero database");
        poolManager = IPoolManager(poolManager_);
        database = IDatabase(database_);
    }

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

    // ─── Buy (BNB → token, exactIn) ─────────────────────────────────

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable override ensure(deadline) {
        if (path.length != 2 || !_isBnbMarker(path[0])) revert InvalidPath();
        address token = path[1];
        if (!database.isLumoriaToken(token)) revert NotLumoriaToken();
        if (msg.value == 0) revert ZeroAmount();

        poolManager.unlock(abi.encode(true, token, msg.value, amountOutMin, to, to));
    }

    // ─── Sell (token → BNB, exactIn) ────────────────────────────────

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        if (path.length != 2 || !_isBnbMarker(path[1])) revert InvalidPath();
        address token = path[0];
        if (!database.isLumoriaToken(token)) revert NotLumoriaToken();
        if (amountIn == 0) revert ZeroAmount();

        TransferHelper.safeTransferFrom(token, msg.sender, address(this), amountIn);

        // user = msg.sender (the seller) for volume attribution; output to `to`.
        poolManager.unlock(abi.encode(false, token, amountIn, amountOutMin, to, msg.sender));
    }

    // ─── Add Liquidity (always locked in the vault) ─────────────────

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address, /* to — ignored: liquidity is permanently vault-locked */
        uint256 deadline
    ) external payable override ensure(deadline)
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        if (!database.isLumoriaToken(token)) revert NotLumoriaToken();

        address vault = database.liquidityVault();
        TransferHelper.safeTransferFrom(token, msg.sender, vault, amountTokenDesired);

        uint128 liq;
        (amountToken, amountETH, liq) = ILumoriaLiquidityVault(vault).addLiquidityLocked{
            value: msg.value
        }(token, amountTokenDesired, msg.sender);
        liquidity = uint256(liq);

        if (amountToken < amountTokenMin) revert InsufficientOutput();
        if (amountETH < amountETHMin) revert InsufficientOutput();
    }

    // ─── PoolManager Unlock Callback ────────────────────────────────

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();

        (bool isBuy, address token, uint256 amountIn, uint256 amountOutMin, address to, address user) =
            abi.decode(data, (bool, address, uint256, uint256, address, address));

        PoolKey memory key = poolKeyFor(token);

        if (isBuy) {
            // Settle the full native input FIRST so the hook's fee take()
            // in beforeSwap can never outrun the PoolManager's BNB balance.
            poolManager.settle{value: amountIn}();

            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                abi.encode(user)
            );

            uint256 tokensOut = uint256(uint128(delta.amount1()));
            if (tokensOut < amountOutMin) revert InsufficientOutput();
            poolManager.take(key.currency1, to, tokensOut);
            return abi.encode(tokensOut);
        }

        // SELL: settle the token input, swap, take the post-tax BNB output.
        poolManager.sync(key.currency1);
        TransferHelper.safeTransfer(token, address(poolManager), amountIn);
        poolManager.settle();

        BalanceDelta delta_ = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(user)
        );

        // delta is post-hook: amount0 is the seller's net BNB after
        // platform fee + sell tax were taken by the hook.
        uint256 bnbOut = uint256(uint128(delta_.amount0()));
        if (bnbOut < amountOutMin) revert InsufficientOutput();
        poolManager.take(key.currency0, to, bnbOut);
        return abi.encode(bnbOut);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    /// @dev Modules build paths with Database.wbnb() (legacy convention);
    ///      frontends may use address(0). Both mean "native BNB".
    function _isBnbMarker(address candidate) internal view returns (bool) {
        return candidate == address(0) || candidate == database.wbnb();
    }
}
