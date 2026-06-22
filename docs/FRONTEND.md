# Lumoria Frontend & Subgraph Integration Notes

Living document. **Every time a contract event, storage field, or external function changes, update this doc.** This is what the frontend team (and subgraph) will build against, and it's the contract-side source of truth for what a UI needs to know.

Keep in sync with `DESIGN.md` (contract spec) and `ROADMAP.md` (build status). When a phase lands, move its sections from 🟡 "pending" to 🟢 "live".

---

## Table of Contents

1. [Data Source Philosophy](#1-data-source-philosophy)
2. [Per-Contract Reference](#2-per-contract-reference)
   - [Database](#21-database-)
   - [LumoriaToken](#22-lumoriatoken-)
   - [FeeReceiver](#23-feereceiver-)
   - [TaxHandler](#24-taxhandler-)
   - [CreatorFeeModule](#25-creatorfeemodule-)
   - [RewardModule](#26-rewardmodule-)
   - [BurnModule](#27-burnmodule-)
   - [LiquidityModule](#28-liquiditymodule-)
   - [LumoriaHook + V4 PoolManager](#29-lumoriahook--uniswap-v4-poolmanager-)
   - [LumoriaSwapRouter + LiquidityVault](#210-lumoriaswaprouter--liquidityvault-)
   - [RebateContract](#211-rebatecontract-)
   - [Generator](#212-generator-)
   - [FlatCurve](#213-flatcurve-)
   - [VestingVault](#214-vestingvault-)
3. [Canonical UI Flows](#3-canonical-ui-flows)
4. [Subgraph Entity Sketch](#4-subgraph-entity-sketch)
5. [Open Questions / TODO](#5-open-questions--todo)

Phase legend: 🟢 live, 🟡 pending, ⚪ future

---

## 1. Data Source Philosophy

Three kinds of data. The UI should always pick the cheapest correct source:

### Direct RPC reads (wagmi / viem / ethers `readContract`)
**When to use:** current authoritative state. Balances, allowances, pending timelock state, current fees, current module list, pending rebate balance, unclaimable rewards.

**Why:** always up-to-date, no indexer lag, no extra infrastructure. Cheap to batch via `multicall`.

**Caveats:** can't read historical state or aggregate across time (use subgraph for that).

### Subgraph queries (GraphQL)
**When to use:** history, aggregations, cross-contract joins, charts, feeds.

Examples:
- Price chart OHLC candles → aggregate the V4 PoolManager's `Swap` events (filter by our PoolIds), or reconstruct from the hook's `TokenPurchased`/`TokenSold`.
- "Top tokens by 24h volume" → aggregate `TokenPurchased` / `TokenSold` from the **LumoriaHook** (fires on every swap, any router — aggregator trades included).
- User's trade history → filter by trader address.
- Holder list per token → from `Transfer` events on each LumoriaToken.
- Lifetime burns / lifetime rewards distributed per token → accumulate module events.
- Creator dashboard: every pending + executed fee change ever → `FeeChangeProposed` / `FeesUpdated` stream.

**Why:** indexing + aggregation is what subgraphs are for. Doing this with RPC scans would DOS an RPC.

### Direct tx writes (user signs in wallet)
All state-changing interactions. The UI surfaces the tx, the user signs it, the UI waits for inclusion + confirmation and optimistically updates (or re-reads state).

### Rule of thumb
- If it's **about now**, read it directly.
- If it's **about over time**, query the subgraph.
- Balance displays: direct read with a subgraph-backed refresh when relevant events fire (via websocket or polling).

---

## 2. Per-Contract Reference

Each contract section follows the same template so the doc is skimmable. When a contract is built, move its status from 🟡 to 🟢 and fill in the details.

### 2.1 Database 🟢

Central registry. Cheap to read; rarely changes.

**Key reads (direct RPC):**
- `isLumoriaToken(token)` → bool — for any "is this a Lumoria token?" gate in the UI (e.g. external token lookups, token lists).
- `tokenCreator(token)` → creator address.
- `tokenTaxHandler(token)` → address of the per-token TaxHandler.
- `allTokensLength()` + `allTokens(i)` → on-chain iteration. For listing, prefer the subgraph.
- `platformFeeBps()` → current platform fee (100 = 1%).
- `generator()`, `router()`, `poolManager()`, `hook()`, `liquidityVault()`, `vestingVault()`, `wbnb()`, `feeReceiver()`, `rebateContract()` → infrastructure addresses. Cache aggressively; these change rarely. (`wbnb` is only the legacy path marker — pools are native-BNB.)
- `userVolume(token, user)`, `tokenVolume(token)` → lifetime volume counters. Prefer the subgraph for recent / windowed volume. Note: `userVolume` only accrues for swaps routed with hookData attribution (our router); `tokenVolume` counts everything.

**Key writes:**
- None from end users. All setters are `onlyOwner` / `onlyGenerator` / hook-gated.

**Events to index in subgraph:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TokenRegistered(token, creator, taxHandler)` | Generator finalizes a new token launch | Create `Token` entity with creator + taxHandler pointers |
| `VolumeRegistered(token, user, amount)` | Hook records a trade (`user = address(0)` for unattributed third-party routes) | Aggregate into `TokenDailyVolume` / `UserVolume` entities |
| `PlatformFeeUpdated(oldFee, newFee)` | Owner changes the flat platform fee | Rare; log to `PlatformConfigChange` |
| `ModuleMasterCopySet(moduleType, masterCopy)` | Admin registers a new module implementation | Track available module types |
| `GeneratorUpdated`, `RouterUpdated`, `PoolManagerUpdated`, `HookUpdated`, `LiquidityVaultUpdated`, `VestingVaultUpdated`, `FeeReceiverUpdated`, `RebateContractUpdated` | Admin upgrades core infra | Audit trail |
| `MasterCopyUpdated(copyType, newCopy)` | Admin upgrades master copies | Audit trail |

**UI surfaces:**
- "All tokens" page → subgraph listing, falls back to on-chain iteration if subgraph is unavailable.
- Admin dashboard (platform owner only) → read all system config directly.

---

### 2.2 LumoriaToken 🟢

Per-token clean ERC20 with TaxHandler holder tracking.

**Key reads (direct RPC):**
- Standard ERC20: `name()`, `symbol()`, `decimals()`, `totalSupply()`, `balanceOf(addr)`, `allowance(owner, spender)`.
- `pair()`, `taxHandler()`, `creator()` → useful links for the token's dashboard page. **V4 note:** `pair()` returns the PoolManager address (the reserve-custody venue excluded from reward-share tracking); the tradable pool itself is identified by `poolId = keccak256(abi.encode(poolKey))` — see §2.9.

**Key writes:**
- `transfer(to, amount)`, `transferFrom(from, to, amount)`, `approve(spender, amount)` — standard.
- `burn(amount)` — user burns their own tokens (reduces `totalSupply`, updates share in TaxHandler).

**Events to index in subgraph:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `Transfer(from, to, value)` | Every transfer (including mint-on-init and burn-to-zero) | Build `Holder` entity (balance per token, rank by balance), compute holder count |
| `Approval(owner, spender, value)` | Allowance change | Usually ignored by the subgraph; read directly when needed |

**Subgraph-derived entities:**
- `Holder { token, address, balance, firstSeen, lastSeen }`
- `Token.holderCount` — incremented when `Holder.balance` crosses 0.

**UI surfaces:**
- Token page: "Holder count", "Top holders" → subgraph.
- Wallet balance → direct read with event-driven refresh.
- Burn button → direct write.

**⚠️ Gotcha:** `ITaxHandler.setShare` is called from inside `transfer` on both sender and recipient. If a future RewardModule is added post-launch, *existing holders* who haven't transacted since the add won't have their share registered in the new module. Known limitation documented in the RewardModule section.

---

### 2.3 FeeReceiver 🟢

Single collector for platform 1% BNB fees. Owner-managed.

**Key reads:**
- `totalReceived()` → lifetime BNB collected (stats page).
- `feesByToken(token)` → per-token lifetime platform fees (analytics).
- `recipient()` → current withdraw destination.

**Key writes:**
- `receiveFee(token)` payable — called by Router/FlatCurve/Generator with a token tag.
- `receive()` payable — untagged fallback.
- `withdraw()` — owner only.
- `setRecipient(newRecipient)` — owner only.

**Events to index:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `FeeReceived(from, amount)` | Any BNB-in (tagged or untagged) | Platform revenue stream |
| `TokenFeeReceived(token, amount)` | Tagged sends only — attributes fees to tokens | Per-token platform revenue |
| `FeesWithdrawn(recipient, amount)` | Owner withdraws | Audit trail |
| `RecipientUpdated(old, new)` | Owner rotates recipient | Audit trail |

**UI surfaces:** platform analytics dashboard only — no end-user interaction.

---

### 2.4 TaxHandler 🟢

Per-token orchestrator. Distributes BNB tax to modules, holds timelock state, aggregates holder shares.

**Key reads:**
- `buyFee()`, `sellFee()` → current fees in bps.
- `token()`, `creator()` → references.
- `getModuleCount()`, `getModule(i)` → enumerate modules live.
- `shares(holder)`, `totalShares()` → share state (largely for module debugging; holders see it through RewardModule).
- `pendingFeeChange()` → `{ newBuyFee, newSellFee, effectiveTime, pending }` — UI shows a banner if pending.
- `pendingModuleChange()` → `{ changeType, moduleType, moduleIndex, buyAllocation, sellAllocation, initPayload, effectiveTime, pending }`.
- `pendingRebalanceLength()` + `pendingRebalance(i)` → enumerate the rebalance array of a pending proposal.
- `totalBuyTaxReceived()`, `totalSellTaxReceived()` → analytics.
- `managementRenounced()` → `bool` — `true` once the creator has permanently frozen this token's tax/module config (B6). Drives the Manage "Locked vs Editable" status pill.

**Key writes (creator only unless noted):**
- `proposeFeeChange(newBuy, newSell)` — instant if both decrease, else 24h timelock.
- `executeFeeChange()`, `cancelFeeChange()`.
- `proposeModuleAdd(type, buyAlloc, sellAlloc, initPayload, AllocationUpdate[] rebalance)` — atomic add + rebalance.
- `proposeModuleRemove(index, AllocationUpdate[] rebalance)` — atomic remove + rebalance.
- `proposeModuleUpdate(AllocationUpdate[] updates)` — bulk allocation rewrites.
- `executeModuleChange()`, `cancelModuleChange()`.
- `renounceManagement()` — **one-way, permanent.** Freezes all fee/module changes forever (even a decrease) and cancels any pending change. Backs the Manage "Lock Token" action. After this, all propose/execute calls revert `"Renounced"`.
- `receiveBuyTax()` / `receiveSellTax()` payable — called by the **LumoriaHook** mid-swap (permissionless deposits; depositing tax is harmless).
- `setShare(holder, amount)` — **Token-only**.

> **⚠️ R1 — the timelock is real; the UI must honor it.** Fee/module edits are **not** instant (except a fee *decrease*). The Manage dashboard must show a pending-change banner, an effective-time countdown, and a cancel-pending control driven by `pendingFeeChange()` / `pendingModuleChange()` + the `*Proposed`/`*Cancelled` events. See `CONTRACTS_DRIFT_RESOLUTION.md` §2 (R1).

**Events to index:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `BuyTaxDistributed(token, amount, buyer)` | Hook delivers buy-side tax BNB mid-swap | Per-token tax BNB flow chart; buyer is `address(0)` here — trader attribution lives on the hook's `TokenPurchased` event in the same tx |
| `SellTaxDistributed(token, amount, seller)` | Hook delivers sell-side tax BNB | Same as above |
| `ShareUpdated(holder, oldShare, newShare)` | Token calls `setShare` (every transfer) | Build holder-by-token table, drive RewardModule holder pages |
| `ModuleAdded(moduleType, moduleAddress, buyAlloc, sellAlloc)` | Module created at init or via executed ADD proposal | Build `Module` entity, link to token |
| `ModuleRemoved(moduleType, moduleAddress)` | Executed REMOVE proposal | Mark `Module.active = false` |
| `ModuleUpdated(moduleType, moduleAddress, buyAlloc, sellAlloc)` | Any allocation change (part of ADD/REMOVE/UPDATE execute) | Update `Module.buyAlloc/sellAlloc` |
| `FeesUpdated(oldBuy, newBuy, oldSell, newSell)` | Fee change applied (instant or after timelock) | Historical fee chart |
| `FeeChangeProposed(newBuy, newSell, effectiveTime)` | Timelocked fee increase proposed | Drive "pending change" banner, notifications |
| `FeeChangeCancelled()` | Creator cancels pending fee change | Banner dismissal |
| `ModuleChangeProposed(changeType, moduleType, buyAlloc, sellAlloc, effectiveTime)` | Any module proposal | Same banner / notifications system |
| `ModuleRebalanceProposed(indices[], buyAllocs[], sellAllocs[])` | Emitted alongside ModuleChangeProposed with the rebalance array — same tx | Subgraph should associate by tx hash |
| `ModuleChangeCancelled()` | Creator cancels pending module change | Banner dismissal |
| `ManagementRenounced(token, timestamp)` | Creator permanently freezes tax/module config (B6) | Set `Token.renounced = true`; flip the Manage status pill to "Locked / Renounced" |

**UI surfaces:**
- **Creator dashboard** (for tokens they created): propose/cancel/execute fee & module changes. Pending state displayed prominently with a countdown to `effectiveTime`.
- **Token info panel**: list of modules (type, allocations). Pending-change banner if `pendingFeeChange.pending` or `pendingModuleChange.pending`.
- **Historical fee chart**: subgraph-backed timeline of `FeesUpdated`.

**⚠️ Subgraph mapping note:** `ModuleChangeProposed` and `ModuleRebalanceProposed` are emitted in the **same transaction**. A GraphQL `ModuleProposal` entity should merge them via `tx.hash`.

---

### 2.5 CreatorFeeModule 🟢

Simplest module. Forwards BNB to a recipient.

**Reads:** `taxHandler`, `recipient`, `totalPaid`, `getModuleType()` (returns 3), `getStats()` (returns `(recipient, totalPaid)`).

**Writes:**
- `receiveTax()` payable — TaxHandler only.
- `setRecipient(newRecipient)` — **current recipient only** (not creator). Allows selling/transferring the fee stream.

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TaxForwarded(recipient, amount)` | Every tax receipt > 0 | Per-recipient fee stream chart |
| `RecipientUpdated(oldRecipient, newRecipient)` | `setRecipient` called | Audit trail of fee-stream ownership |

**UI surfaces:** "Creator earnings" stat on token page (direct read `totalPaid`). Recipient rotation form (visible only to current recipient).

---

### 2.6 RewardModule 🟢

Dividend distribution. Two modes: BNB (`rewardToken = address(0)`) or arbitrary ERC20 via external router swap.

**Reads:**
- `rewardToken`, `externalRouter`, `externalWBNB`, `minDistribution`, `pendingBNB` (BNB mode only).
- `dividendsPerShare`, `totalSharesTracked`, `totalDividendsDistributed`, `totalDividendsWithdrawn`.
- `shares(holder)`, `dividendCheckpoint(holder)`, `creditedDividends(holder)`, `withdrawnDividends(holder)`.
- **`getUnpaidRewards(holder)`** — **the critical frontend read**. Returns live claimable amount.

**Writes:**
- `receiveTax()` payable — TaxHandler only.
- `triggerDistribution()` — **permissionless**, anyone can nudge a distribution once `minDistribution` threshold is met. UI can expose as a "refresh rewards" button with small BNB gas cost.
- `claimReward()` — user claims their unpaid.
- `setShare(holder, amount)` — TaxHandler only.

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TaxReceived(amount)` | Tax delivered from TaxHandler | Tax-inflow chart per module |
| `DividendsDistributed(rewardAmount, bnbSpent)` | A distribution round crystallizes (auto in receiveTax / triggerDistribution) | Distribution cadence chart; for token-mode, `bnbSpent - rewardAmount` is the swap slippage |
| `RewardClaimed(holder, amount)` | User claims | Per-user earnings tally |
| `ShareUpdated(holder, oldShare, newShare)` | Mirror of TaxHandler's `ShareUpdated` | Can be ignored if TaxHandler's event is already indexed |

**UI surfaces:**
- **Holder page** ("My rewards"): per-token claimable balance — `getUnpaidRewards(msg.sender)` direct read. Claim button → `claimReward()` write. Historical claims → subgraph.
- **Token info panel**: "Lifetime rewards distributed" / "Reward token" / "Min distribution threshold".
- **Keeper incentive**: optional `triggerDistribution` button for anyone.

**⚠️ Gotcha — newly-added RewardModule:** when a Reward module is added to a token post-launch, existing holders' shares aren't registered in the new module. They're only added when they next transact (triggering `setShare`). Dividend distributions during that bootstrap window will over-reward early-movers. Consider displaying a "Module just added — distributions may be uneven until all holders transact" banner for ~a day after add.

---

### 2.7 BurnModule 🟢

Buys back tokens via Lumoria Router and burns them.

**Reads:**
- `taxHandler`, `token`, `database`, `burnInterval`, `lastBurnTime`, `totalBurned`, `totalBNBSpent`.
- `getStats()` returns `(burnInterval, lastBurnTime, totalBurned, totalBNBSpent, currentBNBBalance)`.
- **Time until next burn**: `lastBurnTime + burnInterval - block.timestamp` — UI computes this for a countdown.

**Writes:**
- `receiveTax()` payable — TaxHandler only.
- **`executeBurn()` — permissionless**. Expose as "Trigger Burn" button. Fires gas but anyone can spin the wheel.
- `setInterval(newInterval)` — creator only, bounded by `MIN_INTERVAL` (5 min floor).

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TaxReceived(amount, pendingBNB)` | Tax delivered from TaxHandler | Inflow chart |
| `BurnExecuted(bnbSpent, tokensBurned, timestamp)` | `executeBurn` succeeds | Burn history chart, total supply timeline |
| `IntervalUpdated(oldInterval, newInterval)` | Creator adjusts cadence | Audit trail |

**UI surfaces:**
- **Token info panel**: "Total burned", "Total BNB spent", "Next burn in X minutes".
- **"Trigger burn"** CTA when interval has elapsed.

---

### 2.8 LiquidityModule 🟢

Auto-liquidity. Swaps half BNB for tokens, pairs with the other half, and locks the result as permanent full-range liquidity in the LumoriaLiquidityVault (the V4-era replacement for LP-to-dEaD). `totalLPLocked` counts V4 liquidity units.

**Reads:**
- `taxHandler`, `token`, `database`, `liquidityInterval`, `lastLiquidityTime`, `totalTokensLiquified`, `totalBNBLiquified`, `totalLPLocked`.
- `getStats()` returns `(liquidityInterval, lastLiquidityTime, totalTokensLiquified, totalBNBLiquified, totalLPLocked, currentBNBBalance)`.

**Writes:**
- `receiveTax()` payable — TaxHandler only.
- **`executeLiquidity()` — permissionless**.
- `setInterval(newInterval)` — creator only, `MIN_INTERVAL` floor.

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TaxReceived(amount, pendingBNB)` | Tax delivered | Inflow chart |
| `LiquidityAdded(bnbAmount, tokenAmount, lpTokens, timestamp)` | `executeLiquidity` succeeds | Cumulative LP locked chart, TVL tracking |
| `IntervalUpdated(oldInterval, newInterval)` | Creator adjusts cadence | Audit trail |

**UI surfaces:**
- **Token info panel**: "Liquidity locked forever" (vault has no removal path), "Total BNB added to LP".
- **"Trigger liquidity add"** CTA when interval has elapsed.

---

### 2.9 LumoriaHook + Uniswap V4 PoolManager 🟢

Trading lives in the canonical Uniswap V4 PoolManager (BSC: `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`). The **LumoriaHook** runs on every swap — any router — and is the source of truth for trades, fees, rebates, and volume.

**Pool identity (deterministic — no factory, no registry):**
```
PoolKey  = { currency0: address(0) /* native BNB */, currency1: token,
             fee: 0, tickSpacing: 60, hooks: LumoriaHook }
PoolId   = keccak256(abi.encode(poolKey))
```
- `LumoriaHook.poolKeyFor(token)` / `poolIdFor(token)` → on-chain helpers; trivially mirrored client-side.

**Fee order (buy and sell both take fees on the BNB side, inside the swap):**
1. **Platform fee**: `Database.platformFeeBps()` (default 1%, cap 5%) → FeeReceiver (tagged with the traded token).
2. **Token tax**: `TaxHandler.buyFee()` or `sellFee()` → TaxHandler → distributed to modules.
3. **Pool LP fee**: **0** — all economics are hook fees.

Only **exactInput** swaps work; exactOutput reverts. Quote with exactIn amounts.

**Pool-state reads:**
- Reserves/price: canonical **StateView** (BSC: `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4`) → `getSlot0(poolId)` for `sqrtPriceX96` (price = `(sqrtPriceX96/2^96)^2` token-per-BNB), `getLiquidity(poolId)`.
- Token balance of the PoolManager ≈ pool reserves (one pool per token).

**Quoting — the headline change:** the legacy `quoteBuy`/`quoteSell` views are gone. Use the canonical **V4Quoter** (BSC: `0x9f75dd27d6664c475b90e105573e550ff69437b0`): `quoteExactInputSingle({ poolKey, zeroForOne, exactAmount, hookData: "0x" })`. The quoter **simulates hook deltas**, so the returned amount already nets out the platform fee + token tax at any fee level — no client-side fee math needed. For the fee *breakdown* display, compute client-side: `platformFee = bnbIn × platformFeeBps/10000`, `tax = (bnbIn − platformFee) × buyFee/10000` (sells: same off the quoted gross output).

**Events to index (the subgraph's primary trade source):**
| Event | Fires when | Subgraph use |
|---|---|---|
| `TokenPurchased(token, buyer, bnbIn, platformFee, taxTaken, tokensOut)` | **Every** buy on the pool — ours, Universal Router, aggregators | Primary trade feed, volume + price charts. `buyer = address(0)` when the route carried no hookData |
| `TokenSold(token, seller, tokensIn, platformFee, taxTaken, bnbOut)` | Every sell | Same |
| `LumoriaPoolInitialized(token, poolId)` | Pool created at launch | Link `Token` ↔ `poolId` |

PoolManager-level `Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)` also fires (canonical contract) — index it if you want OHLC from `sqrtPriceX96` directly; filter by our PoolIds.

**⚠️ Gotcha — tax recursion**: when BurnModule / LiquidityModule route through the LumoriaSwapRouter, they pay the 1% platform fee AND the token's buy fee. That buy fee flows back through TaxHandler → modules, including back to themselves. Design feature (amplifies reward flow on every execute*) but subgraph dashboards should note that "BNB in" at module level exceeds raw execute* counts.

**⚠️ Gotcha — PoolManager excluded from reward shares**: `LumoriaToken._transferFrom` skips `setShare` for the `pair()` address, which is the PoolManager — pool reserves don't accrue reward-module dividends (they'd be stuck). By design.

---

### 2.10 LumoriaSwapRouter + LiquidityVault 🟢

**LumoriaSwapRouter** is our thin V4 router. It collects no fees (the hook does); what it adds over third-party routes is **attribution**: it passes `hookData = abi.encode(user)` so the hook can credit buy rebates and per-user volume. The UI should always route through it.

**Key writes:**
- `swapExactETHForTokensSupportingFeeOnTransferTokens(amountOutMin, path, to, deadline)` payable — **buys**. `path` = `[address(0) | WBNB-marker, token]`. Native BNB in; no wrapping.
- `swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, to, deadline)` — **sells**. Requires prior `token.approve(router, amountIn)`.
- `addLiquidityETH(token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline)` payable — adds **permanently-locked** full-range liquidity via the vault; lazily initializes the pool on the first add. `to` is ignored (no LP tokens exist). Returns `(amountToken, amountETH, liquidity)`.
- **There is no `removeLiquidityETH`.** Liquidity is unremovable, period.

**Key reads:** `poolKeyFor(token)`, `poolManager()`, `database()`.

**LumoriaLiquidityVault** — the sole owner of all pool liquidity; no removal code path exists, and the hook reverts all third-party liquidity ops + donations.
- Reads: `lockedLiquidity(token)`, `totalBnbLocked(token)`, `totalTokensLocked(token)` — the token page's "liquidity locked forever" stats.
- Events: `PoolInitialized(token, poolId, sqrtPriceX96)`, `LiquidityLocked(token, bnbAmount, tokenAmount, liquidity, totalLocked)` → cumulative locked-liquidity chart / TVL tracking.

**UI surfaces:**
- **Trade widget**: user enters BNB (buy) or token (sell) amount → quote via V4Quoter (see 2.9) → show `{ platformFee, taxAmount, expected output }` breakdown → user signs the router swap. `amountOutMin = quoted × (1 − slippage)`. Note: at high tax rates the *fee* is the dominant "slippage" — show it separately from price impact.
- **Approve flow**: before sell, check `token.allowance(user, router)`; prompt approve if insufficient.
- **"Liquidity locked" badge**: `vault.lockedLiquidity(token) > 0` + the hard invariant ("removal is impossible by construction") is a strong trust signal — surface it prominently.
- **Third-party routes** (Universal Router / aggregators): taxed identically; they just skip rebates + per-user volume. If Uniswap-interface routing is desired later, the hook can be submitted to the Uniswap routing-API hook allowlist post-audit.

---

### 2.11 RebateContract 🟢

Global contract. One rebate pool per token. Creator funds with their own token supply + sets a bps rate. Authorized creditors (the **LumoriaHook**) trigger bonus-token transfers to buyers after buys — but only for buys carrying hookData attribution (i.e. routed through the LumoriaSwapRouter); aggregator buys are taxed but earn no rebate.

**Key reads:**
- `getRebate(token)` → `{ rebateBps, fundedBalance, creator, active }`.
- `rebates(token)` → same (auto-getter on the public mapping).
- `authorizedCreditors(addr)` → which addresses may call `creditRebate` (typically just the Router).

**Key writes (creator only unless noted):**
- `fundRebate(token, amount, rebateBps)` — first-time or re-funding. Requires `token.approve(rebate, amount)` first. Sets/updates bps rate.
- `topUpRebate(token, amount)` — add to existing pool without changing the rate. Auto-reactivates a drained pool.
- `setRebateBps(token, rebateBps)` — adjust the rate without funding.
- `withdrawFunds(token, amount)` — creator pulls unused tokens out. Deactivates the pool if drained.
- `creditRebate(token, buyer, tokensBought)` — **authorized creditors only** (the hook). Silent exit on empty/inactive.
- `setAuthorizedCreditor(creditor, authorized)` — **owner only** (platform admin).

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `RebateFunded(token, creator, amount, rebateBps)` | Creator funds a pool | Timeline of creator top-ups + rate changes |
| `RebateToppedUp(token, amount, newBalance)` | Creator adds more | Timeline |
| `RebateBpsUpdated(token, oldBps, newBps)` | Creator changes rate | Notify holders; drives "rebate became more/less generous" UI |
| `RebateCredited(token, buyer, tokenAmount)` | Router triggers a credit after a buy | Per-buyer rebate history; "you got X bonus tokens on this purchase" |
| `RebateWithdrawn(token, amount)` | Creator pulls out | Timeline |
| `RebateDeactivated(token)` | Pool drained (via credit or withdraw) | UI banner: "rebate paused until top-up" |
| `CreditorUpdated(creditor, authorized)` | Admin rotates Router auth | Audit trail |

**UI surfaces:**
- **Token page**: show "Rebate: X% — Y tokens remaining in pool" if `active`. If `!active`, show "Rebate currently paused".
- **Buy widget**: when rebate is active, show "You'll also receive ~Y bonus tokens from the rebate pool" as part of the quote. Compute as `tokensOut * rebateBps / 10000`, clipped to `fundedBalance`.
- **Creator dashboard**: fund / top-up / set bps / withdraw forms. Show current pool state + recent credit events.

---

### 2.12 Generator 🟢

Single-transaction project launch. Clones Token + TaxHandler + optional FlatCurve, registers in Database, executes the chosen launch mode atomically.

**Key reads:**
- `getDatabase()` → the Database this Generator is bound to (immutable).
- **`predictTokenAddress(salt)`** → CREATE2-deterministic future token address. **Crucial for UIs:** use this to display the pending token's address in a confirmation screen and pre-cache subgraph queries before the tx lands.

**Key writes:**
- **`generateProject(name, symbol, buyFee, sellFee, modules[], launchMode, launchPayload, allocations[], salt)` payable** — the single-tx launch. Caller becomes the creator (owner of fee controls, recipient of whatever token remains after LP/presale and allocations).
  - **`allocations`** is `AllocationData[]` where `AllocationData { address beneficiary; uint256 amount; uint64 cliff; uint64 duration; }`. Carved from the creator's remainder: `duration == 0` → immediate transfer to `beneficiary`; `duration > 0` → locked in the VestingVault (§2.13) on a linear+cliff schedule. `sum(amount)` must be ≤ the remainder (else revert `"Gen: alloc exceeds remainder"`); max **100** allocations. Pass `[]` for none. This is the on-chain backing for the Create "carve % to Dev/Marketing/Treasury, optional lock" UI — `isLocked` is now real and enforced.

**Launch modes and their payloads:**
| Mode | Enum | Payload | msg.value |
|---|---|---|---|
| `BYOL` | 0 | `abi.encode(uint256 tokensForLP)` | required — becomes the BNB side of initial LP (after 1% platform fee) |
| `FLAT_CURVE` | 1 | `abi.encode(hardCap, minContribution, maxContribution, tokensForPresale, tokensForLP, liquidityBps, creatorBps, startTime, endTime)` | must be 0 |

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `ProjectGenerated(token, taxHandler, creator, name, symbol, buyFee, sellFee, launchMode)` | Every launch | Primary token-creation event; creates the `Token` entity and links to creator |
| `BYOLLaunched(token, platformFee, tokensForLP, bnbForLP)` | BYOL branch | LP-seeding record: what went to fees vs. the pool |
| `FlatCurveLaunched(token, flatCurve, hardCap)` | FLAT_CURVE branch | Links the token to its raise contract; seed a `Raise` entity |
| `AllocationMinted(token, beneficiary, amount)` | An `allocations` entry with `duration == 0` | Immediate (unlocked) allocation → a `TokenAllocation` row (locked=false) |
| `AllocationVested(token, beneficiary, scheduleId, amount, cliff, duration)` | An `allocations` entry with `duration > 0` | Links to the VestingVault `VestingSchedule` (by `scheduleId`); drives the Portfolio vested-tokens UI |

**UI surfaces:**
- **Launch wizard (creator-facing)**:
  1. User enters name, symbol, fees, modules (visual builder maps to `ModuleInitData[]`).
  2. Picks launch mode; mode-specific form opens.
  3. Client generates a random `salt`, calls `predictTokenAddress(salt)` to preview the future token address.
  4. Builds the launch payload via `abi.encode` (helpers in `test/fixtures/deploy.js` mirror what the UI should do).
  5. Submits `generateProject` — for BYOL, with BNB attached; for FLAT_CURVE, with value 0.
- **Post-launch confirmation**: show `ProjectGenerated` + launch-mode event, link to the token page (and FlatCurve page if applicable).

**⚠️ Salt management**: `salt` must be unique per launch (CREATE2 reuses would fail). Recommend the UI derive salt from `keccak256(creator ++ block.timestamp ++ random)` client-side. Users who want a vanity address can grind the salt offline and submit.

**⚠️ Module payload format**: modules no longer encode `taxHandler` — they read it from `msg.sender` at init time (the TaxHandler clone is the caller). Payload builders:
- CreatorFee: `abi.encode(recipient)`
- Reward: `abi.encode(token, rewardToken, externalRouter, externalWBNB, minDistribution)`
- Burn: `abi.encode(token, database, burnInterval)`
- Liquidity: `abi.encode(token, database, liquidityInterval)`

**Multi-recipient fee splits (no contract changes needed).** TaxHandler does not enforce uniqueness on `moduleType`, so a launch can stack up to **MAX_MODULES (10)** entries of any combination — including N CreatorFeeModule instances each pointing at a different wallet. This is how the UI's "Fee Wallets" feature should be wired:

```
[ + Add wallet ]   name="Marketing"   address=0x…   buy%=15  sell%=15
[ + Add wallet ]   name="Team"        address=0x…   buy%=10  sell%=10
[ + Add wallet ]   name="Treasury"    address=0x…   buy%=5   sell%=5
```
→ becomes 3 `ModuleInitData` entries with `moduleType: 3 (CREATOR)`, each carrying `abi.encode(walletAddr)`. The UI is responsible for ensuring the buy and sell allocation columns each sum to 10000 bps across **all** modules in the array (presets + CreatorFee instances combined).

- **Names live off-chain.** Don't put labels on-chain. Index them in the subgraph or backend keyed off `(token, moduleIndex)` — `moduleIndex` is the position in `TaxHandler.modules[]` and is stable for the life of the module.
- **Contract recipients allowed but flag them.** A wallet address can be a contract with custom `receive()` logic (vesting, splitting, swap-and-forward). `safeTransferETH` reverts the entire trade if `receive()` reverts or runs out of gas, so warn users when adding a contract recipient and consider a simulation step.
- **`setRecipient` is owner-style.** Each recipient (and only that recipient) can rotate its own destination via `CreatorFeeModule.setRecipient(newRecipient)`. UI should expose this on a per-wallet "Manage" panel for the connected address.

---

### 2.13 FlatCurve 🟢

Cloneable presale contract. Users contribute BNB within `[minContribution, maxContribution]` (net of 1% platform fee) until `hardCap` is reached or `endTime` elapses. On success: LP auto-created and permanently locked in the LiquidityVault (no removal path); creator receives the configured BNB share; contributors claim proportional tokens. On failure: contributors withdraw their net amount.

**Key reads:**
- `token()`, `hardCap()`, `totalRaised()`.
- `contributions(user)` → user's credited net amount (post-1% fee).
- `claimed(user)` → bool, for claim-state checks.
- `launched()` / `failed()` → mutually-exclusive state flags. `!launched && !failed` = ACTIVE.
- `minContribution()`, `maxContribution()`, `tokensForPresale()`, `tokensForLP()`, `liquidityBps()`, `creatorBps()`, `startTime()`, `endTime()`.

**State machine (derive client-side from flags + time):**
| State | Flags | UI |
|---|---|---|
| `PENDING` | `!launched && !failed && block.timestamp < startTime` | "Raise opens in HH:MM" countdown |
| `ACTIVE` | `!launched && !failed && startTime ≤ t < endTime` | contribute / refund open |
| `CAPPED` | `!launched && !failed && totalRaised ≥ hardCap` | "Launch now" CTA (anyone can call) |
| `ENDED_UNFILLED` | `!launched && !failed && t ≥ endTime && totalRaised < hardCap` | "Finalize as failed" CTA |
| `SUCCESS` | `launched` | claim open; tokens live for trading |
| `FAILED` | `failed` | withdrawOnFailure open |

**Key writes:**
- `contribute()` payable — contributes BNB. 1% platform fee is taken from gross, 99% credited as net. Gross → `msg.value`.
- `refund()` — pre-finalization only. Returns **net** (the 1% fee was already consumed).
- **`launch()` — permissionless**. Routes to success branch if cap met, failure branch if cap unmet after endTime, reverts otherwise. UI exposes as "Finalize Raise".
- `claim()` — post-success. Mints no new tokens; transfers the contributor's proportional share of `tokensForPresale`.
- `withdrawOnFailure()` — post-failure. Returns contributor's net amount.

**Events:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `ContributionMade(contributor, grossAmount, netAmount, totalRaised)` | Each successful `contribute()` | Contribution history per user; raise progress chart |
| `ContributionRefunded(contributor, refundAmount)` | `refund()` or `withdrawOnFailure()` | Refund timeline; helps distinguish exit patterns |
| `PlatformFeeTaken(amount)` | Fired alongside each contribute | Sum = raise's platform-fee contribution (separate from trade fees) |
| `RaiseLaunched(token, totalRaised, liquidityBNB, liquidityTokens, creatorBNB)` | Success branch | Flip `Raise.status → SUCCESS`, record LP + creator payout |
| `RaiseFailed(token, totalRaised)` | Failure branch | Flip `Raise.status → FAILED`; contributors now refundable |
| `TokensClaimed(contributor, tokenAmount)` | Post-success `claim()` | Per-user claim record |

**UI flows:**
- **Raise page (public)**: progress bar `totalRaised / hardCap`, time remaining, current contributor's balance, estimated allocation (`contribution * tokensForPresale / totalRaised`).
- **Contributor actions**: contribute form (shows gross → net breakdown with 1% fee), refund button (pre-finalization), claim button (post-success), withdraw button (post-failure).
- **Creator view**: read-only raise health — no creator-side actions after launch config is locked in via Generator.
- **Public finalize**: once `CAPPED` or `ENDED_UNFILLED`, any keeper can call `launch()`. UI exposes as a call-to-action with a gas estimate.

**⚠️ Stranded tokens on failure**: if the raise fails, the `tokensForPresale + tokensForLP` allocation stays in the FlatCurve contract (no recovery path in the MVP). Document in the creator flow: "a failed raise burns the allocated supply effectively." Phase 5 could add a creator-recovery function.

**⚠️ BNB dust from Router refunds**: FlatCurve has a `receive()` to accept BNB refunds from the Router's `addLiquidityETH`. In practice our liquidity-add uses exact ratios (first mint), so no refunds fire. Any stray BNB sent directly becomes stuck — accounting uses `totalRaised`, not `address(this).balance`.

---

### 2.14 VestingVault 🟢

Shared singleton (one deployment, `Database.vestingVault()`) custodying **vested** creator allocations created at launch (see Generator `allocations`, §2.12). Linear with optional cliff, **non-revocable** — there is no revoke/claw-back path, so a vested allocation can never be reclaimed (the same trust posture as the permanently-locked liquidity vault).

**Key reads:**
- `getSchedule(id)` → `{ token, beneficiary, total, released, start, cliff, duration }`.
- `releasable(id)` → tokens claimable **right now** (`vested − released`).
- `vestedAmount(id)` → total vested to date (incl. already released).
- `getBeneficiarySchedules(beneficiary)` → `uint256[]` of that wallet's schedule ids. **This is the entry point for a wallet's vesting UI.**
- `scheduleCount()` → total schedules ever created.

**Key writes:**
- **`release(id)` — permissionless.** Anyone can poke; tokens always go to the schedule's `beneficiary`. The Portfolio "Claim" button calls this for the connected wallet's ready schedules.

**Events to index:**
| Event | Fires when | Subgraph use |
|---|---|---|
| `ScheduleCreated(id, token, beneficiary, total, start, cliff, duration)` | Generator creates a vested allocation at launch | Create a `VestingSchedule` entity; link to token + beneficiary (`Holder`/`User`) |
| `TokensReleased(id, beneficiary, amount)` | `release(id)` pays out | Append a `VestingRelease`; bump `VestingSchedule.released` |

**UI surfaces:**
- **Portfolio `vested-tokens-section`**: `getBeneficiarySchedules(wallet)` → per id show `total`, `released`, `releasable`, and a vest curve from `start`/`cliff`/`duration`. "Claim" → `release(id)`.
- **Token page**: optionally show team/treasury vesting schedules for transparency (query `VestingSchedule` by token).

**⚠️ Vesting math**: nothing unlocks before `start + cliff`; at the cliff the elapsed-since-`start` portion unlocks at once (`total · cliff / duration`), then it continues linearly; fully vested at `start + duration`. Compute `releasable` on-chain (`releasable(id)`) rather than re-deriving client-side, to stay exact.

**⚠️ The vault is share-excluded**: tokens sitting in the vault accrue **no** reward reflections (every TaxHandler excludes it). A beneficiary only starts earning rewards on tokens **after** they `release` them into their own wallet. Surface this in the vesting UI so holders aren't surprised.

---

## 3. Canonical UI Flows

High-level user stories, mapped to reads / writes / subgraph.

### 3.1 Token discovery / launchpad landing

- **Token list**: paginated query to subgraph (`Token` entity). Sort by 24h volume, holder count, launch date.
- **Per-card data**: name, symbol, creator, current price (last `Swap` → reserve ratio), 24h volume, buy/sell fees.
- Direct-read fallback: if subgraph is down, iterate `Database.allTokens` and fetch per-token info — slow but functional.

### 3.2 Trade flow (V4)

1. User arrives on a token page.
2. UI reads token info (Database, Token contract, TaxHandler, modules) + pool state (StateView `getSlot0(poolId)`).
3. User enters BNB amount → UI quotes via **V4Quoter** `quoteExactInputSingle({ poolKey, zeroForOne: true, exactAmount, hookData: "0x" })` — the result already nets out platform fee + tax. Show the fee breakdown computed client-side (see §2.9).
4. User clicks "Buy" → wallet signs `LumoriaSwapRouter.swapExactETHForTokensSupportingFeeOnTransferTokens` (native BNB attached). The router carries the user's address as hookData → rebate + volume attribution.
5. On confirmation: toast + balance refresh (direct read) + "your trade appears in the feed" (subgraph after indexer lag).
6. Price chart (subgraph OHLC from PoolManager `Swap` events filtered to our PoolIds, or from the hook's trade events).

### 3.3 Creator dashboard

- List tokens where `Database.tokenCreator(t) == msg.sender` (subgraph is efficient; direct scan of `allTokens` is a fallback).
- Per token: current fees, modules, pending changes.
- **Change-proposal form**: compose a `proposeModuleUpdate` / `proposeModuleAdd` / `proposeModuleRemove` call. UI must:
  - Render current modules with their allocations.
  - Let creator edit allocations (either as direct inputs or as a single "target" allocation with auto-rebalance from other modules).
  - Validate that new sums hit 10000 **client-side before submitting** (contract will also revert, but client feedback is faster).
  - Display the resulting `AllocationUpdate[]` rebalance array that will be submitted.
- **Pending state view**: `pendingFeeChange` / `pendingModuleChange` + `pendingRebalance[]` — countdown, cancel button, execute button (once elapsed).

### 3.4 Holder flow — claim rewards

- Per token the user holds: `RewardModule.getUnpaidRewards(user)` direct read. Show across all tokens as an aggregated table.
- "Claim all" UX: submit one claim tx per token (current contract API). Future: batch claim router if needed.
- Recent claims history: subgraph on `RewardClaimed`.

### 3.5 Keeper / public utility flows

- **Burn/Liquidity triggers**: any user can call `executeBurn` / `executeLiquidity` once the interval has elapsed. UI shows a "Trigger now" button with gas estimate.
- **Reward distribution triggers**: `RewardModule.triggerDistribution()` — useful when a holder wants to crystallize before claiming.
- Consider: run a keeper bot in parallel for any tokens that accumulate above a threshold, so UIs don't have to expose this to unsophisticated users.

### 3.6 Admin / platform owner dashboard

- Read-only: fees collected, per-token fee distribution, platform volume.
- Controlled writes: `setPlatformFeeBps` (≤5% cap), master copy upgrades, withdraw from FeeReceiver.
- Source: mostly subgraph for historical, direct reads for current.

### 3.7 Launch flow — BYOL

Generator single-tx: creator supplies tokens + BNB, Generator creates Token + TaxHandler + modules, then seeds the V4 pool through the router → vault (pool initialized at the implied price; liquidity locked forever). Confirmation screen shows the predicted token address (`predictTokenAddress(salt)`) and, post-launch, the derived `poolId`.

### 3.8 Launch flow — FlatCurve

Contributors see a raise page with hardCap, min/max, soft countdown. Contribute → 1% platform fee skimmed, 99% credited. Refund available until raise completes. On fill: V4 pool initialized + liquidity vault-locked, creator BNB share paid, tokens claimable.

---

## 4. Subgraph Entity Sketch

Suggested GraphQL schema. Refine as subgraph implementer sees fit, but this captures the relationships the UI will want.

```graphql
type Token @entity {
    id: ID!                    # token address
    creator: Bytes!
    taxHandler: Bytes!
    poolId: Bytes              # keccak256(abi.encode(poolKey)) — from LumoriaPoolInitialized
    name: String!
    symbol: String!
    decimals: Int!
    launchMode: Int!           # 0 = BYOL, 1 = FlatCurve (once Phase 4 lands)
    launchedAt: BigInt!        # block timestamp of TokenRegistered
    buyFee: BigInt!            # current fee (updated on FeesUpdated)
    sellFee: BigInt!
    totalSupply: BigInt!
    holderCount: Int!
    totalVolume: BigInt!       # lifetime BNB volume
    modules: [Module!]! @derivedFrom(field: "token")
    trades: [Trade!]! @derivedFrom(field: "token")
    feeHistory: [FeeChange!]! @derivedFrom(field: "token")
    moduleHistory: [ModuleEvent!]! @derivedFrom(field: "token")
}

type Holder @entity {
    id: ID!                    # token-address:holder-address
    token: Token!
    address: Bytes!
    balance: BigInt!
    firstSeen: BigInt!
    lastSeen: BigInt!
}

type Trade @entity(immutable: true) {
    id: ID!                    # tx-hash:log-index
    token: Token!
    trader: Bytes!
    kind: String!              # "buy" | "sell"
    bnbIn: BigInt              # buy only
    bnbOut: BigInt             # sell only
    tokensIn: BigInt           # sell only
    tokensOut: BigInt          # buy only
    platformFee: BigInt!
    taxTaken: BigInt!
    timestamp: BigInt!
    blockNumber: BigInt!
}

type Module @entity {
    id: ID!                    # module address
    token: Token!
    moduleType: Int!           # 0=REWARD, 1=BURN, 2=LIQUIDITY, 3=CREATOR
    buyAllocation: BigInt!
    sellAllocation: BigInt!
    active: Boolean!
    addedAt: BigInt!
    totalReceived: BigInt!     # lifetime BNB received
    # type-specific:
    rewardToken: Bytes         # RewardModule only
    totalDistributed: BigInt   # RewardModule only
    totalBurned: BigInt        # BurnModule only
    totalLPLocked: BigInt      # LiquidityModule only
    creatorRecipient: Bytes    # CreatorFeeModule only
}

type FeeChange @entity(immutable: true) {
    id: ID!                    # tx-hash
    token: Token!
    oldBuyFee: BigInt!
    newBuyFee: BigInt!
    oldSellFee: BigInt!
    newSellFee: BigInt!
    proposedAt: BigInt         # null if instant
    effectiveAt: BigInt!
    kind: String!              # "instant" | "timelocked"
}

type ModuleEvent @entity(immutable: true) {
    id: ID!                    # tx-hash:log-index
    token: Token!
    kind: String!              # "added" | "removed" | "updated" | "proposed" | "cancelled"
    moduleAddress: Bytes
    moduleType: Int
    buyAllocation: BigInt
    sellAllocation: BigInt
    rebalanceIndices: [BigInt!]
    rebalanceBuyAllocs: [BigInt!]
    rebalanceSellAllocs: [BigInt!]
    timestamp: BigInt!
}

type RewardClaim @entity(immutable: true) {
    id: ID!                    # tx-hash:log-index
    module: Module!
    holder: Bytes!
    amount: BigInt!
    timestamp: BigInt!
}

type BurnExecution @entity(immutable: true) {
    id: ID!                    # tx-hash:log-index
    module: Module!
    bnbSpent: BigInt!
    tokensBurned: BigInt!
    timestamp: BigInt!
}

type LiquidityInjection @entity(immutable: true) {
    id: ID!                    # tx-hash:log-index
    module: Module!
    bnbAmount: BigInt!
    tokenAmount: BigInt!
    liquidity: BigInt!         # V4 liquidity units locked in the vault
    timestamp: BigInt!
}

# Phase 3+
type Rebate @entity { ... }
type RebateCredit @entity(immutable: true) { ... }

# Phase 4+
type Raise @entity { ... }
type Contribution @entity(immutable: true) { ... }
```

---

## 5. Open Questions / TODO

### Known limitations to surface in UI
- `BuyTaxDistributed` / `SellTaxDistributed` emit `address(0)` for the trader — trader attribution lives on the hook's `TokenPurchased` / `TokenSold` events in the same transaction; the subgraph should join by tx hash if it needs both.
- Per-user attribution (rebates + `userVolume`) only works for swaps routed through the LumoriaSwapRouter (which supplies `hookData`). Aggregator/Universal-Router trades are fully taxed but show `buyer = address(0)` and earn no rebate — the UI should explain this where rebates are advertised ("buy through Lumoria to receive the rebate").
- Adding a RewardModule post-launch creates a bootstrap period where existing holders' shares aren't registered until they next transact. UI should flag this with a banner on the creator dashboard (confirm creator knows) and the token page (inform holders).
- 100% of pool liquidity is protocol-locked: there are no LP tokens at all. Display "Liquidity locked: 100% (permanent, by construction)" — backed by `vault.lockedLiquidity(token)`.

### Open questions
- **Rebate UI:** how does a user know a rebate happened? The hook fires `TokenPurchased` with `tokensOut` as the *swap output* — the rebate bonus comes through a separate `RebateCredited` event. Show both as a combined "You received N tokens (M from rebate)".
- **Uniswap interface routing:** post-audit, submit the LumoriaHook to the Uniswap routing-API hook allowlist so Lumoria pools are routable from app.uniswap.org. Tracked as a go-to-market follow-up, not contract work.
- **Module-specific config surfacing:** each module type has different `getStats()` return shapes. Client needs per-module decoders (or GraphQL handles all of it). Decide: decode client-side from module ABIs (smaller subgraph) or expand in subgraph (simpler client). Leaning toward subgraph for performance.
- **Pending changes notifications:** push (email / telegram) or in-app only? Out of scope for contract work but worth parking here.
- **Multi-token holder views:** "show me all tokens I hold and my rewards across all of them" — needs a cross-token Holder index in the subgraph. Plan for it.
- **Failed-raise stranded supply:** FlatCurve tokens not claimable after a failed raise. Currently stuck. Consider a creator-callable `recoverUnusedTokens()` in a future update.
- **Salt UX:** best default for `generateProject`'s salt parameter? Current recommendation (client-side `keccak256(creator, timestamp, random)`) works but requires intentional UI design. Vanity-address grinding should be a pro-mode feature.

---

*When updating this doc, keep entries short. If a section gets > 2 screens, split it into a dedicated sub-doc under `docs/frontend/` and link from here.*
