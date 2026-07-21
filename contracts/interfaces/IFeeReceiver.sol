//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFeeReceiver {

    // FeeReceived fires on EVERY inflow (all receive* functions + the plain
    // receive() fallback) — it is the single, non-double-counting source for
    // the platform fee total (the subgraph indexes only this one). The typed
    // events below add per-path context and are a subset of FeeReceived.
    event FeeReceived(address indexed from, uint256 amount);
    event TokenFeeReceived(address indexed token, uint256 amount);
    event TradeFeeReceived(address indexed token, address indexed user, uint256 fee, uint256 tradeAmount, bool isBuy);
    event LaunchFeeReceived(address indexed token, address indexed user, uint256 fee);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event RecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    /// @notice Generic tagged inflow — kept for future callers that have no
    ///         trade/launch context.
    function receiveFee(address token) external payable;

    /// @notice Platform fee from trade-like flow: hook swaps (buys + sells)
    ///         and FlatCurve raise contributions.
    /// @param token       Token traded (or being raised).
    /// @param user        Trader/contributor. address(0) when the swap came
    ///                    through a third-party router (no hookData).
    /// @param tradeAmount Gross BNB size of the trade: BNB in on buys and
    ///                    contributions, gross BNB out on sells.
    /// @param isBuy       true for buys/contributions, false for sells.
    function receiveTradeFee(address token, address user, uint256 tradeAmount, bool isBuy) external payable;

    /// @notice Flat anti-spam launch fee from a project launch (Generator,
    ///         both BYOL and FLAT_CURVE modes).
    /// @param token Token launched (kept for feesByToken analytics).
    /// @param user  Creator paying the launch fee.
    function receiveLaunchFee(address token, address user) external payable;

    function withdraw() external;
    function totalReceived() external view returns (uint256);
    function feesByToken(address token) external view returns (uint256);
}
