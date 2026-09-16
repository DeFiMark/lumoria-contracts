// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../NativeVRFRandomness.sol";

/// @notice Isolated deployment smoke test. Never registered with the production
/// Database. Exercises the actual adapter/coordinator payment and callback path.
contract VRFDeploymentCanary is IRandomnessConsumer {
    address public immutable owner = msg.sender;
    address public provider;
    bool public requested;
    bool public fulfilled;
    uint256 public word;
    function configure(address adapter) external {
        require(msg.sender == owner && provider == address(0), "Canary: owner/once");
        provider = adapter;
    }
    function token() external view returns (address) { return address(this); }
    function supportsNonCancellableRandomness() external pure returns (bool) { return true; }
    function isLumoriaToken(address candidate) external view returns (bool) { return candidate == address(this); }
    function tokenCreator(address) external view returns (address) { return owner; }
    function tokenTaxHandler(address) external view returns (address) { return address(this); }
    function getModuleCount() external pure returns (uint256) { return 1; }
    function getModule(uint256 index) external view returns (ITaxHandler.ModuleConfig memory) {
        require(index == 0, "Canary: index");
        return ITaxHandler.ModuleConfig(address(this), 4, 10000, 10000, true);
    }
    function draw() external returns (uint256) {
        require(msg.sender == owner && !requested, "Canary: owner/once");
        requested = true;
        return NativeVRFRandomness(payable(provider)).requestRandomness(bytes32(0));
    }
    function fulfillRandomness(bytes32, uint256 value) external {
        require(msg.sender == provider && requested && !fulfilled, "Canary: provider/state");
        word = value;
        fulfilled = true;
    }
}
