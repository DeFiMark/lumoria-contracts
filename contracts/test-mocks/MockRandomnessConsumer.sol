//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    MockRandomnessConsumer — records fulfillments so tests can assert what a
    provider delivered, and to whom.
 */

import "../interfaces/IRandomnessProvider.sol";

contract MockRandomnessConsumer is IRandomnessConsumer {

    address public provider;
    mapping(bytes32 => uint256) public words;
    mapping(bytes32 => bool) public received;

    constructor(address provider_) {
        provider = provider_;
    }

    function request(bytes32 requestKey) external returns (uint256) {
        return IRandomnessProvider(provider).requestRandomness(requestKey);
    }

    function fulfillRandomness(bytes32 requestKey, uint256 randomWord) external override {
        require(msg.sender == provider, "Only provider");
        require(!received[requestKey], "Duplicate fulfillment");
        received[requestKey] = true;
        words[requestKey] = randomWord;
    }
}
