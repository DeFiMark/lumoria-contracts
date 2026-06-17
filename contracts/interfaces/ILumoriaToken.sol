//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IERC20.sol";

interface ILumoriaToken is IERC20 {

    function __init__(
        string calldata name_,
        string calldata symbol_,
        address pair_,
        address taxHandler_,
        address creator_
    ) external;

    function burn(uint256 amount) external;

    function pair() external view returns (address);
    function taxHandler() external view returns (address);
    function creator() external view returns (address);
}
