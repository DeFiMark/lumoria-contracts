//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Fee Receiver

    Collects all platform BNB fees:
    - receiveTradeFee  — LumoriaHook (every buy/sell, any router) and
                         FlatCurve raise contributions, with trader context
    - receiveLaunchFee — Generator flat launch fees (both modes), with
                         creator context
    - receiveFee       — generic tagged inflow (future callers)

    Simple accrue-and-withdraw collector for now. The Database can be
    repointed to a richer implementation later (revenue splitting, buyback,
    wager tracking on trades, staking rewards, ...) — the typed functions
    exist so that future contract receives full context from the frozen
    hook without any hook change.
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

    /// @dev Shared accrual. FeeReceived is emitted on every inflow — it is
    ///      the single source for the platform fee total (see IFeeReceiver).
    function _accrue(address token) internal {
        require(msg.value > 0, "Zero fee");
        totalReceived += msg.value;
        feesByToken[token] += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }

    /// @notice Generic tagged inflow (no trade/launch context).
    function receiveFee(address token) external payable override {
        _accrue(token);
        emit TokenFeeReceived(token, msg.value);
    }

    /// @notice Trade-flow fees: hook swaps + FlatCurve contributions.
    function receiveTradeFee(address token, address user, uint256 tradeAmount, bool isBuy)
        external
        payable
        override
    {
        _accrue(token);
        emit TradeFeeReceived(token, user, msg.value, tradeAmount, isBuy);
    }

    /// @notice Flat launch fees (Generator, both launch modes).
    function receiveLaunchFee(address token, address user) external payable override {
        _accrue(token);
        emit LaunchFeeReceived(token, user, msg.value);
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
