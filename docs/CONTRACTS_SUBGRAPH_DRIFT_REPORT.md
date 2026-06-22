# Lumoria — Frontend ⇄ Contracts/Subgraph Drift Report

**From:** Frontend team
**To:** Contracts + Subgraph owner
**Date:** 2026-06-17
**Re:** `documentation/FRONTEND_HANDOFF.md` — drift audit before mainnet deploy

We mapped **every datum the current (mock-data) UI renders or collects** to the data surface you specified (§2a direct reads, §2b V4 reads, §2c + Appendix A subgraph entities, Appendix B events). Below is everything the UI shows that your contracts/subgraph **don't (yet) provide**, classified per your §3 scheme:

- **Type B** — no read (§2a) *and* no event (Appendix B). Needs a **contract decision before deploy** — can't be added later without redeploying, and liquidity locks forever.
- **Type A** — exists on-chain / in an event but no subgraph field exposes it yet. Cheap.
- **Type C** — derivable client-side or cosmetic. No backend change; listed for completeness + a couple of copy/labeling fixes.

> **Headline:** there is **no Type-B blocker in the trading, discover, or landing surfaces** — those map cleanly. The Type-B items are concentrated in **Create**, **Portfolio**, and **Manage**, and most reduce to a single question: *several UI subsystems have no on-chain backing at all.* For each, you need to decide **build-before-deploy vs. cut-from-product**. Three of them (referrals, loyalty tiers, a "PXX" platform reward token) have **zero trace anywhere** in the contract or subgraph surface and look like generic-launchpad UI that was never part of the Lumoria protocol — they're the most likely cuts. The rest (vesting, custom allocations, custom fee recipients, management-lock, reward cadence) look intentional to the product but are currently unenforceable.

There's also a **reverse-drift** section at the end: data your contracts *do* provide (the fee/module **timelock**, the real `getUnpaidRewards` claim flow) that the UI currently **ignores**. Those are frontend build items, not contract changes — but you should confirm the timelock is intended, because the UI must change to honor it.

---

## Type B — contract changes / decisions needed BEFORE deploy

