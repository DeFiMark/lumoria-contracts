// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./interfaces/IRandomnessProvider.sol";
import "./interfaces/IDatabase.sol";
import "./interfaces/ITaxHandler.sol";
import "./lib/ReentrancyGuard.sol";
import "./lib/TransferHelper.sol";

/// @dev ABI subset of Chainlink VRF v2.5 (VRFV2PlusClient.RandomWordsRequest).
interface INativeVRFCoordinator {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256);
    function fundSubscriptionWithNative(uint256 subId) external payable;
}

interface IVRFPrizePool {
    function token() external view returns (address);
    function supportsNonCancellableRandomness() external pure returns (bool);
}

/// @notice Project credits pay a fixed, disclosed BNB service charge per draw.
/// The entire charge funds the subscription. Actual oracle costs vary; the
/// subscription owner supplies the operating reserve and bears that variance.
/// Unspent project credits never leave this escrow except by creator withdrawal.
/// There is no admin withdrawal, arbitrary consumer allowlist, or word override.
contract NativeVRFRandomness is IRandomnessProvider, ReentrancyGuard {
    IDatabase public immutable database;
    INativeVRFCoordinator public immutable coordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable confirmations;
    uint32 public constant CALLBACK_GAS_LIMIT = 100_000;
    uint256 public immutable requestFee;
    mapping(address => uint256) public projectBalance;
    mapping(address => address) public consumerToken;
    mapping(address => mapping(bytes32 => bool)) public requested;
    mapping(address => mapping(bytes32 => uint256)) public requestIds;

    struct Request {
        address consumer;
        bytes32 key;
        uint256 word;
        bool fulfilled;
        bool delivered;
    }
    mapping(uint256 => Request) public requests;
    event ProjectFunded(address indexed token, address indexed sponsor, uint256 amount);
    event ProjectWithdrawn(address indexed token, uint256 amount);
    event ReserveFunded(address indexed sponsor, uint256 amount);
    event ConsumerRegistered(address indexed consumer, address indexed token);
    event RandomnessRequested(uint256 indexed requestId, address indexed consumer, bytes32 key, address token, uint256 charge);
    event RandomnessStored(uint256 indexed requestId, uint256 word);
    event RandomnessDelivered(uint256 indexed requestId);

    constructor(address db, address coord, uint256 subId, bytes32 lane, uint16 confs, uint256 fee) {
        require(db.code.length != 0 && coord.code.length != 0, "VRF: invalid contracts");
        require(subId != 0 && lane != bytes32(0) && confs >= 3 && confs <= 200, "VRF: invalid config");
        require(fee != 0 && fee <= 1 ether, "VRF: invalid fee");
        database = IDatabase(db);
        coordinator = INativeVRFCoordinator(coord);
        subscriptionId = subId;
        keyHash = lane;
        confirmations = confs;
        requestFee = fee;
    }

    function isVerifiableRandomness() external pure returns (bool) { return true; }

    /// @notice A plain BNB transfer tops up the shared Chainlink operating
    /// reserve. It does not create withdrawable project credit. The subscription
    /// owner controls this reserve; the Railway operator must not own it.
    receive() external payable { fundReserve(); }

    function fundReserve() public payable {
        require(msg.value != 0, "VRF: zero funding");
        coordinator.fundSubscriptionWithNative{value: msg.value}(subscriptionId);
        emit ReserveFunded(msg.sender, msg.value);
    }

    function fundProject(address token) external payable {
        require(database.isLumoriaToken(token), "VRF: unknown token");
        require(msg.value != 0, "VRF: zero funding");
        projectBalance[token] += msg.value;
        emit ProjectFunded(token, msg.sender, msg.value);
    }

    function withdrawProject(address token, uint256 amount) external nonReentrant {
        require(msg.sender == database.tokenCreator(token), "VRF: only creator");
        require(amount != 0 && amount <= projectBalance[token], "VRF: invalid amount");
        projectBalance[token] -= amount;
        TransferHelper.safeTransferETH(msg.sender, amount);
        emit ProjectWithdrawn(token, amount);
    }

    /// @notice Register while the module belongs to the token. Registration
    /// persists after removal so already closed epochs remain settleable.
    function registerConsumer(address consumer) public {
        if (consumerToken[consumer] != address(0)) return;
        address token = IVRFPrizePool(consumer).token();
        require(database.isLumoriaToken(token), "VRF: unknown token");
        require(IVRFPrizePool(consumer).supportsNonCancellableRandomness(), "VRF: legacy pool");
        ITaxHandler handler = ITaxHandler(database.tokenTaxHandler(token));
        uint256 count = handler.getModuleCount();
        bool found;
        for (uint256 i; i < count; ++i) {
            ITaxHandler.ModuleConfig memory m = handler.getModule(i);
            if (m.moduleAddress == consumer && m.moduleType == 4) { found = true; break; }
        }
        require(found, "VRF: unregistered module");
        consumerToken[consumer] = token;
        emit ConsumerRegistered(consumer, token);
    }

    function requestRandomness(bytes32 key) external override nonReentrant returns (uint256 id) {
        registerConsumer(msg.sender);
        require(!requested[msg.sender][key], "VRF: already requested");
        address token = consumerToken[msg.sender];
        require(projectBalance[token] >= requestFee, "VRF: fund project");
        requested[msg.sender][key] = true;
        projectBalance[token] -= requestFee;
        coordinator.fundSubscriptionWithNative{value: requestFee}(subscriptionId);
        id = coordinator.requestRandomWords(INativeVRFCoordinator.RandomWordsRequest({
            keyHash: keyHash, subId: subscriptionId, requestConfirmations: confirmations,
            callbackGasLimit: CALLBACK_GAS_LIMIT, numWords: 1,
            extraArgs: abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), true)
        }));
        require(requests[id].consumer == address(0), "VRF: duplicate id");
        requests[id] = Request(msg.sender, key, 0, false, false);
        requestIds[msg.sender][key] = id;
        emit RandomnessRequested(id, msg.sender, key, token, requestFee);
    }

    /// @dev Coordinator authentication is immutable. Store only: no consumer
    /// external call can make the one-shot oracle callback fail.
    function rawFulfillRandomWords(uint256 id, uint256[] calldata words) external {
        require(msg.sender == address(coordinator), "VRF: only coordinator");
        Request storage r = requests[id];
        if (r.consumer == address(0) || r.fulfilled || words.length == 0) return;
        r.word = words[0];
        r.fulfilled = true;
        emit RandomnessStored(id, words[0]);
    }

    /// @notice Anyone may deliver. A failed consumer call rolls back delivery,
    /// preserving the same stored word for a later retry, never a new draw.
    function deliver(uint256 id) external nonReentrant {
        Request storage r = requests[id];
        require(r.fulfilled && !r.delivered, "VRF: not deliverable");
        r.delivered = true;
        IRandomnessConsumer(r.consumer).fulfillRandomness(r.key, r.word);
        emit RandomnessDelivered(id);
    }
}
