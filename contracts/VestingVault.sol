//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria VestingVault (shared singleton)

    Custodies token allocations that creators choose to vest at launch. The
    Generator transfers the allocation into this vault and calls
    createSchedule(). Schedules are linear with an optional cliff and are
    NON-REVOCABLE — there is deliberately no revoke path, so a vested
    allocation can never be clawed back (the same trust posture as the
    permanently-locked liquidity vault).

    One vault holds schedules for every token; each Schedule carries its own
    token address, so balances never commingle (ERC20 balances are per-token).

    This address is excluded from reward-share tracking by every TaxHandler
    (each caches `Database.vestingVault()` at init), so vested-but-unclaimed
    tokens do not accrue reflections that would otherwise be stranded here.
 */

import "./interfaces/IVestingVault.sol";
import "./interfaces/IDatabase.sol";
import "./lib/TransferHelper.sol";
import "./lib/ReentrancyGuard.sol";

contract VestingVault is IVestingVault, ReentrancyGuard {

    IDatabase public immutable database;

    mapping(uint256 => Schedule) internal _schedules;
    uint256 public override scheduleCount;
    mapping(address => uint256[]) internal _beneficiarySchedules;

    constructor(address _database) {
        require(_database != address(0), "Vault: zero database");
        database = IDatabase(_database);
    }

    // ─── Schedule Creation (Generator only) ─────────────────────────

    function createSchedule(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 cliff,
        uint64 duration
    ) external override returns (uint256 id) {
        require(msg.sender == database.generator(), "Vault: only generator");
        require(token != address(0), "Vault: zero token");
        require(beneficiary != address(0), "Vault: zero beneficiary");
        require(amount > 0, "Vault: zero amount");
        require(duration > 0, "Vault: zero duration");
        require(cliff <= duration, "Vault: cliff > duration");

        id = scheduleCount++;
        _schedules[id] = Schedule({
            token: token,
            beneficiary: beneficiary,
            total: amount,
            released: 0,
            start: uint64(block.timestamp),
            cliff: cliff,
            duration: duration
        });
        _beneficiarySchedules[beneficiary].push(id);

        emit ScheduleCreated(id, token, beneficiary, amount, uint64(block.timestamp), cliff, duration);
    }

    // ─── Release ────────────────────────────────────────────────────

    function release(uint256 id) external override nonReentrant {
        Schedule storage s = _schedules[id];
        require(s.total > 0, "Vault: no schedule");
        uint256 amount = _vested(s) - s.released;
        require(amount > 0, "Vault: nothing to release");
        s.released += amount;
        TransferHelper.safeTransfer(s.token, s.beneficiary, amount);
        emit TokensReleased(id, s.beneficiary, amount);
    }

    // ─── Views ──────────────────────────────────────────────────────

    function vestedAmount(uint256 id) external view override returns (uint256) {
        return _vested(_schedules[id]);
    }

    function releasable(uint256 id) external view override returns (uint256) {
        Schedule storage s = _schedules[id];
        return _vested(s) - s.released;
    }

    function getSchedule(uint256 id) external view override returns (Schedule memory) {
        return _schedules[id];
    }

    function getBeneficiarySchedules(address beneficiary) external view override returns (uint256[] memory) {
        return _beneficiarySchedules[beneficiary];
    }

    // ─── Internal ───────────────────────────────────────────────────

    /// @dev Linear vest with cliff. Nothing unlocks before start+cliff; at the
    ///      cliff the elapsed-since-start portion unlocks at once, then vesting
    ///      continues linearly until start+duration (fully vested).
    function _vested(Schedule storage s) internal view returns (uint256) {
        if (s.total == 0) return 0;
        uint256 start = s.start;
        if (block.timestamp < start + s.cliff) return 0;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= s.duration) return s.total;
        return (s.total * elapsed) / s.duration;
    }
}
