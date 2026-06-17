//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Creator Fee Module (Type 3)

    The simplest tokenomics module. Receives BNB from the TaxHandler
    and immediately forwards it to the recipient (defaults to the creator).

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../lib/TransferHelper.sol";

contract CreatorFeeModule is IModule {

    uint8 internal constant MODULE_TYPE = 3;

    // core references
    address public taxHandler;
    address public recipient;

    // analytics
    uint256 public totalPaid;

    // init guard
    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxForwarded(address indexed recipient, uint256 amount);
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
        taxHandler = msg.sender;
        recipient = recipient_;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        if (msg.value == 0) return;

        totalPaid += msg.value;
        TransferHelper.safeTransferETH(recipient, msg.value);

        emit TaxForwarded(recipient, msg.value);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Current recipient can transfer the fee stream to a new address
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
        return abi.encode(recipient, totalPaid);
    }
}
