//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./lib/Ownable.sol";
import "./interfaces/IDatabase.sol";

contract Database is Ownable, IDatabase {

    // ─── System Config ──────────────────────────────────────────────

    address public override generator;
    address public override router;          // LumoriaSwapRouter (V4)
    address public override poolManager;     // canonical Uniswap V4 PoolManager
    address public override hook;            // LumoriaHook (one instance, all pools)
    address public override liquidityVault;  // LumoriaLiquidityVault (sole LP owner)
    address public override vestingVault;    // VestingVault (shared; custodies vested allocations)
    address public immutable override wbnb;  // legacy path marker for modules — pools are native-BNB
    address public override feeReceiver;
    address public override rebateContract;

    /// @dev Platform-wide randomness source, resolved by modules at settlement
    ///      time (never in the swap path). One provider serves every token, so
    ///      no per-token VRF subscription is required. Starts as a trusted
    ///      commit-reveal operator and can be swapped for a Chainlink VRF
    ///      consumer without redeploying a single module. See docs/TOKENOMICS_V2.md §3.
    address public override randomnessProvider;

    // ─── Operators ──────────────────────────────────────────────────

    /// @dev Lumoria's own backend services, trusted to supply a slippage floor
    ///      for module-initiated swaps. Platform-wide, never per-token: a token
    ///      creator cannot appoint an operator for their own module.
    ///
    ///      While `operatorCount == 0`, modules treat every caller as authorized
    ///      — the system is permissionless by default and only becomes
    ///      operator-gated once the first backend key is registered here.
    mapping(address => bool) public override isOperator;
    uint256 public override operatorCount;

    // ─── Master Copies ──────────────────────────────────────────────

    address public override tokenMasterCopy;
    address public override taxHandlerMasterCopy;
    address public override flatCurveMasterCopy;

    // module type => master copy address
    mapping(uint8 => address) public override moduleMasterCopies;

    // ─── Token Registry ─────────────────────────────────────────────

    mapping(address => bool) public override isLumoriaToken;
    mapping(address => address) public override tokenTaxHandler;
    mapping(address => address) public override tokenCreator;
    address[] internal _allTokens;

    // ─── Platform Fee ───────────────────────────────────────────────

    uint256 public override platformFeeBps; // 100 = 1%
    uint256 public constant MAX_PLATFORM_FEE = 500; // 5% hard cap

    // ─── Volume Tracking ────────────────────────────────────────────

    mapping(address => mapping(address => uint256)) public override userVolume;
    mapping(address => uint256) public override tokenVolume;

    // ─── Constructor ────────────────────────────────────────────────

    constructor(address _wbnb) {
        require(_wbnb != address(0), "Zero WBNB");
        wbnb = _wbnb;
        platformFeeBps = 100; // 1%
    }

    // ─── Token Registry (called by Generator) ───────────────────────

    function registerToken(
        address token,
        address creator_,
        address taxHandler
    ) external override {
        require(msg.sender == generator, "Only generator");
        require(!isLumoriaToken[token], "Already registered");
        require(token != address(0), "Zero token");

        isLumoriaToken[token] = true;
        tokenTaxHandler[token] = taxHandler;
        tokenCreator[token] = creator_;
        _allTokens.push(token);

        emit TokenRegistered(token, creator_, taxHandler);
    }

    // ─── Volume Tracking (called by the LumoriaHook on every swap) ──

    function registerVolume(
        address token,
        address user,
        uint256 amount
    ) external override {
        require(msg.sender == hook, "Only hook");

        // user == address(0) means the swap came through a third-party
        // router without hookData — taxed all the same, but per-user
        // attribution is impossible. Token volume is always tracked.
        if (user != address(0)) {
            userVolume[token][user] += amount;
        }
        tokenVolume[token] += amount;

        emit VolumeRegistered(token, user, amount);
    }

    // ─── Views ──────────────────────────────────────────────────────

    function allTokens(uint256 index) external view override returns (address) {
        return _allTokens[index];
    }

    function allTokensLength() external view override returns (uint256) {
        return _allTokens.length;
    }

    function owner() external view override returns (address) {
        return this.getOwner();
    }

    // ─── Admin: System Config ───────────────────────────────────────

    function setGenerator(address _generator) external onlyOwner {
        emit GeneratorUpdated(generator, _generator);
        generator = _generator;
    }

    function setRouter(address _router) external onlyOwner {
        emit RouterUpdated(router, _router);
        router = _router;
    }

    function setPoolManager(address _poolManager) external onlyOwner {
        emit PoolManagerUpdated(poolManager, _poolManager);
        poolManager = _poolManager;
    }

    function setHook(address _hook) external onlyOwner {
        emit HookUpdated(hook, _hook);
        hook = _hook;
    }

    function setLiquidityVault(address _liquidityVault) external onlyOwner {
        emit LiquidityVaultUpdated(liquidityVault, _liquidityVault);
        liquidityVault = _liquidityVault;
    }

    function setVestingVault(address _vestingVault) external onlyOwner {
        emit VestingVaultUpdated(vestingVault, _vestingVault);
        vestingVault = _vestingVault;
    }

    function setFeeReceiver(address _feeReceiver) external onlyOwner {
        emit FeeReceiverUpdated(feeReceiver, _feeReceiver);
        feeReceiver = _feeReceiver;
    }

    function setRebateContract(address _rebateContract) external onlyOwner {
        emit RebateContractUpdated(rebateContract, _rebateContract);
        rebateContract = _rebateContract;
    }

    function setRandomnessProvider(address _randomnessProvider) external onlyOwner {
        emit RandomnessProviderUpdated(randomnessProvider, _randomnessProvider);
        randomnessProvider = _randomnessProvider;
    }

    /// @notice Grant or revoke the platform operator role.
    /// @dev Registering the FIRST operator flips every module from
    ///      "permissionless immediately" to "operator-first, public after the
    ///      fallback delay". Revoking the last one flips it back. That is a
    ///      single owner transaction with system-wide effect — intentional, but
    ///      worth knowing.
    function setOperator(address operator, bool allowed) external onlyOwner {
        require(operator != address(0), "Zero operator");
        if (isOperator[operator] == allowed) return; // no-op, keeps the count honest

        isOperator[operator] = allowed;
        if (allowed) {
            operatorCount += 1;
        } else {
            operatorCount -= 1;
        }
        emit OperatorUpdated(operator, allowed);
    }

    // ─── Admin: Master Copies ───────────────────────────────────────

    function setTokenMasterCopy(address _masterCopy) external onlyOwner {
        tokenMasterCopy = _masterCopy;
        emit MasterCopyUpdated("token", _masterCopy);
    }

    function setTaxHandlerMasterCopy(address _masterCopy) external onlyOwner {
        taxHandlerMasterCopy = _masterCopy;
        emit MasterCopyUpdated("taxHandler", _masterCopy);
    }

    function setFlatCurveMasterCopy(address _masterCopy) external onlyOwner {
        flatCurveMasterCopy = _masterCopy;
        emit MasterCopyUpdated("flatCurve", _masterCopy);
    }

    function setModuleMasterCopy(uint8 moduleType, address _masterCopy) external onlyOwner {
        moduleMasterCopies[moduleType] = _masterCopy;
        emit ModuleMasterCopySet(moduleType, _masterCopy);
    }

    // ─── Admin: Platform Fee ────────────────────────────────────────

    function setPlatformFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_PLATFORM_FEE, "Exceeds max");
        emit PlatformFeeUpdated(platformFeeBps, _feeBps);
        platformFeeBps = _feeBps;
    }
}
