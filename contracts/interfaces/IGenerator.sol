//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ITaxHandler.sol";

interface IGenerator {

    enum LaunchMode { BYOL, FLAT_CURVE }

    event ProjectGenerated(
        address indexed token,
        address indexed taxHandler,
        address indexed creator,
        string name,
        string symbol,
        uint256 buyFee,
        uint256 sellFee,
        uint8 launchMode
    );
    event FlatCurveLaunched(address indexed token, address indexed flatCurve, uint256 hardCap);

    function generateProject(
        string calldata name,
        string calldata symbol,
        uint256 buyFee,
        uint256 sellFee,
        ITaxHandler.ModuleInitData[] calldata modules,
        LaunchMode launchMode,
        bytes calldata launchPayload,
        bytes32 salt
    ) external payable returns (address token, address taxHandler);

    function getDatabase() external view returns (address);
}
