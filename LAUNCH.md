# Lumoria — Pre-Mainnet Launch Checklist

**This is the working todo list to mainnet.** Step through it top-to-bottom; flip each box as it lands. Keep it honest — an item is only ✅ when it's actually verified, not "should work."

**Legend:** ✅ done · 🔄 in progress · ⬜ todo · ⏸️ deferred (intentionally, for now) · 🚧 blocked

**Strategy: closed-beta-first.** Ship to mainnet **ASAP** and run a **closed beta in parallel with the security audit**. The audit is no longer a hard gate for the *beta* — but it **remains required before an open/public launch**. The beta uses real mainnet contracts with real BNB and **permanently-locked liquidity**, so treat it as a controlled-exposure launch — see the beta guardrails in §3.

```
Critical path (closed-beta-first):
  [✅ contracts + docs + tests]
        │
        ├─ ✅ frozen-layer doors closed (§1b)
        ├─ ✅ fork rehearsal (ran 2026-07-20 — caught + fixed missing Phase-B wiring in deploy-base.js)
        ├─ ⬜ Slither / quick static pass
        │        │
        │        ▼
        ├─ ✅ MAINNET DEPLOY → ✅ verify → ⬜ guarded smoke ──→ ⬜ CLOSED BETA (capped exposure)
        │      (2026-07-21)                                          running IN PARALLEL with
  ┌─ ✅ subgraph spec → ✅ scaffold → ✅ deploy (Goldsky) ─┐        ⬜ SECURITY AUDIT → ⬜ remediation
  ├─ ⬜ frontend integration (quoting/routing)   ┘                          │
  └ (hand the agents the docs; build alongside the beta)                    ▼
                                                          ⬜ OPEN / PUBLIC LAUNCH (audit-gated)
                                                          → ⏸️ ownership handoff → ⬜ Uniswap routing allowlist
```

---

## 1. Code & Repo (✅ complete)

- [x] Phases 1–5 implemented; custom V2 DEX retired to `legacy/` (Uniswap V4 + LumoriaHook).
- [x] **Phase 6 — frontend alignment**: built token vesting (`VestingVault`) + custom allocations (`Generator.allocations`) + management renounce (`TaxHandler.renounceManagement`, which also freezes the `RebateContract` rate/withdraw paths); reward-share exclusion for the vault (TaxHandler-side, token untouched). Full drift audit + follow-up Q&A (rebate lock, funding path, reward-token mode) resolved in `docs/CONTRACTS_DRIFT_RESOLUTION.md`.
- [x] `npm test` green — **175 passing**.
- [x] Dead-code sweep: deleted `IWETH.sol`, `lib/Cloneable.sol`; kept `EnumerableSet.sol` for future use.
- [x] Stale comments + docs refined to the V4 / pool-level-tax / vault-lock model (DESIGN/ROADMAP/FRONTEND).
- [x] Git hygiene: `.claude/` gitignored; stale `goofy-booth` worktree + branch removed.
- [x] Whole rebuild committed to `main`.
- [x] **Tokenomics V2 — Phase A** (`docs/TOKENOMICS_V2.md` §7, §4.1, §4.2): fixed two trade-bricking defects in frozen-at-launch code — `RewardModule` performed an external router swap inside the V4 swap callback (§7.1), and `CreatorFeeModule` pushed BNB with `require(success)`, so a contract recipient without `receive()` reverted every trade (§7.2). Added the share-exclusion set (§7.3 — `RebateContract`/`FlatCurve`/`LiquidityVault`/module clones would otherwise strand reflections once reward-by-default ships), `Database.randomnessProvider` (§7.4), the 0-bps dust-sweep fix (§7.5), plus `RewardModule.donate()` + `sync()`. `graph codegen`/`build` pass; deploy + smoke re-validated locally.
  - Also (§6.2): every module swap took `amountOutMin = 0` — a free sandwich, since these swaps spend the *module's* BNB and an arbitrary caller has no incentive to pick a good floor. `executeBurn` / `executeLiquidity` / `triggerDistribution` now require a non-zero slippage floor + deadline, and execution authority comes from a **platform-wide operator registry on the Database** (`isOperator` / `operatorCount` / `setOperator`, owner-only — token creators cannot appoint operators). While `operatorCount == 0` everything stays permissionless; once operators exist they execute first and anyone may execute after a 1h fallback, so an absent backend delays a burn but never strands funds. Only the three functions that *swap* are gated (§6.3) — `triggerDistribution` was split into the permanently-permissionless `processRewards()` and the gated `convertAndDistribute()`; claims, donations and share-sync are never gated. `RewardModule.receiveTax` lost its reentrancy guard (a guard there reverts whenever a module-initiated swap re-enters the tax path); self-rewarding tokens are rejected at init. **211 tests green.**
  - ⚠️ **Breaking ABI changes** for frontend/subgraph, catalogued in [`docs/FRONTEND_MIGRATION_V2.md`](./docs/FRONTEND_MIGRATION_V2.md) (nothing in the UI repo touched yet): `CreatorFeeModule.TaxForwarded` → `TaxAccrued` + `TaxWithdrawn` and fees must be pulled via `withdraw()`; module `execute*` signatures gained `minOut`/`deadline`; `RewardModule.triggerDistribution` was replaced by `processRewards()` + `convertAndDistribute()`. Module init payloads are **unchanged**.
  - ✅ **Frozen-layer doors all closed** — see §1b: fee-timelock bait-and-switch fixed, per-change fee-increase cap added, hook now emits pool price for OHLC. **217 tests green.**
