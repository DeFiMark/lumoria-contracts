//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Trusted Operator Randomness — the v1 platform randomness provider.

    A bare "backend posts a number" is not randomness: the operator sees the
    ticket set and can pick the winner. Commit–reveal with blockhash mixing
    costs nothing extra and closes that:

    1. COMMIT — at or before the start of the epoch, the operator submits
       keccak256(seed). The seed is fixed before any participants are known.
    2. REVEAL — at settlement, the seed is submitted. The contract checks the
       preimage and computes
           word = keccak256(abi.encode(seed, blockhash(block.number - 1)))

    The operator cannot grind the outcome at reveal time (the seed is
    committed) and cannot precompute it at commit time (the future blockhash
    is unknown). A withheld reveal delays a prize — the consumer's deadline
    rolls its epoch over — it never freezes or steals one.

    ORDER IS LOAD-BEARING: commit before the participants are known, reveal
    after. The contract enforces commit-before-request; committing early
    enough relative to the consumer's epoch is operational discipline,
    publicly auditable from the SeedCommitted timestamp.

    RESIDUAL RISK, disclosed: BSC validators have some influence over
    blockhash, and the revealer chooses which block to reveal in. Acceptable
    for a closed beta with capped exposure; disappears entirely when
    Database.setRandomnessProvider swaps in ChainlinkVRFRandomness. This is
    the one place in the system where a trusted party can affect who gets
    paid. Say so publicly.

    KEYS ARE SCOPED BY CONSUMER: the effective key is
    keccak256(abi.encode(consumer, requestKey)), so a stranger cannot
    front-run requestRandomness with a module's key and strand its epoch.
    Operators compute the scoped key off-chain (or via scopedKeyFor) when
    committing.

    Deployed once, platform-wide. Registered at Database.randomnessProvider.
    See docs/TOKENOMICS_V2.md §3.
 */

import "./interfaces/IRandomnessProvider.sol";
import "./interfaces/IDatabase.sol";
import "./lib/ReentrancyGuard.sol";

contract TrustedOperatorRandomness is IRandomnessProvider, ReentrancyGuard {

    address public immutable database;

    struct Request {
        address consumer;      // set at requestRandomness; zero = not requested
        uint64  requestedAt;
        bool    fulfilled;
    }

    // scopedKey => committed seed hash (zero = no commit)
    mapping(bytes32 => bytes32) public seedHashes;
    // scopedKey => request state
    mapping(bytes32 => Request) public requests;

    uint256 public nextRequestId;

    // ─── Events ─────────────────────────────────────────────────────

    event SeedCommitted(bytes32 indexed scopedKey, bytes32 seedHash, address indexed operator);
    event RandomnessRequested(bytes32 indexed scopedKey, bytes32 indexed requestKey, address indexed consumer, uint256 requestId);
    event RandomnessFulfilled(bytes32 indexed scopedKey, address indexed consumer, uint256 randomWord);

    constructor(address database_) {
        require(database_ != address(0), "Zero database");
        database = database_;
    }

    // ─── Operator gate ──────────────────────────────────────────────
    // Same platform registry every gated module action uses. With no
    // operators registered the platform runs permissionless (tests, and the
    // pre-backend default) — matching Database.isOperator semantics
    // everywhere else. A commit is a trusted attestation, so there is no
    // public-fallback window here (TOKENOMICS_V2 §6.3).

    function _requireOperator() internal view {
        IDatabase db = IDatabase(database);
        if (db.operatorCount() == 0) return;
        require(db.isOperator(msg.sender), "Only operator");
    }

    // ─── Commit ─────────────────────────────────────────────────────

    /// @notice Commit keccak256(seed) for a scoped key, BEFORE the consumer's
    ///         epoch participants are known. One commit per key, forever —
    ///         re-committing after seeing the tickets is exactly the grind
    ///         this contract exists to prevent.
    function commit(bytes32 scopedKey, bytes32 seedHash) external {
        _requireOperator();
        require(seedHash != bytes32(0), "Zero hash");
        require(seedHashes[scopedKey] == bytes32(0), "Already committed");
        seedHashes[scopedKey] = seedHash;
        emit SeedCommitted(scopedKey, seedHash, msg.sender);
    }

    // ─── Request (consumer) ─────────────────────────────────────────

    /// @notice Called by the consuming module at settlement. Requires a prior
    ///         commit — no commit, no draw, and the consumer's deadline rolls
    ///         its epoch over instead of freezing it.
    function requestRandomness(bytes32 requestKey) external override returns (uint256 requestId) {
        bytes32 scopedKey = scopedKeyFor(msg.sender, requestKey);
        require(seedHashes[scopedKey] != bytes32(0), "No commit");
        require(requests[scopedKey].consumer == address(0), "Already requested");

        requestId = ++nextRequestId;
        requests[scopedKey] = Request({
            consumer: msg.sender,
            requestedAt: uint64(block.timestamp),
            fulfilled: false
        });
        emit RandomnessRequested(scopedKey, requestKey, msg.sender, requestId);
    }

    // ─── Reveal ─────────────────────────────────────────────────────

    /// @notice Reveal the committed seed and deliver the word. Permissionless
    ///         on purpose: knowing the preimage IS the credential, and it lets
    ///         the operator publish the seed so anyone can finish the job.
    function reveal(address consumer, bytes32 requestKey, bytes32 seed) external nonReentrant {
        bytes32 scopedKey = scopedKeyFor(consumer, requestKey);
        Request storage req = requests[scopedKey];
        require(req.consumer != address(0), "Not requested");
        require(!req.fulfilled, "Already fulfilled");
        require(keccak256(abi.encodePacked(seed)) == seedHashes[scopedKey], "Bad seed");

        req.fulfilled = true;
        uint256 word = uint256(keccak256(abi.encode(seed, blockhash(block.number - 1))));

        IRandomnessConsumer(consumer).fulfillRandomness(requestKey, word);
        emit RandomnessFulfilled(scopedKey, consumer, word);
    }

    // ─── Views ──────────────────────────────────────────────────────

    /// @notice The storage key for (consumer, requestKey). Operators use this
    ///         (off-chain or via this view) to commit for a specific module's
    ///         epoch.
    function scopedKeyFor(address consumer, bytes32 requestKey) public pure returns (bytes32) {
        return keccak256(abi.encode(consumer, requestKey));
    }
}
