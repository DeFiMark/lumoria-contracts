//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Creator Fee Module (Type 3)

    The simplest tokenomics module. Accrues BNB from the TaxHandler on behalf of
    a recipient (defaults to the creator), who withdraws it on demand.

    ACCRUE-AND-PULL, NOT PUSH. An earlier version forwarded BNB inside
    `receiveTax()` via `TransferHelper.safeTransferETH`, which does
    `require(success)`. Because `receiveTax()` runs inside the Uniswap V4 swap
    callback, a recipient that was a contract without a payable `receive()` — or
    with an expensive or reverting one — would revert EVERY trade of the token,
    permanently, with no way to recover short of a 24h module-change timelock.

    Now `receiveTax()` only credits a balance, and the recipient pulls with
    `withdraw()`. A recipient that cannot accept BNB harms only itself.

    See docs/TOKENOMICS_V2.md §6.1 and §7.2.

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../lib/ReentrancyGuard.sol";
import "../lib/TransferHelper.sol";

contract CreatorFeeModule is IModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 3;

    // core references
    address public taxHandler;
    address public recipient;

    // per-account claimable balance. Keyed by account (not a single scalar) so
    // that changing the recipient never strands the previous recipient's accrual.
    mapping(address => uint256) public owed;

    // analytics
    uint256 public totalAccrued;
    uint256 public totalPaid;

    // init guard
    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxAccrued(address indexed recipient, uint256 amount, uint256 owedAfter);
    event TaxWithdrawn(address indexed recipient, uint256 amount);
    event RecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // ─── Initialization ─────────────────────────────────────────────

    /// @dev taxHandler is inferred from msg.sender — TaxHandler is what clones
    /// and inits each module. This removes the chicken-and-egg of payloads
    /// needing the not-yet-deployed TaxHandler address, and forecloses the
    /// misconfiguration where a module is pointed at the wrong TaxHandler.
    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (address recipient_) = abi.decode(payload, (address));
        require(recipient_ != address(0), "Zero recipient");

        _initialized = true;
        _status = _NOT_ENTERED;
        taxHandler = msg.sender;
        recipient = recipient_;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    /// @dev Runs inside the V4 swap callback. Accrues only — no value out, no
    ///      external calls. See IModule.
    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        if (msg.value == 0) return;

        address to = recipient;
        uint256 owedAfter = owed[to] + msg.value;
        owed[to] = owedAfter;
        totalAccrued += msg.value;

        emit TaxAccrued(to, msg.value, owedAfter);
    }

    // ─── Withdraw (pull) ────────────────────────────────────────────

    /// @notice Withdraw everything accrued to the caller. A failure here reverts
    ///         only the caller's own transaction — never a trade.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        require(amount > 0, "Nothing owed");

        owed[msg.sender] = 0;
        totalPaid += amount;

        TransferHelper.safeTransferETH(msg.sender, amount);
        emit TaxWithdrawn(msg.sender, amount);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Current recipient can transfer the fee stream to a new address.
    ///         Any balance already accrued stays claimable by the old recipient.
    function setRecipient(address newRecipient) external {
        require(msg.sender == recipient, "Only recipient");
        require(newRecipient != address(0), "Zero address");
        emit RecipientUpdated(recipient, newRecipient);
        recipient = newRecipient;
    }

    // ─── Views ──────────────────────────────────────────────────────

    function getModuleType() external pure override returns (uint8) {
        return MODULE_TYPE;
    }

    function getStats() external view override returns (bytes memory) {
        return abi.encode(recipient, totalAccrued, totalPaid, owed[recipient]);
    }
}
