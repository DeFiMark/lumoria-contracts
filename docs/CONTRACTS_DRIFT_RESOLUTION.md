# Lumoria — Drift Resolution (Contracts → Frontend)

**From:** Contracts + Subgraph owner
**To:** Frontend team
**Date:** 2026-06-18
**Re:** Authoritative resolution of every item in `CONTRACTS_SUBGRAPH_DRIFT_REPORT.md`

This is the **decision-of-record** for the drift audit. Each item below is resolved against the **actual contract code** (not the handoff doc), so the "confirm whether X exists" hedges are now definitive yes/no answers. This doc is **self-contained** — you do not need any other file from the contracts repo to act on it.

Three buckets, plus the corrections:

1. **Built this cycle** — three new capabilities landed on-chain (B6, B1, B2). New ABI below.
2. **Already shipped — we under-documented it** — the largest bucket. These work *today*; the handoff just didn't describe them correctly (B3, B4, B5, R1, R2, R3, rebates/volume/quoting). **No contract change — wire the UI to what already exists.**
3. **Cut** — no protocol backing, not building for the beta (B7, B8, B9).

Plus: **B10 metadata → off-chain** (spec below), **A1–A4 subgraph aggregates approved**, **Type-C corrections confirmed**.

---

## 1. Built this cycle (new on-chain capability)

### B6 — Management lock / renounce ✅ BUILT
`TaxHandler` now supports a permanent, one-way freeze of a token's tax + module configuration.

- **Write:** `TaxHandler.renounceManagement()` — creator-only. Freezes **all** fee and module changes forever (even a holder-friendly fee *decrease*), and cancels any in-flight pending change.
- **Read:** `TaxHandler.managementRenounced() → bool`.
- **Event:** `ManagementRenounced(address indexed token, uint256 timestamp)`.
- **UI:** the Manage "Lock Token" action calls `renounceManagement()`. The status pill = `managementRenounced()` (`true` → "Locked / Renounced", `false` → "Editable"). Subgraph carries a `renounced` flag (see §A).
- **Note:** this is *management* renouncement, distinct from the LP lock (liquidity is already permanently locked with no removal path).

### B1 — Token vesting ✅ BUILT
New shared **`VestingVault`** singleton custodies vested allocations. Linear with optional cliff, **non-revocable** (there is deliberately no revoke path — vested tokens can never be clawed back).

