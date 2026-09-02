//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/**
    Lumoria Liquidity Vault interface.

    The vault is the sole owner of liquidity in every Lumoria V4 pool.
    Liquidity added through it is permanently locked — the vault has no
    removal code path, and the LumoriaHook reverts any third-party
    modifyLiquidity attempt.
 */

interface ILumoriaLiquidityVault {
    event SingleSidedPositionLocked(
        address indexed token,
        PoolId indexed poolId,
        int24 tickLower,
        int24 tickUpper,
        uint160 sqrtPriceX96,
        uint256 tokenAmount,
        uint128 liquidity,
        uint256 dustBurned
    );

    /// @notice Adds permanently-locked full-range liquidity (router-only).
    ///         Lazily initializes the pool on the first add at the implied
    ///         BNB/token price. Tokens must already sit in the vault;
    ///         BNB rides along as msg.value. Unconsumed remainders are
    ///         refunded to `dustRecipient`.
    function addLiquidityLocked(address token, uint256 tokenAmountDesired, address dustRecipient)
        external
        payable
        returns (uint256 amountToken, uint256 amountBnb, uint128 liquidity);

    /// @notice Initializes a fresh canonical pool and permanently locks one
    ///         token-only [minimum usable tick, startTick] position.
    function initializeSingleSided(address token, int24 startTick)
        external
        payable
        returns (uint256 tokenAmount, uint128 liquidity, uint160 sqrtPriceX96);

    function isSingleSided(address token) external view returns (bool);

    function singleSidedPosition(address token)
        external
        view
        returns (
            int24 tickLower,
            int24 tickUpper,
            uint160 sqrtPriceX96,
            uint128 liquidity,
            uint256 tokenAmount,
            uint256 dustBurned
        );

    function lockedLiquidity(address token) external view returns (uint128);
    function totalBnbLocked(address token) external view returns (uint256);
    function totalTokensLocked(address token) external view returns (uint256);
}
