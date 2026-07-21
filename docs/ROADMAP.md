# Lumoria Master Plan

## Context

**What we're building:** A curated token launchpad with modular tokenomics on BNB Chain, with liquidity living in **Uniswap V4 pools** governed by a custom **LumoriaHook**. Token creators launch tax-on-transfer tokens through our system, configure how their taxes are used via pluggable modules (rewards, burn, auto-liquidity, creator fees), and trade on a hook-taxed native-BNB/token V4 pool.

**Core innovation:** Taxes are collected as BNB at the **pool level** (not as tokens that need to be sold later), eliminating sell pressure from tax processing. The LumoriaHook takes 1% platform fee + token-configured tax in native BNB on every swap — no matter which router initiated it — and sends the tax to a per-token TaxHandler that distributes to modules. (Phases 1–4 built this around a custom V2-style DEX; Phase 5 replaced that DEX with Uniswap V4 + hook.)

**Revenue model:** Lumoria has no token (yet). Platform earns a flat 1% BNB fee on all trades and raise contributions, collected in a single `FeeReceiver` contract.

**Reference docs (keep all three in lock-step with this file):**
- **[`docs/DESIGN.md`](./DESIGN.md)** — the comprehensive "what we're building" doc. 17 sections (architecture, contracts, events, security, resolved decisions).
- **[`docs/FRONTEND.md`](./FRONTEND.md)** — UI + subgraph integration notes. Events, reads, writes, entity sketch, user flows. Update alongside every contract change.
- **[`docs/TESTING.md`](./TESTING.md)** — Hardhat test setup + coverage status + Blocked list. Every contract change should land with a test (or an explicit "blocked" entry).

---

## System Roadmap (All Phases)

```
Phase 1: Core Infrastructure      ✅ DONE
Phase 2: Tax System               ✅ DONE
Phase 3: DEX Refactor             ✅ DONE   (superseded by Phase 5)
Phase 4: Launch System            ✅ DONE
Phase 5: Uniswap V4 Migration     ✅ DONE
Phase 6: Pre-Beta Frontend Align  ✅ DONE
Phase 7: Tokenomics V2 modules    ✅ DONE (Phase A + B1 Milestone + B2 Randomness + B3 PrizePool + B4 subgraph/operators)
```

