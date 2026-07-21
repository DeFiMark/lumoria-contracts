# Lumoria: Comprehensive System Design

## Overview

Lumoria is a **curated token launchpad** with **modular tokenomics**, whose liquidity and trading live in **Uniswap V4 pools** governed by a custom **LumoriaHook**. Token creators launch tax-on-transfer tokens through our system, configure how their taxes are used via pluggable modules, and trade on a native-BNB/token V4 pool. The key innovation is that **taxes are collected as BNB at the pool level** (by the hook, on every swap, regardless of which router initiated it), not as tokens that need to be sold later — eliminating sell pressure from tax processing and making the tax unbypasseable.

> **History:** Phases 1–4 built this around a custom V2-style DEX (Factory/Pair/Router, now in `legacy/`). Phase 5 replaced that DEX with the canonical Uniswap V4 `PoolManager` (BSC: `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`) + LumoriaHook. Everything outside the DEX layer (Database, TaxHandler, modules, RebateContract, FeeReceiver, Generator, FlatCurve, LumoriaToken) survived the migration nearly untouched.

**Revenue model**: Lumoria does not have its own token (yet). Platform revenue comes from a flat **1% BNB fee** on all trading activity and contributions to raises. A single `FeeReceiver` contract collects and processes all platform fees.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                        DATABASE                             │
│  Central registry: master copies, tokens, config, modules,  │
│  poolManager / hook / liquidityVault / router references    │
└────────────┬────────────────────────────────────────────────┘
             │
     ┌───────┴───────┐
     │   GENERATOR   │  Clone factory (ERC-1167 proxies)
     │               │  Creates: Token + TaxHandler
     │               │  Launch modes: BYOL / Flat Curve
     └───────┬───────┘
             │ creates
     ┌───────┴───────────────────────────────────────┐
     │                                               │
┌────┴─────┐                                  ┌──────┴──────┐
│  TOKEN   │  ERC20 + holder tracking         │ TAX HANDLER │
│          │  (clean — no tax logic)          │             │
└────┬─────┘                                  │ Routes BNB  │
     │ trades on                              │ to modules  │
┌────┴──────────────────────────┐             └──────┬──────┘
│   UNISWAP V4 POOLMANAGER      │                    │ distributes to
│   (canonical singleton)       │             ┌──────┴──────────┐
│  ┌─────────────────────────┐  │             │    MODULES      │
│  │      LUMORIA HOOK       │  │             │  ┌────────────┐ │
│  │ runs on EVERY swap:     │  │             │  │  Rewards   │ │
│  │ 1% platform fee +       │──┼─BNB taxes──>│  │  Burn      │ │
│  │ token tax taken as      │  │             │  │  Liquidity │ │
│  │ native BNB, in-pool     │  │             │  │  Creator   │ │
│  └─────────────────────────┘  │             │  └────────────┘ │
│  pools: native-BNB / token,   │             └─────────────────┘
│  LP fee 0, full-range only    │
└────┬──────────────┬───────────┘             ┌─────────────┐
     │              │ all liquidity owned by  │   REBATE    │
     │ platform     ▼                         │  CONTRACT   │
     │ fees   ┌───────────────────┐           │ (hook-fed)  │
     │        │  LIQUIDITY VAULT  │           └─────────────┘
     │        │  full-range, NO   │
     │        │  removal path —   │    ┌──────────────────────┐
     │        │  locked forever   │    │  LUMORIA SWAP ROUTER │
     │        └───────────────────┘    │  thin V4 router:     │
     ▼                                 │  hookData user attrib│
┌───────────────────┐                  │  (rebates + volume)  │
│   FEE RECEIVER    │                  └──────────────────────┘
│  Platform fee     │
│  processing       │           ┌──────────────────┐
└───────────────────┘           │   FLAT CURVE     │
         ▲                      │  Presale/raise   │
         └─ contribution fees ──│  with refunds    │
                                └──────────────────┘
```

---

## 1. CONTRACT INVENTORY

### Core Infrastructure
| Contract | Purpose | Status |
|----------|---------|--------|
| `Database.sol` | Central registry for all system config, master copies, launched tokens, module registry | **DONE** |
| `Generator.sol` | Clone factory — creates Token + TaxHandler + launch mode (BYOL or FlatCurve); carves optional creator allocations (immediate or vested) from the remainder | **DONE** |
| `LumoriaToken.sol` | ERC20 master copy — clean transfer with holder tracking, no tax logic | **DONE** |
| `FeeReceiver.sol` | Single contract collecting all platform 1% fees (trading + raise contributions) | **DONE** |

### DEX layer (Uniswap V4)
| Contract | Purpose | Status |
|----------|---------|--------|
| Uniswap V4 `PoolManager` | Canonical singleton holding all pools/reserves (NOT ours — BSC: `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`; deployed locally for tests) | **CANONICAL** |
| `v4/LumoriaHook.sol` | One hook, all pools: collects 1% platform fee + token tax in native BNB on every swap (any router), credits rebates, registers volume, gates pool creation/liquidity/donations | **DONE** |
| `v4/LumoriaLiquidityVault.sol` | Sole owner of all pool liquidity (full-range). No removal code path — permanently locked | **DONE** |
| `v4/LumoriaSwapRouter.sol` | Thin V4 unlock-callback router; keeps the legacy `ILumoriaRouter` interface so Generator/FlatCurve/modules are unchanged; passes `hookData` user attribution | **DONE** |
| ~~`Factory.sol` / `Pair.sol` / `Router.sol`~~ | Legacy custom V2 DEX — superseded by the above in Phase 5, moved to `legacy/` | **RETIRED** |

### Tax System
| Contract | Purpose | Status |
|----------|---------|--------|
| `TaxHandler.sol` | Per-token tax router — receives BNB from Router, distributes to modules based on config | **DONE** |
| `RewardModule.sol` | Distributes rewards in a different asset (e.g., USDC) to holders proportional to holdings | **DONE** |
| `BurnModule.sol` | Buys back tokens with collected BNB and burns them, on a configurable interval | **DONE** |
| `LiquidityModule.sol` | Auto-liquidity: sells half of tokens, pairs with received BNB, adds to LP | **DONE** |
| `CreatorFeeModule.sol` | Sends collected BNB directly to the token creator | **DONE** |
| `MilestoneRewardModule.sol` | Accrues tax; creator releases any amount to ALL holders via the RewardModule, milestone recorded as free text. 18-month public-release valve. (TOKENOMICS_V2 §2B) | **DONE** |
| `PrizePool.sol` | Buyers earn tickets per epoch; merkle-settled pro-rata / lottery / all-holders payouts (TOKENOMICS_V2 §2, impl notes §2.12) | **DONE** |
| `RebateContract.sol` | Holds token supply funded by creator, credits rebates to buyers on DEX purchases | **DONE** |

### Launch Modes
| Contract | Purpose | Status |
|----------|---------|--------|
| `FlatCurve.sol` | Presale-style raise: users contribute BNB within min/max, refundable (minus 1% platform fee), auto-pairs on fill | **DONE** |
| `VestingVault.sol` | Shared singleton custodying vested creator allocations — linear+cliff, **non-revocable** (no removal path), `createSchedule` gated to the Generator, permissionless `release` | **DONE** |

### Platform Services
| Contract | Purpose | Status |
|----------|---------|--------|
| `TrustedOperatorRandomness.sol` | Platform-wide commit–reveal randomness (consumer-scoped keys, blockhash mixing) behind `IRandomnessProvider`; registered at `Database.randomnessProvider`; swappable for Chainlink VRF with zero module changes (TOKENOMICS_V2 §3) | **DONE** |

### Libraries & Interfaces
| Contract | Purpose | Status |
|----------|---------|--------|
| `Ownable.sol` | Ownership | **EXISTS** |
| `ReentrancyGuard.sol` | Reentrancy protection | **EXISTS** |
| `TransferHelper.sol` | Safe ERC20 transfers | **EXISTS** |
| `EnumerableSet.sol` | Set data structures (retained for future use; not currently imported) | **EXISTS** |
| All interfaces (`I*.sol`) | Interface definitions | **DONE** (IERC20, IDatabase, ILumoriaToken, ITaxHandler, IModule, IFeeReceiver, IRebate, IFlatCurve, IGenerator, ILumoriaRouter, ILumoriaLiquidityVault, IVestingVault, IRandomnessProvider) |

---

## 2. THE TAX MODEL (Pool-Level BNB Collection via Hook)

This is the core innovation. Every token launched on Lumoria trades on a native-BNB/token Uniswap V4 pool whose hook is the `LumoriaHook` — so we collect taxes as native BNB *inside the swap itself*, on every swap, instead of accumulating tokens and selling them later.

### Fee Stack (applied on every swap, by the hook)
1. **Platform fee**: Flat 1% of BNB — always taken, sent to `FeeReceiver`
2. **Token tax**: Creator-configured (0–98%) — taken from remaining BNB, sent to `TaxHandler`
3. **Pool LP fee**: **0** — the locked full-range liquidity earns nothing and strands nothing; all economics are hook fees

Only **exactInput** swaps are supported; exactOutput swaps revert in the hook (matches the legacy Router, which was exactIn-only).

### Buy Flow (User spends BNB → receives Tokens; exactIn, `zeroForOne`)

```
User sends 1 BNB to buy Token X (Token X has 20% buy fee)

1. Any router calls PoolManager.swap; PoolManager invokes LumoriaHook.beforeSwap
2. Hook takes 1% platform fee: 0.01 BNB → FeeReceiver       (poolManager.take)
3. Hook queries Token X's buy fee from TaxHandler: 20%
4. Hook takes 0.198 BNB (20% of 0.99) → TaxHandler.receiveBuyTax
   (TaxHandler distributes to modules in the same transaction)