Each row is a UI feature whose data has **no read and no event**. "Suggested resolution" assumes you keep the feature; the alternative is always "cut it from the UI" (we'll do that side).

| # | UI feature (where) | Datum shown/collected | Why no read or event can back it | Decision / suggested contract change |
|---|---|---|---|---|
| **B1** | **Token vesting** — Create vesting-modal + tokenomics-step ("Add Vesting", "Vests over N weeks") and Portfolio `vested-tokens-section` ("Vested", "Claimable", "Claim"); `demo-transactions` has a `vesting.claim` action | Linear vesting schedule (cliff / duration / intervals) on team/dev allocations; per-user claimable amount; claim action | No vesting/escrow contract, no claimable view, no `VestingClaimed` event, no subgraph entity. `FlatCurve.TokensClaimed` is a one-time presale claim (no schedule); `LiquidityVault` locks LP *forever* (not user-claimable). Vesting requires **escrowed state that was never created** — a view can't be retrofitted to state that doesn't exist. | **Build or cut.** If keep: a vesting/escrow contract holding allocations with `claimable(addr,token)` / `vested(addr,token)` views + `VestingClaimed(token, beneficiary, amount)` event + subgraph `VestingSchedule`/`VestingClaim` entities. |
| **B2** | **Custom token allocations** — Create tokenomics-step (carve supply % to Dev/Marketing/Treasury wallets, each with `walletAddress`, `isLocked`, `lockPeriod`); shown in preview | Supply distributed to arbitrary wallets at mint; optional per-allocation lock | Nothing in §2a / Appendix B distributes supply to arbitrary recipients at launch or locks arbitrary *token* allocations (`LiquidityVault` locks LP only). If the Generator mints all supply to the creator, these allocations are **unenforced UI**. | **Confirm Generator behavior.** If allocations are real: distribute (+ optionally lock) at launch and emit `AllocationAssigned(token, recipient, amount, lockUntil)` so they're displayable. If not supported → cut, or it's a contract change. Tightly coupled to B1 (vesting sits on these allocations). |
| **B3** | **Custom fee recipients** beyond the 4 modules — Create fee-structure-step (Development / Treasury / Charity / Buyback rows, each with a **required** wallet + %); rendered in fee pie + preview + Manage breakdown labels | A tax slice routed to an **arbitrary recipient wallet** (potentially several) | On-chain modules are a fixed enum: 0 REWARD, 1 BURN, 2 LIQUIDITY, 3 CREATOR. Routing tax to an arbitrary wallet = a **CreatorFeeModule (type 3) per recipient**. Unknown whether the launch/config path supports **>1 type-3 module** with arbitrary recipients + per-side allocations. | **Confirm multi-CreatorFeeModule support** (register multiple type-3 modules with arbitrary recipients at launch *and* add/remove later). If only one creator recipient is supported on-chain → multi-custom-fee is unbuildable → contract change. (Subgraph side is already fine: `Module` rows + `CreatorFeeForward`.) |
| **B4** | **Reward distribution cadence** — Create fee-structure-step "Reward Period" (Daily/Weekly/Monthly/Yearly); also editable in Manage edit-fees modal | A periodic reward-payout interval for the Reward module | RewardModule is continuous dividend-per-share (`dividendsPerShare`, `minDistribution`, `getUnpaidRewards`). Only **Burn/Liquidity** modules have an `interval`. There is no reward-period field to read or emit. | If periodic rewards are intended: add `interval` / `lastExecuted` to RewardModule (mirroring Burn/Liquidity) + expose via `getStats()` + `IntervalUpdated` event + subgraph `Module.interval`. If rewards are continuous → **remove the control** (becomes Type C). |
| **B5** | **"Min Tokens to Earn"** reward eligibility — Create fee-structure-step + Manage | Minimum **holder balance to qualify** for rewards | No read for a holder-eligibility threshold. `minDistribution` (§2a) is the min *accrued BNB before a distribution fires* — a different concept, so it can't back this field. | Confirm whether RewardModule has a min-balance-to-earn threshold. If yes → expose read + event. If no → the collected value has nowhere to go → drop it (or it's a contract change). |
| **B6** | **"Token Lock" / management renounce** — Manage page status pill ("Locked" vs "Editable") + "Lock Token" action (`lock-token-modal`) | Whether the creator has permanently renounced fee/rebate/module edit rights, and the act of locking | This is *management renouncement*, not LP-lock (LP is already locked-forever, §2d). Nothing in §2a exposes a `locked`/`owner`/`renounced` state on TaxHandler or RebateContract, and **no Appendix-B event** carries it. The subgraph can't index what isn't emitted. | **Confirm the capability even exists on-chain.** If yes: add a `managementLocked(token)` (or `owner()==0`) view **and** a `ManagementLocked(token, timestamp)` event covering the fee/module/rebate edit paths. |
| **B7** | **Loyalty tier / rewards-multiplier** — Portfolio `user-profile-section` (tier "Diamond", "4× multiplier", next-tier progress, thresholds) | Tier, reward multiplier, progress to next tier | No tier/multiplier concept anywhere. `UserVolume`/`userVolume` exist, but there is no tier accrual and **no multiplier applied at reward distribution**. A multiplier that boosts payouts lives *inside* distribution logic — can't be bolted on later. | **Most likely a cut** (no protocol trace). If keep: a tier contract + thresholds + a multiplier honored by the reward distribution path + `TierUpdated` event. |
| **B8** | **Referral system** — Portfolio `user-profile-section` (30% referral rate, total referrals, referral earnings, referral link) | Referrer→referee relationship; referrer earnings | No referral concept in the protocol. `RebateContract` is a *per-token buy bonus to the buyer* (`RebateCredited`), **not** a referrer relationship or referrer payout. No registration, attribution, or payout event/read exists. (Note: `User.referrals` / `ReferralData` are dormant in `lib/types.ts` too.) | **Most likely a cut** (no protocol trace). If keep: a Referral contract (register referrer, `ReferralAttributed`, `ReferralPaid`) + subgraph `Referral`/`ReferralEarning` entities. |
| **B9** | **"PXX" platform rewards** — Portfolio `rewards-section` (total/claimable/pending platform rewards in **PXX**, `earnedFrom: trading_fees`, "Claim Rewards") | A platform token + per-user emission + claim | There is **no platform token (PXX)** and **no platform emission/claim** in the surface. The platform fee is taken in BNB and sent to `FeeReceiver` (`FeeReceived`/`TokenFeeReceived`) — there is no user-claimable emission or per-user platform-reward accrual. | **Most likely a cut** (no protocol trace). If keep: an emissions/staking-rewards contract (token + per-user accrual view + `RewardClaimed`) — large; must predate deploy. **If cut, wire the tiles to the real `getUnpaidRewards` flow instead** (see Reverse-Drift R2). |
| **B10** | **Token metadata** — Create basic-info-step collects **logo image + description**; shown on preview, discover cards, token detail, portfolio | Logo image URL, description text | `ProjectGenerated` emits only name/symbol; `Token` entity has no image/description; ERC20 has no `tokenURI`. | **Decide the metadata source before deploy.** Either (a) **off-chain** metadata store keyed by token address — *no contract change, but the subgraph won't carry it* (frontend owns it); or (b) add a `metadataURI` arg to `ProjectGenerated` + `Token.metadataURI` — that's a **Type-B event-signature change**, so it must land pre-deploy if you want it queryable. |

