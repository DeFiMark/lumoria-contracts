//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Prize Pool Module (Type 4)

    Buyers earn tickets during an epoch; the accumulated tax pot pays out at
    epoch end — pro-rata by BNB spent, by weighted lottery (<= 10 winners), or
    to all holders via the RewardModule.

    THE DESIGN DECISION THAT MAKES THIS POSSIBLE WITHOUT TOUCHING FROZEN CODE:
    ticket data is reconstructed OFF-CHAIN from the TokenPurchased event the
    hook already emits, and settled on-chain via a merkle root. receiveTax()
    stays the unchanged zero-argument accrual the swap path requires; the
    module never learns who bought until a claim proves it. See
    docs/TOKENOMICS_V2.md §1.3 before proposing an on-chain trade callback —
    that option was evaluated and rejected (it changes the hook, ITaxHandler
    and IModule, all frozen per-token at launch).

    ORDER IS LOAD-BEARING. The merkle root is committed BEFORE randomness
    exists: postRoot → 6h challenge window → drawRandomness → reveal → claims.
    Backwards, and the operator could grind the winner. drawRandomness
    additionally waits out the challenge window so an invalidation can never
    race a draw.

    EVERY PAYOUT IS PULL. You cannot push BNB to N winners in one transaction —
    a single bad recipient would revert the whole settlement. Claims are
    permissionless, O(1), and a claimant who cannot receive BNB harms only
    themselves.

    ROLLOVER, NEVER STRANDING. Empty epochs, thin epochs, missing reward
    module, withheld randomness, expired claim windows, invalidated roots —
    every failure path moves the pot into the LIVE epoch (the spec's
    "epochId + 1" in the prompt-settlement case) rather than reverting or
    stranding. A settled epoch's pot snapshot is immutable, so a rollover can
    never dilute or inflate someone's already-posted entitlement.

    TRUST POSTURE (§5): the root is the trust boundary. It is deterministically
    derivable from public TokenPurchased logs, so anyone can recompute and
    verify it; Database.owner() may invalidate a fraudulent root during the
    challenge window, which rolls the pot over rather than paying it out.
    Verifiable, not enforced — the honest wording for user-facing material.

    Cloned via ERC-1167 proxy per-token. Spec: docs/TOKENOMICS_V2.md §2.
 */

import "../interfaces/IModule.sol";
import "../interfaces/ITaxHandler.sol";
import "../interfaces/IDatabase.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/IRandomnessProvider.sol";
import "../lib/ReentrancyGuard.sol";
import "../lib/TransferHelper.sol";
import "../lib/MerkleProof.sol";

