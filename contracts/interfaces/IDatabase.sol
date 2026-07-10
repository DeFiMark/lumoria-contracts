//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IDatabase {

    // Events
    event TokenRegistered(address indexed token, address indexed creator, address taxHandler);
    event MasterCopyUpdated(string indexed copyType, address indexed newCopy);
    event ModuleMasterCopySet(uint8 indexed moduleType, address indexed masterCopy);
    event PlatformFeeUpdated(uint256 oldFee, uint256 newFee);
    event VolumeRegistered(address indexed token, address indexed user, uint256 amount);
    event GeneratorUpdated(address indexed oldGenerator, address indexed newGenerator);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event PoolManagerUpdated(address indexed oldPoolManager, address indexed newPoolManager);
    event HookUpdated(address indexed oldHook, address indexed newHook);
    event LiquidityVaultUpdated(address indexed oldVault, address indexed newVault);
    event VestingVaultUpdated(address indexed oldVault, address indexed newVault);
    event FeeReceiverUpdated(address indexed oldFeeReceiver, address indexed newFeeReceiver);
    event RebateContractUpdated(address indexed oldRebate, address indexed newRebate);
    event RandomnessProviderUpdated(address indexed oldProvider, address indexed newProvider);
    event OperatorUpdated(address indexed operator, bool allowed);

    // System Config
    function generator() external view returns (address);
    function router() external view returns (address);
    function poolManager() external view returns (address);
    function hook() external view returns (address);
    function liquidityVault() external view returns (address);
    function vestingVault() external view returns (address);
    function wbnb() external view returns (address);
    function feeReceiver() external view returns (address);
    function rebateContract() external view returns (address);

    /// @notice Platform-wide randomness source. One provider serves every module
    ///         on every token, so a per-token VRF subscription is never needed.
    ///         Swappable by the owner (trusted-operator today, VRF later) without
    ///         touching any deployed module.
    function randomnessProvider() external view returns (address);

    // ─── Operators (platform-wide, owner-managed) ───────────────────
    //
    // Operators are Lumoria's own backend services. They are trusted only to
    // supply a sane slippage floor for module-initiated swaps, which spend the
    // MODULE's BNB rather than the caller's — so a caller-chosen `minOut` cannot
    // be trusted from an arbitrary address.
    //
    // Deliberately NOT per-token: creators do not configure operators.
    //
    // While `operatorCount == 0` every module action is permissionless, so the
    // system is permissionless by default until the backend is switched on.

    function isOperator(address account) external view returns (bool);
    function operatorCount() external view returns (uint256);

    // Master Copies
    function tokenMasterCopy() external view returns (address);
    function taxHandlerMasterCopy() external view returns (address);
    function flatCurveMasterCopy() external view returns (address);
    function moduleMasterCopies(uint8 moduleType) external view returns (address);

    // Token Registry
    function isLumoriaToken(address token) external view returns (bool);
    function tokenTaxHandler(address token) external view returns (address);
    function tokenCreator(address token) external view returns (address);
    function allTokens(uint256 index) external view returns (address);
    function allTokensLength() external view returns (uint256);

    // Platform Fee
    function platformFeeBps() external view returns (uint256);

    // Volume
    function userVolume(address token, address user) external view returns (uint256);
    function tokenVolume(address token) external view returns (uint256);

    // Registration (called by Generator)
    function registerToken(address token, address creator, address taxHandler) external;

    // Volume tracking (called by the LumoriaHook; user may be address(0)
    // for swaps that arrived without hookData attribution)
    function registerVolume(address token, address user, uint256 amount) external;

    // Owner
    function owner() external view returns (address);
}