5. Hook returns a BeforeSwapDelta — only the remaining 0.792 BNB swaps
6. PoolManager executes the swap; user receives Token X amount
7. afterSwap: hook decodes hookData (buyer address, supplied by the
   LumoriaSwapRouter), calls RebateContract.creditRebate(token, buyer,
   tokensReceived) and Database.registerVolume, emits TokenPurchased
8. If rebate active: buyer receives bonus tokens from rebate pool
```

### Sell Flow (User sends Tokens → receives BNB; exactIn, `!zeroForOne`)

```
User sells Token X for BNB (Token X has 15% sell fee)

1. Any router calls PoolManager.swap with the token input
2. Pool swap produces 1 BNB gross; PoolManager invokes LumoriaHook.afterSwap
3. Hook takes 1% platform fee: 0.01 BNB → FeeReceiver
4. Hook queries Token X's sell fee: 15%
5. Hook takes 0.1485 BNB (15% of 0.99) → TaxHandler.receiveSellTax
6. Hook returns the fee as its afterSwap delta — user receives 0.8415 BNB
7. Hook registers volume + emits TokenSold
```

### Why This Is Better
- **No sell pressure from taxes**: Taxes never touch the token supply
- **Immediate distribution**: BNB is sent to TaxHandler immediately, no accumulation
- **Simpler token contract**: Token doesn't need swapBack logic
- **Predictable**: Users know exactly what they'll pay
- **Unbypasseable**: the hook runs inside the PoolManager on *every* swap — our UI, Universal Router, 1inch, MEV bots, anyone. (The legacy `Pair.swap()` was permissionless, so router-level taxes were bypassable by trading against the pair directly. Pool-level taxes close that hole, and third-party routing becomes free distribution instead of a leak.)
- **Native BNB**: pools are native-currency pools — no WBNB wrapping anywhere in the hot path

### Key Implication for Token Contract
The `LumoriaToken` does NOT need:
- `swapBack()` logic
- `swapThreshold`
- `inSwap` flag
- Router address storage
- Fee accumulation in contract balance

The token is a **clean ERC20 with holder tracking** — all tax logic lives in the LumoriaHook + TaxHandler.

---

## 3. DATABASE CONTRACT

Central registry and configuration hub.

### Storage
```
// System Config
address public generator;
address public router;          // LumoriaSwapRouter (V4)
address public poolManager;     // canonical Uniswap V4 PoolManager
address public hook;            // LumoriaHook (one instance, all pools)
address public liquidityVault;  // LumoriaLiquidityVault (sole LP owner)
address public vestingVault;    // VestingVault (shared; custodies vested allocations)
address public wbnb;            // legacy path marker only — pools are native-BNB
address public feeReceiver;
address public rebateContract;

// Master Copies (for cloning)
address public tokenMasterCopy;
address public taxHandlerMasterCopy;
address public flatCurveMasterCopy;

// Module Registry (type => master copy)
mapping(uint8 => address) public moduleMasterCopies;
// MODULE_REWARD = 0, MODULE_BURN = 1, MODULE_LIQUIDITY = 2, MODULE_CREATOR = 3

// Launched Tokens
mapping(address => bool) public isLumoriaToken;
mapping(address => address) public tokenTaxHandler;  // token => its TaxHandler
mapping(address => address) public tokenCreator;      // token => creator
address[] public allTokens;

// Platform Fee Config
uint256 public platformFeeBps;  // 100 = 1% (MAX_PLATFORM_FEE = 500)
address public platformFeeRecipient;  // = feeReceiver

// Flat anti-spam launch fee, charged by the Generator on EVERY launch
// (both modes), on top of what the mode consumes. Absolute wei, not bps.
// Owner-tunable via setLaunchFee (MAX_LAUNCH_FEE = 1 BNB sanity cap).
uint256 public launchFeeBnb;    // 0.005 ether at deploy

// Volume Tracking
mapping(address => mapping(address => uint256)) public userVolume;  // token => user => volume
mapping(address => uint256) public tokenVolume;  // token => total volume
```

### Events
```
event TokenRegistered(address indexed token, address indexed creator, address taxHandler);
event MasterCopyUpdated(string indexed copyType, address indexed newCopy);
event ModuleMasterCopySet(uint8 indexed moduleType, address indexed masterCopy);
event PlatformFeeUpdated(uint256 oldFee, uint256 newFee);
event LaunchFeeUpdated(uint256 oldFee, uint256 newFee);
event VolumeRegistered(address indexed token, address indexed user, uint256 amount);
event GeneratorUpdated(address indexed oldGenerator, address indexed newGenerator);
event RouterUpdated(address indexed oldRouter, address indexed newRouter);
```

### Key Functions
- `registerToken(token, creator, taxHandler)` — called by Generator after launch
- `setModuleMasterCopy(uint8 moduleType, address masterCopy)` — admin: register new module types
- `registerVolume(token, user, amount)` — called by Router on each trade
- `isLumoriaToken(address)` — used by Factory/Router to enforce curated-only trading
- Getters for all master copies and config

---

## 4. TOKEN CONTRACT (LumoriaToken)

Clean ERC20 with holder tracking. **No tax logic** — that's in the hook.

### Storage
```
string public name;
string public symbol;
uint8 public decimals = 18;
uint256 public totalSupply = 1_000_000_000 * 10**18;

mapping(address => uint256) public balanceOf;
mapping(address => mapping(address => uint256)) public allowance;

address public pair;            // V4 PoolManager — reserve-custody venue, excluded from share tracking
address public taxHandler;      // this token's TaxHandler
address public creator;         // token creator
bool public initialized;
```

### Holder Tracking
On every transfer, the token calls `TaxHandler.setShare(address, balance)` to keep the holder registry in sync. This is critical for the reward module to know how to distribute.

```solidity
function _transferFrom(address sender, address recipient, uint256 amount) internal {
    balanceOf[sender] -= amount;
    balanceOf[recipient] += amount;
    
    ITaxHandler(taxHandler).setShare(sender, balanceOf[sender]);
    ITaxHandler(taxHandler).setShare(recipient, balanceOf[recipient]);
    
    emit Transfer(sender, recipient, amount);
}
```

### Events
```
event Transfer(address indexed from, address indexed to, uint256 value);
event Approval(address indexed owner, address indexed spender, uint256 value);
```

### Key Decisions
- **No fee logic in token** — the LumoriaHook handles all taxation at the pool level
- **No special transfer restrictions** — any address can transfer freely (curated enforcement is at the pool/hook level)
- **Holder tracking via TaxHandler** — TaxHandler aggregates share data and passes to modules that need it
- **Burn function** — allows burning tokens, updates shares

---

## 5. TAX HANDLER CONTRACT

One TaxHandler per launched token. Receives BNB from the Router. Distributes to configured modules.

### Storage
```
address public token;
address public database;
address public creator;
bool public initialized;

// Fee Configuration (basis points, max 9800 = 98%)
uint256 public buyFee;
uint256 public sellFee;
uint256 public constant MAX_FEE = 9800;  // 98%

// Timelock for ALL creator changes (fee changes + module changes)
uint256 public constant CHANGE_DELAY = 24 hours;

// Pending fee change
struct PendingFeeChange {
    uint256 newBuyFee;
    uint256 newSellFee;
    uint256 effectiveTime;    // block.timestamp + CHANGE_DELAY
    bool pending;
}
PendingFeeChange public pendingFeeChange;

// Pending module changes (add/remove/update)
struct PendingModuleChange {
    uint8 changeType;         // 0 = add, 1 = remove, 2 = update allocations
    uint8 moduleType;
    uint256 moduleIndex;      // for remove/update
    uint256 buyAllocation;
    uint256 sellAllocation;
    bytes initPayload;        // for add
    uint256 effectiveTime;
    bool pending;
}
PendingModuleChange public pendingModuleChange;

// Module Configuration
struct ModuleConfig {
    address moduleAddress;    // deployed module contract
    uint8 moduleType;         // enum: REWARD, BURN, LIQUIDITY, CREATOR
    uint256 buyAllocation;    // % of buy fee BNB going to this module (basis points of the fee)
    uint256 sellAllocation;   // % of sell fee BNB going to this module
    bool active;
}
ModuleConfig[] public modules;

// Holder Tracking (aggregated, forwarded to modules that need it)
mapping(address => uint256) public shares;
uint256 public totalShares;
```

### Tax Distribution Logic
```solidity
function receiveBuyTax() external payable {
    uint256 taxBNB = msg.value;
    for (uint i = 0; i < modules.length; i++) {
        if (!modules[i].active) continue;
        uint256 moduleShare = (taxBNB * modules[i].buyAllocation) / 10000;
        if (moduleShare > 0) {
            IModule(modules[i].moduleAddress).receiveTax{value: moduleShare}();
        }
    }
    emit BuyTaxDistributed(token, taxBNB, msg.sender);
}