- [x] **Typed FeeReceiver interface (2026-07-20)** — closed the last frozen-layer door before deploy: the hook forwarded platform fees as `receiveFee(token)` with no trade context, and the hook can never be upgraded once pools exist. `IFeeReceiver` now has `receiveTradeFee(token, user, tradeAmount, isBuy)` (hook swaps — any router, `user=0x0` without hookData — and FlatCurve contributions) and `receiveLaunchFee(token, user)` (Generator BYOL). A future FeeReceiver swapped in via `Database.setFeeReceiver` receives full per-trade context on-chain (wager tracking etc.). Current implementation still just accrues; `FeeReceived` still fires on every inflow so the subgraph revenue handler is unchanged. ABI notes in `FRONTEND_MIGRATION_V2.md §3b`. **290 tests green.**
- [x] **Flat launch fee (2026-07-20)** — replaced BYOL's 1% skim on the creator's LP seed with a **flat anti-spam fee** (`Database.launchFeeBnb`, 0.005 BNB at deploy, owner-settable via `setLaunchFee`, ≤ 1 BNB, can be 0) charged on **every** `generateProject` call: BYOL sends `launchFee + LP BNB` (ALL post-fee BNB seeds the pool), FLAT_CURVE sends exactly `launchFee` (raise creation now costs the fee too). FlatCurve *contributions* keep the 1% trade-like fee (→ `receiveTradeFee`). `BYOLLaunched` dropped its `platformFee` param. Wizard math in `FRONTEND_MIGRATION_V2.md §3a`; subgraph indexes `LaunchFeeUpdated` → `PlatformConfig.launchFeeBnb`. **298 tests green.**

## 1c. Token display metadata — Generator + token master-copy swap (⬜ migration pending)

Reverses the Phase-6 "metadata is off-chain" call. Without metadata on chain a
Lumoria token is legible to Lumoria and to nobody else — every external scanner,
wallet and aggregator renders it as a letter avatar with `$0`, because there is
nothing to read and no reason to ask us. Spec: **DESIGN §12.2**; rollout notes:
ROADMAP Phase 8.

