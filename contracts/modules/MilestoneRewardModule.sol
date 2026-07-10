//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Milestone Reward Module (Type 5)

    Accrues tax BNB and holds it. The token's creator releases any amount of it
    to ALL holders, whenever they choose, with the milestone they are claiming
    recorded as free text on-chain. There is deliberately NO on-chain milestone
    check — holder count is not on-chain at all, and market cap needs a spot
    price a flash loan can move, so a gate on either would be theatre.

    THE SAFETY PROPERTY IS THE DESTINATION, NOT THE BUTTON. The only code path
    that moves BNB out of this contract sends it to the token's RewardModule,
    which pays every non-excluded holder pro-rata. No withdraw, no recipient,
    no sweep, no admin escape hatch. The creator's discretion is over timing
    and amount — never over destination. An auditor can grep this file, find
    exactly one value-moving call (`donate` in `_release`), and see that its
    target is resolved from the TaxHandler's module list and is not a parameter.

    ANTI-STRANDING VALVE. If no release has happened for 18 months, `publicRelease`
    lets ANYONE trigger a release of the FULL balance — still only into the
    RewardModule. The token is likely abandoned at that point; the valve turns
    "idle forever" into "holders eventually get paid". Any release (creator or
    public) restarts the 18-month clock. The public path releases everything so
    a hostile caller cannot reset the clock with a dust release and keep the
    rest locked for another 18 months.

    `TaxHandler.renounceManagement()` does not disable releases — `creator()` is
    fixed at launch. A renounced token with this module is MORE trustworthy:
    tokenomics frozen, funds still only reachable by holders.

    See docs/TOKENOMICS_V2.md §2B. Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../interfaces/ITaxHandler.sol";
import "../lib/ReentrancyGuard.sol";

contract MilestoneRewardModule is IModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 5;
    uint8 internal constant MODULE_REWARD = 0;

    /// @notice After this long with no release, `publicRelease` opens to anyone.
    uint256 public constant PUBLIC_RELEASE_DELAY = 540 days; // 18 months

    // core references
    address public taxHandler;
    address public token;

    // analytics
    uint256 public totalAccrued;
    uint256 public totalReleased;

    /// @notice Timestamp of the last release (or init). The 18-month public
    ///         valve is measured from here and reset by every release.
    uint256 public lastReleaseTime;

    // init guard
    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxReceived(uint256 amount, uint256 totalAccrued);

    /// @param by            msg.sender — the creator, or anyone via the 18-month valve
    /// @param rewardModule  destination; always the token's RewardModule
    /// @param amount        BNB released
    /// @param remaining     balance left in the module after the release
    /// @param reason        the team's public, timestamped claim about the milestone
    event RewardsReleased(
        address indexed by,
        address indexed rewardModule,
        uint256 amount,
        uint256 remaining,
        string  reason
    );

    // ─── Initialization ─────────────────────────────────────────────

    /// @dev taxHandler is inferred from msg.sender — TaxHandler is what clones
    ///      and inits each module. `creator` is read live at release time from
    ///      the TaxHandler, which never changes it.
    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (address token_) = abi.decode(payload, (address));
        require(token_ != address(0), "Zero token");

        _initialized = true;
        _status = _NOT_ENTERED;
        taxHandler = msg.sender;
        token = token_;
        lastReleaseTime = block.timestamp;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    /// @dev Runs inside the V4 swap callback. Accrues only — no value out, no
    ///      external calls, no loops. See IModule.
    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        if (msg.value == 0) return;

        totalAccrued += msg.value;
        emit TaxReceived(msg.value, totalAccrued);
    }

    // ─── Release ────────────────────────────────────────────────────

    /// @notice CREATOR ONLY. Sends `amount` to the token's RewardModule, which
    ///         distributes it pro-rata to every non-excluded holder. `reason` is
    ///         the milestone being claimed, recorded verbatim on-chain.
    function releaseRewards(uint256 amount, string calldata reason) external nonReentrant {
        require(msg.sender == ITaxHandler(taxHandler).creator(), "Only creator");
        _release(amount, reason);
    }

    /// @notice ANYONE, but only after 18 months with no release. Releases the
    ///         ENTIRE balance — full, not partial, so this cannot be used to
    ///         reset the clock while keeping funds locked. Destination is still
    ///         the RewardModule; the caller gains nothing but the gas bill.
    function publicRelease() external nonReentrant {
        require(block.timestamp >= lastReleaseTime + PUBLIC_RELEASE_DELAY, "Creator window");
        _release(address(this).balance, "18-month public release");
    }

    /// @dev THE ONLY VALUE-MOVING CALL IN THIS CONTRACT lives here, and its
    ///      target is resolved from the TaxHandler — never a parameter.
    function _release(uint256 amount, string memory reason) internal {
        require(amount > 0 && amount <= address(this).balance, "Bad amount");
        address rewardModule = _findRewardModule();

        lastReleaseTime = block.timestamp;
        totalReleased += amount;

        IRewardModule(rewardModule).donate{value: amount}();

        emit RewardsReleased(msg.sender, rewardModule, amount, address(this).balance, reason);
    }

    /// @dev Resolved at release time, not init — the module set can change.
    ///      Bounded by TaxHandler.MAX_MODULES = 10.
    function _findRewardModule() internal view returns (address) {
        ITaxHandler handler = ITaxHandler(taxHandler);
        uint256 n = handler.getModuleCount();
        for (uint256 i; i < n; ++i) {
            ITaxHandler.ModuleConfig memory m = handler.getModule(i);
            if (m.moduleType == MODULE_REWARD) return m.moduleAddress;
        }
        revert("No reward module");
    }

    // ─── Views ──────────────────────────────────────────────────────

    /// @notice Earliest timestamp at which `publicRelease` becomes callable.
    function publicReleaseAt() external view returns (uint256) {
        return lastReleaseTime + PUBLIC_RELEASE_DELAY;
    }

    function getModuleType() external pure override returns (uint8) {
        return MODULE_TYPE;
    }

    function getStats() external view override returns (bytes memory) {
        return abi.encode(totalAccrued, totalReleased, address(this).balance, lastReleaseTime);
    }
}