contract PrizePool is IModule, IRandomnessConsumer, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 4;
    uint8 internal constant MODULE_REWARD = 0;

    uint256 internal constant BPS = 10000;

    uint8 public constant PRO_RATA = 0;
    uint8 public constant LOTTERY = 1;
    uint8 public constant ALL_HOLDERS = 2;

    uint256 public constant MIN_EPOCH = 1 hours;
    uint256 public constant MAX_EPOCH = 30 days;
    uint256 public constant MAX_WINNERS = 10;
    uint256 public constant MAX_BOUNTY_BPS = 500;

    /// @notice Claims open this long after postRoot; Database.owner() may
    ///         invalidate a fraudulent root inside the window. Must exceed the
    ///         time to independently recompute a root from public events.
    uint256 public constant CHALLENGE_WINDOW = 6 hours;

    /// @notice A lottery epoch whose randomness is not fulfilled this long
    ///         after its root posted rolls over. A weak fallback source would
    ///         be worse than a delayed prize.
    uint256 public constant RANDOMNESS_DEADLINE = 3 days;

    /// @notice How long claims stay open once they start. Afterwards the
    ///         remainder is sweepable into the live epoch.
    uint256 public constant CLAIM_WINDOW = 30 days;

    // ─── Core references ────────────────────────────────────────────

    address public taxHandler;
    address public token;
    address public database;

    // ─── Config (set at __init__; payoutMode immutable thereafter) ──

    uint8   public payoutMode;
    uint8   public winnerCount;         // LOTTERY only, 1..10
    uint256 public holdRequirementBps;  // anti-snipe: must still hold this share of tokensBought
    uint256 public maxWeightBps;        // 0 = uncapped; enforced off-chain in the root (§2.5)
    uint256 public minPot;
    uint256 public minParticipants;
    uint256 public settleBountyBps;
    address public rootPoster;

    // ─── Epoch state (timestamp-derived; a keeper outage makes settlement
    //     late, never wrong) ───────────────────────────────────────────

    uint256 public epochLength;
    uint256 public pendingEpochLength;  // 0 = none queued; applies at next boundary
    uint256 public currentEpochId;
    uint256 public currentEpochStart;

    mapping(uint256 => uint256) public epochPot;

    // ─── Settlement state ───────────────────────────────────────────

    struct Settlement {
        bytes32 root;
        uint256 totalWeight;
        uint256 ticketCount;
        uint256 pot;              // claimable snapshot: epochPot minus bounties
        uint256 paidOut;
        uint64  rootPostedAt;
        uint64  randomFulfilledAt;
        uint256 randomWord;
        address randProvider;     // provider resolved at draw time (§3: resolve at settlement)
        bool    randomnessRequested;
        bool    randomnessFulfilled;
        bool    rolledOver;       // terminal: pot moved to the live epoch
        bool    settled;          // terminal: ALL_HOLDERS donated
        bool    swept;            // terminal: unclaimed remainder rolled
    }

    mapping(uint256 => Settlement) public settlements;
    mapping(uint256 => mapping(address => bool)) public claimed;      // PRO_RATA
    mapping(uint256 => mapping(uint256 => bool)) public slotClaimed;  // LOTTERY

    bool internal _initialized;

    // ─── Events (§2.11) ─────────────────────────────────────────────

    event TaxReceived(uint256 indexed epochId, uint256 amount);
    event EpochLengthQueued(uint256 newLength);
    event EpochLengthApplied(uint256 indexed epochId, uint256 newLength);
    event RootPosted(uint256 indexed epochId, bytes32 root, uint256 totalWeight, uint256 ticketCount);
    event RootInvalidated(uint256 indexed epochId);
    event RandomnessRequested(uint256 indexed epochId, uint256 requestId);
    event RandomnessFulfilled(uint256 indexed epochId, uint256 randomWord);
    event PrizeClaimed(uint256 indexed epochId, address indexed account, uint256 amount);
    event LotteryClaimed(uint256 indexed epochId, uint256 indexed slot, address indexed winner, uint256 amount);
    event PotRolledOver(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount, string reason);
    event DonatedToRewards(uint256 indexed epochId, address rewardModule, uint256 amount);
    event SettleBountyPaid(uint256 indexed epochId, address indexed to, uint256 amount);

    // ─── Initialization (§2.10) ─────────────────────────────────────

    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (
            address token_,
            address database_,
            uint8   payoutMode_,
            uint256 epochLength_,
            uint8   winnerCount_,
            uint256 holdRequirementBps_,
            uint256 maxWeightBps_,
            uint256 minPot_,
            uint256 minParticipants_,
            uint256 settleBountyBps_,
            address rootPoster_
        ) = abi.decode(payload, (
            address, address, uint8, uint256, uint8,
            uint256, uint256, uint256, uint256, uint256, address
        ));

        require(token_ != address(0), "Zero token");
        require(database_ != address(0), "Zero database");
        require(payoutMode_ <= ALL_HOLDERS, "Bad mode");
        require(epochLength_ >= MIN_EPOCH && epochLength_ <= MAX_EPOCH, "Bad epoch length");
        require(holdRequirementBps_ <= BPS, "Bad hold bps");
        require(maxWeightBps_ <= BPS, "Bad weight cap");
        require(settleBountyBps_ <= MAX_BOUNTY_BPS, "Bad bounty");
        if (payoutMode_ == LOTTERY) {
            require(winnerCount_ >= 1 && winnerCount_ <= MAX_WINNERS, "Bad winner count");
        }
        if (payoutMode_ != ALL_HOLDERS) {
            require(rootPoster_ != address(0), "Zero rootPoster");
        }

        _initialized = true;
        _status = _NOT_ENTERED;
        taxHandler = msg.sender;
        token = token_;
        database = database_;
        payoutMode = payoutMode_;
        epochLength = epochLength_;
        winnerCount = winnerCount_;
        holdRequirementBps = holdRequirementBps_;
        maxWeightBps = maxWeightBps_;
        minPot = minPot_;
        minParticipants = minParticipants_;
        settleBountyBps = settleBountyBps_;
        rootPoster = rootPoster_;
        currentEpochStart = block.timestamp;
    }

    // ─── Epoch math (§2.3) ──────────────────────────────────────────
    // O(1), no external calls, cannot revert. Epochs skipped because no tax
    // arrived were necessarily empty, so the multi-epoch jump loses nothing.

    function _advance() internal {
        uint256 len = epochLength;
        if (block.timestamp < currentEpochStart + len) return;
        uint256 n = (block.timestamp - currentEpochStart) / len;
        currentEpochId   += n;
        currentEpochStart += n * len;
        if (pendingEpochLength != 0) {
            epochLength = pendingEpochLength;
            pendingEpochLength = 0;
            emit EpochLengthApplied(currentEpochId, epochLength);
        }
    }

    /// @notice Creator-only. Queues a new epoch length that takes effect at the
    ///         NEXT boundary — it can never move the goalposts of an epoch
    ///         already in flight (that would let a creator resize the window
    ///         after seeing the ticket set). No timelock: cadence is not
    ///         economics, matching BurnModule.setInterval precedent.
    function setEpochLength(uint256 newLength) external {
        require(msg.sender == ITaxHandler(taxHandler).creator(), "Only creator");
        require(newLength >= MIN_EPOCH && newLength <= MAX_EPOCH, "Bad epoch length");
        _advance();
        pendingEpochLength = newLength;
        emit EpochLengthQueued(newLength);
    }

    // ─── Tax receipt (§2.4) — runs inside the V4 swap callback ──────
    // _advance() + two SSTOREs + an event. No external calls, no value out,
    // no unbounded loops. See IModule / TOKENOMICS_V2 §6.1.

    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        if (msg.value == 0) return;
        _advance();
        epochPot[currentEpochId] += msg.value;
        emit TaxReceived(currentEpochId, msg.value);
    }

    // ─── Phase 1: postRoot (§2.6) ───────────────────────────────────

    /// @notice Commit the epoch's ticket-set root. rootPoster only, once, only
    ///         after the epoch ends, and ALWAYS before randomness exists.
    ///         Thin/empty epochs roll over here instead of settling.
    function postRoot(
        uint256 epochId,
        bytes32 root,
        uint256 totalWeight,
        uint256 ticketCount
    ) external nonReentrant {
        require(payoutMode != ALL_HOLDERS, "Wrong mode");
        require(msg.sender == rootPoster, "Only rootPoster");
        _advance();
        require(epochId < currentEpochId, "Epoch not ended");

        Settlement storage s = settlements[epochId];
        require(s.root == bytes32(0) && !s.rolledOver, "Already settled");

        uint256 pot = epochPot[epochId];

        // Rollover conditions knowable at root time (§2.8).
        if (totalWeight == 0 || ticketCount == 0) {
            _rollover(epochId, pot, "no tickets");
            return;
        }
        if (pot < minPot) {
            _rollover(epochId, pot, "below min pot");
            return;
        }
        if (ticketCount < minParticipants) {
            _rollover(epochId, pot, "below min participants");
            return;
        }

        require(root != bytes32(0), "Zero root");

        uint256 bounty = (pot * settleBountyBps) / BPS;
        s.root = root;
        s.totalWeight = totalWeight;
        s.ticketCount = ticketCount;
        s.pot = pot - bounty;
        s.rootPostedAt = uint64(block.timestamp);

        emit RootPosted(epochId, root, totalWeight, ticketCount);
        _payBounty(epochId, bounty);
    }

    /// @notice Database.owner() may void a root during the challenge window —
    ///         the pot rolls over rather than paying out. The window elapses
    ///         before claims OR a randomness draw, so an invalidation can
    ///         never race either.
    function invalidateRoot(uint256 epochId) external nonReentrant {
        require(msg.sender == IDatabase(database).owner(), "Only platform owner");
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver, "No live root");
        require(block.timestamp < uint256(s.rootPostedAt) + CHALLENGE_WINDOW, "Window closed");

        uint256 amount = s.pot;
        s.pot = 0;
        emit RootInvalidated(epochId);
        _rollover(epochId, amount, "root invalidated");
    }

    // ─── Phase 2: randomness (LOTTERY only, §2.6/§3) ────────────────

    /// @notice Permissionless (bounty-paid) so settlement never depends on our
    ///         operator staying alive. Requires the root to exist — this
    ///         ordering is what stops the operator grinding the winner — and
    ///         waits out the challenge window so invalidation cannot race it.
    function drawRandomness(uint256 epochId) external nonReentrant {
        require(payoutMode == LOTTERY, "Wrong mode");
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver, "No root");
        require(block.timestamp >= uint256(s.rootPostedAt) + CHALLENGE_WINDOW, "Challenge window");
        require(!s.randomnessRequested, "Already requested");

        address provider = IDatabase(database).randomnessProvider();
        require(provider != address(0), "No provider");

        uint256 bounty = (s.pot * settleBountyBps) / BPS;
        s.pot -= bounty;
        s.randomnessRequested = true;
        s.randProvider = provider;
        _payBounty(epochId, bounty);

        // May fulfill synchronously (MockRandomness) — all state is set first.
        uint256 requestId = IRandomnessProvider(provider).requestRandomness(bytes32(epochId));
        emit RandomnessRequested(epochId, requestId);
    }

    /// @notice Callback from the provider resolved at draw time. NOT
    ///         nonReentrant — it may run inside drawRandomness's frame.
    function fulfillRandomness(bytes32 requestKey, uint256 randomWord) external override {
        uint256 epochId = uint256(requestKey);
        Settlement storage s = settlements[epochId];
        require(msg.sender == s.randProvider, "Only provider");
        require(s.randomnessRequested && !s.randomnessFulfilled, "Bad request state");
        require(!s.rolledOver, "Rolled over");

        s.randomnessFulfilled = true;
        s.randomWord = randomWord;
        s.randomFulfilledAt = uint64(block.timestamp);
        emit RandomnessFulfilled(epochId, randomWord);
    }

    /// @notice A withheld reveal must delay a prize, never freeze one: past the
    ///         deadline anyone can roll the epoch over. Rolling over rather
    ///         than falling back to a weak randomness source is deliberate.
    function rolloverStaleRandomness(uint256 epochId) external nonReentrant {
        require(payoutMode == LOTTERY, "Wrong mode");
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver, "No root");
        require(!s.randomnessFulfilled, "Already fulfilled");
        require(
            block.timestamp >= uint256(s.rootPostedAt) + RANDOMNESS_DEADLINE,
            "Deadline not reached"
        );

        uint256 amount = s.pot;
        s.pot = 0;
        _rollover(epochId, amount, "randomness timeout");
    }

    // ─── Phase 3: claims (permissionless, pull, O(1)) ───────────────

    /// @notice PRO_RATA claim. Leaf: keccak256(abi.encode(account, weight, tokensBought)).
    function claim(
        uint256 epochId,
        uint256 weight,
        uint256 tokensBought,
        bytes32[] calldata proof
    ) external nonReentrant {
        require(payoutMode == PRO_RATA, "Wrong mode");
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver, "Not settled");
        uint256 opensAt = uint256(s.rootPostedAt) + CHALLENGE_WINDOW;
        require(block.timestamp >= opensAt, "Challenge window");
        require(block.timestamp <= opensAt + CLAIM_WINDOW, "Claim window closed");
        require(!claimed[epochId][msg.sender], "Already claimed");

        bytes32 leaf = keccak256(abi.encode(msg.sender, weight, tokensBought));
        require(MerkleProof.verify(proof, s.root, leaf), "Bad proof");
        _requireStillHolding(tokensBought);

        uint256 amount = (s.pot * weight) / s.totalWeight;
        claimed[epochId][msg.sender] = true;
        s.paidOut += amount;

        TransferHelper.safeTransferETH(msg.sender, amount);
        emit PrizeClaimed(epochId, msg.sender, amount);
    }

    /// @notice LOTTERY claim. Leaf: keccak256(abi.encode(index, account, weight,
    ///         cumBefore, tokensBought)). The contract recomputes the slot's
    ///         winning point r and requires cumBefore <= r < cumBefore + weight
    ///         — one range check plus the proof, no scanning, no stored ticket
    ///         array. The SAME account may win multiple slots: that is correct
    ///         for weighted sampling with replacement, not a bug.
    function claimLottery(
        uint256 epochId,
        uint256 slot,
        uint256 index,
        uint256 weight,
        uint256 cumBefore,
        uint256 tokensBought,
        bytes32[] calldata proof
    ) external nonReentrant {
        require(payoutMode == LOTTERY, "Wrong mode");
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver, "Not settled");
        require(s.randomnessFulfilled, "No randomness");
        require(block.timestamp <= uint256(s.randomFulfilledAt) + CLAIM_WINDOW, "Claim window closed");
        require(slot < winnerCount, "Bad slot");
        require(!slotClaimed[epochId][slot], "Slot claimed");

        bytes32 leaf = keccak256(abi.encode(index, msg.sender, weight, cumBefore, tokensBought));
        require(MerkleProof.verify(proof, s.root, leaf), "Bad proof");

        uint256 r = uint256(keccak256(abi.encode(s.randomWord, slot))) % s.totalWeight;
        require(cumBefore <= r && r < cumBefore + weight, "Not the winner");
        _requireStillHolding(tokensBought);

        uint256 amount = s.pot / winnerCount;
        slotClaimed[epochId][slot] = true;
        s.paidOut += amount;

        TransferHelper.safeTransferETH(msg.sender, amount);
        emit LotteryClaimed(epochId, slot, msg.sender, amount);
    }

    // ─── ALL_HOLDERS settlement (§2.2) ──────────────────────────────

    /// @notice Delegates the whole pot to the RewardModule's donate() — every
    ///         non-excluded holder, one accumulator write, no second pro-rata
    ///         system. Permissionless with a bounty; no root, no challenge
    ///         window (there is no per-buyer entitlement to challenge). Rolls
    ///         over if no RewardModule exists rather than reverting.
    function settleAllHolders(uint256 epochId) external nonReentrant {
        require(payoutMode == ALL_HOLDERS, "Wrong mode");
        _advance();
        require(epochId < currentEpochId, "Epoch not ended");

        Settlement storage s = settlements[epochId];
        require(!s.settled && !s.rolledOver, "Already settled");

        uint256 pot = epochPot[epochId];
        if (pot == 0) {
            // donate() rejects zero value; an empty epoch just closes.
            _rollover(epochId, 0, "empty pot");
            return;
        }
        if (pot < minPot) {
            _rollover(epochId, pot, "below min pot");
            return;
        }
        address rewardModule = _findRewardModule();
        if (rewardModule == address(0)) {
            _rollover(epochId, pot, "no reward module");
            return;
        }

        uint256 bounty = (pot * settleBountyBps) / BPS;
        uint256 amount = pot - bounty;
        s.settled = true;
        s.pot = amount;
        s.paidOut = amount;

        _payBounty(epochId, bounty);
        IRewardModule(rewardModule).donate{value: amount}();
        emit DonatedToRewards(epochId, rewardModule, amount);
    }

    // ─── Sweep (§2.8: claim window elapsed with shares unclaimed) ───

    /// @notice After the claim window, roll whatever was never claimed into
    ///         the live epoch. Permissionless. No BNB is ever stranded.
    function sweepUnclaimed(uint256 epochId) external nonReentrant {
        Settlement storage s = settlements[epochId];
        require(s.root != bytes32(0) && !s.rolledOver && !s.swept, "Nothing to sweep");

        uint256 opensAt = payoutMode == LOTTERY
            ? uint256(s.randomFulfilledAt)
            : uint256(s.rootPostedAt) + CHALLENGE_WINDOW;
        if (payoutMode == LOTTERY) {
            require(s.randomnessFulfilled, "No randomness");
        }
        require(block.timestamp > opensAt + CLAIM_WINDOW, "Claim window open");

        uint256 remaining = s.pot - s.paidOut;
        s.swept = true;
        if (remaining > 0) {
            _rolloverKeepRoot(epochId, remaining, "unclaimed");
        }
    }

    // ─── Internals ──────────────────────────────────────────────────

    /// @dev Terminal rollover: marks the epoch closed and moves `amount` into
    ///      the LIVE epoch's pot. Settled epochs' snapshots are never touched.
    function _rollover(uint256 fromEpoch, uint256 amount, string memory reason) internal {
        settlements[fromEpoch].rolledOver = true;
        _rolloverKeepRoot(fromEpoch, amount, reason);
    }

    /// @dev Rollover that does NOT close the epoch record — used by the sweep,
    ///      where the epoch settled fine and only the remainder moves.
    function _rolloverKeepRoot(uint256 fromEpoch, uint256 amount, string memory reason) internal {
        _advance();
        uint256 toEpoch = currentEpochId;
        epochPot[toEpoch] += amount;
        emit PotRolledOver(fromEpoch, toEpoch, amount, reason);
    }

    function _payBounty(uint256 epochId, uint256 amount) internal {
        if (amount == 0) return;
        TransferHelper.safeTransferETH(msg.sender, amount);
        emit SettleBountyPaid(epochId, msg.sender, amount);
    }

    /// @dev The anti-snipe lever (§2.7): a claimant must still hold
    ///      holdRequirementBps of what they bought. 10000 = everything;
    ///      0 disables. Recommended default 10000.
    function _requireStillHolding(uint256 tokensBought) internal view {
        if (holdRequirementBps == 0) return;
        uint256 required = (tokensBought * holdRequirementBps) / BPS;
        require(IERC20(token).balanceOf(msg.sender) >= required, "Sold before claim");
    }

    /// @dev Resolved at settlement time, not init — the module set can change.
    ///      Bounded by TaxHandler.MAX_MODULES = 10. Returns zero when absent
    ///      (rollover, not revert).
    function _findRewardModule() internal view returns (address) {
        ITaxHandler handler = ITaxHandler(taxHandler);
        uint256 n = handler.getModuleCount();
        for (uint256 i; i < n; ++i) {
            ITaxHandler.ModuleConfig memory m = handler.getModule(i);
            if (m.moduleType == MODULE_REWARD) return m.moduleAddress;
        }
        return address(0);
    }

    // ─── Views ──────────────────────────────────────────────────────

    /// @notice The epoch id the NEXT receiveTax would bucket into (live view of
    ///         _advance without mutating).
    function liveEpochId() external view returns (uint256) {
        uint256 len = epochLength;
        if (block.timestamp < currentEpochStart + len) return currentEpochId;
        return currentEpochId + (block.timestamp - currentEpochStart) / len;
    }

    function getModuleType() external pure override returns (uint8) {
        return MODULE_TYPE;
    }

    function getStats() external view override returns (bytes memory) {
        return abi.encode(
            payoutMode,
            epochLength,
            currentEpochId,
            currentEpochStart,
            epochPot[currentEpochId],
            address(this).balance
        );
    }
}
