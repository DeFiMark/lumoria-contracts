# Lumoria — Subgraph Specification

**Purpose.** This is the complete, self-contained brief for scaffolding a subgraph against the Lumoria contracts. It lists every indexable contract, every event (exact signature + indexed fields), how the contracts relate, what each handler should do, the entity schema, and the non-obvious indexing traps. A subgraph agent should be able to build the manifest + schema + mappings from this doc alone. A frontend agent should review §11 and confirm nothing the UI needs is missing.

Keep it in lock-step with `DESIGN.md` (contract spec), `FRONTEND.md` (client data needs), and the deployed ABIs. Event signatures below were extracted from source on 2026-06-17 — re-verify against the committed ABIs before generating types.

> **Read these three sections first, they're where subgraphs for this system go wrong:**
> §3 (dynamic data sources + the **same-transaction ordering trap** → hydrate initial state via contract calls), §4 (deterministic pool identity), §10 (consolidated gotchas).

---

## 1. Contracts at a Glance

Lumoria is a **factory system**: a handful of singletons, plus per-launch contracts cloned on every token launch. The subgraph needs **static data sources** for the singletons and **dynamic templates** for the cloned ones.

| Contract | Kind | Address source | Instantiated by | Index for |
|---|---|---|---|---|
| `Database` | singleton | `deployments/<net>.json` → `core.database` | — | token registry, volume, platform config, infra changes |
| `Generator` | singleton | `core.generator` | — | launches (ProjectGenerated, BYOL/FlatCurve) |
| `LumoriaHook` | singleton | `core.hook` | — | **all trades** (TokenPurchased/Sold), pool init |
| `LumoriaLiquidityVault` | singleton | `core.liquidityVault` | — | locked-liquidity / TVL |
| `FeeReceiver` | singleton | `core.feeReceiver` | — | platform revenue |
| `RebateContract` | singleton | `core.rebateContract` | — | rebate pools + credits |
| `VestingVault` | singleton | `core.vestingVault` | — | vested creator allocations (schedules + releases) |
| Uniswap V4 `PoolManager` | singleton (canonical) | `v4.poolManager` | — | **not indexed** — the hook emits `sqrtPriceX96`/`tick` itself (§13.1) |
| `LumoriaToken` | **template** | from event | `Database.TokenRegistered` | Transfer (holders, supply) |
| `TaxHandler` | **template** | from event | `Database.TokenRegistered` | fees, modules, tax flow, shares |
| `FlatCurve` | **template** | from event | `Generator.FlatCurveLaunched` | raise lifecycle |
| `CreatorFeeModule` | **template** | from event | `TaxHandler.ModuleAdded` (type 3) | creator-fee forwards |
| `RewardModule` | **template** | from event | `TaxHandler.ModuleAdded` (type 0) | dividends/claims |
| `BurnModule` | **template** | from event | `TaxHandler.ModuleAdded` (type 1) | buyback-burns |
| `LiquidityModule` | **template** | from event | `TaxHandler.ModuleAdded` (type 2) | auto-LP |

**Addresses + start blocks.** All singleton addresses come from `deployments/bsc.json`, which also records **`startBlock`** — the chain height just before any Lumoria contract was deployed (added to `deploy-base.js`). Use it as the manifest `startBlock` for every data source. The canonical PoolManager predates us, so if you index it, use this same `startBlock`, not the PoolManager's.

---

## 2. Module Type Enum (used everywhere)

```
0 = REWARD     (RewardModule)
1 = BURN       (BurnModule)
2 = LIQUIDITY  (LiquidityModule)
3 = CREATOR    (CreatorFeeModule)
4 = PRIZE      (PrizePool)
5 = MILESTONE  (MilestoneRewardModule)
```
`ModuleAdded.moduleType` selects which template to spawn. Launch mode enum: `0 = BYOL`, `1 = FLAT_CURVE`. Module change type: `0 = ADD`, `1 = REMOVE`, `2 = UPDATE`.

---

## 3. The Dynamic-Data-Source Model (read this carefully)

Each launch clones a `LumoriaToken` + `TaxHandler` (+ optional `FlatCurve`) + N module contracts. The subgraph discovers these at runtime via templates:

- On **`Database.TokenRegistered(token, creator, taxHandler)`** → create `LumoriaToken` template at `token` and `TaxHandler` template at `taxHandler`.
- On **`Generator.FlatCurveLaunched(token, flatCurve, hardCap)`** → create `FlatCurve` template at `flatCurve`.
- On **`TaxHandler.ModuleAdded(moduleType, moduleAddress, ...)`** → create the module template matching `moduleType` at `moduleAddress`. Pass the owning `token` + `taxHandler` via **data-source context** so the module's events can be linked back.

### ⚠️ The same-transaction ordering trap (the #1 thing to get right)

`Generator.generateProject()` does everything in **one transaction**, in this order:

```
1. clone Token + TaxHandler
2. TaxHandler.__init__()   → emits ModuleAdded for EACH initial module
3. Token.__init__()        → emits Transfer (mint 1B supply to Generator)
4. Database.registerToken()→ emits TokenRegistered
5. launch mode             → BYOL: vault PoolInitialized/LiquidityLocked, hook LumoriaPoolInitialized
                             FlatCurve: Generator FlatCurveLaunched
6. emit ProjectGenerated   (last)
```

graph-node templates **only index events emitted after the template is created**. A template spawned while handling `TokenRegistered` (step 4) or `ProjectGenerated` (step 6) **will miss the initial `ModuleAdded` (step 2) and the initial mint `Transfer` (step 3)** — they're earlier in the same transaction.

**Solution — hydrate initial state with contract calls, don't rely on those early same-tx events:**

