//SPDX-License-Identifier: MIT
// Vendored, trimmed from OpenZeppelin Contracts v5.x (utils/cryptography/MerkleProof.sol),
// the same way lib/EnumerableSet.sol was vendored — no OZ package is installed here.
pragma solidity 0.8.28;

/**
    Merkle proof verification with COMMUTATIVE pair hashing: each internal node
    is keccak256(min(a,b) || max(a,b)), so proofs need no left/right flags.

    Safe against second-preimage confusion here because every Lumoria leaf is
    keccak256(abi.encode(...)) of 3+ fields (>= 96 bytes of preimage), which can
    never collide with a 64-byte internal-node preimage.

    The JS mirror lives in scripts/lib/merkle.js — the tree builder used by the
    tests, the operator scripts, and (as documentation) the subgraph's ticket
    derivation. Keep the two in lock-step.
 */
library MerkleProof {

    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf)
        internal
        pure
        returns (bool)
    {
        return processProof(proof, leaf) == root;
    }

    function processProof(bytes32[] calldata proof, bytes32 leaf)
        internal
        pure
        returns (bytes32 computedHash)
    {
        computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            computedHash = _hashPair(computedHash, proof[i]);
        }
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? _efficientHash(a, b) : _efficientHash(b, a);
    }

    function _efficientHash(bytes32 a, bytes32 b) private pure returns (bytes32 value) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            value := keccak256(0x00, 0x40)
        }
    }
}
