// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Optional capability; legacy TaxHandlers do not implement it.
interface ILaunchGuard {
    function startSniperGuard() external;
    function baseBuyFee() external view returns (uint256);
    function sniperGuardActive() external view returns (bool);
    function sniperGuardStart() external view returns (uint256);
    function sniperGuardEnd() external view returns (uint256);
}
