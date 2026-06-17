//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Fee Receiver

    Collects all platform 1% BNB fees from:
    - Router (trading fees)
    - FlatCurve (raise contribution fees)
    - Generator (BYOL launch fees)

    Simple collector for now. Can be extended later for
    revenue splitting, buyback, staking rewards, etc.
 */

import "./lib/Ownable.sol";
import "./lib/TransferHelper.sol";
import "./interfaces/IFeeReceiver.sol";

contract FeeReceiver is Ownable, IFeeReceiver {

    // where withdrawn fees go (EOA or multisig)
    address public recipient;

    // total BNB received lifetime
    uint256 public override totalReceived;

    // per-token fee tracking for analytics
    mapping(address => uint256) public override feesByToken;

    constructor(address _recipient) {
        require(_recipient != address(0), "Zero recipient");
        recipient = _recipient;
    }

    // ─── Fee Receiving ──────────────────────────────────────────────

    /// @notice Called by Router/FlatCurve/Generator with a token tag for analytics
    function receiveFee(address token) external payable override {
        require(msg.value > 0, "Zero fee");
        totalReceived += msg.value;
        feesByToken[token] += msg.value;
        emit FeeReceived(msg.sender, msg.value);
        emit TokenFeeReceived(token, msg.value);
    }

    /// @notice Accept untagged BNB (fallback for simple sends)
    receive() external payable {
        totalReceived += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }

    // ─── Withdrawal ─────────────────────────────────────────────────

    function withdraw() external override onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        TransferHelper.safeTransferETH(recipient, balance);
        emit FeesWithdrawn(recipient, balance);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function setRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "Zero recipient");
        emit RecipientUpdated(recipient, _recipient);
        recipient = _recipient;
    }
}
