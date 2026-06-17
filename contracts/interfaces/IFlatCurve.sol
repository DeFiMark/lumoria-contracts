//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFlatCurve {

    event ContributionMade(address indexed contributor, uint256 grossAmount, uint256 netAmount, uint256 totalRaised);
    event ContributionRefunded(address indexed contributor, uint256 refundAmount);
    event RaiseLaunched(address indexed token, uint256 totalRaised, uint256 liquidityBNB, uint256 liquidityTokens, uint256 creatorBNB);
    event RaiseFailed(address indexed token, uint256 totalRaised);
    event TokensClaimed(address indexed contributor, uint256 tokenAmount);
    event PlatformFeeTaken(uint256 amount);

    function __init__(
        address token_,
        address database_,
        address creator_,
        bytes calldata payload
    ) external;

    function contribute() external payable;
    function refund() external;
    function launch() external;
    function claim() external;
    function withdrawOnFailure() external;

    // Views
    function token() external view returns (address);
    function hardCap() external view returns (uint256);
    function totalRaised() external view returns (uint256);
    function contributions(address user) external view returns (uint256);
    function launched() external view returns (bool);
    function failed() external view returns (bool);
    function claimed(address user) external view returns (bool);
}
