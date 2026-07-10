//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Platform-wide randomness, behind an interface.

    ONE provider serves every module on the platform, registered at
    `Database.randomnessProvider` and resolved by consumers AT SETTLEMENT TIME —
    so swapping the implementation (e.g. TrustedOperatorRandomness → a Chainlink
    VRF consumer) is one owner transaction and requires zero module changes.
    Modules must never import a randomness vendor directly; that swappability is
    the entire reason this interface exists.

    See docs/TOKENOMICS_V2.md §3.
 */
interface IRandomnessProvider {
    /// @notice Ask for a random word for `requestKey`. The provider namespaces
    ///         the key by msg.sender, so two consumers using the same key can
    ///         never collide and a stranger cannot squat a consumer's key.
    ///         Fulfillment arrives via IRandomnessConsumer.fulfillRandomness —
    ///         possibly synchronously, in the same call (MockRandomness does).
    function requestRandomness(bytes32 requestKey) external returns (uint256 requestId);
}

interface IRandomnessConsumer {
    /// @notice Called by the provider exactly once per requestKey.
    ///         Implementations MUST check msg.sender is the provider they
    ///         requested from.
    function fulfillRandomness(bytes32 requestKey, uint256 randomWord) external;
}