---

## Type A — subgraph additions (data exists on-chain / in events; just not exposed yet)

| # | UI element | Datum | Nearest existing source | Suggested entity.field |
|---|---|---|---|---|
| **A1** | Home `MetricsSection` "Trading Volume" (total + 7d delta) | Platform-wide cumulative + 7-day-change trade volume | `PlatformConfig` exposes only `platformFeeBps / totalFeesReceivedBnb / totalTokens`; per-token `Token.totalVolumeBnb` exists but summing every token client-side is unbounded | Add `PlatformConfig.totalVolumeBnb`; for the delta, a `PlatformDayData { date, volumeBnb }` daily aggregate |
| **A2** | Home `MetricsSection` "Active Builders" (count + 24h delta) | Platform creator/user count + active-in-24h | No platform user/creator count; enumerating `Token.creator` is unbounded. *(Also note §2d: 24h-active by trader is undercounted — unattributed trades have `trader=0x0`.)* | Add `PlatformConfig.creatorCount` (and/or `userCount`); a 24h-active aggregate, or define "builder" = creator to sidestep the attribution gap |
| **A3** | Token-page price chart — **5m & 15m** timeframes (15m is the **default**) | Sub-hour OHLCV candles | `TokenHourData` (hourly) / `TokenDayData` (daily) only; 4h/1d are client-aggregatable from hourly, but 5m/15m are not | Add `TokenMinuteData { token, periodStart, OHLCV }` at 5-min resolution. *Not strictly blocking — derivable client-side from the `Trade` feed for short windows — but pre-agg is a real perf/UX win.* |
| **A4** | Portfolio "Performance" chart (7d/30d/90d portfolio value over time; currently synthetic) | Historical portfolio value | Price history exists (`TokenDayData.close`); only **current** balance exists (`Holder.balance`) — no historical balance. Reconstructable from `Transfer` events but not exposed. | Add `HolderDayData { holder, token, date, balance }` so value-over-time = Σ(balanceₜ × closeₜ) without replaying every `Transfer` client-side |
| **A5** | Token logo across cards/detail/portfolio | `token.image` | No image field on `Token` or any event | Same decision as **B10** — if on-chain route, `Token.logoURI` populated from a `metadataURI` event arg; if off-chain, frontend owns it |

---

## Type C — client-side / cosmetic (no backend change; listed for our own follow-up + 2 fixes for you to confirm)

