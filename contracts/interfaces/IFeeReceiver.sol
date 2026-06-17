//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFeeReceiver {

    event FeeReceived(address indexed from, uint256 amount);
    event TokenFeeReceived(address indexed token, uint256 amount);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event RecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    function receiveFee(address token) external payable;
    function withdraw() external;
    function totalReceived() external view returns (uint256);
    function feesByToken(address token) external view returns (uint256);
}
