//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IModule {
    function __init__(bytes calldata payload) external;
    function receiveTax() external payable;
    function getModuleType() external view returns (uint8);
    function getStats() external view returns (bytes memory);
}

interface IRewardModule is IModule {
    function setShare(address holder, uint256 amount) external;
    function claimReward() external;
    function getUnpaidRewards(address holder) external view returns (uint256);
}