function receiveSellTax() external payable {
    // Same pattern with sellAllocation
}
```

### Timelock System
**All creator changes that affect token economics are timelocked (24 hours).** This includes:
- Fee increases (fee decreases are instant)
- Adding new modules
- Removing modules
- Changing module allocations

This protects holders from sudden, adverse changes by the creator.

#### Fee Changes
```solidity
function proposeFeeChange(uint256 newBuyFee, uint256 newSellFee) external {
    require(msg.sender == creator, "only creator");
    require(newBuyFee <= MAX_FEE && newSellFee <= MAX_FEE, "exceeds max");
    
    // If both fees are decreasing, apply immediately (always good for holders)
    if (newBuyFee <= buyFee && newSellFee <= sellFee) {
        uint256 oldBuy = buyFee;
        uint256 oldSell = sellFee;
        buyFee = newBuyFee;
        sellFee = newSellFee;
        emit FeesUpdated(oldBuy, newBuyFee, oldSell, newSellFee);
        return;
    }
    
    // Otherwise, timelock
    pendingFeeChange = PendingFeeChange({
        newBuyFee: newBuyFee,
        newSellFee: newSellFee,
        effectiveTime: block.timestamp + CHANGE_DELAY,
        pending: true
    });
    emit FeeChangeProposed(newBuyFee, newSellFee, block.timestamp + CHANGE_DELAY);
}

function executeFeeChange() external {
    require(pendingFeeChange.pending, "no pending change");
    require(block.timestamp >= pendingFeeChange.effectiveTime, "timelock active");
    
    uint256 oldBuy = buyFee;
    uint256 oldSell = sellFee;
    buyFee = pendingFeeChange.newBuyFee;
    sellFee = pendingFeeChange.newSellFee;
    pendingFeeChange.pending = false;
    
    emit FeesUpdated(oldBuy, buyFee, oldSell, sellFee);
}

function cancelFeeChange() external {
    require(msg.sender == creator, "only creator");
    pendingFeeChange.pending = false;
    emit FeeChangeCancelled();
}
```

#### Module Changes (Batch Proposals: Add / Remove / Update)

The **sum of buy allocations** across all modules must always equal 10000 bps. Same for sell allocations. This invariant is enforced both at propose time (via simulation) and at execute time (direct validation).

Because changing any single module's allocation breaks this invariant, every module proposal accepts a **rebalance array** — a list of `AllocationUpdate` rewrites to other modules, applied atomically with the primary change. One 24h timelock covers the full atomic transition.

```solidity
struct AllocationUpdate {
    uint256 moduleIndex;
    uint256 buyAllocation;
    uint256 sellAllocation;
}

function proposeModuleAdd(
    uint8 moduleType,
    uint256 buyAlloc,
    uint256 sellAlloc,
    bytes calldata initPayload,
    AllocationUpdate[] calldata rebalance
) external {
    // only creator, no pending change, modules.length < MAX_MODULES
    // validate rebalance indices in bounds, no duplicates
    // simulate final sums (existing modules with rebalance overrides + new module) — require == 10000
    // store PendingModuleChange(changeType=ADD, ...) + _pendingRebalance = rebalance
    // emit ModuleChangeProposed + ModuleRebalanceProposed
}

function proposeModuleRemove(
    uint256 moduleIndex,
    AllocationUpdate[] calldata rebalance
) external {
    // only creator, no pending change, modules.length > 1 (cannot remove last)
    // validate rebalance indices in bounds, no duplicates, none equals moduleIndex
    // simulate final sums (existing modules minus target, with rebalance overrides) — require == 10000
    // store PendingModuleChange(changeType=REMOVE, moduleIndex, ...) + _pendingRebalance = rebalance
}

function proposeModuleUpdate(
    AllocationUpdate[] calldata updates
) external {
    // only creator, no pending change, updates.length > 0
    // validate indices in bounds, no duplicates
    // simulate final sums (existing modules with overrides applied) — require == 10000
    // store PendingModuleChange(changeType=UPDATE) + _pendingRebalance = updates
}

function executeModuleChange() external {
    // only creator, pending exists, timelock elapsed, nonReentrant
    // Branch on changeType:
    //   ADD:    clone + init new module, push to modules[], then apply rebalance to existing indices.
    //   REMOVE: apply rebalance (pre-remove indices), then swap-and-pop the target.
    //   UPDATE: apply rebalance entries to each listed module.
    // Re-validate sum == 10000 on the post-state (belt-and-suspenders).
    // clear pending + _pendingRebalance
}

function cancelModuleChange() external {
    // only creator, pending exists
    // clear pending + _pendingRebalance, emit ModuleChangeCancelled
}
```

**Example — rebalance three modules in one proposal:**
```
Before: [Reward=6000/6000, Burn=2000/2000, CreatorFee=2000/2000]  // sum = 10000 each side
Goal:   [Reward=5000/5000, Burn=3000/3000, CreatorFee=2000/2000]

proposeModuleUpdate([
    AllocationUpdate({ moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 }),
    AllocationUpdate({ moduleIndex: 1, buyAllocation: 3000, sellAllocation: 3000 })
]);
// wait 24 hours
executeModuleChange();
```

**Example — add a new module and free up allocation in the same proposal:**
```
Before: [Reward=10000/10000]
Goal:   [Reward=7000/7000, Burn=3000/3000]

proposeModuleAdd(
    moduleType = BURN,
    buyAlloc = 3000,
    sellAlloc = 3000,
    initPayload = abi.encode(...),
    rebalance = [AllocationUpdate({ moduleIndex: 0, buyAllocation: 7000, sellAllocation: 7000 })]
);
// wait 24 hours
executeModuleChange();
```

**Example — remove a module and redistribute its allocation:**
```
Before: [Reward=5000/5000, Burn=3000/3000, CreatorFee=2000/2000]
Goal:   [Reward=6000/6000, Burn=4000/4000]  // CreatorFee removed, bps redistributed

proposeModuleRemove(
    moduleIndex = 2,  // CreatorFee
    rebalance = [
        AllocationUpdate({ moduleIndex: 0, buyAllocation: 6000, sellAllocation: 6000 }),
        AllocationUpdate({ moduleIndex: 1, buyAllocation: 4000, sellAllocation: 4000 })
    ]
);
```

**Rules:**
- Only one pending module change at a time (cancel or execute before proposing another).
- Cannot remove the last module (would leave an empty set with no tax destinations).
- Rebalance entries for REMOVE cannot target the module being removed.
- Rebalance can be empty `[]` if the primary change alone keeps the sum at 10000 (e.g. ADD with zero alloc for a dormant module).
- Remove uses swap-and-pop internally, so module indices are volatile — subgraph should track modules by address, not index.

### Share Management
```solidity
function setShare(address holder, uint256 amount) external {
    require(msg.sender == token, "only token");

    // VestingVault is excluded from share tracking (cached from
    // Database.vestingVault() at init): tokens it custodies are locked for a
    // beneficiary who hasn't claimed yet, so the vault must not accrue
    // reflections it could never forward. Same rationale the token uses to
    // exclude the PoolManager.
    if (_vestingVault != address(0) && holder == _vestingVault) return;

    uint256 oldShare = shares[holder];
    totalShares = totalShares - oldShare + amount;
    shares[holder] = amount;
    
    // Forward to modules that need holder data (e.g., RewardModule)
    for (uint i = 0; i < modules.length; i++) {
        if (modules[i].moduleType == MODULE_REWARD && modules[i].active) {
            IRewardModule(modules[i].moduleAddress).setShare(holder, amount);
        }
    }
    
    emit ShareUpdated(holder, oldShare, amount);
}
```

> **Two excluded addresses, two layers.** The **PoolManager** is excluded inside `LumoriaToken._transferFrom` (it never calls `setShare` for the pair). The **VestingVault** is excluded here in `TaxHandler.setShare` — chosen deliberately so `LumoriaToken` stays byte-for-byte unchanged. Net effect is identical: neither address accrues reward shares.

### Events
```
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
```

### Initialization
Called by Generator during token launch:
```solidity
function __init__(
    address _token,
    address _database,
    address _creator,
    uint256 _buyFee,
    uint256 _sellFee,
    ModuleInitData[] calldata _modules  // array of (moduleType, buyAlloc, sellAlloc, initPayload)
) external
```

For each module in `_modules`, the TaxHandler:
1. Clones the module master copy from Database
2. Initializes the module with its payload
3. Stores the ModuleConfig

### Creator Controls
The token creator can:
- **Decrease fees**: takes effect immediately (always good for holders)
- **Increase fees**: subject to 24-hour timelock (proposeFeeChange → wait → executeFeeChange)
- **Add modules**: 24-hour timelock
- **Remove modules**: 24-hour timelock
- **Update module allocations**: 24-hour timelock
- **Max fee cap**: 98% (MAX_FEE = 9800 bps)
- **Renounce management** (`renounceManagement()`): a **one-way, permanent freeze** of the token's tax + module configuration. After it, no fee or module change can ever be proposed or executed — not even a holder-friendly fee *decrease* — and any in-flight pending change is cancelled. Sets `managementRenounced = true` and emits `ManagementRenounced(token, timestamp)`. This is the "tokenomics are frozen forever" trust signal (distinct from the LP lock, which is already permanent). The six mutators (`proposeFeeChange` / `executeFeeChange` / `proposeModuleAdd|Remove|Update` / `executeModuleChange`) all guard on `!managementRenounced`. **Renounce is also honored by the RebateContract** (§7): once `managementRenounced` is true, the rebate rate/withdraw/re-fund paths are frozen (top-ups stay open). So "renounce" is a complete freeze of every creator-editable control — fees, modules, and rebate.

**All changes that could negatively impact holders require 24h notice.** This gives holders time to exit if they disagree with the direction.

---

## 6. TOKENOMICS MODULES

Each module is a standalone contract implementing `IModule`. Modules receive BNB from the TaxHandler and execute their specific tokenomics strategy.

### 6.1 RewardModule
**Purpose**: Distributes rewards in a specified reward token (e.g., USDC, BUSD) proportional to holdings.

```
Storage:
- rewardToken (IERC20): the token distributed as rewards
- shares mapping: holder => share amount
- totalShares
- dividendsPerShare: accumulator for pro-rata distribution
- unpaidRewards: holder => unclaimed amount
- totalDistributed

