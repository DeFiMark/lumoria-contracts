//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    IVestingVault — shared singleton that custodies vested token allocations
    created at launch by the Generator.

    Schedules are linear with an optional cliff and are NON-REVOCABLE: once
    created, the beneficiary's tokens unlock on schedule and can never be
    clawed back (a trust guarantee mirroring the permanently-locked
    liquidity vault).
 */
interface IVestingVault {

    struct Schedule {
        address token;        // the LumoriaToken being vested
        address beneficiary;  // who can claim the unlocked tokens
        uint256 total;        // total tokens locked under this schedule
        uint256 released;     // tokens already released to the beneficiary
        uint64  start;        // unix ts when vesting begins (launch time)
        uint64  cliff;        // seconds after `start` before anything unlocks
        uint64  duration;     // total vest duration in seconds (> 0)
    }

    event ScheduleCreated(
        uint256 indexed id,
        address indexed token,
        address indexed beneficiary,
        uint256 total,
        uint64 start,
        uint64 cliff,
        uint64 duration
    );
    event TokensReleased(uint256 indexed id, address indexed beneficiary, uint256 amount);

    /// @notice Create a vesting schedule. The allocation must already have
    ///         been transferred into this vault. Callable only by the
    ///         Generator (resolved live from the Database).
    function createSchedule(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 cliff,
        uint64 duration
    ) external returns (uint256 id);

    /// @notice Release all currently-vested-but-unreleased tokens to the
    ///         schedule's beneficiary. Permissionless (anyone can poke).
    function release(uint256 id) external;

    function vestedAmount(uint256 id) external view returns (uint256);
    function releasable(uint256 id) external view returns (uint256);
    function getSchedule(uint256 id) external view returns (Schedule memory);
    function getBeneficiarySchedules(address beneficiary) external view returns (uint256[] memory);
    function scheduleCount() external view returns (uint256);
}