In the `TokenRegistered` (or `ProjectGenerated`) handler, after creating the templates, **read the launch's initial state directly**:
- `TaxHandler.buyFee()`, `sellFee()` → initial fees.
- `TaxHandler.getModuleCount()` + `getModule(i)` → each initial module's `{ moduleAddress, moduleType, buyAllocation, sellAllocation, active }`. Create a `Module` entity **and** spawn its template here (not from the missed `ModuleAdded`).
- **Per-module type-specific reads** (these have NO event, so they must be call-hydrated): RewardModule → `rewardToken()`, `minDistribution()`; BurnModule → `burnInterval()`, `lastBurnTime()`; LiquidityModule → `liquidityInterval()`, `lastLiquidityTime()`; CreatorFeeModule → `recipient()`. Without this, `Module.rewardToken` / interval fields stay null and the reward/burn panels render blank.
- For FlatCurve launches, read the raise config from the FlatCurve clone when creating the `Raise` (only `hardCap` is in the `FlatCurveLaunched` event): `startTime()`, `endTime()`, `minContribution()`, `maxContribution()`, `tokensForPresale()`, `tokensForLP()`.
- `LumoriaToken.totalSupply()` (and treat the Generator's post-launch balance as the initial holder via `balanceOf` if you need holder accuracy from genesis).

After this bootstrap, **all subsequent changes arrive as normal events in later transactions** (`FeesUpdated`, `ModuleAdded`/`Removed`/`Updated`, `Transfer`, …) and are indexed normally. So: contract-call hydration for the genesis snapshot, events for everything after.

> Prefer `ProjectGenerated` over `TokenRegistered` as the bootstrap handler if you want `name`/`symbol`/`launchMode` in the same callback (they're event fields there). `ProjectGenerated` is emitted last, so the templates you create from it still won't catch the same-tx earlier events — which is fine, because you're hydrating via calls anyway. Use whichever; just hydrate.

---

## 4. Deterministic Pool Identity & the PoolManager

One V4 pool per token. The pool is **never stored in a registry** — it's derived:

```
PoolKey = { currency0: address(0) /* native BNB */, currency1: token,
            fee: 0, tickSpacing: 60, hooks: <LumoriaHook address> }
PoolId  = keccak256(abi.encode(PoolKey))        // bytes32
```

You **do not need to compute it** — the subgraph receives `PoolId` directly:
- `LumoriaHook.LumoriaPoolInitialized(token, poolId)` and `LumoriaLiquidityVault.PoolInitialized(token, poolId, sqrtPriceX96)` both carry it.

Build a **`poolId → token` map** from these so you can attribute canonical `PoolManager.Swap(id, …)` events (keyed by `id = PoolId`) to a token if you index the PoolManager for OHLC.

> ✅ **Settled — do NOT index the PoolManager for price.** The hook's
> `TokenPurchased` / `TokenSold` now carry the post-swap `sqrtPriceX96` + `tick`
> directly (`TOKENOMICS_V2.md` §13.1). One event stream gives you price, volume,
> fee breakdown and per-user attribution, for our pools only. Convert with
> `poolPriceBnbPerToken()` in `src/helpers.ts`:
> `BNB per token = 2^192 / sqrtPriceX96^2` (currency0 = BNB, currency1 = token, both 18dp).
> Candles are built from this **pool mark**, never from execution price — a
> high-tax token would otherwise chart its own fee stack instead of its market.

**Indexing the PoolManager is now unnecessary.** It's a global singleton across *all* V4 pools, so you'd filter every `Swap` by your PoolId set. Cheaper primary path: use the hook's `TokenPurchased`/`TokenSold` (they fire on the same swaps, already carry token + fee breakdown + BNB amounts, and only fire for our pools). Index `PoolManager.Swap` **only** if you want `sqrtPriceX96`-precise OHLC candles; otherwise reconstruct price from the hook events' BNB/token amounts.

---

## 5. Per-Contract Event Reference

Signatures are exact (indexed fields marked). "Emitter" is the concrete contract; some signatures are declared in an `I*` interface but emitted by the implementation.

### 5.1 Database (singleton) — registry, volume, infra

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `TokenRegistered` | `(address indexed token, address indexed creator, address taxHandler)` | every launch (in `generateProject`) | **Bootstrap**: create `Token`, `LumoriaToken` + `TaxHandler` templates, hydrate fees+modules via calls (§3) |
| `VolumeRegistered` | `(address indexed token, address indexed user, uint256 amount)` | hook records a trade | add to `Token.totalVolume` always; add to `UserVolume`/daily only if `user != 0x0` |
| `PlatformFeeUpdated` | `(uint256 oldFee, uint256 newFee)` | owner changes platform fee | update `PlatformConfig` |
| `ModuleMasterCopySet` | `(uint8 indexed moduleType, address indexed masterCopy)` | admin registers a module impl | `ModuleType` registry (rare) |
| `MasterCopyUpdated` | `(string indexed copyType, address indexed newCopy)` | admin upgrades a master copy | audit trail. ⚠️ `string indexed` → topic is the **keccak hash** of the string, not readable; capture the hash |
| `GeneratorUpdated` / `RouterUpdated` / `PoolManagerUpdated` / `HookUpdated` / `LiquidityVaultUpdated` / `FeeReceiverUpdated` / `RebateContractUpdated` | `(address indexed old, address indexed new)` | admin rewires infra | `InfraChange` audit entries |

### 5.2 Generator (singleton) — launches

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `ProjectGenerated` | `(address indexed token, address indexed taxHandler, address indexed creator, string name, string symbol, uint256 buyFee, uint256 sellFee, uint8 launchMode)` | end of every launch | fill `Token` metadata (name/symbol/launchMode); good bootstrap point (see §3) |
| `BYOLLaunched` | `(address indexed token, uint256 platformFee, uint256 tokensForLP, uint256 bnbForLP)` | BYOL branch | record LP-seed split on `Token` |
| `FlatCurveLaunched` | `(address indexed token, address indexed flatCurve, uint256 hardCap)` | FLAT_CURVE branch | create `Raise`, spawn `FlatCurve` template |
| `AllocationMinted` | `(address indexed token, address indexed beneficiary, uint256 amount)` | an `allocations` entry with `duration == 0` | create a `TokenAllocation` (locked=false) → token + beneficiary |
| `AllocationVested` | `(address indexed token, address indexed beneficiary, uint256 indexed scheduleId, uint256 amount, uint64 cliff, uint64 duration)` | an `allocations` entry with `duration > 0` | create a `TokenAllocation` (locked=true) and link to the `VestingSchedule` with `id = scheduleId` (same tx as the VestingVault `ScheduleCreated` — §5.11) |

### 5.3 LumoriaHook (singleton) — the primary trade source

Fires on **every** swap on our pools, regardless of router. This is the canonical trade feed.

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `TokenPurchased` | `(address indexed token, address indexed buyer, uint256 bnbIn, uint256 platformFee, uint256 taxTaken, uint256 tokensOut)` | every buy | create `Trade(kind:"buy")`; price = `bnbIn/tokensOut`; `buyer == 0x0` for unattributed (non-Lumoria-router) routes |
| `TokenSold` | `(address indexed token, address indexed seller, uint256 tokensIn, uint256 platformFee, uint256 taxTaken, uint256 bnbOut)` | every sell | create `Trade(kind:"sell")`; price = `bnbOut/tokensIn`; `seller == 0x0` if unattributed |
| `LumoriaPoolInitialized` | `(address indexed token, bytes32 indexed poolId)` | pool created at launch | set `Token.poolId`; add to `poolId→token` map |

`platformFee` + `taxTaken` are **BNB amounts**. Lifetime platform fee per token, total tax routed, buy/sell counts, and volume/price charts all derive from these two events.

### 5.4 LumoriaLiquidityVault (singleton) — locked liquidity / TVL

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `PoolInitialized` | `(address indexed token, bytes32 indexed poolId, uint160 sqrtPriceX96)` | first liquidity add for a token | record initial price; link poolId |
| `LiquidityLocked` | `(address indexed token, uint256 bnbAmount, uint256 tokenAmount, uint128 liquidity, uint128 totalLocked)` | every locked add (launch + LiquidityModule + later adds) | cumulative locked-liquidity / TVL; `totalLocked` is the running V4 liquidity-unit total |

There is **no removal event** — liquidity is permanent by construction. TVL only grows.

### 5.5 FeeReceiver (singleton) — platform revenue

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `FeeReceived` | `(address indexed from, uint256 amount)` | any BNB in (tagged or not) | total platform revenue |
| `TokenFeeReceived` | `(address indexed token, uint256 amount)` | tagged sends (the hook tags with the token) | per-token platform revenue |
| `FeesWithdrawn` | `(address indexed recipient, uint256 amount)` | owner withdraws | audit |
| `RecipientUpdated` | `(address indexed oldRecipient, address indexed newRecipient)` | owner rotates recipient | audit |

### 5.6 TaxHandler (template, one per token) — fees, modules, tax flow

⚠️ `BuyTaxDistributed`/`SellTaxDistributed` carry `buyer`/`seller == address(0)` (the actor isn't known at this layer) — **trader attribution lives on the hook's `TokenPurchased`/`TokenSold` in the same tx**; join by `tx.hash` if you need both.

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `BuyTaxDistributed` | `(address indexed token, uint256 amount, address indexed buyer)` | buy-side tax delivered mid-swap | per-token tax-BNB inflow (buyer always 0x0) |
| `SellTaxDistributed` | `(address indexed token, uint256 amount, address indexed seller)` | sell-side tax delivered | same (seller always 0x0) |
| `ShareUpdated` | `(address indexed holder, uint256 oldShare, uint256 newShare)` | every token transfer (`setShare`) | holder-share table; powers reward views |
| `ModuleAdded` | `(uint8 indexed moduleType, address indexed moduleAddress, uint256 buyAlloc, uint256 sellAlloc)` | init **and** executed ADD | upsert `Module`; spawn module template (but initial ones are hydrated via calls — §3) |
| `ModuleRemoved` | `(uint8 indexed moduleType, address indexed moduleAddress)` | executed REMOVE | `Module.active = false` |
| `ModuleUpdated` | `(uint8 indexed moduleType, address indexed moduleAddress, uint256 buyAlloc, uint256 sellAlloc)` | allocation change (part of ADD/REMOVE/UPDATE execute) | update `Module.buyAllocation/sellAllocation` |
| `FeesUpdated` | `(uint256 oldBuyFee, uint256 newBuyFee, uint256 oldSellFee, uint256 newSellFee)` | fee change applied (instant or post-timelock) | update `Token.buyFee/sellFee`; append `FeeChange` |
| `FeeChangeProposed` | `(uint256 newBuyFee, uint256 newSellFee, uint256 effectiveTime)` | timelocked fee increase proposed | `PendingChange` (banner/countdown) |
| `FeeChangeCancelled` | `()` | creator cancels | clear pending |
| `ModuleChangeProposed` | `(uint8 changeType, uint8 indexed moduleType, uint256 buyAlloc, uint256 sellAlloc, uint256 effectiveTime)` | any module proposal | `PendingChange` |
| `ModuleRebalanceProposed` | `(uint256[] indices, uint256[] buyAllocs, uint256[] sellAllocs)` | **same tx** as ModuleChangeProposed | merge into the `PendingChange` by `tx.hash` |
| `ModuleChangeCancelled` | `()` | creator cancels | clear pending |
| `ManagementRenounced` | `(address indexed token, uint256 timestamp)` | creator permanently freezes tax/module config (B6) | set `Token.renounced = true`, `Token.renouncedAt = timestamp`; clear any open `PendingChange` |

⚠️ **Module index volatility**: REMOVE uses swap-and-pop, so `modules[]` indices shift. **Key `Module` entities by address, never by index.**

⚠️ **Renounce ends the change stream**: after `ManagementRenounced`, no further `Fee*`/`Module*` proposals or executes can ever fire for that token. Treat `Token.renounced = true` as a terminal state for the Manage/timelock UI.

### 5.7 RebateContract (singleton) — per-token rebate pools

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `RebateFunded` | `(address indexed token, address indexed creator, uint256 amount, uint256 rebateBps)` | creator funds a pool | upsert `Rebate` |
| `RebateToppedUp` | `(address indexed token, uint256 amount, uint256 newBalance)` | creator adds (auto-reactivates) | update balance/active |
| `RebateCredited` | `(address indexed token, address indexed buyer, uint256 tokenAmount)` | hook credits a buyer after a buy | `RebateCredit`; per-buyer bonus history |
| `RebateBpsUpdated` | `(address indexed token, uint256 oldBps, uint256 newBps)` | rate change | update rate |
| `RebateWithdrawn` | `(address indexed token, uint256 amount)` | creator pulls out | update balance |
| `RebateDeactivated` | `(address indexed token)` | pool drained | `Rebate.active = false` |
| `CreditorUpdated` | `(address indexed creditor, bool authorized)` | admin rotates creditor (the hook) | audit |

### 5.8 LumoriaToken (template, one per token) — holders/supply

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `Transfer` | `(address indexed from, address indexed to, uint256 value)` | every transfer (incl. mint from `0x0`, burn to `0x0`) | maintain `Holder.balance`; holder count on 0-crossings; `totalSupply` on mint/burn |
| `Approval` | `(address indexed owner, address indexed spender, uint256 value)` | allowance change | usually ignore (read directly when needed) |

⚠️ The **PoolManager address is excluded from reward-share tracking** on-chain (it's the token's `pair`). It still appears in `Transfer` events (it custodies pool reserves) — count it as a holder if you want, but know it won't accrue reward dividends. ⚠️ Initial 1B mint to the Generator happens pre-registration in the same tx (§3).

### 5.9 Module templates (one instance per module, linked to a token via context)

Spawn the matching template in the `ModuleAdded` handler (and via call-hydration for initial modules). Pass `token` + `taxHandler` in the data-source **context** so these events attribute correctly. ⚠️ Note `TaxReceived` has **different signatures across module types** (different topic0) — that's fine since each template has its own ABI.

**CreatorFeeModule (type 3):**
| Event | Signature | Use |
|---|---|---|
| `TaxAccrued` | `(address indexed recipient, uint256 amount, uint256 owedAfter)` | per-recipient earnings; `Module.totalReceivedBnb`; `CreatorFeeAccrual` |
| `TaxWithdrawn` | `(address indexed recipient, uint256 amount)` | payouts; `Module.totalWithdrawnBnb`; `CreatorFeeWithdrawal` |
| `RecipientUpdated` | `(address indexed oldRecipient, address indexed newRecipient)` | fee-stream ownership transfer |

**RewardModule (type 0):**
| Event | Signature | Use |
|---|---|---|
| `TaxReceived` | `(uint256 amount)` | inflow |
| `DividendsDistributed` | `(uint256 rewardAmount, uint256 bnbSpent)` | distribution cadence; `bnbSpent - rewardAmount` = swap slippage in token mode |
| `RewardClaimed` | `(address indexed holder, uint256 amount)` | per-holder claim history |
| `ShareUpdated` | `(address indexed holder, uint256 oldShare, uint256 newShare)` | mirror of TaxHandler's — can ignore if that's indexed |

**BurnModule (type 1):**
| Event | Signature | Use |
|---|---|---|
| `TaxReceived` | `(uint256 amount, uint256 pendingBNB)` | inflow |
| `BurnExecuted` | `(uint256 bnbSpent, uint256 tokensBurned, uint256 timestamp)` | burn history; supply timeline |
| `IntervalUpdated` | `(uint256 oldInterval, uint256 newInterval)` | cadence audit |

**LiquidityModule (type 2):**
| Event | Signature | Use |
|---|---|---|
| `TaxReceived` | `(uint256 amount, uint256 pendingBNB)` | inflow |
| `LiquidityAdded` | `(uint256 bnbAmount, uint256 tokenAmount, uint256 lpTokens, uint256 timestamp)` | auto-LP history (`lpTokens` = V4 liquidity units locked in the vault) |
| `IntervalUpdated` | `(uint256 oldInterval, uint256 newInterval)` | cadence audit |

**PrizePool (type 4):**
| Event | Signature | Use |
|---|---|---|
| `TaxReceived` | `(uint256 indexed epochId, uint256 amount)` | `PrizeEpoch.pot`; `Module.totalReceivedBnb` |
| `EpochLengthQueued` / `EpochLengthApplied` | `(uint256)` / `(uint256 indexed epochId, uint256 newLength)` | keep the epoch mirror in sync (see below) |
| `RootPosted` | `(uint256 indexed epochId, bytes32 root, uint256 totalWeight, uint256 ticketCount)` | the operator's claim — store next to the DERIVED totals |
| `RootInvalidated` | `(uint256 indexed epochId)` | fraud alarm fired during the challenge window |
| `RandomnessFulfilled` | `(uint256 indexed epochId, uint256 randomWord)` | lottery word |
| `PrizeClaimed` / `LotteryClaimed` | `(epochId, account, amount)` / `(epochId, slot, winner, amount)` | `PrizeClaim`; `PrizeEpoch.paidOut` |
| `PotRolledOver` | `(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount, string reason)` | mark from-epoch rolled over **unless reason == "unclaimed"** (a sweep — the epoch settled fine); credit to-epoch pot |
| `DonatedToRewards` | `(uint256 indexed epochId, address rewardModule, uint256 amount)` | ALL_HOLDERS settlement |

**PrizePool ticket derivation (`src/prize.ts`) — the reference implementation.**
`hook.ts` calls `recordPrizeTicket` for every **attributed, non-module-flow buy**
of a token whose `Token.prizePool` is set: one `PrizeTicket` per buy, append-only,
never merged, `weight = bnbIn` RAW (the lottery `maxWeightBps` cap is applied at
root-build time by `scripts/lib/merkle.js`, not here). Module-flow buys (e.g. a
BurnModule buyback) are tax recursion, not participation — excluded, matching
`scripts/operator/lib/tickets.js`. The `Module.prizeEpoch*` fields mirror
`PrizePool._advance()` exactly (a queued length applies at the first boundary; a
multi-epoch jump uses the old length throughout); PrizePool events carrying an
`epochId` are authoritative sync points for the money buckets. `PrizeEpoch`
stores BOTH the operator's posted `totalWeight/ticketCount` and the derived
ones — **a mismatch during the 6h challenge window is how a third party detects
a fraudulent root** and the reason this template ships with the module. Prize
config (`payoutMode`, `epochLength`, `winnerCount`, `holdRequirementBps`) has no
events — call-hydrated per §3.

**MilestoneRewardModule (type 5):**
| Event | Signature | Use |
|---|---|---|
| `TaxReceived` | `(uint256 amount, uint256 totalAccrued)` | inflow; `Module.totalReceivedBnb` |
| `RewardsReleased` | `(address indexed by, address indexed rewardModule, uint256 amount, uint256 remaining, string reason)` | `MilestoneRelease` entity; `Module.totalReleased`, `Module.lastReleaseTime`. `reason` is the team's public, immutable accountability record — surface verbatim on the token page. `by != creator` means the 18-month public valve fired. |

Milestone hydration note: `Module.lastReleaseTime` needs no contract call — the module's
`__init__` runs in the same tx as `ModuleAdded` / `TokenRegistered`, so the 18-month clock
starts at that block's timestamp. The frontend derives "public release opens at" as
`lastReleaseTime + 540 days` (or reads `publicReleaseAt()` live).

### 5.10 FlatCurve (template, one per raise)

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `ContributionMade` | `(address indexed contributor, uint256 grossAmount, uint256 netAmount, uint256 totalRaised)` | each contribute | `Contribution`; raise progress |
| `ContributionRefunded` | `(address indexed contributor, uint256 refundAmount)` | refund / withdrawOnFailure | refund timeline |
| `PlatformFeeTaken` | `(uint256 amount)` | alongside each contribute | raise platform-fee sum |
| `RaiseLaunched` | `(address indexed token, uint256 totalRaised, uint256 liquidityBNB, uint256 liquidityTokens, uint256 creatorBNB)` | success | `Raise.status = SUCCESS` |
| `RaiseFailed` | `(address indexed token, uint256 totalRaised)` | failure | `Raise.status = FAILED` |
| `TokensClaimed` | `(address indexed contributor, uint256 tokenAmount)` | post-success claim | per-user claim record |

### 5.11 VestingVault (singleton) — vested creator allocations

A **singleton** (not a template), so its events index from the manifest `startBlock` — including `ScheduleCreated` fired **during a launch tx**. No same-tx ordering trap here (the trap only affects dynamically-spawned templates); the vault data source already exists, so genesis schedules are captured normally.

| Event | Signature | Fires when | Handler |
|---|---|---|---|
| `ScheduleCreated` | `(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration)` | Generator creates a vested allocation (`AllocationVested` is emitted in the same tx) | create `VestingSchedule` (id = `id`); link `token` + `beneficiary`; `released = 0` |
| `TokensReleased` | `(uint256 indexed id, address indexed beneficiary, uint256 amount)` | `release(id)` pays out | append `VestingRelease`; `VestingSchedule.released += amount` |

> **Releasable is time-derived, not event-derived.** `VestingSchedule.released` is exact from events, but *current claimable* depends on `block.timestamp` and can't be event-sourced. Compute it client-side (linear+cliff from `start`/`cliff`/`duration`/`total`/`released`) or read `VestingVault.releasable(id)` directly. Don't try to keep a live "releasable" field in the subgraph.

---

## 6. Recommended GraphQL Schema

Expanded from `FRONTEND.md §4`. Adjust as the implementer sees fit, but keep the relationships.

```graphql
type Token @entity {
    id: ID!                       # token address
    creator: Bytes!
    taxHandler: Bytes!
    poolId: Bytes                 # from LumoriaPoolInitialized
    name: String!
    symbol: String!
    decimals: Int!
    launchMode: Int!              # 0 BYOL, 1 FlatCurve
    launchedAt: BigInt!
    launchTx: Bytes!
    buyFee: BigInt!               # current (FeesUpdated)
    sellFee: BigInt!
    renounced: Boolean!           # true after ManagementRenounced (B6) — config frozen forever
    renouncedAt: BigInt           # timestamp of renounce (null until then)
    totalSupply: BigInt!
    holderCount: Int!             # EXCLUDES PoolManager + 0x0 (§1d/§10.8)
    # lifetime aggregates (from hook events)
    totalVolumeBnb: BigInt!       # tokenVolume — all routes
    attributedVolumeBnb: BigInt!  # only hookData-attributed
    buyCount: BigInt!
    sellCount: BigInt!
    totalPlatformFeeBnb: BigInt!  # sum platformFee
    totalTaxBnb: BigInt!          # sum taxTaken
    totalLiquidityLocked: BigInt! # vault totalLocked (V4 units)
    pendingFeeChange: PendingChange
    pendingModuleChange: PendingChange
    rebate: Rebate
    raise: Raise
    modules: [Module!]! @derivedFrom(field: "token")
    trades: [Trade!]! @derivedFrom(field: "token")
    holders: [Holder!]! @derivedFrom(field: "token")
    feeHistory: [FeeChange!]! @derivedFrom(field: "token")
    moduleHistory: [ModuleEvent!]! @derivedFrom(field: "token")
    allocations: [TokenAllocation!]! @derivedFrom(field: "token")
    vestingSchedules: [VestingSchedule!]! @derivedFrom(field: "token")
}

# Creator allocations carved from the remainder at launch (Generator).
type TokenAllocation @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    token: Token!
    beneficiary: Bytes!
    amount: BigInt!
    locked: Boolean!              # false = AllocationMinted (immediate), true = AllocationVested
    schedule: VestingSchedule     # set only when locked (links by scheduleId)
    createdAt: BigInt!
}

# A vested allocation held in the shared VestingVault (linear + cliff, non-revocable).
type VestingSchedule @entity {
    id: ID!                       # VestingVault schedule id (uint256, stringified)
    token: Token!
    beneficiary: Bytes!
    user: User!
    total: BigInt!
    released: BigInt!             # exact from TokensReleased; current "releasable" is time-derived — compute client-side / read releasable(id)
    start: BigInt!
    cliff: BigInt!                # seconds after start
    duration: BigInt!             # seconds
    createdAt: BigInt!
    releases: [VestingRelease!]! @derivedFrom(field: "schedule")
}

type VestingRelease @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    schedule: VestingSchedule!
    beneficiary: Bytes!
    amount: BigInt!
    timestamp: BigInt!
}

type Holder @entity {
    id: ID!                       # token-addr:holder-addr
    token: Token!
    user: User!                   # cross-token holder index (§1f)
    address: Bytes!
    balance: BigInt!
    isPool: Boolean!              # true for the PoolManager — suppress in lists, exclude from holderCount (§1d)
    firstSeen: BigInt!
    lastSeen: BigInt!
}

type User @entity {               # cross-token index (§1f) — powers the multi-token holder dashboard
    id: ID!                       # user address
    holdings: [Holder!]! @derivedFrom(field: "user")
    # rewardClaims / trades: query by holder/trader address filter (Bytes), or
    # promote those fields to User refs if a derived list is needed.
}

type Trade @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    token: Token!
    trader: Bytes!                # 0x0 if unattributed
    attributed: Boolean!          # trader != 0x0
    isModuleFlow: Boolean!        # buyer/seller is a known module address — EXCLUDE from OHLC + organic volume (§1e)
    kind: String!                 # "buy" | "sell"
    bnbIn: BigInt                 # buy
    bnbOut: BigInt                # sell
    tokensIn: BigInt              # sell
    tokensOut: BigInt             # buy
    platformFee: BigInt!
    taxTaken: BigInt!
    priceBnbPerToken: BigDecimal! # derived
    rebateCredited: BigInt        # join RebateCredited in same tx (buys)
    timestamp: BigInt!
    blockNumber: BigInt!
    txHash: Bytes!
}

type Module @entity {
    id: ID!                       # module address
    token: Token!
    taxHandler: Bytes!
    moduleType: Int!              # 0..5
    buyAllocation: BigInt!
    sellAllocation: BigInt!
    active: Boolean!
    addedAt: BigInt!
    totalReceivedBnb: BigInt!     # sum TaxReceived/TaxAccrued
    totalWithdrawnBnb: BigInt!    # sum TaxWithdrawn (Creator)
    # type-specific:
    rewardToken: Bytes            # Reward
    totalDividendsDistributed: BigInt  # Reward
    totalBurned: BigInt           # Burn
    totalBnbSpent: BigInt         # Burn
    totalLpLocked: BigInt         # Liquidity (V4 units)
    recipient: Bytes              # Creator (current; rotates via RecipientUpdated)
    minDistribution: BigInt       # Reward (call-hydrated, §3)
    interval: BigInt              # Burn/Liquidity (call-hydrated; then IntervalUpdated)
    lastExecuted: BigInt          # Burn/Liquidity (BurnExecuted/LiquidityAdded timestamp; for countdowns)
    totalReleased: BigInt         # Milestone (sum RewardsReleased.amount)
    lastReleaseTime: BigInt       # Milestone — 18-month public valve measures from here
    forwards: [CreatorFeeForward!]! @derivedFrom(field: "module")  # Creator: per-recipient history
    releases: [MilestoneRelease!]! @derivedFrom(field: "module")   # Milestone: release history
}

# Milestone releases. `reason` is the team's public, timestamped, immutable
# accountability record; `by != token.creator` means the 18-month valve fired.
type MilestoneRelease @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    module: Module!
    by: Bytes!
    rewardModule: Bytes!
    amount: BigInt!
    remaining: BigInt!
    reason: String!
    timestamp: BigInt!
}

type PendingChange @entity {
    id: ID!                       # token addr (+ "fee" | "module")
    token: Token!
    kind: String!                 # "fee" | "module"
    newBuyFee: BigInt
    newSellFee: BigInt
    changeType: Int               # module: 0 ADD 1 REMOVE 2 UPDATE
    moduleType: Int
    rebalanceIndices: [BigInt!]
    rebalanceBuyAllocs: [BigInt!]
    rebalanceSellAllocs: [BigInt!]
    effectiveTime: BigInt!
    proposedAt: BigInt!
    proposedTx: Bytes!
    status: String!               # "pending" | "executed" | "cancelled"
}

type FeeChange @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    token: Token!
    oldBuyFee: BigInt!  newBuyFee: BigInt!
    oldSellFee: BigInt! newSellFee: BigInt!
    kind: String!                 # "instant" | "timelocked"
    timestamp: BigInt!
}

type ModuleEvent @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    token: Token!
    kind: String!                 # "added"|"removed"|"updated"|"proposed"|"cancelled"
    module: Bytes
    moduleType: Int
    buyAllocation: BigInt
    sellAllocation: BigInt
    timestamp: BigInt!
}

type RewardClaim @entity(immutable: true)   { id: ID! module: Module! holder: Bytes! amount: BigInt! timestamp: BigInt! }
type BurnExecution @entity(immutable: true) { id: ID! module: Module! bnbSpent: BigInt! tokensBurned: BigInt! timestamp: BigInt! }
type LiquidityInjection @entity(immutable: true) { id: ID! module: Module! bnbAmount: BigInt! tokenAmount: BigInt! liquidity: BigInt! timestamp: BigInt! }
type CreatorFeeForward @entity(immutable: true) { id: ID! module: Module! recipient: Bytes! amount: BigInt! timestamp: BigInt! }  # per-recipient earnings across rotations (§1b)

type Rebate @entity {
    id: ID!                       # token addr
    token: Token!
    creator: Bytes!
    rebateBps: BigInt!
    fundedBalance: BigInt!        # also DECREMENT by RebateCredited.tokenAmount, else it drifts high (§1h)
    active: Boolean!
    totalCreditedTokens: BigInt!
    credits: [RebateCredit!]! @derivedFrom(field: "rebate")
}
type RebateCredit @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    rebate: Rebate!
    token: Token!
    buyer: Bytes!
    amount: BigInt!
    timestamp: BigInt!
}

type Raise @entity {
    id: ID!                       # flatCurve address
    token: Token!
    flatCurve: Bytes!
    hardCap: BigInt!
    totalRaised: BigInt!
    contributorCount: Int!
    startTime: BigInt!            # window/cap config (call-hydrated) — client derives PENDING/CAPPED/ENDED (§4)
    endTime: BigInt!
    minContribution: BigInt!
    maxContribution: BigInt!
    tokensForPresale: BigInt!     # stranded supply if FAILED
    tokensForLP: BigInt!          # stranded supply if FAILED
    status: String!               # "ACTIVE" | "SUCCESS" | "FAILED" (time-states derived client-side)
    liquidityBnb: BigInt
    creatorBnb: BigInt
    contributions: [Contribution!]! @derivedFrom(field: "raise")
}
type Contribution @entity {
    id: ID!                       # raise-addr:contributor
    raise: Raise!
    contributor: Bytes!
    grossContributed: BigInt!
    netContributed: BigInt!
    refunded: BigInt!
    claimed: BigInt!
}

type UserVolume @entity {
    id: ID!                       # token-addr:user-addr
    token: Token!
    user: Bytes!
    volumeBnb: BigInt!            # attributed only
}

type TokenDayData @entity {       # OHLCV candles (daily)
    id: ID!                       # token-addr:dayStartUnix
    token: Token!
    date: Int!
    open: BigDecimal!  high: BigDecimal!  low: BigDecimal!  close: BigDecimal!
    volumeBnb: BigInt!
    txCount: BigInt!
}
type TokenHourData @entity {      # intraday candles — REQUIRED for the trade widget chart (§1a)
    id: ID!                       # token-addr:hourStartUnix
    token: Token!
    periodStart: Int!
    open: BigDecimal!  high: BigDecimal!  low: BigDecimal!  close: BigDecimal!
    volumeBnb: BigInt!
    txCount: BigInt!
}
type TokenMinuteData @entity {    # A3 — 5-min candles for the 5m/15m chart timeframes (15m is the UI default)
    id: ID!                       # token-addr:minuteBucketUnix (5-min buckets)
    token: Token!
    periodStart: Int!
    open: BigDecimal!  high: BigDecimal!  low: BigDecimal!  close: BigDecimal!
    volumeBnb: BigInt!
    txCount: BigInt!
}
# ⚠️ Candle + organic-volume handlers MUST skip Trade.isModuleFlow == true (§1e).

type PlatformConfig @entity {     # singleton id="1"
    id: ID!
    platformFeeBps: BigInt!
    totalFeesReceivedBnb: BigInt!
    totalTokens: Int!
    totalVolumeBnb: BigInt!        # A1 — platform-wide cumulative trade volume (sum of VolumeRegistered)
    creatorCount: Int!            # A2 — distinct creators ("active builders"); bump on first TokenRegistered per creator
}

type PlatformDayData @entity {    # A1 — daily platform volume, powers the landing "Trading Volume" 7d delta
    id: ID!                       # dayStartUnix
    date: Int!
    volumeBnb: BigInt!
    feesBnb: BigInt!
    newTokens: Int!
}

type HolderDayData @entity {      # A4 — per-holder per-token end-of-day balance (portfolio value-over-time)
    id: ID!                       # holder-addr:token-addr:dayStartUnix
    holder: Bytes!
    token: Token!
    date: Int!
    balance: BigInt!              # value-over-time = Σ(balance × TokenDayData.close) without replaying Transfers
}
```

---

## 7. Entity Relationships

```
Token 1───* Holder
Token 1───* Trade ──(same tx)── RebateCredit
Token 1───* Module 1───* {RewardClaim | BurnExecution | LiquidityInjection}
Token 1───1 Rebate 1───* RebateCredit
Token 1───1 Raise  1───* Contribution        (FlatCurve launches only)
Token 1───* FeeChange / ModuleEvent / TokenDayData / UserVolume
Token 0/1─ PendingChange (fee) + PendingChange (module)
poolId ──map──> Token                          (for optional PoolManager.Swap)
PlatformConfig (singleton)
```

---

## 8. Derived / Aggregated Data the UI Needs

- **Holder count** → increment when a `Holder.balance` crosses 0→+, decrement on →0 (from `Transfer`).
- **Price + OHLC** (`TokenDayData`) → from hook `TokenPurchased`/`TokenSold` BNB÷token ratios (or `PoolManager.Swap` `sqrtPriceX96` if indexed). Update open/high/low/close/volume per day bucket.
- **24h / windowed volume, "top tokens"** → aggregate `Trade` (or daily snapshots). `Token.totalVolumeBnb` counts all routes; `attributedVolumeBnb` only Lumoria-router trades.
- **TVL / "liquidity locked"** → cumulative from vault `LiquidityLocked.totalLocked` (only grows).
- **Lifetime burns / rewards / auto-LP** → accumulate module events.
- **Platform revenue** → `FeeReceiver.FeeReceived` (total) + `TokenFeeReceived` (per token).
- **Creator dashboard** → `FeeChange` + `ModuleEvent` + live `PendingChange`; `Token.renounced` is terminal (no more changes once true).
- **Platform volume + 7d delta (A1)** → maintain `PlatformConfig.totalVolumeBnb` and a `PlatformDayData` bucket from `Database.VolumeRegistered` (and `FeeReceiver` for `feesBnb`).
- **Active builders (A2)** → `PlatformConfig.creatorCount`, incremented on the *first* `TokenRegistered` for each distinct creator.
- **5m/15m candles (A3)** → `TokenMinuteData` (5-min buckets) from the hook trade events, same as `TokenHourData` but finer; skip `isModuleFlow`.
- **Portfolio value-over-time (A4)** → snapshot `HolderDayData.balance` on `Transfer`; value = Σ(balance × `TokenDayData.close`).
- **Vesting (Portfolio)** → `VestingSchedule` by beneficiary (`getBeneficiarySchedules` mirror); current claimable is time-derived — compute client-side or read `releasable(id)`, don't store it.
- **Creator allocations** → `TokenAllocation` per token (locked vs immediate); the locked ones join to `VestingSchedule` by id.

---

## 9. Manifest Sketch (subgraph.yaml)

```yaml
dataSources:
  - Database        # events: TokenRegistered, VolumeRegistered, PlatformFeeUpdated,
                    #         ModuleMasterCopySet, *Updated(infra), MasterCopyUpdated
  - Generator       # ProjectGenerated, BYOLLaunched, FlatCurveLaunched
  - LumoriaHook     # TokenPurchased, TokenSold, LumoriaPoolInitialized
  - LumoriaLiquidityVault   # PoolInitialized, LiquidityLocked
  - FeeReceiver     # FeeReceived, TokenFeeReceived, FeesWithdrawn, RecipientUpdated
  - RebateContract  # RebateFunded, RebateToppedUp, RebateCredited, RebateBpsUpdated,
                    #            RebateWithdrawn, RebateDeactivated, CreditorUpdated
  - VestingVault    # ScheduleCreated, TokensReleased
  # - PoolManager   # OPTIONAL: Swap (filter by our PoolIds) for sqrtPrice OHLC
templates:
  - LumoriaToken        # Transfer (+ Approval)
  - TaxHandler          # fees + module + share + tax-distributed events + ManagementRenounced
  - CreatorFeeModule    # TaxAccrued, TaxWithdrawn, RecipientUpdated
  - RewardModule        # TaxReceived, DividendsDistributed, RewardClaimed, ShareUpdated
  - BurnModule          # TaxReceived, BurnExecuted, IntervalUpdated
  - LiquidityModule     # TaxReceived, LiquidityAdded, IntervalUpdated
  - PrizePool           # TaxReceived, EpochLength*, RootPosted/Invalidated,
                        #   RandomnessFulfilled, Prize/LotteryClaimed, PotRolledOver, DonatedToRewards
  - MilestoneRewardModule  # TaxReceived, RewardsReleased
  - FlatCurve           # contribute/refund/launch/claim lifecycle
```

Each `template` instance is created from the spawning event (§3) with `context` carrying `{ token, taxHandler }` where relevant. Use the committed ABIs in `artifacts/` (or `abi/` exports) for codegen — don't hand-write ABIs.

---

## 10. Consolidated Gotchas (don't skip)

1. **Same-tx ordering** — initial `ModuleAdded` + initial mint `Transfer` fire *before* `TokenRegistered`/`ProjectGenerated` in the launch tx; a template created there misses them. **Hydrate genesis state via contract calls** (§3).
2. **`address(0)` actors** — `BuyTaxDistributed`/`SellTaxDistributed` always have a zero buyer/seller; real trader is on the hook event in the same tx. Join by `tx.hash`.
3. **Unattributed trades** — non-Lumoria-router swaps (aggregators/Universal Router) emit `TokenPurchased`/`TokenSold` with `buyer/seller == 0x0`, no rebate, and don't bump `UserVolume`. They DO count toward `Token.totalVolumeBnb` and are fully taxed.
4. **Module index volatility** — REMOVE uses swap-and-pop; key `Module` by **address**, never index.
5. **`ModuleChangeProposed` + `ModuleRebalanceProposed`** are two events in one tx — merge by `tx.hash`.
6. **`string indexed`** (`MasterCopyUpdated.copyType`) → topic is a keccak hash, not the string. Don't expect a readable value.
7. **PoolManager is a global singleton** — only index it if you want `sqrtPrice` OHLC, and filter `Swap` to your PoolIds; otherwise use hook events.
8. **PoolManager address excluded from reward shares** — it's the token's `pair`; it holds reserves and shows in transfers but earns no dividends.
9. **Tax recursion** — Burn/Liquidity modules trade through the router, which re-emits `TokenPurchased` + tax events. Module-level "BNB in" exceeds raw `execute*` counts by design; don't double-count it as organic volume if you separate organic vs module flow.
10. **No liquidity-removal event exists** — TVL is monotonic; never decrement it.
11. **Start blocks** — use `deployments/<net>.json`'s `startBlock` for all data sources. Templates need no start block (created dynamically).
12. **Pending-change execute has no dedicated event** — `executeFeeChange()` emits only `FeesUpdated` (which also fires for *instant* decreases that never had a pending change). Handler: on `FeesUpdated`, if a `PendingChange(kind:"fee")` exists for the token AND its `(newBuyFee,newSellFee)` match → mark it `executed`, null the pointer, set `FeeChange.kind="timelocked"`; else `kind="instant"`. Mirror for module changes (execution arrives as `ModuleAdded`/`Removed`/`Updated`). This inference is the most bug-prone handler — get it right.
13. **Module-recursion trades** — Burn/Liquidity modules trade through the router and re-emit `TokenPurchased`/`TokenSold`. Set `Trade.isModuleFlow = true` when the buyer/seller is a known module address (you index them all) and **exclude those trades from OHLC candles and organic volume** (§1e). They're real swaps, but counting them as organic price/volume double-counts.
14. **Renounce is terminal** — after `TaxHandler.ManagementRenounced`, no further fee/module proposals or executes ever fire for that token. Set `Token.renounced = true`, clear any open `PendingChange`, and treat it as a final state in the Manage UI. It also freezes the **rebate** controls: `RebateBpsUpdated` / `RebateWithdrawn` / `RebateFunded` stop firing for that token (only `RebateToppedUp` / `RebateCredited` can still fire). There's no dedicated rebate-renounce event — it's the read `RebateContract.isManagementRenounced(token)`, which mirrors `Token.renounced`.
15. **Vesting "releasable" is time-derived** — `VestingSchedule.released` is exact from `TokensReleased`, but *current claimable* depends on `block.timestamp`. Compute it client-side (linear+cliff) or read `VestingVault.releasable(id)`; never store a live releasable field in the subgraph.
16. **VestingVault is a singleton, not a template** — its `ScheduleCreated` fires during the launch tx but is captured normally (the vault data source predates the launch). The same-tx trap (#1) is template-only.

---

## 11. Frontend Review — Resolutions & Priorities

The frontend/UI lead reviewed this spec against FRONTEND.md (2026-06-17). **Outcome: no contract changes are required for launch** — every UI datum has an event or a cheap view; the items without an event (`Module.rewardToken`, intervals, raise config) are handled by call-hydration (§3). Resolved decisions (already folded into the schema/handlers above):

- **OHLC source** → use the **hook's** `TokenPurchased`/`TokenSold` as the canonical price feed (fires only for our pools, carries token + BNB amounts). Index `PoolManager.Swap` only later if sqrtPrice/TWAP precision is wanted. **Add intraday candles** (`TokenHourData`, optionally minute) — day candles alone don't drive a trade widget. Exclude `isModuleFlow` trades.
- **Rebate display** → the same-tx `Trade.rebateCredited` join is sufficient; no unified on-chain field needed. The live buy quote's projected bonus is a client read.
- **Cross-token holder view** → **add** the `User` entity + `Holder.user` link (done) — required for the multi-token holder dashboard.
- **Module stats** → **decode in the subgraph** (per-type `Module` fields) rather than client-side. Keep `getUnpaidRewards(holder)` as a live direct read (never subgraph it).
- **Pending-change UX** → `PendingChange` is enough to render the banner; the gap was the **execute→executed transition** — now specified in §10.12. Button-enable should read `block.timestamp ≥ effectiveTime` live.
- **FlatCurve state machine** → keep `status` at `ACTIVE|SUCCESS|FAILED`; derive PENDING/CAPPED/ENDED client-side from the **stored config** (`startTime`/`endTime`/`hardCap`/`totalRaised`, now on `Raise`). The subgraph can't track time-only transitions (no triggering event).
- **Failed-raise stranded supply** → `tokensForPresale`/`tokensForLP` now on `Raise`; a failed-raise page can show "X tokens permanently stranded." Low priority.

### Priority for the subgraph implementer

**Must-have before launch (correctness of the core trade / launch / creator surfaces):**
1. **Deploy-block `startBlock`** — ✅ now recorded by `deploy-base.js` (§1). Use it as the manifest start block.
2. **`Trade.isModuleFlow`** + exclude module-recursion trades from OHLC & organic volume (§1e / §10.13) — else price + headline volume are wrong.
3. **Intraday candles** `TokenHourData` (§1a) — the trade-widget chart.
4. **Pending-change execute→executed** handler (§10.12) — creator dashboard correctness.
5. **`holderCount` excludes PoolManager + 0x0** (§1d) — otherwise every count is off by one.
6. **Call-hydrate `Module.rewardToken` + `minDistribution`** (§2d / §3) — else the reward panel is blank.

**Nice-to-have (polish, post-launch OK):**
- `User` entity / `Holder.user` cross-token index (separate dashboard page).
- `CreatorFeeForward` per-recipient earnings history (multi-wallet fee splits).
- `Rebate.fundedBalance` decrement on `RebateCredited` (§1h) — or document the direct read.
- Extra `Raise` fields (`contributorCount`, window/cap config) to save client reads.
- `Module` interval / `lastExecuted` for server-rendered burn/liquidity countdowns (client read works today).
- Readable `MasterCopyUpdated.copyType` — admin-audit legibility only; won't-fix unless a contract revision is already happening.

### 2026-06-18 update — drift resolution folded in

The full drift audit was resolved in **`docs/CONTRACTS_DRIFT_RESOLUTION.md`** (the answer-back for the frontend team). Net effect on the subgraph: three new on-chain capabilities were built and are now in this spec, plus four cheap aggregates were approved.

**New (built) — now in the schema/manifest above:**
- **B6 renounce** → `TaxHandler.ManagementRenounced` → `Token.renounced`/`renouncedAt` (§5.6, §10.14).
- **B1 vesting** → `VestingVault` data source (§5.11) → `VestingSchedule` + `VestingRelease`.
- **B2 allocations** → `Generator.AllocationMinted`/`AllocationVested` (§5.2) → `TokenAllocation` (+ link to `VestingSchedule`).

**Approved aggregates (A1–A4) — now in the schema:** `PlatformConfig.totalVolumeBnb`/`creatorCount`, `PlatformDayData`, `TokenMinuteData` (5m), `HolderDayData`. Treat A1/A2 as must-haves for the landing metrics; A3/A4 are polish (derivable client-side short-term).

**No-ops for the subgraph:** B3 (multi CreatorFeeModule — already covered by `Module`/`CreatorFeeForward`), B4/B5 (continuous rewards + `minDistribution` — already call-hydrated), B7/B8/B9 (cut), B10 (metadata is **off-chain** — the subgraph does not carry logo/description; the frontend joins it by token address).

---

*Feed this doc to the subgraph agent to scaffold. Keep in lock-step with DESIGN.md / FRONTEND.md.*
