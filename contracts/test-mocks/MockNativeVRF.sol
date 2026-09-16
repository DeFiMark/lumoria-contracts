// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../NativeVRFRandomness.sol";
contract MockNativeVRF is INativeVRFCoordinator {
    uint256 public nextId = 1;
    uint256 public funded;
    bool public failRequest;
    bytes public lastExtraArgs;
    function setFailRequest(bool value) external { failRequest = value; }
    function fundSubscriptionWithNative(uint256) external payable { funded += msg.value; }
    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256) {
        require(!failRequest, "Coordinator unavailable");
        lastExtraArgs = req.extraArgs;
        return nextId++;
    }
    function fulfill(address consumer, uint256 id, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        NativeVRFRandomness(payable(consumer)).rawFulfillRandomWords(id, words);
    }
}
