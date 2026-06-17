//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Liquidity Vault interface.

    The vault is the sole owner of liquidity in every Lumoria V4 pool.
    Liquidity added through it is permanently locked — the vault has no
    removal code path, and the LumoriaHook reverts any third-party
    modifyLiquidity attempt.
 */

interface ILumoriaLiquidityVault {
    /// @notice Adds permanently-locked full-range liquidity (router-only).
    ///         Lazily initializes the pool on the first add at the implied
    ///         BNB/token price. Tokens must already sit in the vault;
    ///         BNB rides along as msg.value. Unconsumed remainders are
    ///         refunded to `dustRecipient`.
    function addLiquidityLocked(address token, uint256 tokenAmountDesired, address dustRecipient)
        external
        payable
        returns (uint256 amountToken, uint256 amountBnb, uint128 liquidity);

    function lockedLiquidity(address token) external view returns (uint128);
    function totalBnbLocked(address token) external view returns (uint256);
    function totalTokensLocked(address token) external view returns (uint256);
}