**All six phases complete.** Phase 5 replaced the custom V2-style DEX (Factory/Pair/Router) with Uniswap V4 pools + a LumoriaHook that enforces the entire fee stack at the pool level. Phase 6 closed the frontend drift audit (`docs/CONTRACTS_SUBGRAPH_DRIFT_REPORT.md`) by building the three genuinely-missing capabilities — token **vesting** + custom **allocations** + management **renounce** — and documenting the many capabilities that already existed but were mis-described to the frontend (see `docs/CONTRACTS_DRIFT_RESOLUTION.md`). **175 tests green; deploy + smoke validated locally.** Remaining pre-mainnet work: a real **security audit** (the hook handles up to 98% of swap flow — see DESIGN.md §14, now also covering `VestingVault`), the **subgraph** (hook/vault/vesting events — see FRONTEND.md / SUBGRAPH.md), and final frontend integration (V4Quoter quoting, Universal Router support). Deployment scripts live in `scripts/` (see [TESTING.md § Deployment](./TESTING.md#deployment-scripts)).

### Phase 1 — Core Infrastructure ✅ COMPLETE
Built:
- **Core interfaces** in `contracts/interfaces/`: `IERC20`, `IDatabase`, `ILumoriaToken`, `ITaxHandler`, `IModule` (+ `IRewardModule`), `IFeeReceiver`, `IRebate`, `IFlatCurve`, `IGenerator` (`ILumoriaRouter` + `ILumoriaLiquidityVault` added in Phase 5)
- **`Database.sol`** — central registry (system config, master copies, token registry, volume tracking, 1% platform fee)
- **`LumoriaToken.sol`** — clean ERC20 master copy (1B supply, holder tracking via `ITaxHandler.setShare()`, no tax logic)
- **`FeeReceiver.sol`** — platform fee collector with per-token analytics

### Phase 2 — Tax System ✅ COMPLETE
Built the TaxHandler (per-token BNB distributor with 24h timelock for all creator changes) + 4 tokenomics modules (CreatorFee, Reward, Burn, Liquidity).

**Progress:**
- ✅ ReentrancyGuard modified (`_status` made `internal`)
- ✅ `contracts/interfaces/ILumoriaRouter.sol` created
- ✅ `contracts/interfaces/ITaxHandler.sol` updated with `AllocationUpdate` struct + batch-proposal signatures
- ✅ `contracts/modules/CreatorFeeModule.sol` — Type 3
- ✅ `contracts/modules/RewardModule.sol` — Type 0 (checkpoint-based dividends, BNB and token modes)
- ✅ `contracts/modules/BurnModule.sol` — Type 1 (permissionless executeBurn, 5-min MIN_INTERVAL floor)
- ✅ `contracts/modules/LiquidityModule.sol` — Type 2 (permissionless executeLiquidity, LP to dEaD)
- ✅ `contracts/TaxHandler.sol` — orchestrator with batch module proposals + 24h timelock for all adverse creator changes

### Phase 3 — DEX Refactor ✅ COMPLETE
- ✅ **`Pair.sol`** — V2-style constant-product pair, 0.1% LP fee kept in pool, `swap()` accepts a trailing `user` parameter so Factory can emit user-attributed Buy/Sell events.
- ✅ **`Factory.sol`** — curated-only (`Database.isLumoriaToken` gate). Only Generator + Router can call `createPair`. Always pairs against WBNB.
- ✅ **`Router.sol`** — new fee flow (1% platform fee → FeeReceiver, then token tax → TaxHandler, then swap remainder). `quoteBuy` / `quoteSell` for UI. Lazy pair creation on first `addLiquidityETH`. Rebate callout silent on empty pools.
- ✅ **`RebateContract.sol`** — global contract, per-token pools. Creators fund with their own token + set bps rate. Router-authorized creditors call `creditRebate` after buys. Silent exit on empty/inactive; auto-reactivate on topUp.
- ✅ **Tax-recursion flywheel confirmed working** — modules routing through the Router pay 1% platform fee + the token's own tax, which loops back through TaxHandler. Intentional; each execute* run gently amplifies reward flow.
- ✅ **Pair excluded from reward-share tracking** — `LumoriaToken._transferFrom` skips `setShare` calls when the counterparty is the pair. Prevents the pool from accruing stuck rewards.

### Phase 4 — Launch System ✅ COMPLETE
- ✅ **`Generator.sol`** — single-tx launch: CREATE2 token clone (predictable address), non-deterministic TaxHandler clone, Factory-CREATE2 pair-address pre-computation, atomic branch to BYOL or FlatCurve. `predictTokenAddress(salt)` view for UIs.
- ✅ **`FlatCurve.sol`** — cloneable presale. `contribute` (1% platform fee on entry, non-refundable). `refund` pre-launch. `launch` permissionless — success branch creates LP via Router (pair lazy-created) + sends creator share + makes tokens claimable; failure branch enables `withdrawOnFailure` for contributors.
- ✅ **Module init payload refactor** — `taxHandler` is now inferred from `msg.sender` at `__init__` (was encoded in payload). This closes the chicken-and-egg that previously required pre-computing the TaxHandler address before building module configs — now single-tx launches work cleanly.
- ✅ Integration tests: BYOL full flow, FlatCurve contribute/refund/launch/claim, FlatCurve failure path with `withdrawOnFailure`, post-launch tradability via Router.
- ✅ Deployment scripts (`scripts/deploy-base.js`, `scripts/smoke-launch.js`, `scripts/verify.js`) — dry-run validated end-to-end against a persistent localhost node.

---

## Phase 5 Plan (Current Focus) — Uniswap V4 Migration

**Goal:** delete the custom DEX (Factory/Pair/Router) and run all liquidity + trading on the canonical Uniswap V4 `PoolManager` (BSC: `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`), with a single `LumoriaHook` enforcing the full fee stack at the pool level. Everything else (Database, TaxHandler, modules, RebateContract, FeeReceiver, Generator, FlatCurve, LumoriaToken) stays.

**Why this is strictly better:** the old `Pair.swap()` was permissionless — taxes were bypassable by swapping against the pair directly. The hook runs on *every* swap regardless of router (our UI, Universal Router, aggregators), so taxes are now unbypasseable within our pool, and third-party routing becomes free distribution instead of a tax leak.

### Pool architecture (decisions, all final)

| Decision | Choice |
|---|---|
| Pool shape | One V4 pool per token: `PoolKey{ currency0: native BNB (address(0)), currency1: token, fee: 0, tickSpacing: 60, hooks: LumoriaHook }` |
| PoolId | `keccak256(abi.encode(poolKey))` — fully deterministic from token address; no registry storage needed |
| Pairing | **Native BNB** (no WBNB wrapping). `Database.wbnb` retained only as the path marker modules already use |
| LP fee | **0** — the 0.1% LP-depth model is dropped (owner decision). All economics flow through hook-taken fees |
| Liquidity | Full-range only, owned exclusively by `LumoriaLiquidityVault`, which has **no removal code path** — permanently locked (replaces LP-to-dEaD; strictly stronger) |
| Swap support | exactInput both directions. **All exactOutput swaps revert in the hook** (matches old Router UX; removes the awkward fee-on-specified-output case) |
| Hook upgrades | Hook address is immutable per pool. All mutable config (fees, modules, platform fee, feeReceiver, rebate) is read live from Database/TaxHandler, so creator/admin changes never require pool migration |

### Fee flow (identical math to the old Router)

- **Buy (BNB→token, exactIn)** — `beforeSwap` + `beforeSwapReturnDelta`: hook takes `platformFee = bnbIn × platformFeeBps / 10000` then `tax = (bnbIn − platformFee) × buyFee / 10000` from the BNB input via `poolManager.take()`, forwards immediately (`FeeReceiver.receiveTradeFee{value}(token, user, bnbIn, true)`, `TaxHandler.receiveBuyTax{value}()`), returns a `BeforeSwapDelta` so only the remainder swaps.
- **Sell (token→BNB, exactIn)** — `afterSwap` + `afterSwapReturnDelta`: hook reads actual BNB output from `BalanceDelta`, takes `platformFee` then `sellFee` portion, forwards, returns the `int128` hook delta so the user receives the remainder.
- **Rebates + volume** — in `afterSwap` on buys the hook decodes `hookData = abi.encode(address user)` (supplied by our `LumoriaSwapRouter`), calls `RebateContract.creditRebate(token, user, tokensOut)` (silent-exit semantics unchanged) and `Database.registerVolume(token, user, bnbAmount)`. Empty `hookData` (third-party routers) → taxes still collected, rebate + per-user volume skipped, `tokenVolume` still tracked.
- **Events** — hook emits `TokenPurchased` / `TokenSold` with the same fields as the old Router events (subgraph continuity).

### Files

**Create (3):**
1. `contracts/v4/LumoriaHook.sol` — permissions: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `afterSwap`, `beforeSwapReturnDelta`, `afterSwapReturnDelta`, `beforeDonate`.
   - `beforeInitialize`: pool must match the canonical shape AND `database.isLumoriaToken(currency1)` AND `sender == liquidityVault` — no rogue hooked pools.
   - `beforeAddLiquidity`: `require(sender == liquidityVault)` — every drop of liquidity is protocol-locked.
   - `beforeRemoveLiquidity`: always reverts — hard "liquidity can never leave" invariant.
   - `beforeDonate`: reverts (donations would accrue to the locked position, i.e. be burned by accident).
   - `beforeSwap` / `afterSwap`: fee flow above; exactOut reverts.
2. `contracts/v4/LumoriaLiquidityVault.sol` — the only liquidity owner. `addLiquidityLocked(token, tokenAmount)` payable (router-only): on first add, computes `sqrtPriceX96` from the BNB/token ratio and calls `poolManager.initialize`; then mints full-range liquidity via `unlock → modifyLiquidity → settle` (native BNB + ERC20 sync/settle), refunds dust to the funding caller. No removal function exists. Tracks `lockedLiquidity[token]` for analytics; emits `LiquidityLocked(token, bnbAmount, tokenAmount, liquidity)`.
3. `contracts/v4/LumoriaSwapRouter.sol` — thin unlock-callback router implementing the **existing `ILumoriaRouter` interface** so Generator / FlatCurve / BurnModule / LiquidityModule / RewardModule need zero changes:
   - `swapExactETHForTokensSupportingFeeOnTransferTokens(amountOutMin, path, to, deadline)` payable — `path[0]` accepts `Database.wbnb()` (module convention) or `address(0)`; swaps native BNB → token with `hookData = abi.encode(to)`.
   - `swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, to, deadline)` — sell side for the frontend.
   - `addLiquidityETH(token, amountTokenDesired, ..., to, deadline)` payable — pulls tokens, delegates to the vault. `to` is ignored (liquidity is always vault-locked); returns `(amountToken, amountETH, liquidity)` as before.
   - No `removeLiquidityETH` — liquidity is unremovable by design.

**Modify (4):**
4. `Database.sol` + `IDatabase.sol` — remove `factory`; add `poolManager`, `hook`, `liquidityVault` (+ setters/events). `registerVolume` gate: `msg.sender == hook`; skip `userVolume` when `user == address(0)`.
5. `Generator.sol` — drop `_computePairAddress` / `ILumoriaFactory`; pass the **PoolManager address** as the token's `pair` (it is the token-holding venue, so the existing share-tracking exclusion carries over unchanged). BYOL still calls `router.addLiquidityETH`.
6. `RebateContract` wiring (deploy-time only) — authorize the **hook** as creditor instead of the router.
7. `hardhat.config.js` — dual compiler (0.8.28 project / 0.8.26 for PoolManager), `evmVersion: cancun` (BSC has Cancun opcodes since the Haber hardfork, June 2024).

**Unchanged (verified against source):** `TaxHandler.sol` (`receiveBuyTax`/`receiveSellTax` are permissionless deposits), `LumoriaToken.sol` (the `pair` exclusion address just becomes the PoolManager), all 4 modules (they speak `ILumoriaRouter` via `database.router()`), `FeeReceiver.sol`, `FlatCurve.sol` (calls `database.router()`), `RebateContract.sol` (creditor is config, not code).

**Delete → `legacy/`:** `Factory.sol`, `Pair.sol`, `Router.sol`, `ILumoriaFactory.sol`, `ILumoriaPair.sol`.

### Hook deployment mechanics
Hook permissions are encoded in the low 14 bits of the hook's address (`v4-core/src/libraries/Hooks.sol`). Deployment uses CREATE2 with a mined salt: tests mine in JS against a small `Create2Deployer` mock; BSC deploy mines against the canonical deterministic-deployment proxy. The fixture exposes `mineHookSalt(deployer, initCodeHash, requiredFlags)`.

### Quoting
On-chain `quoteBuy`/`quoteSell` views are dropped (CL math can't be replicated as a cheap view). The UI uses the canonical **V4Quoter** (BSC: `0x9f75dd27d6664c475b90e105573e550ff69437b0`) with our deterministic PoolKey — it simulates hook deltas, so quotes are tax-accurate automatically. Documented in FRONTEND.md.

### Build order
1. ✅ V4 deps + hardhat config (cancun, dual compiler — 0.8.26 entry solely for PoolManager)
2. ✅ `contracts/v4/LumoriaHook.sol`
3. ✅ `contracts/v4/LumoriaLiquidityVault.sol`
4. ✅ `contracts/v4/LumoriaSwapRouter.sol`
5. ✅ Database/IDatabase rework + Generator rework + legacy moves (`Factory/Pair/Router` + their interfaces → `legacy/`)
6. ✅ Test fixtures (local PoolManager deploy + hook salt mining via `scripts/lib/hook-miner.js`) + full test-suite migration + new `V4Hook.test.js` — **147 tests green**
7. ✅ Deploy scripts (canonical PoolManager/periphery on bsc; deployed PoolManager on testnet/local) — deploy + smoke validated end-to-end on localhost
8. ✅ Docs lock-step (DESIGN/FRONTEND/TESTING/README) + `npm test` green

### Phase 5 Verification
- Buy + sell exactIn: platform fee → FeeReceiver and tax → TaxHandler **to the wei**, same formulas as old Router; remainder swaps; user receives output
- 98% buy/sell fee works end-to-end; 0% fee works (no TaxHandler call)
- exactOut (both directions) reverts; swaps without hookData are still taxed (the bypass-proofing property)
- Rebate credited and volume registered when routed through LumoriaSwapRouter; skipped (no revert) otherwise
- Pool creation impossible except via Generator→vault path; `modifyLiquidity` removal attempts revert; third-party `addLiquidity` reverts; donate reverts
- BYOL + FlatCurve launches end-to-end on V4 pools; Burn/Liquidity/Reward module `execute*` flows green through the new router
- Token's share-tracking exclusion holds for PoolManager (no stuck reward shares)

---

## Phase 6 — Pre-Beta Frontend Alignment ✅ COMPLETE

Closed the frontend drift audit (`docs/CONTRACTS_SUBGRAPH_DRIFT_REPORT.md`). Built the three capabilities the UI assumed but the protocol lacked, and produced the authoritative resolution doc (`docs/CONTRACTS_DRIFT_RESOLUTION.md`) for everything else.

**Built (new on-chain capability):**
- ✅ **`VestingVault.sol`** (+ `IVestingVault`) — shared singleton, linear+cliff schedules, **non-revocable** (no revoke path), `createSchedule` gated to the Generator, permissionless `release`. Events `ScheduleCreated` / `TokensReleased`.
- ✅ **`Generator` allocations (B2)** — `generateProject` gains an `AllocationData[]` param carved from the creator remainder (immediate `duration==0` → `AllocationMinted`; vested `duration>0` → vault + `AllocationVested`). `MAX_ALLOCATIONS = 100`; over-allocation reverts.
- ✅ **`TaxHandler.renounceManagement()` (B6)** — one-way freeze of all fee/module changes (clears pendings); `managementRenounced()` view + `ManagementRenounced` event; guards on all six mutators.
- ✅ **RebateContract renounce-freeze (Q1)** — `fundRebate` / `setRebateBps` / `withdrawFunds` revert `"Rebate: renounced"` once the token's creator has renounced; `topUpRebate` + `creditRebate` stay open. New `isManagementRenounced(token)` view. Makes "Lock Token" cover fees + modules + rebate.
- ✅ **Reward-share exclusion** — `TaxHandler` caches `Database.vestingVault()` at init and skips it in `setShare`, so vested-but-unclaimed tokens never accrue stranded reflections. **`LumoriaToken` untouched.**
- ✅ **Wiring** — `Database.vestingVault` + `setVestingVault`; deploy-base.js deploys/wires it (+ artifact); verify.js verifies it; fixture + smoke updated.

**Documented-only (already shipped, was mis-described to the frontend):** multi-recipient fees via N CreatorFeeModules (B3), the 24h fee/module **timelock** (R1), the real `getUnpaidRewards` reward-claim flow (R2), module stats/burn countdowns (R3), the **continuous** reward model (B4), `minDistribution` semantics (B5), rebates vs referrals, per-user volume attribution, `predictTokenAddress`, V4Quoter/StateView quoting. **Cut:** loyalty tiers (B7), referrals (B8), PXX (B9). **Off-chain:** token metadata (B10). All resolved in `CONTRACTS_DRIFT_RESOLUTION.md`.

**Verification:** 175 tests green (+28: VestingVault 11, allocations 7, renounce 6, rebate renounce-freeze 4). Deploy dry-run wires the vesting vault end-to-end.

---

## Phase 7 — Tokenomics V2 Modules ([`TOKENOMICS_V2.md`](./TOKENOMICS_V2.md))

**Phase A (pre-mainnet substrate) ✅ COMPLETE** — hot-path swap removed from
RewardModule (§7.1), CreatorFeeModule accrue-and-pull (§7.2), share-exclusion set
(§7.3), `Database.randomnessProvider` (§7.4), dust-sweep fix (§7.5), fee
pending-disarm + per-change increase cap (§7.6/§7.7), `donate()`/`sync()`,
slippage floors + platform operator registry (§6.2/§6.3). 217 tests green at
Phase-A close.

**Phase B (module drops — nothing frozen changes, ships any time):**

- ✅ **B1 · MilestoneRewardModule (type 5)** — `contracts/modules/MilestoneRewardModule.sol`.
  Accrues tax; creator releases any amount to all holders via the RewardModule's
  `donate()` with the milestone recorded as free text on-chain. Exactly one
  value-moving call; destination never a parameter. Includes the **18-month
  public-release valve** (§2B.2b): after 540 days with no release, anyone can
  push the full balance to holders; any release resets the clock. 24 tests
  (`test/modules/MilestoneRewardModule.test.js`) + subgraph template.
- ✅ **B2 · Randomness** — `IRandomnessProvider` + `TrustedOperatorRandomness`
  (commit–reveal + blockhash mixing, consumer-scoped keys — V2 §3.2b) +
  `MockRandomness`. Registered at `Database.randomnessProvider`. 14 tests
  (`test/TrustedOperatorRandomness.test.js`).
- ✅ **B3 · PrizePool (type 4)** — `contracts/modules/PrizePool.sol` + vendored
  `lib/MerkleProof.sol`. Epoch bucketing, off-chain tickets from
  `TokenPurchased`, merkle settlement (root **before** randomness, 6h challenge
  window), three payout modes, pull claims, rollover-never-strand. 28 tests +
  implementation notes in TOKENOMICS_V2 §2.12.
- ✅ **B4 · Subgraph + operator scripts** — PrizePool + Milestone templates,
  reference ticket derivation (`subgraph/src/prize.ts` — PrizeEpoch stores
  posted AND independently-derived totals), operator tooling
  (`scripts/operator/settle-prizepool.js`, `scripts/operator/randomness.js`)
  sharing `scripts/lib/merkle.js` with the tests, and a closed-loop test
  (`test/operator/Settlement.test.js`) proving hook logs → derivation → root →
  on-chain claim agree.

---

## Ongoing Tracks (every phase)

These aren't phases themselves — they're disciplines that run alongside every phase.

### Testing ([`docs/TESTING.md`](./TESTING.md))
- Every contract change lands with a test (or a `TODO:` stub + Blocked entry).
- `npm test` must pass before a phase is marked done.
- When Phase 3 lands a real Router, migrate the pending Blocked tests (Burn/Liquidity `execute*`, RewardModule token-mode) to green.

### Frontend / Subgraph ([`docs/FRONTEND.md`](./FRONTEND.md))
- Every new event, storage field, or external function gets a line in FRONTEND.md — reads/writes/subgraph guidance.
- Phase sections flip 🟡 → 🟢 as each contract lands.
- Treat the subgraph entity sketch as a living design — refine when we have real client requirements.