**Derivable — currently faked in the mock, real source exists:**
- 24h High/Low, 24h Volume, 24h Trades — from last-24 `TokenHourData` (**not** `Token.totalVolumeBnb`/`buyCount`/`sellCount`, which are all-time/cumulative).
- Price change 24h %, Market Cap (`getSlot0` price × `Token.totalSupply`).
- **Liquidity in BNB** — derive from `StateView.getSlot0`+`getLiquidity`. **Do not display `Token.totalLiquidityLocked` raw** — it's V4 liquidity units, not BNB.
- Holder concentration / top-holder list — `Holder`(balance, isPool) ordered desc + `totalSupply`; labels via `==creator`/`isPool`.
- Trade quote / net-after-tax / price impact — must use **`V4Quoter.quoteExactInputSingle`** (§2b), not the current `price×fee` math.
- Realized/Unrealized/Total P&L, avg buy/sell price, Invested — from per-trade `Trade.*`.
- Raise progress %, time remaining, status (PENDING/ACTIVE/SUCCESS/FAILED) — client-derived per §2d.

**Cross-cutting — needs an explicit owner decision (not a contract blocker):**
- ⚠️ **No BNB→USD source anywhere in §2.** Every `$`-denominated value in the app (`formatUsd(..., {fromBnb:true})` — market cap, volume, portfolio value, raise totals) requires an **external price oracle/API**. All contract/subgraph values are BNB-denominated (`priceBnbPerToken`, `sqrtPriceX96`, every `*Bnb` field). Please confirm whether USD display stays (frontend wires an oracle) or the UI goes BNB-only.

**Copy / labeling fixes (frontend will make; flagging so contracts confirms intent):**
- ⚠️ **"Transfer fee" is rendered but doesn't exist.** `token-info-panel` shows a `Transfer {n}%` pill, and `Token`/mock data still carry `transferFee`. The protocol taxes **buy/sell swaps in BNB via the hook only** — there is no ERC-20 transfer tax (a plain `Transfer` can't take a BNB fee). `TokenCreationForm` already marks `transferFee` "REMOVED"; the display panels/mocks lagged. **We'll remove it** from UI + `Token` type + mock. Please confirm no transfer tax is intended (we believe it isn't).
- ⚠️ **"Tax-on-transfer" marketing copy** (hero, CTA, footer, features) misdescribes the mechanism. We'll reword to "tax-on-trade" / "buy & sell tax."
- **BYOL "Lock Period: X days"** contradicts the model — BYOL liquidity is permanently locked/burned (`LiquidityVault`, no expiry). We'll relabel to "Permanent."
- **FlatCurve duration** is inconsistent across screens ("Until sold out" vs "{duration} hours"). We'll standardize from `Raise.startTime/endTime`.
- **`PENDING_LAUNCH` status filter** (discover) has no obvious on-chain state — please confirm it's a real lifecycle phase or we drop the filter option.

---

## Reverse drift — data you provide that the UI currently ignores

These are **frontend build items, not contract changes** — but they're genuine inconsistencies between "the functionality you allow" and "what the front end expects," so please confirm intent:

- **R1 — Fee/module edits are not instant; you ship a timelock.** The Manage dashboard treats fee/breakdown/rebate edits as immediate ("now active"). Your contracts ship a full timelock: `pendingFeeChange()`/`pendingModuleChange()` reads, the `PendingChange` entity, and `FeeChangeProposed`/`ModuleChangeProposed(effectiveTime)` + `*Cancelled` events. The UI has **no pending-change banner, effective-time countdown, or cancel-pending control.** If the timelock is intended (we assume it is), the Manage UI must be rebuilt to honor it. *Please confirm.*
- **R2 — The real claimable-reward flow is unused.** Per-token `RewardModule.getUnpaidRewards(holder)` (live claimable, §2d) + `RewardClaimed` is the actual reward mechanism. Portfolio instead shows a non-existent "PXX" balance (B9). When B9 is cut, we'll wire the Claimable tile to `getUnpaidRewards` and the history to `RewardClaim`.
- **R3 — Module stats/countdowns/history are not surfaced.** Burn countdown (`lastBurnTime + burnInterval − now`), `totalBurned`, LP-locked, fee history, and module history are all available (reads + `Module`/`FeeChange`/`ModuleEvent` entities) but unused in the Manage dashboard. Frontend build item.

