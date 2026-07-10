//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Every tokenomics module implements IModule.

    INVARIANT — `receiveTax()` runs inside the Uniswap V4 swap callback, on a
    real trader's transaction, with no try/catch and no gas cap anywhere on the
    path from LumoriaHook._forward down through TaxHandler._distribute. It may
    therefore ONLY accrue state and emit events:

        - no value transfers out
        - no external calls
        - no unbounded loops

    A module that reverts here bricks all trading for its token. A module that
    calls back into the router here trips both the PoolManager lock and the
    TaxHandler reentrancy guard. Heavy work belongs in a separate,
    permissionlessly-triggered transaction (see BurnModule.executeBurn,
    LiquidityModule.executeLiquidity, RewardModule.convertAndDistribute).

    See docs/TOKENOMICS_V2.md §6.1.
 */
interface IModule {
    function __init__(bytes calldata payload) external;

    /// @notice Accrue tax BNB. MUST NOT transfer value out or make external calls.
    function receiveTax() external payable;

    function getModuleType() external view returns (uint8);
    function getStats() external view returns (bytes memory);
}

interface IRewardModule is IModule {
    function setShare(address holder, uint256 amount) external;
    function claimReward() external;
    function getUnpaidRewards(address holder) external view returns (uint256);

    /// @notice Permissionlessly add BNB to the reward pool. Lets any contract
    ///         (e.g. a PrizePool paying out in ALL_HOLDERS mode) or any person
    ///         top up rewards without being the TaxHandler.
    function donate() external payable;

    /// @notice Backfill holder shares from on-chain balances.
    ///
    ///         A RewardModule added after launch starts blind: `setShare` only
    ///         fires on transfer, so existing holders would be silently excluded
    ///         from every distribution until they next transact. Permissionless
    ///         and self-verifying — it reads `balanceOf` directly, so a bogus
    ///         holder list cannot inflate anyone's share.
    function sync(address[] calldata holders) external;
}
