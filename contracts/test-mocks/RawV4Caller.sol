//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Test-only raw Uniswap V4 caller.

    Simulates a THIRD-PARTY router (or attacker) talking to the
    PoolManager directly, bypassing the LumoriaSwapRouter entirely.
    Used to prove the hook's core properties:

      - swaps are taxed no matter who initiates them (no hookData);
      - exactOutput swaps revert;
      - liquidity cannot be added by anyone but the vault;
      - liquidity removal and donations always revert;
      - pools cannot be initialized around the Generator/vault path.

    NEVER deployed outside tests.
 */

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "../interfaces/IERC20.sol";

contract RawV4Caller is IUnlockCallback {
    IPoolManager public immutable poolManager;

    uint8 internal constant ACTION_SWAP = 0;
    uint8 internal constant ACTION_MODIFY_LIQUIDITY = 1;
    uint8 internal constant ACTION_DONATE = 2;

    constructor(address poolManager_) {
        poolManager = IPoolManager(poolManager_);
    }

    receive() external payable {}

    // ─── Entry points ───────────────────────────────────────────────

    /// @notice Raw swap with NO hookData — what an aggregator route looks like.
    ///         exactIn buys send BNB as msg.value; exactIn sells pull tokens
    ///         from the caller. exactOut attempts revert inside the hook.
    function rawSwap(PoolKey calldata key, SwapParams calldata params) external payable {
        if (!params.zeroForOne && params.amountSpecified < 0) {
            // exactIn sell — pull the token input up front.
            IERC20(Currency.unwrap(key.currency1)).transferFrom(
                msg.sender, address(this), uint256(-params.amountSpecified)
            );
        }
        poolManager.unlock(abi.encode(ACTION_SWAP, abi.encode(key, params, msg.sender)));
    }

    function rawAddLiquidity(PoolKey calldata key, int256 liquidityDelta) external payable {
        poolManager.unlock(abi.encode(ACTION_MODIFY_LIQUIDITY, abi.encode(key, liquidityDelta)));
    }

    function rawDonate(PoolKey calldata key, uint256 amount0, uint256 amount1) external payable {
        poolManager.unlock(abi.encode(ACTION_DONATE, abi.encode(key, amount0, amount1)));
    }

    function rawInitialize(PoolKey calldata key, uint160 sqrtPriceX96) external {
        poolManager.initialize(key, sqrtPriceX96);
    }

    // ─── Unlock callback ────────────────────────────────────────────

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "RawV4Caller: only PM");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == ACTION_SWAP) {
            (PoolKey memory key, SwapParams memory params, address user) =
                abi.decode(payload, (PoolKey, SwapParams, address));

            if (params.zeroForOne) {
                // buy: settle native input first, like any well-behaved router
                poolManager.settle{value: uint256(-params.amountSpecified)}();
                BalanceDelta delta = poolManager.swap(key, params, ""); // ← NO hookData
                poolManager.take(key.currency1, user, uint256(uint128(delta.amount1())));
            } else {
                poolManager.sync(key.currency1);
                IERC20(Currency.unwrap(key.currency1)).transfer(
                    address(poolManager), uint256(-params.amountSpecified)
                );
                poolManager.settle();
                BalanceDelta delta = poolManager.swap(key, params, ""); // ← NO hookData
                poolManager.take(key.currency0, user, uint256(uint128(delta.amount0())));
            }
            return "";
        }

        if (action == ACTION_MODIFY_LIQUIDITY) {
            (PoolKey memory key, int256 liquidityDelta) = abi.decode(payload, (PoolKey, int256));
            poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: (TickMath.MIN_TICK / key.tickSpacing) * key.tickSpacing,
                    tickUpper: (TickMath.MAX_TICK / key.tickSpacing) * key.tickSpacing,
                    liquidityDelta: liquidityDelta,
                    salt: bytes32(0)
                }),
                ""
            );
            return "";
        }

        // ACTION_DONATE
        (PoolKey memory key_, uint256 amount0, uint256 amount1) =
            abi.decode(payload, (PoolKey, uint256, uint256));
        poolManager.donate(key_, amount0, amount1, "");
        return "";
    }
}
