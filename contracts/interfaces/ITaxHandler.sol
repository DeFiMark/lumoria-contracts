//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ITaxHandler {

    // ─── Structs ────────────────────────────────────────────────────

    struct ModuleConfig {
        address moduleAddress;
        uint8 moduleType;
        uint256 buyAllocation;   // bps of fee BNB routed to this module
        uint256 sellAllocation;  // bps of fee BNB routed to this module
        bool active;
    }

    struct ModuleInitData {
        uint8 moduleType;
        uint256 buyAllocation;
        uint256 sellAllocation;
        bytes initPayload;
    }

    /// @notice A single allocation rewrite. Bundled into batch proposals so that
    ///         creators can atomically move bps around when the new total must
    ///         still sum to exactly 10000.
    struct AllocationUpdate {
        uint256 moduleIndex;
        uint256 buyAllocation;
        uint256 sellAllocation;
    }

    // ─── Events ─────────────────────────────────────────────────────

    event BuyTaxDistributed(address indexed token, uint256 amount, address indexed buyer);
    event SellTaxDistributed(address indexed token, uint256 amount, address indexed seller);
    event ShareUpdated(address indexed holder, uint256 oldShare, uint256 newShare);
    event ModuleAdded(uint8 indexed moduleType, address indexed moduleAddress, uint256 buyAlloc, uint256 sellAlloc);
    event ModuleRemoved(uint8 indexed moduleType, address indexed moduleAddress);
    event ModuleUpdated(uint8 indexed moduleType, address indexed moduleAddress, uint256 buyAlloc, uint256 sellAlloc);
    event FeesUpdated(uint256 oldBuyFee, uint256 newBuyFee, uint256 oldSellFee, uint256 newSellFee);
    event FeeChangeProposed(uint256 newBuyFee, uint256 newSellFee, uint256 effectiveTime);
    event FeeChangeCancelled();
    event ModuleChangeProposed(uint8 changeType, uint8 indexed moduleType, uint256 buyAlloc, uint256 sellAlloc, uint256 effectiveTime);
    event ModuleRebalanceProposed(uint256[] indices, uint256[] buyAllocs, uint256[] sellAllocs);
    event ModuleChangeCancelled();
    event ManagementRenounced(address indexed token, uint256 timestamp);
    event ExcludedFromShares(address indexed account);

    // ─── Initialization ─────────────────────────────────────────────

    function __init__(
        address token_,
        address database_,
        address creator_,
        uint256 buyFee_,
        uint256 sellFee_,
        ModuleInitData[] calldata modules_
    ) external;

    // ─── Tax receiving (called by Router) ───────────────────────────

    function receiveBuyTax() external payable;
    function receiveSellTax() external payable;

    // ─── Share management (called by Token) ─────────────────────────

    function setShare(address holder, uint256 amount) external;

    /// @notice True if `holder` is excluded from reward-share tracking.
    ///         Excluded addresses are system contracts that custody tokens on
    ///         someone else's behalf (VestingVault, RebateContract, FlatCurve,
    ///         LiquidityVault, module clones) plus the pool itself. Letting them
    ///         accrue reflections would strand BNB with no claim path.
    function isExcludedFromShares(address holder) external view returns (bool);

    /// @notice Exclude an address from share tracking. Callable only by the
    ///         Generator, which uses it to exclude a token's FlatCurve — the one
    ///         excluded address that does not exist yet at TaxHandler init time.
    ///         Deliberately NOT owner-callable: an owner able to exclude arbitrary
    ///         holders could zero any holder's rewards.
    function excludeFromShares(address account) external;

    // ─── Fee queries ────────────────────────────────────────────────

    function buyFee() external view returns (uint256);
    function sellFee() external view returns (uint256);
    function token() external view returns (address);
    function creator() external view returns (address);

    // ─── Fee changes (called by creator, subject to timelock) ───────

    function proposeFeeChange(uint256 newBuyFee, uint256 newSellFee) external;
    function executeFeeChange() external;
    function cancelFeeChange() external;

    // ─── Module changes (called by creator, subject to timelock) ────
    //
    // All three propose* functions accept an `AllocationUpdate[]` array
    // describing allocation rewrites to OTHER modules that must be applied
    // atomically at execute time. This keeps the `sum == 10000` invariant
    // achievable across every valid lifecycle transition (add/remove/update).

    function proposeModuleAdd(
        uint8 moduleType,
        uint256 buyAlloc,
        uint256 sellAlloc,
        bytes calldata initPayload,
        AllocationUpdate[] calldata rebalance
    ) external;

    function proposeModuleRemove(
        uint256 moduleIndex,
        AllocationUpdate[] calldata rebalance
    ) external;

    /// @notice Propose bulk allocation updates across existing modules.
    ///         For rebalancing the set without adding or removing.
    function proposeModuleUpdate(AllocationUpdate[] calldata updates) external;

    function executeModuleChange() external;
    function cancelModuleChange() external;

    // ─── Renounce (called by creator; one-way, freezes all changes) ──

    /// @notice Permanently freeze this token's tax/module configuration. After
    ///         this, no fee or module change can ever be proposed or executed,
    ///         and any in-flight pending change is cancelled. One-way.
    function renounceManagement() external;

    function managementRenounced() external view returns (bool);

    // ─── Views ──────────────────────────────────────────────────────

    function shares(address holder) external view returns (uint256);
    function totalShares() external view returns (uint256);
    function getModuleCount() external view returns (uint256);
}