---

## Fully covered (no drift — confirmed mapping)

- **Discover cards & filters:** name, symbol, description, createdAt, creator, buy/sell fee, holders, launch type, status; presale raised/target/contributors → `Token.*` + `Raise.{totalRaised,hardCap,contributorCount,status}`. Sort (volume/marketCap/priceChange/created) + category filters → derivable.
- **Token detail / trading:** identity + addresses → `Token.*`; fee distribution (rewards/liquidity/burn/creator %) → `Module.{moduleType,buyAllocation,sellAllocation}`; trade history → `Trade.*`; balances → `balanceOf`; rebate "+X% on buy" → `Rebate.rebateBps` (§2d attribution caveat noted).
- **Create — core path:** name/symbol/supply/decimals, buy/sell fee, the **four canonical breakdown buckets** (burn/rewards/liquidity/creator → modules 1/0/2/3 with per-side allocations), rebate rate + funded amount → `Rebate.{rebateBps,fundedBalance}`.
- **Launch:** BYOL (`bnbForLP`/`tokensForLP`); FlatCurve (`hardCap`, `tokensForPresale/ForLP`, min/max contribution, `totalRaised`, `contributorCount`, per-user `contributions`).
- **Manage — core path:** token details, the 4 canonical fee channels, rebate pool (rate/remaining/top-up via `getRebate` + `RebateToppedUp`), raise raised/target.
- **Portfolio — core path:** value/holdings (`Holder.balance` × `getSlot0`), open positions, P&L (client-derived from `Trade.*`, §2d caveat), trade history, token reward history (`RewardClaim`).
- **Home/landing & nav:** "Tokens Launched" total + this-week delta (`PlatformConfig.totalTokens` + `Token.launchedAt`); the rest is static marketing copy; wallet chip is a standard RPC read.

---

## Decisions we need from you before deploy (checklist)

**Build-or-cut (full subsystems with no backing):**
- [ ] **B7 Loyalty tiers**, **B8 Referrals**, **B9 PXX platform rewards** — confirm these are **cut** (no protocol trace), or commit to building them pre-deploy.
- [ ] **B1 Vesting** + **B2 custom allocations** — real Generator behavior, or cut?

**Confirm capability / param exists (else cut or change contract):**
- [ ] **B3** — can multiple `CreatorFeeModule` (type-3) instances with arbitrary recipients be registered at launch *and* added/removed later?
- [ ] **B4** — does the Reward module support a distribution interval/cadence?
- [ ] **B5** — does the Reward module have a min-holder-balance-to-earn threshold (vs. `minDistribution`)?
- [ ] **B6** — does a "lock management / renounce edit rights" capability exist? If so add the view + `ManagementLocked` event.

**Pick a path (cheap if decided now):**
- [ ] **B10/A5** — token logo + description: off-chain metadata store, or add `metadataURI` to `ProjectGenerated` (event-signature change → must be pre-deploy)?
- [ ] **A1–A4** — approve the cheap subgraph aggregates/entities (`PlatformConfig.totalVolumeBnb`/`creatorCount`, `PlatformDayData`, `TokenMinuteData`, `HolderDayData`).

**Confirm intent (we adapt the UI either way):**
- [ ] **R1** — fee/module timelock is intended (UI must show pending/countdown/cancel).
- [ ] No ERC-20 transfer tax exists (we remove the "Transfer %" UI).
- [ ] `PENDING_LAUNCH` — real lifecycle state or drop the filter.

*Type B is the only category that can block deploy. Everything else is subgraph-side (A) or our side (C / reverse-drift).*
