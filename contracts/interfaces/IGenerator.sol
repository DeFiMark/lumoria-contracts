//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ITaxHandler.sol";

interface IGenerator {

    enum LaunchMode { BYOL, FLAT_CURVE }

    /// @notice A creator-defined token allocation carved out of the creator's
    ///         post-launch remainder. `duration == 0` sends `amount` straight
    ///         to `beneficiary`; `duration > 0` locks it in the VestingVault
    ///         on a linear+cliff schedule (non-revocable).
    struct AllocationData {
        address beneficiary;
        uint256 amount;
        uint64  cliff;     // seconds after launch before vesting unlocks (≤ duration)
        uint64  duration;  // 0 = immediate transfer; > 0 = linear vest over this many seconds
    }

    event ProjectGenerated(
        address indexed token,
        address indexed taxHandler,
        address indexed creator,
        string name,
        string symbol,
        uint256 buyFee,
        uint256 sellFee,
        uint8 launchMode
    );
    event FlatCurveLaunched(address indexed token, address indexed flatCurve, uint256 hardCap);
    event AllocationMinted(address indexed token, address indexed beneficiary, uint256 amount);
    event AllocationVested(
        address indexed token,
        address indexed beneficiary,
        uint256 indexed scheduleId,
        uint256 amount,
        uint64 cliff,
        uint64 duration
    );

    function generateProject(
        string calldata name,
        string calldata symbol,
        uint256 buyFee,
        uint256 sellFee,
        ITaxHandler.ModuleInitData[] calldata modules,
        LaunchMode launchMode,
        bytes calldata launchPayload,
        AllocationData[] calldata allocations,
        bytes32 salt
    ) external payable returns (address token, address taxHandler);

    function getDatabase() external view returns (address);
}