- **Reads:**
  - `getSchedule(uint256 id) → (address token, address beneficiary, uint256 total, uint256 released, uint64 start, uint64 cliff, uint64 duration)`
  - `releasable(uint256 id) → uint256` (claimable right now)
  - `vestedAmount(uint256 id) → uint256` (total vested to date, incl. already released)
  - `getBeneficiarySchedules(address beneficiary) → uint256[]` (a wallet's schedule ids)
  - `scheduleCount() → uint256`
- **Write:** `release(uint256 id)` — **permissionless** (anyone can poke; tokens always go to the schedule's beneficiary).
- **Events:** `ScheduleCreated(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration)`, `TokensReleased(uint256 indexed id, address indexed beneficiary, uint256 amount)`.
- **UI:** Portfolio `vested-tokens-section` reads `getBeneficiarySchedules(wallet)` → per-id `releasable`; "Claim" calls `release(id)`. Vesting math: linear from `start`; nothing before `start+cliff`; fully vested at `start+duration`.

### B2 — Custom token allocations ✅ BUILT
`Generator.generateProject` now accepts creator-defined allocations, **carved from the creator's post-launch remainder** (not from LP/presale). Works on both BYOL and FlatCurve.

- **New param (added before `salt`):** `AllocationData[] allocations`, where
  `AllocationData { address beneficiary; uint256 amount; uint64 cliff; uint64 duration; }`
  - `duration == 0` → immediate transfer to `beneficiary` (unlocked). Event `AllocationMinted(token, beneficiary, amount)`.
  - `duration > 0` → locked in the VestingVault on a linear+cliff schedule. Event `AllocationVested(token, beneficiary, scheduleId, amount, cliff, duration)`.
- **Rules:** `sum(amount) ≤ creatorRemainder` (else revert `Gen: alloc exceeds remainder`); max **100** allocations per launch; zero-amount / zero-beneficiary revert.
- **UI:** the Create tokenomics-step "carve % to Dev/Marketing/Treasury, optional lock" maps directly: each row → one `AllocationData`. "Locked for N weeks" → `duration = N weeks` (+ optional `cliff`); unlocked → `duration = 0`. `isLocked` is now real and enforced on-chain.

> **Full `generateProject` signature now:**
> `generateProject(string name, string symbol, uint256 buyFee, uint256 sellFee, ModuleInitData[] modules, LaunchMode launchMode, bytes launchPayload, AllocationData[] allocations, bytes32 salt) payable`

---

## 2. Already shipped — we under-documented it (NO contract change)

**This is the bucket the handoff got wrong.** Everything here works in the deployed contracts today; the UI just needs to bind to it.

### B3 — Custom fee recipients ✅ ALREADY SUPPORTED
Routing tax to arbitrary wallets is a **`CreatorFeeModule` (type 3) per recipient**, and the protocol fully supports **multiple type-3 modules with arbitrary recipients and per-side allocations**, added at launch *and* added/removed later.

- Verified: `TaxHandler` allows up to **`MAX_MODULES = 10`** modules with **no uniqueness constraint on module type** — you can register N CreatorFeeModules at launch, each with its own recipient and its own `buyAllocation`/`sellAllocation` (bps).
- Add/remove/rebalance later via the timelocked module-change flow (see R1).
- **UI mapping:** Create fee-structure rows Development / Treasury / Charity → **N CreatorFeeModule instances** (type 3, one per wallet). "Buyback" → **BurnModule** (type 1), not a custom recipient. The 4 canonical buckets + custom recipients are *all just the modules array*; the only constraint is **each side's allocations must sum to exactly 10000 bps** (validate in the form).

### B4 — Reward cadence ✅ MECHANISM EXISTS, but it's CONTINUOUS (not periodic)
There is a real, working reward mechanism — it just isn't interval-based.

- `RewardModule` pays **continuous dividends-per-share**: every taxed swap accrues to a per-share accumulator; holders' entitlement grows in real time and is claimable anytime. There is **no Daily/Weekly/Monthly interval** and no `lastExecuted` for rewards.
- (Burn and Liquidity modules *do* have an `interval` — that's where the "cadence" idea came from. Rewards don't.)
- **UI:** **remove the "Reward Period" control.** Show "real-time rewards." Claimable now = `getUnpaidRewards(holder)` (see R2).

### B5 — "Min Tokens to Earn" ✅ PARAM EXISTS, but it's a DIFFERENT concept
`RewardModule.minDistribution` is real but it is **not** a holder-eligibility threshold.

- `minDistribution` = the **minimum accrued BNB before a distribution actually fires** (a gas-efficiency floor on the payout side). It does **not** gate which holders earn — every holder with a share earns pro-rata.
- There is **no min-holder-balance-to-earn threshold** on-chain.
- **UI:** **drop the "Min Tokens to Earn" field.** If you want to surface `minDistribution`, label it "minimum reward pool before payout."

### R1 — The fee/module timelock is REAL and intended ✅
Fee and module edits are **not instant**. `TaxHandler` ships a 24h timelock you must honor:

- **Reads:** `pendingFeeChange()` → `(newBuyFee, newSellFee, effectiveTime, pending)`; `pendingModuleChange()` → `(changeType, moduleType, moduleIndex, buyAllocation, sellAllocation, …, effectiveTime, pending)`.
- **Flow:** `proposeFeeChange` / `proposeModuleAdd|Remove|Update` → wait `CHANGE_DELAY` (24h) → `executeFeeChange` / `executeModuleChange`; `cancelFeeChange` / `cancelModuleChange` to abort.
- **One exception:** a fee **decrease** applies **instantly** (always good for holders); only increases/module changes are timelocked.
- **Events:** `FeeChangeProposed(newBuyFee, newSellFee, effectiveTime)`, `FeeChangeCancelled()`, `ModuleChangeProposed(changeType, moduleType, buyAlloc, sellAlloc, effectiveTime)`, `ModuleRebalanceProposed(...)`, `ModuleChangeCancelled()`, and the applied `FeesUpdated` / `ModuleAdded` / `ModuleRemoved` / `ModuleUpdated`.
- **UI:** the Manage dashboard **must** add a pending-change banner, an effective-time countdown, and a cancel-pending control. "Edits are instant" is wrong (except the fee-decrease fast path). *Confirmed intended.*

### R2 — The real claimable-reward flow ✅
Per-token rewards are claimed from the RewardModule, not from any platform token.

- **Read:** `RewardModule.getUnpaidRewards(address holder) → uint256` (live claimable BNB, or reward-token in token-mode).
- **Write:** holders claim via the module's claim path; `processRewards()` is public (anyone can poke a pending BNB-mode distribution). Token-mode conversion is `convertAndDistribute(minOut, deadline)`, operator-gated — see `TOKENOMICS_V2.md` §6.3.
- **Event:** `RewardClaimed` (→ subgraph `RewardClaim`).
- **UI:** wire the Portfolio "Claimable / rewards" tiles to `getUnpaidRewards` + `RewardClaim` history. (This replaces the cut "PXX" concept — see B9.)

### R3 — Module stats / countdowns / history ✅
All available, just unused:

- **Burn:** `totalBurned`, and a countdown from `lastBurnTime + burnInterval − now`.
- **Liquidity:** interval/`lastExecuted` similarly.
- **Tax analytics:** `TaxHandler.totalBuyTaxReceived` / `totalSellTaxReceived` (cumulative BNB taxed each side).
- **History:** module + fee-change history via the subgraph (`Module`, `FeeChange`, `ModuleEvent` entities).
- **UI:** surface in the Manage dashboard (burn countdown, total burned, LP-locked, fee/module history).

### Rebates, volume attribution, address prediction, quoting ✅ (all already present)
- **Rebates** (`RebateContract`): a **per-token buy bonus paid to the buyer**, credited by the hook on every buy (`RebateCredited`). Reads via `getRebate`; top-up emits `RebateToppedUp`. This is **not** a referral system (see B8) — don't conflate them.
- **Per-user volume attribution:** swaps routed through `LumoriaSwapRouter` pass `hookData`, so the hook records **per-user** volume (`Database.userVolume[token][user]`) in addition to per-token (`Database.tokenVolume[token]`). Third-party-router swaps are still fully taxed but attribute to `user = 0x0` (token volume still counts). `VolumeRegistered(token, user, amount)` event.
- **`Generator.predictTokenAddress(salt) → address`:** pre-compute the token address before the launch tx lands (vanity + pre-subgraph display).
- **Quoting/pool state (V4):** quote via canonical **`V4Quoter.quoteExactInputSingle`** with the deterministic PoolKey (`currency0 = address(0)` native BNB, `currency1 = token`, `fee = 0`, `tickSpacing = 60`, `hooks = LumoriaHook`); pool state via **`StateView.getSlot0`/`getLiquidity`**. PoolId is deterministic = `keccak256(abi.encode(poolKey))`. Do **not** compute quotes as `price × fee` — the hook's fee stack must be quoted through V4Quoter.

---

## 3. Cut for the beta (no protocol trace)

- **B7 Loyalty tiers / reward multiplier** — no tier or multiplier exists anywhere; a payout multiplier would have to live inside distribution logic. **Cut.**
- **B8 Referrals** — no referrer relationship/attribution/payout exists. (`RebateContract` is a buyer bonus, not a referrer payout.) **Cut.**
- **B9 "PXX" platform rewards** — there is no platform token and no per-user emission/claim. The platform fee is taken in BNB to `FeeReceiver` (`FeeReceived`/`TokenFeeReceived`) — not user-claimable. **Cut, and wire the rewards tiles to the real `getUnpaidRewards` flow (R2) instead.**

Each would be a major new contract; none is in scope for the beta. Remove the corresponding UI (and the dormant `User.referrals` / `ReferralData` / `earnedFrom: trading_fees` types).

---

## 4. B10 — Token metadata → OFF-CHAIN (no contract change)

Decision: logo + description (+ socials) live **off-chain**. `ProjectGenerated` was deliberately **not** changed.

- **Store:** a frontend/backend keyed by token address. Suggested fields: `logo` (image URL/IPFS), `description`, `website`, `twitter`, `telegram`.
- **Write auth:** gate writes by a **signature from the creator key** (recover signer, check it equals `Database.tokenCreator(token)`), so only a token's creator can set its metadata.
- **Subgraph:** **will not carry metadata** — the frontend joins it client-side by token address (this also resolves **A5** logo: off-chain).
- **No pre-deploy deadline** on this (that only applied to the rejected on-chain-event option).

---

## 5. Type A — subgraph aggregates (APPROVED, no contract change)

All derive from existing on-chain state/events; I'll fold them into the subgraph spec:

- **A1** Platform volume — `PlatformConfig.totalVolumeBnb` (+ `PlatformDayData{date, volumeBnb}` for the 7d delta), aggregated from `VolumeRegistered`.
- **A2** Active builders — `PlatformConfig.creatorCount` from `TokenRegistered`. Define "builder" = creator to sidestep the `trader=0x0` attribution gap on unattributed trades.
- **A3** Sub-hour candles — `TokenMinuteData{token, periodStart, OHLCV}` (5-min) for the 5m/15m timeframes. (Derivable client-side from the `Trade` feed too; pre-agg is the perf win.)
- **A4** Portfolio history — `HolderDayData{holder, token, date, balance}` so value-over-time = Σ(balanceₜ × closeₜ) without replaying `Transfer`s.

---

## 6. Type C — confirmed corrections (your side)

- ✅ **No ERC-20 transfer tax** — confirmed. The token is a clean ERC20; tax is taken **only on buy/sell swaps, in BNB, at the V4 pool by the hook**. Remove the "Transfer %" pill, the `transferFee` type/mock, and reword "tax-on-transfer" → **"tax-on-trade."**
- ✅ **No BNB→USD oracle on-chain** — every contract value is BNB-denominated. USD display is a frontend/product choice (wire an external price API, or go BNB-only). Not a contract change.
- ✅ **BYOL "Lock Period"** → relabel **"Permanent"** (liquidity is locked forever, no expiry).
- ✅ **`PENDING_LAUNCH`** — only meaningful for **FlatCurve before `startTime`**; BYOL is instant. Map it to the FlatCurve pending state or drop the filter.
- ✅ 24h High/Low/Volume/Trades from last-24 `TokenHourData` (not the all-time `Token.totalVolumeBnb`/`buyCount`/`sellCount`); liquidity-in-BNB from `StateView` (not raw `totalLiquidityLocked`, which is V4 liquidity units).

---

## Checklist resolution (answers to the drift report's final checklist)

- **B7 / B8 / B9** → **CUT** (confirmed no protocol trace).
- **B1 vesting + B2 allocations** → **BUILT** (VestingVault + Generator `allocations` param). See §1.
- **B3** multiple type-3 CreatorFeeModules at launch + add/remove later → **YES, supported** (no change). See §2.
- **B4** reward distribution interval → **NO** — rewards are continuous; remove the control. See §2.
- **B5** min-holder-balance-to-earn → **NO** (`minDistribution` is a different concept); drop the field. See §2.
- **B6** management lock/renounce → **BUILT** (`renounceManagement()` + `managementRenounced()` + `ManagementRenounced`). See §1.
- **B10 / A5** metadata → **OFF-CHAIN** (no contract change). See §4.
- **A1–A4** subgraph aggregates → **APPROVED.** See §5.
- **R1** timelock intended → **YES** — Manage UI must show pending/countdown/cancel. See §2.
- **No ERC-20 transfer tax** → **CONFIRMED** (remove the UI). See §6.
- **`PENDING_LAUNCH`** → FlatCurve-pre-start only; otherwise drop. See §6.

*Net: zero remaining Type-B blockers. The only new ABI to integrate is §1 (renounce + vesting + allocations); the rest is binding the UI to capabilities that already exist (§2) or cosmetic (§6).*

---

## 7. Follow-up Q&A (rebate lock + reward tokens) — 2026-06-24

### Q1 — Does renounce also freeze the RebateContract? ✅ NOW YES (built)
Originally renounce (B6) froze only fees + modules; the RebateContract is a separate singleton and was still editable. **Fixed** — renounce now freezes the rebate "control" surface too, so the Lock modal's "fee **and rebate** controls can no longer be edited" is accurate.

- After `TaxHandler.renounceManagement()`, for that token the RebateContract **blocks** `setRebateBps`, `withdrawFunds`, and `fundRebate` (all revert `"Rebate: renounced"`).
- **`topUpRebate` stays open** — it can only add funds at the existing rate, never change or withdraw them (additive-only, like a fee decrease). So a renounced token's rebate can still be refilled and keeps paying buyers; the creator just can't change the rate or claw funds back.
- **New read:** `RebateContract.isManagementRenounced(token) → bool` (resolves the token's TaxHandler and reads its flag). Use it to disable the rate/withdraw controls in the Manage UI.
- **UX consequence:** a creator must **fund the rebate before locking** — a renounced token can't open a *new* rebate (only top up an existing one). Surface this in the Lock flow ("set up your rebate before you lock").

### Q2 — Rebate funding path (no contract change)
`generateProject` has no rebate param by design; rebate is a **post-launch tx**. The "reserved supply" the Create UI collects is not reserved on-chain — the creator keeps those tokens and funds the pool afterward:

1. `generateProject(...)` → creator receives the remainder (must keep enough for the rebate + anything not allocated/vested).
2. `token.approve(rebateContract, amount)`.
3. `RebateContract.fundRebate(token, amount, rebateBps)` — pulls tokens, sets rate, activates. Gated to `Database.tokenCreator(token)`.

Later: `topUpRebate(token, amount)`, `setRebateBps(token, bps)`, `withdrawFunds(token, amount)` (the last two only while **not** renounced — see Q1).

⚠️ **Interplay with allocations (B2):** the rebate is funded from the creator's *kept* tokens, which is the same pool the B2 allocations carve from. The wizard must reserve the rebate amount client-side so the creator doesn't allocate/vest away the tokens they need to fund it. And if the token will be locked, fund the rebate **before** the lock tx.

### Q3 — Arbitrary reward token at launch (token-mode) ✅ supported
`RewardModule` supports token-mode at launch via its init payload `(token, rewardToken, externalRouter, externalWBNB, minDistribution)`. If `rewardToken != 0`, the module swaps collected BNB → rewardToken via `externalRouter.swapExactETHForTokensSupportingFeeOnTransferTokens` over `[externalWBNB, rewardToken]`. So a reward-token dropdown is buildable, but each non-BNB option must supply **three real BSC addresses** in the payload:

- **`rewardToken`** — a real BSC ERC20 with WBNB liquidity. Use **BSC addresses**, not Ethereum-mainnet ones: USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, ETH (Binance-peg) `0x2170Ed0880ac9A755fd29B2688956BD959F933F8`, BTCB `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c`, etc.
- **`externalRouter`** — a V2-compatible router with that liquidity: **PancakeSwap V2** `0x10ED43C718714eb63d5aA57B78B54704E256024E`.
- **`externalWBNB`** — `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`.

UI notes:
- **Drop `CONTROL`** from the dropdown — it's a stale platform-token leftover (PXX was cut; there is no Lumoria platform token).
- The module swaps with `amountOutMin = 0`, so only offer **liquid** reward tokens (thin liquidity = bad fills / sandwich risk, though it won't block trades).
- **Recommendation:** default the beta to **BNB-mode rewards** (zero external-router/slippage surface); offer token-mode as an advanced option. The contracts support both — this is a product call, not a contract gate.