- [x] **Contracts.** `ILumoriaToken.Metadata { image, socials, contractURI }` on `__init__`; `contractURI()` (ERC-7572) + `image()`/`logo()`/`socials()` (launchpad convention) + creator-only setters that **also freeze on renounce**; `generateProject` gains `metadata` as its **last** parameter and emits `TokenMetadataInitialized`. No `description` on chain — it lives in the ERC-7572 JSON. **307 tests green.**
- [x] **Subgraph.** `Token.image` / `.socials` / `.metadataURI`; new Generator handler + three token-template handlers. `codegen` + `build` pass.
- [x] **Frontend.** Browser-side WebP re-encode → Arweave (ArDrive Turbo) upload before signing → URIs into calldata; creator editor on the manage page; scheme-checked rendering; caching image proxy for the Arweave propagation window. Needs **`ARWEAVE_SIGNER_KEY`** in the deploy env (`documentation/ENV.md`).
- [ ] ⬜ **Run the migration on mainnet** — `npx hardhat run scripts/migrate-metadata.js --network bsc`. Deploys a new `LumoriaToken` master copy + `Generator` and repoints the live Database via `setTokenMasterCopy` / `setGenerator` (both owner-only).
- [ ] ⬜ **Verify + redeploy the subgraph** with the new Generator address, then **`npm run abis`** in the frontend repo and **smoke-launch** to confirm `TokenMetadataInitialized` carries the URIs.

