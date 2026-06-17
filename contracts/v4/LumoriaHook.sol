//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria V4 Hook

    One hook instance serves every Lumoria pool. It is the pool-level
    replacement for the old custom Router's fee logic — and unlike the
    Router, it cannot be bypassed: the PoolManager invokes it on every
    swap regardless of which router initiated the trade.

    Canonical pool shape (enforced in beforeInitialize):
        currency0   = native BNB (address(0))
        currency1   = a registered Lumoria token
        fee         = 0          (no LP fee — all economics are hook fees)
        tickSpacing = 60
        hooks       = this contract

    Fee flow (identical math to the legacy Router):
      BUY  (BNB -> token, exactIn) — beforeSwap takes
           platformFee = bnbIn * platformFeeBps / 10000        -> FeeReceiver
           tax         = (bnbIn - platformFee) * buyFee / 10000 -> TaxHandler
           from the BNB input via poolManager.take(), forwards both
           immediately, and returns a BeforeSwapDelta so only the
           remainder swaps.
      SELL (token -> BNB, exactIn) — afterSwap reads the actual BNB
           output from the swap delta, takes platformFee + sellFee the
           same way, and returns the int128 hook delta so the seller
           receives the remainder.

    exactOutput swaps are not supported and revert (matches the legacy
    Router, which was exactIn-only).

    hookData is abi.encode(address user) supplied by the LumoriaSwapRouter.
    When present, afterSwap credits buy rebates (silent-exit semantics)
    and registers per-user volume. Swaps arriving from third-party
    routers without hookData are still fully taxed — they just skip
    rebate + per-user attribution.

    Liquidity rules:
      - Pools can only be initialized by the LumoriaLiquidityVault.
      - Only the vault can add liquidity.
      - Liquidity can NEVER be removed (beforeRemoveLiquidity reverts).
      - Donations are disabled (they would accrue to the locked
        position, i.e. be burned by accident).

    All mutable economics (platform fee, per-token buy/sell fees, module
    lineup, FeeReceiver, RebateContract) are read live from the Database /
    TaxHandler on each swap, so creator and admin changes never require a
    pool migration even though the hook address is immutable per pool.
 */

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

import {IDatabase} from "../interfaces/IDatabase.sol";
import {ITaxHandler} from "../interfaces/ITaxHandler.sol";
import {IFeeReceiver} from "../interfaces/IFeeReceiver.sol";
import {IRebate} from "../interfaces/IRebate.sol";