Flow:
1. Receives BNB from TaxHandler via receiveTax()
2. Swaps BNB → rewardToken via DEX (can use PancakeSwap or external router)
3. Increases dividendsPerShare proportionally
4. Holders call claimReward() to withdraw their share
5. Shares updated via setShare() called by TaxHandler

Events:
- RewardDeposited(token, amount)
- RewardClaimed(holder, amount)
- ShareUpdated(holder, oldShare, newShare)
```

### 6.2 BurnModule
**Purpose**: Uses collected BNB to buy back tokens from the DEX and burn them.

```
Storage:
- token: the token to buy back and burn
- router: Lumoria router for executing swaps (LumoriaSwapRouter over the V4 pool)
- (no pair stored — buybacks route through the token's V4 pool via the router)
- burnInterval: minimum time between burns (e.g., 1 hour)
- lastBurnTime
- pendingBNB: accumulated BNB waiting for next burn
- totalBurned

Flow:
1. Receives BNB from TaxHandler via receiveTax()
2. Accumulates BNB until burn interval passes
3. `executeBurn(minTokensOut, deadline)` after the interval. minTokensOut MUST be > 0. Execution authority comes from the platform operator registry (`Database.isOperator`): permissionless while `operatorCount == 0`; otherwise operator-first with a 1h public fallback.
4. Buys tokens via Router, sends to dead address (or calls burn)
5. Interval prevents sandwich attacks on large burns

Events:
- BurnExecuted(token, bnbSpent, tokensBurned, timestamp)
- BNBReceived(amount, newPending)
- BurnIntervalUpdated(oldInterval, newInterval)
```

### 6.3 LiquidityModule
**Purpose**: Auto-liquidity injection — pairs BNB with tokens to add liquidity.

```
Storage:
- token: the token
- router: Lumoria router (LumoriaSwapRouter over the V4 pool)
- (no pair stored — liquidity is added to the V4 pool and locked in the LiquidityVault)
- liquidityInterval: minimum time between injections
- lastLiquidityTime
- pendingBNB: accumulated BNB
- totalLiquidityAdded

Flow:
1. Receives BNB from TaxHandler
2. Accumulates until interval passes
3. `executeLiquidity(minTokensOut, minTokenLP, minBnbLP, deadline)` after the interval. minTokensOut MUST be > 0. Same platform-operator gate as BurnModule.
4. Uses half of BNB to buy tokens
5. Pairs bought tokens + remaining BNB
6. Adds full-range liquidity via Router → LiquidityVault
7. Liquidity permanently locked in the vault — no removal path (no LP tokens minted)

Events:
- LiquidityAdded(token, bnbAmount, tokenAmount, lpTokens, timestamp)
- BNBReceived(amount, newPending)
- LiquidityIntervalUpdated(oldInterval, newInterval)
```

### 6.4 CreatorFeeModule
**Purpose**: Simplest module — forwards BNB to a single recipient address (defaults to the creator, but can be any EOA or contract).

```
Storage:
- recipient: payable address to receive fees (set in init payload, transferable by current recipient via setRecipient)
- taxHandler: inferred from msg.sender at __init__ time
- totalPaid

Flow (ACCRUE-AND-PULL — see docs/TOKENOMICS_V2.md §7.2):
1. Receives BNB from TaxHandler; credits `owed[recipient]`. No transfer, no external call.
2. The recipient later calls `withdraw()` to pull the accrued balance.

Events:
- TaxAccrued(recipient, amount, owedAfter)
- TaxWithdrawn(recipient, amount)
- RecipientUpdated(oldRecipient, newRecipient)
```

**Why pull, not push.** An earlier version forwarded BNB inside `receiveTax()` via `TransferHelper.safeTransferETH`, which does `require(success)`. Because `receiveTax()` runs inside the V4 swap callback, a recipient contract without a payable `receive()` — or with a reverting/expensive one — reverted **every trade of the token**. Under accrue-and-pull, `receiveTax()` cannot fail and only the recipient's own `withdraw()` does. Balances are keyed by account, so rotating the recipient leaves the previous one's accrual claimable.

**Multiple instances per token (arbitrary fee-recipient wallets).** TaxHandler does not enforce uniqueness on `moduleType`, so a creator can stack N CreatorFeeModule instances in the initial `modules[]` array (subject to MAX_MODULES=10), each with its own recipient and allocation. This is the canonical way to support "team wallet + marketing wallet + treasury + …" splits without writing a new module type. Recipients may be contracts; since payouts are pulled, a contract recipient can no longer endanger trading. Names for recipients are not stored on-chain (waste of gas); the frontend keeps a `(token, moduleIndex) → label` mapping off-chain.

### 6.5 MilestoneRewardModule (Type 5)
**Purpose**: Accrues tax BNB; the creator releases any amount of it to **all holders** at any time, with the claimed milestone recorded as free on-chain text. Full spec + rationale: [`TOKENOMICS_V2.md`](./TOKENOMICS_V2.md) §2B.

```
Storage:
- taxHandler: inferred from msg.sender at __init__
- token: from init payload abi.encode(address)
- totalAccrued / totalReleased: analytics
- lastReleaseTime: the 18-month public valve measures from here

Flow:
1. receiveTax() accrues + emits. Nothing else (swap-path invariant, V2 §6.1).
2. releaseRewards(amount, reason) — CREATOR ONLY, any amount, any time. Resolves
   the token's RewardModule from the TaxHandler module list at release time and
   calls donate{value: amount}(). The ONLY value-moving call in the contract;
   destination is never a parameter. Reverts "No reward module" if the token has
   none — the launch wizard must pair the two module types.
3. publicRelease() — ANYONE, but only after 18 months (540 days) with no release.
   Releases the FULL balance (all-or-nothing, so a dust release can't be used to
   grief the clock). Any release resets the clock.

Events:
- TaxReceived(amount, totalAccrued)
- RewardsReleased(by, rewardModule, amount, remaining, reason)
```

**No withdrawal path of any kind** — no withdraw, no recipient, no sweep, no owner. The creator's discretion is over timing and amount, never destination. The test suite pins the external surface as an allowlist so any added function fails review loudly. `renounceManagement()` does not disable releases (`creator()` is fixed at launch).

### 6.6 PrizePool (Type 4)
**Purpose**: Buyers earn tickets during an epoch; the accrued tax pot pays out pro-rata by BNB spent, by weighted lottery (≤10 winners), or to all holders via the RewardModule. Full spec: [`TOKENOMICS_V2.md`](./TOKENOMICS_V2.md) §2; implementation notes §2.12.

```
The frozen-layer trick: ticket data is reconstructed OFF-CHAIN from the hook's
TokenPurchased event and settled on-chain via a merkle root — zero changes to
LumoriaHook / ITaxHandler / IModule, so already-launched tokens can adopt it.

Flow per epoch (PRO_RATA / LOTTERY):
1. receiveTax() buckets BNB by timestamp-derived epoch (O(1), accrue-only).
2. rootPoster calls postRoot(epochId, root, totalWeight, ticketCount) after the
   epoch ends. Thin/empty epochs roll the pot to the live epoch instead.
3. 6h challenge window — Database.owner() may invalidateRoot (pot rolls over).
4. LOTTERY: anyone calls drawRandomness (bounty-paid) → provider resolved from
   Database.randomnessProvider → fulfillRandomness stores the word. Withheld
   reveal? rolloverStaleRandomness after 3 days.
5. Claims: pull-based, O(1). claim() verifies the pro-rata leaf;
   claimLottery() verifies the ticket leaf + the slot range check
   cumBefore <= r < cumBefore+weight. Hold requirement enforced on both.
6. sweepUnclaimed() rolls the post-window remainder to the live epoch.

ALL_HOLDERS: no root — permissionless settleAllHolders() donates the pot to the
RewardModule (rolls over if none exists).
```

**Order is load-bearing**: root → challenge window → randomness → claims. Every failure path rolls the pot to the live epoch; no BNB is ever stranded. Payouts are never pushed. Merkle verification lives in the vendored `lib/MerkleProof.sol`; the JS mirror (`scripts/lib/merkle.js`) is shared by tests and operator tooling.

### Module Interface
```solidity
interface IModule {
    function __init__(bytes calldata payload) external;
    function receiveTax() external payable;
    function getModuleType() external view returns (uint8);
    function getStats() external view returns (bytes memory);  // module-specific stats
}

interface IRewardModule is IModule {
    function setShare(address holder, uint256 amount) external;
    function claimReward() external;
    function getUnpaidRewards(address holder) external view returns (uint256);
    function donate() external payable;                    // permissionless top-up (V2 §4.1)
    function sync(address[] calldata holders) external;    // post-launch backfill (V2 §4.2)
}
```

---

## 7. REBATE CONTRACT

Separate from the module system. The RebateContract is a global contract that any token creator can fund with their tokens to provide buy rebates.

### Concept
Rebates are **simple and token-denominated**. The Router tells the Rebate contract: "User bought X tokens of Token B." The Rebate contract checks the rebate percentage and sends that % of X tokens to the buyer from the funded pool.

**Example**: User buys 100,000 tokens. Rebate is set to 50%. Rebate contract checks if it has 50,000 tokens available. If yes, sends 50,000 tokens to the buyer. If not enough, sends whatever is available. If empty, silently exits (no revert).

This enables creative tokenomics like high-tax tokens (e.g., 80% fee) where buyers get tokens back via rebate — the tax feeds modules while the rebate makes buying attractive.

### Storage
```
// Token => rebate config
mapping(address => RebateConfig) public rebates;

struct RebateConfig {
    uint256 rebateBps;        // rebate in basis points (e.g., 5000 = 50%)
    uint256 fundedBalance;    // tokens remaining in the rebate pool
    address creator;          // who funded it (can top up or withdraw)
    bool active;
}

// Access control: who can credit rebates (Router, etc.)
mapping(address => bool) public authorizedCreditors;
```

### Functions
```solidity
// Creator funds the rebate pool
function fundRebate(address token, uint256 amount, uint256 rebateBps) external;

// Creator tops up the pool
function topUpRebate(address token, uint256 amount) external;

// Creator adjusts rebate percentage
function setRebateBps(address token, uint256 rebateBps) external;

// Creator withdraws unfunded tokens
function withdrawFunds(address token, uint256 amount) external;

// Called by Router after a buy — credits rebate tokens to the buyer
function creditRebate(address token, address buyer, uint256 tokensBought) external;

// Admin: authorize/deauthorize creditors
function setAuthorizedCreditor(address creditor, bool authorized) external;

// View: true once the token's creator has renounced management (TaxHandler)
function isManagementRenounced(address token) external view returns (bool);
```

**Renounce freeze (honors TaxHandler `managementRenounced`).** When the token's creator has renounced management, `setRebateBps`, `withdrawFunds`, and `fundRebate` revert `"Rebate: renounced"` (resolved live via `Database.tokenTaxHandler(token).managementRenounced()`). **`topUpRebate` stays open** — it can only add funds at the existing rate, never change or remove them. So a locked token's rebate is frozen (rate fixed, no withdrawals) but can still be refilled and keeps paying buyers via `creditRebate` (which is never gated — a rebate must never block or change mid-trade). This makes the "Lock Token" promise cover fees, modules, **and** rebate. Funding must happen **before** renounce — a renounced token can't open a new rebate (no `fundRebate`), only top up an existing one.

### Credit Flow (called by Router)
```solidity
function creditRebate(address token, address buyer, uint256 tokensBought) external {
    require(authorizedCreditors[msg.sender], "not authorized");
    RebateConfig storage config = rebates[token];
    if (!config.active || config.fundedBalance == 0) return;  // silent exit
    
    // Calculate rebate: simple percentage of tokens bought
    uint256 rebateAmount = (tokensBought * config.rebateBps) / 10000;
    
    // Cap to available balance
    if (rebateAmount > config.fundedBalance) {
        rebateAmount = config.fundedBalance;
    }
    
    config.fundedBalance -= rebateAmount;
    IERC20(token).transfer(buyer, rebateAmount);
    
    if (config.fundedBalance == 0) {
        config.active = false;
        emit RebateDeactivated(token);
    }
    
    emit RebateCredited(token, buyer, rebateAmount);
}
```

### Events
```
event RebateFunded(address indexed token, address indexed creator, uint256 amount, uint256 rebateBps);
event RebateToppedUp(address indexed token, uint256 amount, uint256 newBalance);
event RebateCredited(address indexed token, address indexed buyer, uint256 tokenAmount);
event RebateBpsUpdated(address indexed token, uint256 oldBps, uint256 newBps);
event RebateWithdrawn(address indexed token, uint256 amount);
event RebateDeactivated(address indexed token);
event CreditorUpdated(address indexed creditor, bool authorized);
```

---

## 8. LAUNCH MODES

Two modes for MVP. Bonding curves planned for future.

### 8.1 BYOL (Bring Your Own Liquidity)
The simplest mode. Creator supplies both the tokens and the BNB to form the initial liquidity pool.

```
Flow:
1. Creator calls Generator.generateProject() with launchMode = BYOL
2. Generator creates Token + TaxHandler
3. Creator sends BNB (as msg.value = LP seed + flat launch fee) + token
   supply is minted to Generator
4. Flat anti-spam launch fee (Database.launchFeeBnb, 0.005 BNB at deploy,
   owner-tunable, absolute wei) → FeeReceiver.receiveLaunchFee(token, creator).
   NO percentage skim — the creator is supplying their own liquidity, so
   ALL remaining BNB seeds the pool.
5. Generator seeds the V4 pool via Router.addLiquidityETH → LiquidityVault
6. Vault lazily initializes the pool at the implied price and mints
   full-range liquidity (tokens + remaining BNB)
7. Liquidity permanently locked in the vault — no removal path exists
8. Token is live for trading immediately

No raise, no presale, no waiting. Instant launch.
LP is permanently locked from day one — creator cannot rug the liquidity.
```

### 8.2 Flat Curve (Presale with Refunds)
A presale-style raise where contributors can exit before the raise completes.

```
Storage:
- token: the token being raised for
- hardCap: BNB raise target (when reached, token launches)
- minContribution: minimum BNB per user
- maxContribution: maximum BNB per user
- totalRaised: current BNB raised (net, after platform fees)
- totalContributed: gross BNB contributed (before platform fees)
- contributions: mapping(address => uint256) — net amounts (what user actually gets credit for)
- tokensForPresale: how many tokens are allocated to presale contributors
- tokensForLiquidity: how many tokens are reserved for the LP
- liquidityBps: % of raised BNB that goes to LP (e.g., 8000 = 80%)
- creatorBps: % of raised BNB that goes to creator (e.g., 2000 = 20%)
  (liquidityBps + creatorBps must = 10000)
- launched: bool
- startTime / endTime: raise window
- claimed: mapping(address => bool)

Flow:
1. Creator calls Generator with launchMode = FLAT_CURVE
   - msg.value must equal the flat launch fee exactly (Database.launchFeeBnb,
     anti-spam, → FeeReceiver.receiveLaunchFee) — raise BNB comes from
     contributors, not the creator
   - Creator configures liquidityBps/creatorBps split (most should go to liquidity)
2. Generator creates Token + TaxHandler + FlatCurve clone
3. Token supply minted to FlatCurve contract
4. Users contribute BNB within [minContribution, maxContribution]
5. Platform takes 1% fee on each contribution immediately → FeeReceiver
6. Net amount (99%) credited to user's contribution balance
7. Users can withdraw (refund) at any time before launch
   - Refund = their net contribution (they already lost the 1% platform fee on entry)
8. When totalRaised == hardCap (in net terms):
   - Splits raised BNB: liquidityBps% → LP, creatorBps% → creator
   - Seeds the V4 pool via Router.addLiquidityETH (LP BNB + tokensForLiquidity);
     the vault lazily initializes the pool and mints full-range liquidity
   - Liquidity permanently locked in the LiquidityVault — no removal path
   - tokensForPresale held in FlatCurve for contributors to claim
   - Token is live for trading
9. Contributors call claim() to receive their token allocation
   - Allocation = (contribution / totalRaised) * tokensForPresale
   - Tokens sit in FlatCurve until claimed (no airdrop, saves gas)
10. If endTime passes without reaching hardCap:
    - Raise fails, contributors can withdraw remaining BNB (net)
    - Tokens returned to creator or burned

Key Difference from Traditional Presale:
Users can EXIT at any time by withdrawing before launch. They contributed 1 BNB? They get back
0.99 BNB (the 1% platform fee was already taken on entry and is non-refundable). This makes
it lower-risk for participants.
```

### FlatCurve Events
```
event ContributionMade(address indexed contributor, uint256 grossAmount, uint256 netAmount, uint256 totalRaised);
event ContributionRefunded(address indexed contributor, uint256 refundAmount);
event RaiseLaunched(address indexed token, uint256 totalRaised, uint256 liquidityBNB, uint256 liquidityTokens, uint256 creatorBNB);
event RaiseFailed(address indexed token, uint256 totalRaised);
event TokensClaimed(address indexed contributor, uint256 tokenAmount);
event PlatformFeeTaken(uint256 amount);
```

---

## 9. FEE RECEIVER CONTRACT

Single contract that collects all platform 1% fees. It exposes **typed,
context-carrying receive functions** so that the (frozen) hook forwards full
trade context on every swap — a future FeeReceiver implementation, swapped in
via `Database.setFeeReceiver`, can act on trades on-chain (wager tracking,
revenue splitting, buyback, ...) without any hook change. The current
implementation just accrues.

### Storage
```
address public owner;          // platform admin
address public recipient;      // where fees ultimately go (EOA or multisig)
uint256 public totalReceived;

// Tracking by source for analytics
mapping(address => uint256) public feesByToken;  // per-token fee accumulation
```

### Functions
```solidity
// Untagged BNB (fallback for simple sends)
receive() external payable;

// Generic tagged receipt — kept for future callers with no trade/launch context
function receiveFee(address token) external payable;

// Trade-like flow: LumoriaHook swaps (buys + sells, any router) and FlatCurve
// raise contributions. `user` is address(0) for third-party-router swaps
// (no hookData). `tradeAmount` is gross BNB: bnbIn on buys/contributions,
// bnbOutGross on sells.
function receiveTradeFee(address token, address user, uint256 tradeAmount, bool isBuy) external payable;

// Project launches (Generator, both modes — flat anti-spam fee);
// `user` is the creator.
function receiveLaunchFee(address token, address user) external payable;

// Withdraw accumulated fees (owner → recipient)
function withdraw() external;
```

All receive paths accrue `totalReceived` + `feesByToken[token]` and emit
`FeeReceived` (the single non-double-counting revenue event), plus their typed
context event.

### Events
```
event FeeReceived(address indexed from, uint256 amount);   // EVERY inflow — total revenue source
event TokenFeeReceived(address indexed token, uint256 amount);              // generic receiveFee only
event TradeFeeReceived(address indexed token, address indexed user, uint256 fee, uint256 tradeAmount, bool isBuy);
event LaunchFeeReceived(address indexed token, address indexed user, uint256 fee);
event FeesWithdrawn(address indexed recipient, uint256 amount);
event RecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
```

---

## 10. V4 POOL ARCHITECTURE (LumoriaHook)

The custom DEX is gone. Liquidity and trading live in the canonical Uniswap V4 `PoolManager`; the **LumoriaHook** (one instance, serving every pool) is the orchestrator of all fee collection.

### Canonical pool shape (enforced by the hook in `beforeInitialize`)
```
PoolKey {
    currency0:   address(0)        // native BNB
    currency1:   <Lumoria token>
    fee:         0                 // no LP fee — all economics are hook fees
    tickSpacing: 60
    hooks:       LumoriaHook
}
PoolId = keccak256(abi.encode(poolKey))   // deterministic from the token address
```
No pool registry is stored anywhere — `LumoriaHook.poolKeyFor(token)` / `poolIdFor(token)` derive it.

### Hook permissions (encoded in the hook's CREATE2-mined address)
`beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `afterSwap`, `beforeDonate`, `beforeSwapReturnDelta`, `afterSwapReturnDelta`.

### What each callback does
| Callback | Behavior |
|---|---|
| `beforeInitialize` | Reverts unless: caller is the LiquidityVault, pool matches the canonical shape, and `currency1` is a registered Lumoria token. Emits `LumoriaPoolInitialized`. |
| `beforeAddLiquidity` | Vault-only — every unit of liquidity is protocol-owned and locked. |
| `beforeRemoveLiquidity` | **Always reverts** (`LiquidityPermanentlyLocked`). |
| `beforeDonate` | Always reverts (donations would accrue to the locked position, i.e. be burned by accident). |
| `beforeSwap` | Reverts exactOutput. On buys: takes platform fee + buy tax from the BNB input via `poolManager.take()`, forwards immediately (FeeReceiver / `TaxHandler.receiveBuyTax`), returns a `BeforeSwapDelta` so only the remainder swaps. |
| `afterSwap` | On sells: takes platform fee + sell tax from the gross BNB output, forwards, returns the `int128` hook delta. On buys: credits rebate + registers volume. Emits `TokenPurchased` / `TokenSold`, each carrying the post-swap `sqrtPriceX96` + `tick` read from the PoolManager — one extsload, no storage, so the subgraph never has to index the canonical PoolManager for price (TOKENOMICS_V2 §13.1). |

### Fee math (identical to the legacy Router)
`platformFee = gross × platformFeeBps / 10000`, then `tax = (gross − platformFee) × buyFee|sellFee / 10000`. Buys measure `gross` as the BNB input; sells as the gross BNB output.

### User attribution (`hookData`)
The LumoriaSwapRouter passes `hookData = abi.encode(address user)`. The hook uses it for `RebateContract.creditRebate` (buys, silent-exit semantics) and `Database.registerVolume`. Swaps arriving without hookData (aggregators, third-party routers) are **fully taxed** — they just skip rebates and per-user volume (`tokenVolume` is always tracked; `userVolume` skipped when `user == address(0)`).

### Mutability without migrations
The hook address is immutable per pool, but the hook stores no economics: platform fee, per-token buy/sell fees, module lineup, FeeReceiver, and RebateContract are all read live from the Database/TaxHandler on every swap. Creator timelocks and admin changes work exactly as before, with zero pool migrations.

### Hook deployment
Permissions live in the low 14 bits of the hook's address, so it is deployed via CREATE2 with a salt mined off-chain (`scripts/lib/hook-miner.js`, `Create2Deployer`).

### Hook Events
```
event TokenPurchased(address indexed token, address indexed buyer, uint256 bnbIn, uint256 platformFee, uint256 taxTaken, uint256 tokensOut, uint160 sqrtPriceX96, int24 tick);
event TokenSold(address indexed token, address indexed seller, uint256 tokensIn, uint256 platformFee, uint256 taxTaken, uint256 bnbOut);
event LumoriaPoolInitialized(address indexed token, PoolId indexed poolId);
```

---

## 11. LIQUIDITY VAULT + SWAP ROUTER

### LumoriaLiquidityVault — permanent liquidity lock
The sole owner of liquidity in every pool. **There is no code path that removes liquidity** — strictly stronger than the legacy "LP tokens to dEaD" (the removal capability itself does not exist, and the hook also reverts any third-party `modifyLiquidity`).

- `addLiquidityLocked(token, tokenAmountDesired, dustRecipient)` payable — router-only. First add lazily initializes the pool at the implied BNB/token price (`sqrtPriceX96` from the ratio); every add mints **full-range** liquidity via `unlock → modifyLiquidity → settle` (native BNB by value; token via sync/transfer/settle) and refunds the unconsumed remainder to `dustRecipient`.
- Analytics: `lockedLiquidity[token]`, `totalBnbLocked[token]`, `totalTokensLocked[token]`.
- Events: `PoolInitialized(token, poolId, sqrtPriceX96)`, `LiquidityLocked(token, bnbAmount, tokenAmount, liquidity, totalLocked)`.
- Pool LP fee is 0, so the locked position accrues no swap fees — nothing to collect, nothing to strand. (The old 0.1% grow-the-pool LP fee was dropped by design decision in Phase 5.)

### LumoriaSwapRouter — thin V4 router, legacy interface
Implements the existing `ILumoriaRouter` interface so **Generator, FlatCurve, and the Burn/Liquidity/Reward modules required zero changes**:

- `swapExactETHForTokensSupportingFeeOnTransferTokens(amountOutMin, path, to, deadline)` payable — `path[0]` accepts `Database.wbnb()` (the legacy module convention) or `address(0)`; both mean native BNB. Settles the native input *before* swapping so the hook's fee `take()` can never outrun the PoolManager's balance. Passes `hookData = abi.encode(to)`.
- `swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, to, deadline)` — sell side; attributes volume to `msg.sender`.
- `addLiquidityETH(token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline)` payable — pulls tokens and delegates to the vault. `to` is ignored (liquidity is always vault-locked); returns `(amountToken, amountETH, liquidity)` as before.
- **No `removeLiquidityETH`** — liquidity is unremovable by design.
- The router collects no fees itself; it adds attribution on top of what any third-party route gets.

### Quoting
On-chain `quoteBuy`/`quoteSell` views are gone (CL math isn't a cheap view). The UI uses the canonical **V4Quoter** (BSC: `0x9f75dd27d6664c475b90e105573e550ff69437b0`) with the deterministic PoolKey — it simulates hook deltas, so quotes are tax-accurate automatically at any fee level. See FRONTEND.md.

---

## 12. GENERATOR CHANGES

The Generator handles both launch modes: BYOL and Flat Curve.

```solidity
enum LaunchMode { BYOL, FLAT_CURVE }

function generateProject(
    string calldata name,
    string calldata symbol,
    uint256 buyFee,
    uint256 sellFee,
    ModuleInitData[] calldata modules,
    LaunchMode launchMode,
    bytes calldata launchPayload,  // mode-specific config (encoded)
    AllocationData[] calldata allocations,  // creator allocations carved from the remainder
    bytes32 salt
) external payable returns (address token, address taxHandler) {
    require(buyFee <= 9800 && sellFee <= 9800, "fee exceeds max");
    
    // 1. Clone token
    token = _cloneToken(salt);
    
    // 2. Clone TaxHandler
    taxHandler = _cloneTaxHandler();
    
    // 3. The token's "pair" is the V4 PoolManager — the address that
    //    custodies pool reserves and is excluded from reward-share
    //    tracking. The pool itself (PoolId) is deterministic from token.
    address pair = database.poolManager();
    
    // 4. Initialize TaxHandler (clones modules internally)
    ITaxHandler(taxHandler).__init__(
        token, address(database), msg.sender,
        buyFee, sellFee, modules
    );
    
    // 5. Initialize Token
    ILumoriaToken(token).__init__(name, symbol, pair, taxHandler, msg.sender);
    
    // 6. Register in database
    database.registerToken(token, msg.sender, taxHandler);
    
    // 7. Flat anti-spam launch fee — every launch mode, on top of whatever
    //    BNB the mode consumes. Forwarded with creator context.
    uint256 launchFee = database.launchFeeBnb();
    require(msg.value >= launchFee, "Gen: insufficient launch fee");
    if (launchFee > 0) {
        IFeeReceiver(database.feeReceiver()).receiveLaunchFee{value: launchFee}(token, msg.sender);
    }
    
    // 8. Execute launch mode. Creator allocations (immediate or vested) are
    //    carved from the creator's remainder inside each launch path, before
    //    the creator receives what's left.
    if (launchMode == LaunchMode.BYOL) {
        _launchBYOL(token, launchPayload, allocations, msg.value - launchFee);
    } else if (launchMode == LaunchMode.FLAT_CURVE) {
        require(msg.value == launchFee, "Gen: no BNB on FLAT_CURVE");
        _launchFlatCurve(token, launchPayload, allocations);
    }
    
    emit ProjectGenerated(token, taxHandler, msg.sender, name, symbol, buyFee, sellFee, launchMode);
}
```

### Creator Allocations + VestingVault

`generateProject` accepts an `AllocationData[]`, applied uniformly to BYOL and FlatCurve. Each allocation is **carved from the creator's post-launch remainder** (never from the LP or presale buckets), then the creator receives whatever is left.

```solidity
struct AllocationData {
    address beneficiary;
    uint256 amount;
    uint64  cliff;     // seconds after launch before vesting unlocks (≤ duration)
    uint64  duration;  // 0 = immediate transfer; > 0 = linear vest over this many seconds
}
```

In `_processAllocations` (called inside each launch path):
- `duration == 0` → `safeTransfer(token, beneficiary, amount)` and `emit AllocationMinted(token, beneficiary, amount)`.
- `duration > 0` → `safeTransfer(token, vestingVault, amount)` then `VestingVault.createSchedule(...)`, and `emit AllocationVested(token, beneficiary, scheduleId, amount, cliff, duration)`.
- Constraints: `sum(amount) ≤ creatorRemainder` (else revert), `≤ MAX_ALLOCATIONS (100)`, non-zero amount + beneficiary.

**VestingVault** (shared singleton, `Database.vestingVault()`):
- `createSchedule(token, beneficiary, amount, cliff, duration) → id` — gated to `Database.generator()`; records a linear+cliff schedule; tokens must already have been transferred in.
- `release(uint256 id)` — **permissionless**; sends `vested − released` to the beneficiary.
- Views: `getSchedule(id)`, `releasable(id)`, `vestedAmount(id)`, `getBeneficiarySchedules(beneficiary)`, `scheduleCount()`.
- **Non-revocable**: there is deliberately no revoke/claw-back path — the same trust posture as the permanently-locked liquidity vault.
- The vault is **excluded from reward-share tracking** by every TaxHandler (see §5) so its locked balance never accrues stranded reflections.
- Vesting math: `vested = total · (now − start) / duration` after `start+cliff`; `0` before the cliff; `total` at/after `start+duration`.

```
event ScheduleCreated(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration);
event TokensReleased(uint256 indexed id, address indexed beneficiary, uint256 amount);
```

### BYOL Launch
```solidity
function _launchBYOL(address token, bytes calldata payload, AllocationData[] calldata allocations, uint256 forLP) internal {
    // payload encodes: (uint256 tokensForLP)
    // forLP = msg.value net of the flat launch fee — ALL of it seeds the
    // pool (no percentage skim; the creator supplies their own liquidity)
    
    // Seed the V4 pool via Router → LiquidityVault. The vault lazily
    // initializes the pool at the implied price and the liquidity is
    // permanently locked (no removal path exists).
    ILumoriaRouter(database.router()).addLiquidityETH{value: forLP}(
        token, tokensForLP, 0, 0, DEAD /* ignored */, block.timestamp
    );
}
```

### Flat Curve Launch
```solidity
function _launchFlatCurve(address token, address pair, bytes calldata payload) internal {
    // payload encodes: (uint256 hardCap, uint256 minContrib, uint256 maxContrib,
    //                   uint256 tokensForPresale, uint256 tokensForLP,
    //                   uint256 startTime, uint256 endTime)
    
    // Clone FlatCurve contract
    address flatCurve = _cloneFlatCurve();
    
    // Initialize FlatCurve with config
    IFlatCurve(flatCurve).__init__(token, pair, payload);
    
    // Transfer tokens to FlatCurve (presale + LP allocation)
    // FlatCurve handles the raise lifecycle
    
    emit FlatCurveLaunched(token, flatCurve, hardCap);
}
```

### Events
```
event ProjectGenerated(
    address indexed token, 
    address indexed taxHandler, 
    address indexed creator,
    string name, 
    string symbol, 
    uint256 buyFee, 
    uint256 sellFee,
    uint8 launchMode
);
event FlatCurveLaunched(address indexed token, address indexed flatCurve, uint256 hardCap);
event AllocationMinted(address indexed token, address indexed beneficiary, uint256 amount);
event AllocationVested(address indexed token, address indexed beneficiary, uint256 indexed scheduleId, uint256 amount, uint64 cliff, uint64 duration);
```

---

## 13. COMPREHENSIVE EVENT INDEX (for Subgraph)

### Entity Tracking Goals
- **Tokens**: all launched tokens with metadata, fees, creator, volume, holder count, launch mode
- **Trades**: every buy/sell with amounts, fees (platform + token), timestamps
- **Holders**: per-token holder list with balances and rewards
- **Modules**: active modules per token with accumulated stats
- **Rebates**: rebate credits per buyer per token
- **Raises**: Flat Curve status, contributions, refunds
- **Liquidity**: LP adds/removes with amounts
- **Burns**: buyback burns with amounts
- **Volume**: per-user per-token volume tracking
- **Platform**: total platform fees, total volume

### Events by Contract

**Database**:
- `TokenRegistered(token, creator, taxHandler)`
- `VolumeRegistered(token, user, amount)`
- `MasterCopyUpdated(copyType, newCopy)`
- `ModuleMasterCopySet(moduleType, masterCopy)`

**Generator**:
- `ProjectGenerated(token, taxHandler, creator, name, symbol, buyFee, sellFee, launchMode)`
- `FlatCurveLaunched(token, flatCurve, hardCap)`
- `AllocationMinted(token, beneficiary, amount)` — immediate (unlocked) creator allocation
- `AllocationVested(token, beneficiary, scheduleId, amount, cliff, duration)` — vested creator allocation (→ VestingVault schedule)

**Token**:
- `Transfer(from, to, value)`
- `Approval(owner, spender, value)`

**LumoriaHook** (the subgraph's primary trade source — fires on EVERY swap, any router):
- `TokenPurchased(token, buyer, bnbIn, platformFee, taxTaken, tokensOut, sqrtPriceX96, tick)` — `buyer = address(0)` for unattributed third-party routes. `sqrtPriceX96`/`tick` are the **post-swap pool mark**, making the hook a complete OHLC source (TOKENOMICS_V2 §13.1).
- `TokenSold(token, seller, tokensIn, platformFee, taxTaken, bnbOut)`
- `LumoriaPoolInitialized(token, poolId)`

**LumoriaLiquidityVault**:
- `PoolInitialized(token, poolId, sqrtPriceX96)`
- `LiquidityLocked(token, bnbAmount, tokenAmount, liquidity, totalLocked)`

**Uniswap V4 PoolManager** (canonical — index if pool-state granularity is wanted):
- `Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)`
- `Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)`
- `ModifyLiquidity(id, sender, tickLower, tickUpper, liquidityDelta, salt)`

**FeeReceiver**:
- `FeeReceived(from, amount)` — every inflow; the revenue total
- `TradeFeeReceived(token, user, fee, tradeAmount, isBuy)` — hook swaps + FlatCurve contributions
- `LaunchFeeReceived(token, user, fee)` — every Generator launch (both modes; flat anti-spam fee)
- `TokenFeeReceived(token, amount)` — generic `receiveFee` only
- `FeesWithdrawn(recipient, amount)`

**TaxHandler**:
- `BuyTaxDistributed(token, amount, buyer)`
- `SellTaxDistributed(token, amount, seller)`
- `ShareUpdated(holder, oldShare, newShare)`
- `ModuleAdded(moduleType, moduleAddress, buyAlloc, sellAlloc)`
- `ModuleRemoved(moduleType, moduleAddress)`
- `ModuleUpdated(moduleType, moduleAddress, buyAlloc, sellAlloc)`
- `FeesUpdated(oldBuyFee, newBuyFee, oldSellFee, newSellFee)`
- `FeeChangeProposed(newBuyFee, newSellFee, effectiveTime)`
- `FeeChangeCancelled()`
- `ModuleChangeProposed(changeType, moduleType, buyAlloc, sellAlloc, effectiveTime)`
- `ModuleRebalanceProposed(indices, buyAllocs, sellAllocs)`
- `ModuleChangeCancelled()`
- `ManagementRenounced(token, timestamp)` — one-way permanent freeze of fee/module config (B6)

**VestingVault** (shared singleton — vested creator allocations):
- `ScheduleCreated(id, token, beneficiary, total, start, cliff, duration)`
- `TokensReleased(id, beneficiary, amount)`

**RewardModule**:
- `RewardDeposited(token, amount)`
- `RewardClaimed(holder, amount)`
- `ShareUpdated(holder, oldShare, newShare)`

**BurnModule**:
- `BurnExecuted(token, bnbSpent, tokensBurned, timestamp)`
- `BNBReceived(amount, newPending)`

**LiquidityModule**:
- `LiquidityAdded(token, bnbAmount, tokenAmount, lpTokens, timestamp)`
- `BNBReceived(amount, newPending)`

**CreatorFeeModule**:
- `TaxAccrued(recipient, amount, owedAfter)`
- `TaxWithdrawn(recipient, amount)`
- `RecipientUpdated(oldRecipient, newRecipient)`

**RebateContract**:
- `RebateFunded(token, creator, amount, rebateBps)`
- `RebateToppedUp(token, amount, newBalance)`
- `RebateCredited(token, buyer, tokenAmount)`
- `RebateBpsUpdated(token, oldBps, newBps)`
- `RebateWithdrawn(token, amount)`
- `RebateDeactivated(token)`
- `CreditorUpdated(creditor, authorized)`

**FlatCurve**:
- `ContributionMade(contributor, grossAmount, netAmount, totalRaised)`
- `ContributionRefunded(contributor, refundAmount)`
- `RaiseLaunched(token, totalRaised, liquidityBNB, liquidityTokens, creatorBNB)`
- `RaiseFailed(token, totalRaised)`
- `TokensClaimed(contributor, tokenAmount)`
- `PlatformFeeTaken(amount)`

---

## 14. SECURITY CONSIDERATIONS

1. **Reentrancy**: All modules, TaxHandler, FlatCurve, the LiquidityVault, and FeeReceiver must have reentrancy guards — they handle BNB transfers. Hook callbacks are PoolManager-only (`onlyPoolManager` via BaseHook); the hook's `receive()` only accepts BNB from the PoolManager.
2. **Access Control**:
   - Hook callbacks: only the PoolManager can invoke them
   - Pool initialization + liquidity adds: only the LiquidityVault (enforced by the hook); vault entry: only the Router
   - `Database.registerVolume`: only the hook
   - Only Token can call TaxHandler.setShare
   - Only authorized creditors (the hook) can call RebateContract.creditRebate
   - Only creator can modify their token's fee config (subject to timelock for increases)
   - `TaxHandler.receiveBuyTax/receiveSellTax` are intentionally permissionless deposits (sending tax in is harmless)
3. **Fee Cap**: Hard cap at 98% (9800 bps). No maximum enforced lower — creator freedom is intentional
4. **Change Timelock**: 24-hour delay on ALL changes that affect token economics (fee increases, module add/remove/update). Fee decreases are instant (always good for holders).
5. **Module Safety**: Modules should not be able to drain the pool or manipulate prices
6. **Liquidity Permanently Locked**: the vault is the sole liquidity owner and has NO removal code path; the hook reverts every third-party `modifyLiquidity` and all removals — no rug pulls possible via LP removal (strictly stronger than the legacy LP-to-dEaD)
7. **Interval Protections**: Burn and Liquidity modules use time intervals to prevent sandwich attacks
8. **Rebate Safety**: Rebates silently exit if underfunded (no reverts), preventing trade failures
9. **Flat Curve Safety**: Contributors can exit at any time (minus 1% platform fee). Raise failure returns funds.
10. **Mid-swap external calls**: the hook forwards tax inside the swap (FeeReceiver → TaxHandler → modules). CreatorFeeModule recipients that are contracts with reverting/expensive `receive()` will fail trades — existing known property, frontend warns on contract recipients. Nested PoolManager calls by malicious recipients are bounded by V4's flash-accounting (their deltas must settle or the whole tx reverts).
11. **exactOutput rejected**: removes the fee-on-specified-output edge case entirely.
12. **Hook is the audit centerpiece**: it handles up to 98% of swap flow. Pre-mainnet audit must cover the hook + vault + router trio (see Cork Protocol, May 2025, and Bunni, Sep 2025 — both were hook-logic exploits, not V4-core failures).

---

## 15. BUILD ORDER

Recommended implementation sequence:

### Phase 1: Core Infrastructure ✅ COMPLETE
1. ~~All interfaces~~ — DONE: `IERC20`, `IDatabase`, `ILumoriaToken`, `ITaxHandler`, `IModule`/`IRewardModule`, `IFeeReceiver`, `IRebate`, `IFlatCurve`, `IGenerator` (+ `ILumoriaRouter`, `ILumoriaLiquidityVault` added in Phase 5)
2. ~~`Database.sol`~~ — DONE: central registry with token/volume tracking, master copy management, platform fee config
3. ~~`LumoriaToken.sol`~~ — DONE: clean ERC20, holder tracking via TaxHandler.setShare(), no tax logic, 1B supply
4. ~~`FeeReceiver.sol`~~ — DONE: platform fee collector with per-token analytics, simple withdraw

### Phase 2: Tax System ✅ COMPLETE (pending rebalance-interface decision)
5. ✅ `TaxHandler.sol` — per-token tax router with fee + module timelocks
6. ✅ `CreatorFeeModule.sol` — simplest module, forwards BNB to recipient
7. ✅ `RewardModule.sol` — holder dividend distribution (BNB + token modes)
8. ✅ `BurnModule.sol` — buyback and burn (`executeBurn(minTokensOut, deadline)`, 5-min floor, operator-gated with 1h public fallback)
9. ✅ `LiquidityModule.sol` — auto-liquidity (`executeLiquidity(minTokensOut, minTokenLP, minBnbLP, deadline)`, operator-gated with 1h public fallback, liquidity vault-locked)

### Phase 3: DEX Refactor ✅ COMPLETE
10. ✅ `Factory.sol` — curated-only enforcement, 0.1% LP fee, Database-aware WBNB pairing
11. ✅ `Pair.sol` — extracted from the legacy monolith, `amountIn * 10` K invariant (0.1% fee), user-attributed swap events
12. ✅ `Router.sol` — fee flow: 1% platform fee → FeeReceiver, then token tax → TaxHandler, then swap remainder; rebate callout on buys; volume registration; lazy pair creation on addLiquidityETH
13. ✅ `RebateContract.sol` — creator-funded token pools; Router-authorized creditRebate; silent-exit on empty/inactive; auto-reactivate on topUp

### Phase 4: Launch System ✅ COMPLETE
13. ✅ `Generator.sol` — single-tx launch: clones Token (CREATE2 with salt) + TaxHandler + modules, registers in Database, branches to BYOL or FlatCurve.
14. ✅ `FlatCurve.sol` — presale with refunds, permissionless finalize (success/fail branching), claim-based token distribution.
15. ✅ **Module init payload refactor** — modules infer `taxHandler` from `msg.sender` at `__init__` time (was encoded in payload). Unlocks single-tx Generator launches.
16. ✅ Deployment scripts (`scripts/deploy-base.js` + `smoke-launch.js` + `verify.js`, validated end-to-end on a persistent localhost node)

### Phase 5: Uniswap V4 Migration ✅ COMPLETE
17. ✅ V4 dependencies (`@uniswap/v4-core` 1.0.2, `@uniswap/v4-periphery` 1.0.3) + Hardhat dual-compiler/cancun config
18. ✅ `v4/LumoriaHook.sol` — pool-level fee stack, rebate/volume attribution, pool-creation + liquidity + donation gates, exactOut rejection
19. ✅ `v4/LumoriaLiquidityVault.sol` — sole liquidity owner, lazy pool init, full-range adds, NO removal path
20. ✅ `v4/LumoriaSwapRouter.sol` — legacy `ILumoriaRouter` interface over V4 unlock/swap/settle/take
21. ✅ Database/Generator rework (poolManager/hook/vault refs; factory removed); legacy DEX moved to `legacy/`
22. ✅ Test suite migrated + V4 suite added (147 tests green: fee math to the wei, 98% taxes, bypass-proofing, lock invariants)
23. ✅ Deploy scripts: canonical BSC PoolManager + periphery addresses; hook salt mining; localhost/testnet PoolManager deploy; smoke-tested end-to-end

---

## 16. RESOLVED DECISIONS

| # | Question | Decision |
|---|----------|----------|
| 1 | Pair LP fee | ~~0.1%~~ → **0 (Phase 5)** — the locked V4 position earns no fees and strands none; all economics are hook fees. The "LP depth grows from fees" model was explicitly dropped with the V4 migration |
| 2 | Fee change timelock | **Yes, 24 hours** — fee increases require timelock, decreases are instant |
| 3 | Module changes | **All module changes timelocked (24h)** — adding, removing, or updating module allocations all require 24h notice to protect holders |
| 4 | Initial liquidity | **Two modes for MVP**: BYOL (creator supplies BNB) and Flat Curve (presale with refunds). Bonding curves planned for future. |
| 5 | Platform fee | **1% flat fee on all trades + raise contributions**, separate from and in addition to token taxes. Sent to FeeReceiver. |
| 6 | Max fee cap | **98%** (9800 bps) — intentionally high to allow creative tokenomics with rebates |
| 7 | Rebate pricing | **Simple token percentage** — user buys 100k tokens with 50% rebate → gets 50k bonus tokens from pool. No BNB conversion needed. |
| 8 | Flat Curve distribution | **Claim-based** — tokens sit in FlatCurve contract until contributors call `claim()`. Saves gas vs airdrop. |
| 9 | Flat Curve BNB split | **Configurable per launch** — creator sets liquidityBps + creatorBps (must sum to 100%). Most should go to liquidity. |
| 10 | LP token handling | ~~LP tokens to dEaD~~ → **vault-locked (Phase 5)**: all liquidity (BYOL, Flat Curve, LiquidityModule auto-LP) is full-range and owned by the LumoriaLiquidityVault, which has no removal code path; the hook additionally reverts all removals. Strictly stronger than dEaD-locking |
| 11 | DEX engine (Phase 5) | **Canonical Uniswap V4 PoolManager + LumoriaHook** instead of the custom V2 DEX. Pool-level taxing closes the legacy `Pair.swap()` bypass and makes aggregator routing tax-safe |
| 12 | Pool currency (Phase 5) | **Native BNB** (`currency0 = address(0)`) — no WBNB wrapping. `Database.wbnb` survives only as the legacy path-marker modules use |
| 13 | exactOutput swaps (Phase 5) | **Rejected by the hook** — matches the exactIn-only legacy Router and removes the fee-on-specified-output edge case |
| 14 | Hook config mutability (Phase 5) | Hook stores no economics; everything is read live from Database/TaxHandler, so fee/module changes never require pool migrations |
| 15 | Quoting (Phase 5) | Off-chain via canonical V4Quoter (simulates hook deltas → tax-accurate); on-chain quote views dropped |

---

## 17. FUTURE WORK (Post-MVP)

- **Bonding curves**: Additional launch mode with dynamic pricing curves. With V4 this can live *inside the trading pool*: a launch-phase hook using `beforeSwapReturnDelta` custom accounting can implement the curve directly (see Doppler's hook-enshrined auctions for prior art), then graduate to the standard LumoriaHook pool. High-interest follow-up.
- **Platform token**: Potential Lumoria token with staking, fee sharing, etc.
- **More module types**: Lottery, auto-compound, charity, etc.
- **FeeReceiver enhancements**: Revenue splitting, auto-conversion, buyback, etc.
- **Governance**: Community voting on module additions, fee parameters
- **Multi-chain**: Expand beyond BSC
