//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria TaxHandler (per-token)

    Receives BNB tax from the Router (after the 1% platform fee has already
    been skimmed) and distributes it across a curated set of modules
    according to per-module buy/sell allocations (basis points, each side
    must sum to exactly 10000).

    Also aggregates holder shares: the token contract calls setShare() on
    every transfer, and this handler forwards the update to any active
    RewardModule instances.

    Creator controls:
    - Fee decreases (buy/sell) apply instantly (always good for holders).
    - Fee increases are 24h timelocked.
    - Module add / remove / update are all 24h timelocked.
    - Only one pending module change at a time.
    - Max 10 modules per token (bounds gas on every trade).
    - Every module-change proposal can bundle a rebalance array so the
      sum == 10000 invariant is maintained atomically across lifecycle
      transitions.

    Cloned via ERC-1167 proxy per-token. Modules are also cloned here
    from master copies registered in the Database.
 */

import "./interfaces/ITaxHandler.sol";
import "./interfaces/IModule.sol";
import "./interfaces/IDatabase.sol";
import "./interfaces/ILumoriaToken.sol";
import "./lib/ReentrancyGuard.sol";

contract TaxHandler is ITaxHandler, ReentrancyGuard {

    // ─── Constants ──────────────────────────────────────────────────

    uint256 public constant BPS = 10000;
    uint256 public constant MAX_FEE = 9800;          // 98% hard cap per side
    uint256 public constant CHANGE_DELAY = 24 hours; // timelock for adverse changes
    uint256 public constant MAX_MODULES = 10;        // gas ceiling on distribution loop

    // module type enum (matches Database.moduleMasterCopies keys)
    uint8 public constant MODULE_REWARD = 0;
    uint8 public constant MODULE_BURN = 1;
    uint8 public constant MODULE_LIQUIDITY = 2;
    uint8 public constant MODULE_CREATOR = 3;

    // change type enum for pendingModuleChange
    uint8 public constant CHANGE_ADD = 0;
    uint8 public constant CHANGE_REMOVE = 1;
    uint8 public constant CHANGE_UPDATE = 2;

    // ─── Core References ────────────────────────────────────────────

    address public override token;
    address public override database;
    address public override creator;
    bool internal _initialized;

    /// @dev When true, this token's tax/module config is frozen forever:
    ///      no fee or module change can be proposed or executed. One-way.
    bool public override managementRenounced;

    /// @dev Addresses excluded from reward-share tracking. These are system
    ///      contracts that custody tokens on someone else's behalf; if they
    ///      accrued reflections, that BNB would be stranded with no claim path.
    ///
    ///      Populated at init with the VestingVault, RebateContract, and
    ///      LiquidityVault; extended with every module clone as it is created;
    ///      and extended once more by the Generator with the token's FlatCurve
    ///      (which does not exist yet when this contract is initialized).
    ///
    ///      The pool itself is excluded on the token side — LumoriaToken never
    ///      calls setShare for `pair` — so it does not need an entry here, but
    ///      `isExcludedFromShares` reports it for the benefit of off-chain
    ///      consumers and RewardModule.sync().
    mapping(address => bool) internal _excludedFromShares;

    uint256 internal _buyFee;
    uint256 internal _sellFee;

    // ─── Module Registry ────────────────────────────────────────────

    ModuleConfig[] public modules;

    // ─── Share Tracking ─────────────────────────────────────────────

    mapping(address => uint256) internal _shares;
    uint256 internal _totalShares;

    // ─── Fee Timelock ───────────────────────────────────────────────

    struct PendingFeeChange {
        uint256 newBuyFee;
        uint256 newSellFee;
        uint256 effectiveTime;
        bool pending;
    }
    PendingFeeChange public pendingFeeChange;

    // ─── Module Timelock ────────────────────────────────────────────

    struct PendingModuleChange {
        uint8 changeType;         // CHANGE_ADD, CHANGE_REMOVE, CHANGE_UPDATE
        uint8 moduleType;         // used for ADD only
        uint256 moduleIndex;      // used for REMOVE only
        uint256 buyAllocation;    // used for ADD only (primary)
        uint256 sellAllocation;   // used for ADD only (primary)
        bytes initPayload;        // used for ADD only
        uint256 effectiveTime;
        bool pending;
    }
    PendingModuleChange public pendingModuleChange;

    /// @dev Rebalance list for the pending change. Indices are resolved in
    ///      the pre-execution modules[] layout; applied before removal
    ///      (when removing) and after push (when adding).
    AllocationUpdate[] internal _pendingRebalance;

    // ─── Analytics ──────────────────────────────────────────────────

    uint256 public totalBuyTaxReceived;
    uint256 public totalSellTaxReceived;

    // ─── Modifiers ──────────────────────────────────────────────────

    modifier onlyCreator() {
        require(msg.sender == creator, "Only creator");
        _;
    }

    // ─── Initialization ─────────────────────────────────────────────

    function __init__(
        address token_,
        address database_,
        address creator_,
        uint256 buyFee_,
        uint256 sellFee_,
        ModuleInitData[] calldata modules_
    ) external override {
        require(!_initialized, "Already initialized");
        require(token_ != address(0), "Zero token");
        require(database_ != address(0), "Zero database");
        require(creator_ != address(0), "Zero creator");
        require(buyFee_ <= MAX_FEE && sellFee_ <= MAX_FEE, "Fee exceeds max");
        require(modules_.length > 0 && modules_.length <= MAX_MODULES, "Bad module count");

        _initialized = true;
        _status = _NOT_ENTERED;

        token = token_;
        database = database_;
        creator = creator_;
        _buyFee = buyFee_;
        _sellFee = sellFee_;

        // System contracts that custody tokens for someone else. Reflections
        // accrued here could never be claimed by anyone. The token's FlatCurve
        // is added later by the Generator (it does not exist yet).
        _exclude(IDatabase(database_).vestingVault());
        _exclude(IDatabase(database_).rebateContract());
        _exclude(IDatabase(database_).liquidityVault());

        uint256 buySum;
        uint256 sellSum;
        for (uint256 i = 0; i < modules_.length; i++) {
            ModuleInitData calldata m = modules_[i];
            address impl = IDatabase(database_).moduleMasterCopies(m.moduleType);
            require(impl != address(0), "Module impl unset");

            address cloneAddr = _clone(impl);
            IModule(cloneAddr).__init__(m.initPayload);
            _exclude(cloneAddr);

            modules.push(ModuleConfig({
                moduleAddress: cloneAddr,
                moduleType: m.moduleType,
                buyAllocation: m.buyAllocation,
                sellAllocation: m.sellAllocation,
                active: true
            }));

            buySum += m.buyAllocation;
            sellSum += m.sellAllocation;

            emit ModuleAdded(m.moduleType, cloneAddr, m.buyAllocation, m.sellAllocation);
        }
        require(buySum == BPS, "Buy alloc != 10000");
        require(sellSum == BPS, "Sell alloc != 10000");
    }

    // ─── Tax Receipt (called by Router) ─────────────────────────────

    function receiveBuyTax() external payable override nonReentrant {
        require(msg.value > 0, "Zero tax");
        totalBuyTaxReceived += msg.value;
        _distribute(msg.value, true);
        // Buyer unknown at this level — Router does not pass it through today.
        emit BuyTaxDistributed(token, msg.value, address(0));
    }

    function receiveSellTax() external payable override nonReentrant {
        require(msg.value > 0, "Zero tax");
        totalSellTaxReceived += msg.value;
        _distribute(msg.value, false);
        emit SellTaxDistributed(token, msg.value, address(0));
    }

    /// @dev Distributes `amount` BNB across modules according to each module's
    ///      buy or sell allocation (bps).
    ///
    ///      Integer-division dust is swept to the LAST module with a NON-ZERO
    ///      allocation on this side — not simply the last module in the array.
    ///      A zero-allocation module (the natural configuration for a
    ///      default RewardModule funded only by donations) must never silently
    ///      collect dust it was not allocated.
    ///
    ///      Shares are computed into memory first so each module's allocation is
    ///      read from storage exactly once, and so the sweep target is known
    ///      before any external call is made.
    function _distribute(uint256 amount, bool isBuy) internal {
        uint256 len = modules.length;
        if (len == 0) return;

        uint256[] memory payouts = new uint256[](len);
        uint256 distributed;
        uint256 sweepIdx = type(uint256).max;

        for (uint256 i = 0; i < len; i++) {
            ModuleConfig storage m = modules[i];
            uint256 alloc = isBuy ? m.buyAllocation : m.sellAllocation;
            if (alloc == 0) continue;

            uint256 share = (amount * alloc) / BPS;
            payouts[i] = share;
            distributed += share;
            sweepIdx = i;
        }

        // The sum == 10000 invariant guarantees at least one non-zero allocation.
        if (sweepIdx == type(uint256).max) return;
        payouts[sweepIdx] += amount - distributed;

        for (uint256 i = 0; i < len; i++) {
            if (payouts[i] > 0) {
                IModule(modules[i].moduleAddress).receiveTax{value: payouts[i]}();
            }
        }
    }

    // ─── Share Management (called by Token) ─────────────────────────

    function setShare(address holder, uint256 amount) external override {
        require(msg.sender == token, "Only token");

        // System contracts that custody tokens on someone else's behalf are
        // excluded: reflections accrued to them could never be claimed. See
        // the `_excludedFromShares` declaration for the full list and rationale.
        if (_excludedFromShares[holder]) return;

        uint256 old = _shares[holder];
        if (old == amount) return;

        _totalShares = _totalShares - old + amount;
        _shares[holder] = amount;

        _propagateShare(holder, amount);

        emit ShareUpdated(holder, old, amount);
    }

    // ─── Share Exclusions ───────────────────────────────────────────

    /// @inheritdoc ITaxHandler
    function isExcludedFromShares(address holder) public view override returns (bool) {
        if (holder == address(0)) return true;
        if (_excludedFromShares[holder]) return true;
        // The pool is excluded on the token side (LumoriaToken never calls
        // setShare for `pair`), so it has no mapping entry. Report it here for
        // off-chain consumers and RewardModule.sync().
        return holder == ILumoriaToken(token).pair();
    }

    /// @inheritdoc ITaxHandler
    function excludeFromShares(address account) external override {
        require(msg.sender == IDatabase(database).generator(), "Only generator");
        require(account != address(0), "Zero account");
        _exclude(account);
    }

    /// @dev Zeroes any share the account already accrued, so an address excluded
    ///      after it has held tokens stops diluting everyone else immediately.
    function _exclude(address account) internal {
        if (account == address(0) || _excludedFromShares[account]) return;
        _excludedFromShares[account] = true;

        uint256 old = _shares[account];
        if (old != 0) {
            _totalShares -= old;
            _shares[account] = 0;
            _propagateShare(account, 0);
            emit ShareUpdated(account, old, 0);
        }

        emit ExcludedFromShares(account);
    }

    /// @dev Pushes a share update to every reward module.
    function _propagateShare(address holder, uint256 amount) internal {
        uint256 len = modules.length;
        for (uint256 i = 0; i < len; i++) {
            ModuleConfig storage m = modules[i];
            if (m.moduleType == MODULE_REWARD) {
                IRewardModule(m.moduleAddress).setShare(holder, amount);
            }
        }
    }

    // ─── Fee Change Timelock ────────────────────────────────────────

    function proposeFeeChange(uint256 newBuyFee, uint256 newSellFee) external override onlyCreator {
        require(!managementRenounced, "Renounced");
        require(newBuyFee <= MAX_FEE && newSellFee <= MAX_FEE, "Fee exceeds max");

        // Instant-apply path: both fees are decreasing (or equal) — always good for holders.
        if (newBuyFee <= _buyFee && newSellFee <= _sellFee) {
            uint256 oldBuy = _buyFee;
            uint256 oldSell = _sellFee;
            _buyFee = newBuyFee;
            _sellFee = newSellFee;
            emit FeesUpdated(oldBuy, newBuyFee, oldSell, newSellFee);
            return;
        }

        pendingFeeChange = PendingFeeChange({
            newBuyFee: newBuyFee,
            newSellFee: newSellFee,
            effectiveTime: block.timestamp + CHANGE_DELAY,
            pending: true
        });
        emit FeeChangeProposed(newBuyFee, newSellFee, block.timestamp + CHANGE_DELAY);
    }

    function executeFeeChange() external override onlyCreator {
        require(!managementRenounced, "Renounced");
        PendingFeeChange memory p = pendingFeeChange;
        require(p.pending, "No pending change");
        require(block.timestamp >= p.effectiveTime, "Timelock active");

        uint256 oldBuy = _buyFee;
        uint256 oldSell = _sellFee;
        _buyFee = p.newBuyFee;
        _sellFee = p.newSellFee;
        pendingFeeChange.pending = false;

        emit FeesUpdated(oldBuy, _buyFee, oldSell, _sellFee);
    }

    function cancelFeeChange() external override onlyCreator {
        require(pendingFeeChange.pending, "No pending change");
        pendingFeeChange.pending = false;
        emit FeeChangeCancelled();
    }

    // ─── Module Change Timelock ─────────────────────────────────────

    function proposeModuleAdd(
        uint8 moduleType,
        uint256 buyAlloc,
        uint256 sellAlloc,
        bytes calldata initPayload,
        AllocationUpdate[] calldata rebalance
    ) external override onlyCreator {
        require(!managementRenounced, "Renounced");
        require(!pendingModuleChange.pending, "Pending exists");
        require(modules.length < MAX_MODULES, "Max modules");

        _validateRebalance(rebalance, type(uint256).max);

        // Simulate final allocations: existing modules (with rebalance overrides) + new module.
        (uint256 buySum, uint256 sellSum) = _simulateSum(
            true, buyAlloc, sellAlloc,
            false, 0,
            rebalance
        );
        require(buySum == BPS, "Buy alloc != 10000");
        require(sellSum == BPS, "Sell alloc != 10000");

        pendingModuleChange = PendingModuleChange({
            changeType: CHANGE_ADD,
            moduleType: moduleType,
            moduleIndex: 0,
            buyAllocation: buyAlloc,
            sellAllocation: sellAlloc,
            initPayload: initPayload,
            effectiveTime: block.timestamp + CHANGE_DELAY,
            pending: true
        });
        _storePendingRebalance(rebalance);

        emit ModuleChangeProposed(CHANGE_ADD, moduleType, buyAlloc, sellAlloc, block.timestamp + CHANGE_DELAY);
        _emitRebalanceProposed(rebalance);
    }

    function proposeModuleRemove(
        uint256 moduleIndex,
        AllocationUpdate[] calldata rebalance
    ) external override onlyCreator {
        require(!managementRenounced, "Renounced");
        require(!pendingModuleChange.pending, "Pending exists");
        require(moduleIndex < modules.length, "Bad index");
        require(modules.length > 1, "Cannot remove last");

        _validateRebalance(rebalance, moduleIndex);

        // Simulate final allocations: existing modules minus the removed one,
        // applying rebalance overrides.
        (uint256 buySum, uint256 sellSum) = _simulateSum(
            false, 0, 0,
            true, moduleIndex,
            rebalance
        );
        require(buySum == BPS, "Buy alloc != 10000");
        require(sellSum == BPS, "Sell alloc != 10000");

        pendingModuleChange = PendingModuleChange({
            changeType: CHANGE_REMOVE,
            moduleType: modules[moduleIndex].moduleType,
            moduleIndex: moduleIndex,
            buyAllocation: 0,
            sellAllocation: 0,
            initPayload: "",
            effectiveTime: block.timestamp + CHANGE_DELAY,
            pending: true
        });
        _storePendingRebalance(rebalance);

        emit ModuleChangeProposed(CHANGE_REMOVE, modules[moduleIndex].moduleType, 0, 0, block.timestamp + CHANGE_DELAY);
        _emitRebalanceProposed(rebalance);
    }

    function proposeModuleUpdate(AllocationUpdate[] calldata updates) external override onlyCreator {
        require(!managementRenounced, "Renounced");
        require(!pendingModuleChange.pending, "Pending exists");
        require(updates.length > 0, "Empty updates");

        _validateRebalance(updates, type(uint256).max);

        (uint256 buySum, uint256 sellSum) = _simulateSum(
            false, 0, 0,
            false, 0,
            updates
        );
        require(buySum == BPS, "Buy alloc != 10000");
        require(sellSum == BPS, "Sell alloc != 10000");

        pendingModuleChange = PendingModuleChange({
            changeType: CHANGE_UPDATE,
            moduleType: 0,
            moduleIndex: 0,
            buyAllocation: 0,
            sellAllocation: 0,
            initPayload: "",
            effectiveTime: block.timestamp + CHANGE_DELAY,
            pending: true
        });
        _storePendingRebalance(updates);

        emit ModuleChangeProposed(CHANGE_UPDATE, 0, 0, 0, block.timestamp + CHANGE_DELAY);
        _emitRebalanceProposed(updates);
    }

    function executeModuleChange() external override onlyCreator nonReentrant {
        require(!managementRenounced, "Renounced");
        PendingModuleChange memory p = pendingModuleChange;
        require(p.pending, "No pending change");
        require(block.timestamp >= p.effectiveTime, "Timelock active");

        pendingModuleChange.pending = false;

        if (p.changeType == CHANGE_ADD) {
            _executeAdd(p);
        } else if (p.changeType == CHANGE_REMOVE) {
            _executeRemove(p);
        } else if (p.changeType == CHANGE_UPDATE) {
            _executeUpdate();
        } else {
            revert("Bad change type");
        }

        delete _pendingRebalance;
        _requireAllocationsSum();
    }

    function cancelModuleChange() external override onlyCreator {
        require(pendingModuleChange.pending, "No pending change");
        pendingModuleChange.pending = false;
        delete _pendingRebalance;
        emit ModuleChangeCancelled();
    }

    // ─── Renounce (one-way; freezes the configuration forever) ──────

    /// @notice Permanently relinquish all management of this token's taxes and
    ///         modules. After this the fee rates and module set can never
    ///         change again — not even a holder-friendly fee decrease — making
    ///         "the tokenomics are frozen" a verifiable on-chain guarantee.
    ///         Any in-flight pending change is cancelled.
    function renounceManagement() external override onlyCreator {
        require(!managementRenounced, "Already renounced");
        managementRenounced = true;

        // Kill anything in flight so renounce is an instant, total freeze.
        if (pendingFeeChange.pending) {
            pendingFeeChange.pending = false;
        }
        if (pendingModuleChange.pending) {
            pendingModuleChange.pending = false;
            delete _pendingRebalance;
        }

        emit ManagementRenounced(token, block.timestamp);
    }

    // ─── Execute Helpers ────────────────────────────────────────────

    function _executeAdd(PendingModuleChange memory p) internal {
        require(modules.length < MAX_MODULES, "Max modules");

        address impl = IDatabase(database).moduleMasterCopies(p.moduleType);
        require(impl != address(0), "Module impl unset");

        address cloneAddr = _clone(impl);
        IModule(cloneAddr).__init__(p.initPayload);
        _exclude(cloneAddr);

        modules.push(ModuleConfig({
            moduleAddress: cloneAddr,
            moduleType: p.moduleType,
            buyAllocation: p.buyAllocation,
            sellAllocation: p.sellAllocation,
            active: true
        }));
        emit ModuleAdded(p.moduleType, cloneAddr, p.buyAllocation, p.sellAllocation);

        // Apply rebalance to existing (pre-add) modules. The new module was
        // just pushed to the END, so pre-add indices are still valid.
        _applyRebalance();
    }

    function _executeRemove(PendingModuleChange memory p) internal {
        uint256 targetIdx = p.moduleIndex;
        require(targetIdx < modules.length, "Bad index");
        address targetAddr = modules[targetIdx].moduleAddress;
        uint8 targetType = modules[targetIdx].moduleType;

        // Apply rebalance BEFORE removal so indices refer to pre-removal layout.
        // (Rebalance was validated at propose time to never target the removed index.)
        _applyRebalance();

        // Swap-and-pop removal
        uint256 lastIdx = modules.length - 1;
        if (targetIdx != lastIdx) {
            modules[targetIdx] = modules[lastIdx];
        }
        modules.pop();

        emit ModuleRemoved(targetType, targetAddr);
    }

    function _executeUpdate() internal {
        _applyRebalance();
    }

    function _applyRebalance() internal {
        uint256 len = _pendingRebalance.length;
        for (uint256 i = 0; i < len; i++) {
            AllocationUpdate storage u = _pendingRebalance[i];
            modules[u.moduleIndex].buyAllocation = u.buyAllocation;
            modules[u.moduleIndex].sellAllocation = u.sellAllocation;
            emit ModuleUpdated(
                modules[u.moduleIndex].moduleType,
                modules[u.moduleIndex].moduleAddress,
                u.buyAllocation,
                u.sellAllocation
            );
        }
    }

    // ─── Propose Helpers ────────────────────────────────────────────

    /// @dev Validates a rebalance array: indices in bounds, no duplicates,
    ///      and (for remove) no entry targets the module being removed.
    ///      Pass `forbiddenIdx = type(uint256).max` if nothing is forbidden.
    function _validateRebalance(AllocationUpdate[] calldata rebalance, uint256 forbiddenIdx) internal view {
        uint256 len = rebalance.length;
        for (uint256 i = 0; i < len; i++) {
            require(rebalance[i].moduleIndex < modules.length, "Bad rebalance index");
            require(rebalance[i].moduleIndex != forbiddenIdx, "Cannot rebalance removed");
            for (uint256 j = i + 1; j < len; j++) {
                require(rebalance[i].moduleIndex != rebalance[j].moduleIndex, "Duplicate rebalance");
            }
        }
    }

    /// @dev Computes what the buy/sell allocation sums would be if the
    ///      proposed change were applied.
    function _simulateSum(
        bool hasAdded, uint256 addedBuy, uint256 addedSell,
        bool hasRemoved, uint256 removedIdx,
        AllocationUpdate[] calldata rebalance
    ) internal view returns (uint256 buySum, uint256 sellSum) {
        if (hasAdded) {
            buySum = addedBuy;
            sellSum = addedSell;
        }
        uint256 len = modules.length;
        for (uint256 i = 0; i < len; i++) {
            if (hasRemoved && i == removedIdx) continue;
            uint256 b = modules[i].buyAllocation;
            uint256 s = modules[i].sellAllocation;
            uint256 rlen = rebalance.length;
            for (uint256 j = 0; j < rlen; j++) {
                if (rebalance[j].moduleIndex == i) {
                    b = rebalance[j].buyAllocation;
                    s = rebalance[j].sellAllocation;
                    break;
                }
            }
            buySum += b;
            sellSum += s;
        }
    }

    function _storePendingRebalance(AllocationUpdate[] calldata rebalance) internal {
        delete _pendingRebalance;
        uint256 len = rebalance.length;
        for (uint256 i = 0; i < len; i++) {
            _pendingRebalance.push(rebalance[i]);
        }
    }

    function _emitRebalanceProposed(AllocationUpdate[] calldata rebalance) internal {
        uint256 len = rebalance.length;
        uint256[] memory indices = new uint256[](len);
        uint256[] memory buyAllocs = new uint256[](len);
        uint256[] memory sellAllocs = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            indices[i] = rebalance[i].moduleIndex;
            buyAllocs[i] = rebalance[i].buyAllocation;
            sellAllocs[i] = rebalance[i].sellAllocation;
        }
        emit ModuleRebalanceProposed(indices, buyAllocs, sellAllocs);
    }

    /// @dev Enforces that active buy and sell allocations both sum to exactly 10000 bps.
    ///      Called after every executed module change so trading is always in a clean state.
    function _requireAllocationsSum() internal view {
        uint256 buySum;
        uint256 sellSum;
        uint256 len = modules.length;
        for (uint256 i = 0; i < len; i++) {
            buySum += modules[i].buyAllocation;
            sellSum += modules[i].sellAllocation;
        }
        require(buySum == BPS, "Buy alloc != 10000");
        require(sellSum == BPS, "Sell alloc != 10000");
    }

    // ─── Views ──────────────────────────────────────────────────────

    function buyFee() external view override returns (uint256) { return _buyFee; }
    function sellFee() external view override returns (uint256) { return _sellFee; }
    function shares(address holder) external view override returns (uint256) { return _shares[holder]; }
    function totalShares() external view override returns (uint256) { return _totalShares; }
    function getModuleCount() external view override returns (uint256) { return modules.length; }

    function getModule(uint256 index) external view returns (ModuleConfig memory) {
        require(index < modules.length, "Bad index");
        return modules[index];
    }

    function pendingRebalanceLength() external view returns (uint256) {
        return _pendingRebalance.length;
    }

    function pendingRebalance(uint256 index) external view returns (AllocationUpdate memory) {
        require(index < _pendingRebalance.length, "Bad index");
        return _pendingRebalance[index];
    }

    // ─── ERC-1167 Minimal Proxy Clone ───────────────────────────────

    function _clone(address implementation) internal returns (address instance) {
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "ERC1167: create failed");
    }
}