contract LumoriaHook is BaseHook {
    using SafeCast for uint256;

    // ─── Constants ──────────────────────────────────────────────────

    uint256 public constant BPS = 10000;
    uint24 public constant POOL_FEE = 0;     // no LP fee — hook fees only
    int24 public constant TICK_SPACING = 60;

    // ─── Core References ────────────────────────────────────────────

    IDatabase public immutable database;

    // ─── Events (subgraph: same shape as the legacy Router events) ──

    event TokenPurchased(
        address indexed token,
        address indexed buyer,
        uint256 bnbIn,
        uint256 platformFee,
        uint256 taxTaken,
        uint256 tokensOut
    );
    event TokenSold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 platformFee,
        uint256 taxTaken,
        uint256 bnbOut
    );
    event LumoriaPoolInitialized(address indexed token, PoolId indexed poolId);

    // ─── Errors ─────────────────────────────────────────────────────

    error ExactOutputNotSupported();
    error LiquidityPermanentlyLocked();
    error DonationsDisabled();
    error OnlyVault();
    error InvalidPoolShape();
    error NotLumoriaToken();
    error OnlyPoolManagerSendsBNB();

    constructor(IPoolManager poolManager_, IDatabase database_) BaseHook(poolManager_) {
        require(address(database_) != address(0), "Hook: zero database");
        database = database_;
    }

    /// @dev Receives native BNB from poolManager.take() during fee collection.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManagerSendsBNB();
    }

    // ─── Hook Permissions (encoded in this contract's address) ──────

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─── Pool Identity Helpers (UI / integrations) ──────────────────

    /// @notice The canonical PoolKey for a Lumoria token. Fully deterministic —
    ///         no registry storage needed anywhere in the system.
    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)), // native BNB
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @notice The canonical PoolId for a Lumoria token.
    function poolIdFor(address token) external view returns (PoolId) {
        return poolKeyFor(token).toId();
    }

    // ─── Pool Creation Gate ─────────────────────────────────────────

    function _beforeInitialize(address sender, PoolKey calldata key, uint160)
        internal
        override
        returns (bytes4)
    {
        if (sender != database.liquidityVault()) revert OnlyVault();
        if (
            !key.currency0.isAddressZero()
                || key.fee != POOL_FEE
                || key.tickSpacing != TICK_SPACING
        ) revert InvalidPoolShape();

        address token = Currency.unwrap(key.currency1);
        if (!database.isLumoriaToken(token)) revert NotLumoriaToken();

        emit LumoriaPoolInitialized(token, key.toId());
        return IHooks.beforeInitialize.selector;
    }

    // ─── Liquidity Gates ────────────────────────────────────────────

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal view override returns (bytes4) {
        if (sender != database.liquidityVault()) revert OnlyVault();
        return IHooks.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal pure override returns (bytes4) {
        revert LiquidityPermanentlyLocked();
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsDisabled();
    }

    // ─── Swap: Buy Fees (beforeSwap) ────────────────────────────────

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // exactOutput (positive amountSpecified) is not supported.
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        // Sells take their fees on the BNB *output* in afterSwap.
        if (!params.zeroForOne) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // BUY: take platform fee + buy tax from the BNB input, swap the rest.
        address token = Currency.unwrap(key.currency1);
        uint256 bnbIn = uint256(-params.amountSpecified);
        (uint256 platformFee, uint256 tax) = _buyFees(token, bnbIn);
        uint256 totalFee = platformFee + tax;

        if (totalFee == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Pull the fee BNB out of the PoolManager and forward immediately.
        // The positive specified delta we return both (a) shrinks the amount
        // that actually swaps and (b) is credited to this hook by the
        // PoolManager after afterSwap, netting our take() debt to zero —
        // the swapper ends up paying the fee.
        poolManager.take(key.currency0, address(this), totalFee);
        _forward(token, platformFee, tax, true);

        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(totalFee.toInt128(), 0), 0);
    }

    // ─── Swap: Sell Fees + Rebates + Volume (afterSwap) ─────────────

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        address token = Currency.unwrap(key.currency1);
        address user = _decodeUser(hookData);

        if (params.zeroForOne) {
            // BUY — fees were already taken in beforeSwap. Credit rebate,
            // register volume, emit the trade event.
            uint256 bnbIn = uint256(-params.amountSpecified);
            uint256 tokensOut = uint256(uint128(delta.amount1()));
            (uint256 platformFee, uint256 tax) = _buyFees(token, bnbIn);

            if (user != address(0) && tokensOut > 0) {
                address rebate = database.rebateContract();
                if (rebate != address(0)) {
                    IRebate(rebate).creditRebate(token, user, tokensOut);
                }
            }
            database.registerVolume(token, user, bnbIn);

            emit TokenPurchased(token, user, bnbIn, platformFee, tax, tokensOut);
            return (IHooks.afterSwap.selector, 0);
        }

        // SELL — take platform fee + sell tax from the gross BNB output.
        uint256 bnbOutGross = uint256(uint128(delta.amount0()));
        uint256 platformFee_ = (bnbOutGross * database.platformFeeBps()) / BPS;
        uint256 tax_ = ((bnbOutGross - platformFee_)
            * ITaxHandler(database.tokenTaxHandler(token)).sellFee()) / BPS;
        uint256 totalFee = platformFee_ + tax_;

        if (totalFee > 0) {
            poolManager.take(key.currency0, address(this), totalFee);
            _forward(token, platformFee_, tax_, false);
        }

        database.registerVolume(token, user, bnbOutGross);

        emit TokenSold(
            token,
            user,
            uint256(-params.amountSpecified),
            platformFee_,
            tax_,
            bnbOutGross - totalFee
        );
        // Positive return: the hook takes this much of the unspecified
        // currency (BNB output) — the seller receives the remainder.
        return (IHooks.afterSwap.selector, totalFee.toInt128());
    }

    // ─── Internal Helpers ───────────────────────────────────────────

    /// @dev Same formulas as the legacy Router: platform fee off gross,
    ///      token tax off the post-platform remainder.
    function _buyFees(address token, uint256 bnbIn)
        internal
        view
        returns (uint256 platformFee, uint256 tax)
    {
        platformFee = (bnbIn * database.platformFeeBps()) / BPS;
        tax = ((bnbIn - platformFee) * ITaxHandler(database.tokenTaxHandler(token)).buyFee()) / BPS;
    }

    /// @dev Forwards collected BNB: platform share to the FeeReceiver,
    ///      tax share to the token's TaxHandler (which distributes to the
    ///      tokenomics modules in the same transaction — "immediate
    ///      distribution" is preserved from the legacy design).
    function _forward(address token, uint256 platformFee, uint256 tax, bool isBuy) internal {
        if (platformFee > 0) {
            IFeeReceiver(database.feeReceiver()).receiveFee{value: platformFee}(token);
        }
        if (tax > 0) {
            ITaxHandler handler = ITaxHandler(database.tokenTaxHandler(token));
            if (isBuy) {
                handler.receiveBuyTax{value: tax}();
            } else {
                handler.receiveSellTax{value: tax}();
            }
        }
    }

    /// @dev hookData is abi.encode(address user) from the LumoriaSwapRouter.
    ///      Anything else (including empty) → address(0): fully taxed, but no
    ///      rebate / per-user volume attribution.
    function _decodeUser(bytes calldata hookData) internal pure returns (address) {
        if (hookData.length != 32) return address(0);
        return abi.decode(hookData, (address));
    }
}