⚠️ **This is a two-transaction swap and the pair must move together** — the new
Generator calls the new 6-argument `__init__`. Between the two txs launches fail
closed (the old Generator's 5-argument call reverts against the new master copy),
which is the safe direction, but do not leave the window open.

⚠️ **Tokens launched before the migration keep working and have no metadata
getters** — they are clones frozen against the old master copy. Every read of
these fields is optional (`try_` in the subgraph, a fallback avatar in the UI)
for exactly this reason. If the beta has not launched a token yet, this window
is empty.

⚠️ **`predictTokenAddress` answers change** — the ERC-1167 init code embeds the
master copy, so the same salt derives a different address afterwards. The launch
path already re-reads the prediction at signing time.

## 1b. Frozen-Layer Decisions (✅ all closed)

`TaxHandler` is cloned per token and `LumoriaHook`'s address is part of every
`PoolKey`. Neither can be changed for a token once it exists. These were the
one-way doors, and they are now shut.

- [x] ✅ **Fixed `TaxHandler` §7.6 — an instant fee decrease now disarms a pending fee increase.** Before: a creator could arm 98%, instantly drop to 0% so every UI read "0% fees", let people buy, then execute the armed increase 24h later. The instant path now clears `pendingFeeChange` and emits `FeeChangeCancelled`. Regression tests in `test/TaxHandler.test.js`.
- [x] ✅ **Added §7.7 — `MAX_FEE_INCREASE_PER_CHANGE = 1000` bps.** A single proposal can raise a fee by at most 10 percentage points. Climbing 5% → 98% now takes ~10 sequential proposals, each with its own 24h public notice — about ten days of unambiguous on-chain intent. Launch fees stay unconstrained (they are public at launch).
- [x] ✅ **Implemented §12 #8a — the hook emits `sqrtPriceX96` + `tick`** on `TokenPurchased` / `TokenSold` (~2.6k gas/swap, one extsload, no storage). The subgraph now builds candles from the exact pool mark and **never indexes the canonical PoolManager**. `docs/TOKENOMICS_V2.md` §13.1; frontend impact in `FRONTEND_MIGRATION_V2.md` §2b.
- [x] ✅ **Decided §12 #8b — no on-chain price observation.** It only covers our own pool (`convertAndDistribute` swaps externally), a lagged-tick floor either allows sandwiches or bricks burns on a volatile token, and the operator registry is reversible where the hook is not. §13.2.
- [x] ✅ **Decided §12 #7 — no fee ratchet.** Fees already cannot rise without 24h of public on-chain notice. Keep the timelock, build the timelock UI (`FRONTEND_MIGRATION_V2.md` §2c). §13.3.

## 2. Pre-Deploy Rehearsal — BSC mainnet fork (⬜ infra ready, run pending)

Validates the deploy + a real launch/buy against the **actual canonical V4 PoolManager** (`0x28e2…e9df`) before spending real BNB. The testnet path deploys its *own* PoolManager, so this fork is the only pre-mainnet exercise of the canonical integration.

- [x] `hardhat.config.js` — optional BSC fork on the `hardhat` network, gated by `BSC_FORK`, pinned `chainId: 56` (so deploy treats it as mainnet). Never forks during `npm test`.
- [x] `deploy-base.js` — detects mainnet by **chainId 56** (not network name), so a fork uses the canonical PoolManager + WBNB marker + periphery.
- [x] ✅ **Ran it (2026-07-20).** Alchemy BSC endpoint (`BSC_RPC`) confirmed archive-capable; forked at block 111169576 with `BSC_FORK=1 BSC_FORK_BLOCK=… npx hardhat node`, then `npm run deploy:local` + `npm run smoke:local`. Deploy used the **canonical PoolManager `0x28e2…e9df`**; smoke launched a BYOL token, seeded + vault-locked V4 liquidity, and bought 0.01 BNB through `LumoriaSwapRouter` with volume registered. **The rehearsal caught a real gap:** `deploy-base.js` predated Phase B and never deployed/wired `PrizePool` (type 4), `MilestoneRewardModule` (type 5), or `TrustedOperatorRandomness` (`Database.randomnessProvider`). Fixed in `deploy-base.js` + `verify.js` (artifact now includes `masterCopies.prizePool/.milestone` + `core.randomnessProvider`); re-ran deploy + smoke green with all six module types wired.

## 3. Security Audit + Closed-Beta Guardrails (⬜ — audit runs in PARALLEL with the beta; gates the PUBLIC launch)

> **Closed-beta risk posture.** Deploying pre-audit means real BNB on unaudited code where **liquidity is permanently locked** (no recovery path if a vault/hook bug strands or misprices it) and the hook runs on 100% of swaps. Bound the blast radius:
> - **Cap exposure** — small seed liquidity, invite-only / known participants, modest trade sizes. Assume any BNB in a beta pool could be lost.
> - **Team-funded beta liquidity** — so the locked-liquidity risk is yours, not third parties'.
> - **Run the cheap safety nets FIRST** — the BSC-fork rehearsal (§2) against the real PoolManager + a Slither pass. They catch integration/logic bugs for ~free before any real BNB is at stake.
> - **Mind the admin key** — admin is a hot deployer EOA (multisig deferred, §7); a compromised key can repoint `Database` infra (hook/router/feeReceiver). For a real-money beta, consider a multisig sooner, or tightly isolate the deployer key.
> - **Tell beta users it's unaudited.**

- [ ] Engage an auditor. **Scope centerpiece: `v4/LumoriaHook.sol`** — it runs on every swap and handles up to 98% of swap flow. Include `LumoriaLiquidityVault`, **`VestingVault`** (new — custodies vested allocations, non-revocable), `LumoriaSwapRouter`, `TaxHandler` (incl. the new `renounceManagement` freeze + vesting-vault share exclusion), `Generator` (incl. the new `allocations` carve path), `RebateContract` (incl. the new renounce-freeze that reads the token's `TaxHandler.managementRenounced`), and the CREATE2 deploy/trust chain (`Create2Deployer` + `hook-miner.js`).
- [ ] Brief the auditor with the prior-art hook exploits noted in `DESIGN.md §14` (Cork Protocol, May 2025; Bunni, Sep 2025 — both hook-logic bugs).
- [ ] Pre-audit hardening (do before handing over, parallel with everything):
  - [ ] Run **Slither** / static analysis; triage findings.
  - [ ] Consider **Foundry invariant/fuzz tests** for: fee math (platform + tax to the wei), the "liquidity can never leave" invariant, exactOutput rejection, and unattributed (no-hookData) swaps still being fully taxed. Current suite is Hardhat unit/integration only.
  - [ ] Confirm `hook-miner.js` `LUMORIA_HOOK_FLAGS` still equals `LumoriaHook.getHookPermissions()`.
- [ ] Remediate findings; re-test (`npm test` green); re-audit deltas if needed.

## 4. Subgraph (spec + review done → scaffold → deploy)

- [x] **Spec doc** — `docs/SUBGRAPH.md`: every contract, every event, relationships, entities, handler guidance, gotchas. Now includes the `VestingVault` data source, `Generator` allocation events, `TaxHandler.ManagementRenounced`, and the A1–A4 aggregate entities.
- [x] **Frontend-agent review folded in** — first pass found no gaps; the follow-up **drift audit** (`docs/CONTRACTS_SUBGRAPH_DRIFT_REPORT.md`) surfaced three real contract gaps (vesting, allocations, renounce), now **built**, plus a set of already-shipped-but-mis-documented capabilities and cheap subgraph aggregates. All resolved in `docs/CONTRACTS_DRIFT_RESOLUTION.md`; subgraph priorities in `SUBGRAPH.md §11`.
- [x] **Deploy-block recording** — `deploy-base.js` now writes `startBlock` for the manifest.
- [x] **Scaffold the subgraph** — full implementation in `subgraph/` (7 singleton data sources + 7 dynamic templates + schema + 14 mappings), built from `SUBGRAPH.md`. **`graph codegen` + `graph build` both pass** (every event signature matches the compiled ABIs; all mappings compile to wasm).
- [ ] Index a fork/testnet deployment; validate the queries the UI needs (token list, trades/OHLC, holders, rewards, raises, rebates, volume).
- [x] ✅ **Deployed to Goldsky (repaired 2026-08-31)** — **`lumoria-bsc/1.0.2`** declares the PrizePool ABI on the TaxHandler template and cleanly replays from the first production launch block (`116894643`). API: `https://api.goldsky.com/api/public/project_cmg2x3lrvy37d01vq4bsnbtig/subgraphs/lumoria-bsc/1.0.2/gn`. (Studio path kept as `deploy:studio` if ever needed.)

## 5. Frontend Integration (⬜ — can run parallel with audit)

- [ ] Quoting via canonical **V4Quoter** (`quoteExactInputSingle` with the deterministic PoolKey) — see `FRONTEND.md §2.9`.
- [ ] Trade flow through **`LumoriaSwapRouter`** (passes `hookData` for rebate + per-user volume attribution).
- [ ] Pool state via **StateView** (`getSlot0`/`getLiquidity`); fee breakdown computed client-side.
- [ ] Launch wizard (`Generator.generateProject` + `predictTokenAddress`), creator dashboard (TaxHandler timelocks), holder rewards, FlatCurve raise pages — per `FRONTEND.md §3`.
- [ ] (Optional) Universal Router support — taxed identically, just no rebate/attribution.

## 6. Mainnet Deploy (⬜ — for the closed beta; audit runs in parallel)

- [x] ✅ `.env` set: `DEPLOYER_PK`, `ETHERSCAN_API_KEY`, `BSC_RPC` (Alchemy, archive-capable — used for fork rehearsals). `FEE_RECIPIENT` left as deployer (deliberate — swap later via `FeeReceiver.setRecipient`). No `LUMORIA_OPERATORS` — shipped permissionless.
- [x] ✅ **DEPLOYED to BSC mainnet (2026-07-21)** — `deployments/bsc.json`, startBlock `111199483`, deployer/owner `0x7F06…3A74`, ~0.03 BNB total cost. All addresses + config in [`deployments/DEPLOYMENTS.md`](./deployments/DEPLOYMENTS.md) (v1) with a frozen snapshot in `deployments/archive/`. ⚠️ Deploy via a **standard RPC** (`BSC_RPC=https://bsc-dataseed.binance.org npm run deploy:bsc`) — Alchemy's BNB endpoint returns `to:""` on pending creates, which crashes ethers v6 (one orphaned Database at nonce 0, see DEPLOYMENTS.md notes).
- [x] ✅ **All 19 contracts verified on BscScan** via Etherscan V2 (`npm run verify:bsc`), zero failures.
- [x] ✅ **v1.1 delta (2026-07-21)** — PrizePool master copy replaced (`0xc53D…ACbb`, verified): `rootPoster == 0` now delegates root posting to the platform operator registry instead of reverting (rotatable, unlike a frozen per-token EOA; no permissionless fallback — unsettled epochs roll over). First platform operator registered: `0x7868…f484` (module execution is now operator-first with the 1h public fallback). 300 tests green. `deployments/DEPLOYMENTS.md` v1.1.
- [ ] `npm run smoke:bsc`-equivalent / a guarded first real launch — confirm launch + buy + volume on mainnet. **Deliberate step: permanently locks the seed BNB (~0.105).**
- [x] ✅ Committed `deployments/bsc.json` + archive + registry.

## 7. Post-Deploy (⏸️ / ⬜)

- [ ] ⏸️ **Ownership handoff** — *deliberately deferred.* Deploy leaves the deployer EOA as owner of `Database` / `FeeReceiver` / `RebateContract`. Transfer to a multisig (or timelock) **once everything is set up and working**. Track here so it's not forgotten.
- [ ] Set up monitoring/alerting on hook + vault events (large taxes, failed trades from contract recipients, rebate drain).
- [ ] Submit the LumoriaHook to the **Uniswap routing-API hook allowlist** so pools are routable from app.uniswap.org (post-audit; go-to-market, not contract work).
- [ ] Publish addresses + docs for integrators.

## 8. Permanent Single-Sided V2 rollout / rollback (🟢 cutover live at block 119472210, 2026-09-02)

Status: steps 1–10 done (fork rehearsal green, four candidates deployed,
verified, and rotated — see `deployments/DEPLOYMENTS.md` v1.2; frontend
`npm run abis` re-run). Remaining: subgraph `lumoria-bsc/1.1.0` on Goldsky +
frontend `NEXT_PUBLIC_SUBGRAPH_URL`, then the canary (step 11, from the UI)
and the feature flag (step 12).

1. Approve the §18 rounding direction/copy, canary parameters, and
   Database-owner disclosure. Confirm (or retune with
   `Generator.setSingleSidedStartTickBounds`) the default start-tick window
   `148_200..196_260` ≈ 366 BNB down to ≈ 3 BNB starting FDV.
2. Complete and verify the separate metadata-aware LumoriaToken master-copy
   migration. Generator V2 preserves that current ABI and candidate deployment
   refuses to proceed while `Database.tokenMasterCopy` is incompatible.
3. Run all local contract, subgraph, and frontend checks.
4. Run the production-state BSC fork rehearsal against the PoolManager and
   addresses in `deployments/bsc.json`.
5. Deploy candidates with `deploy-single-sided-v2.js`; this writes a candidate
   manifest and does not rotate Database pointers.
6. Verify both candidates and review constructor wiring: Vault V2 must reference
   the live Database, canonical PoolManager, and current vault as `legacyVault`;
   Generator V2 must reference the live Database.
7. Add old and new Generator/vault sources to a new subgraph version, verify a
   clean historical replay, and keep the frontend flag off.
8. Generate and independently review setter calldata with
   `prepare-single-sided-v2-cutover.js`.
9. Call `Database.setLiquidityVault(VaultV2)`, then immediately compare old-token
   liquidity views and smoke a legacy liquidity operation.
10. Call `Database.setGenerator(GeneratorV2)`, then smoke BYOL and Flat Curve.
11. Launch one approved mode-2 canary; buy and sell through both Lumoria and raw
    V4-compatible routing; confirm hook fees, entities, prices, and analytics.
12. Enable the frontend feature flag only after subgraph health and monitoring
    checks pass.

Before the first mode-2 launch, restore both old pointers to roll back. After a
mode-2 launch, disable new launches and restore the old Generator if needed, but
normally retain Vault V2 because it owns the new permanent position and
aggregates historical analytics. Existing pools keep trading independently of
the Generator pointer. Never attempt liquidity removal or migration.

---

*Keep this file in lock-step with `docs/ROADMAP.md`. When an item here lands, tick it and update the relevant doc.*
