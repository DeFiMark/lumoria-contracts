//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    MockRandomness — instant, deterministic randomness for the Hardhat suite.

    Two modes:
    - autoFulfill (default): requestRandomness calls the consumer back
      synchronously with the preset `word`. Lets tests pick the winner.
    - manual: the test calls fulfill(consumer, requestKey) later, to exercise
      the async path and deadline/rollover behavior.
 */

import "../interfaces/IRandomnessProvider.sol";

contract MockRandomness is IRandomnessProvider {

    uint256 public word;
    bool public autoFulfill = true;
    uint256 public nextRequestId;

    struct Pending { address consumer; bool requested; bool fulfilled; }
    mapping(bytes32 => Pending) public pending; // keyed by keccak(consumer, requestKey)

    function setWord(uint256 w) external { word = w; }
    function setAutoFulfill(bool v) external { autoFulfill = v; }

    function keyFor(address consumer, bytes32 requestKey) public pure returns (bytes32) {
        return keccak256(abi.encode(consumer, requestKey));
    }

    function requestRandomness(bytes32 requestKey) external override returns (uint256 requestId) {
        bytes32 k = keyFor(msg.sender, requestKey);
        require(!pending[k].requested, "Already requested");
        requestId = ++nextRequestId;
        pending[k] = Pending({ consumer: msg.sender, requested: true, fulfilled: false });
        if (autoFulfill) {
            pending[k].fulfilled = true;
            IRandomnessConsumer(msg.sender).fulfillRandomness(requestKey, word);
        }
    }

    function fulfill(address consumer, bytes32 requestKey) external {
        bytes32 k = keyFor(consumer, requestKey);
        require(pending[k].requested, "Not requested");
        require(!pending[k].fulfilled, "Already fulfilled");
        pending[k].fulfilled = true;
        IRandomnessConsumer(consumer).fulfillRandomness(requestKey, word);
    }
}
