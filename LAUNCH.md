# Lumoria — Pre-Mainnet Launch Checklist

**This is the working todo list to mainnet.** Step through it top-to-bottom; flip each box as it lands. Keep it honest — an item is only ✅ when it's actually verified, not "should work."

**Legend:** ✅ done · 🔄 in progress · ⬜ todo · ⏸️ deferred (intentionally, for now) · 🚧 blocked

**Strategy: closed-beta-first.** Ship to mainnet **ASAP** and run a **closed beta in parallel with the security audit**. The audit is no longer a hard gate for the *beta* — but it **remains required before an open/public launch**. The beta uses real mainnet contracts with real BNB and **permanently-locked liquidity**, so treat it as a controlled-exposure launch — see the beta guardrails in §3.

```
Critical path (closed-beta-first):
  [✅ contracts + docs + tests]
        │
        ├─ ✅ frozen-layer doors closed (§1b)
        ├─ ⬜ fork rehearsal (needs archive RPC)
        ├─ ⬜ Slither / quick static pass
        │        │
        │        ▼
        ├─ ⬜ MAINNET DEPLOY → ⬜ verify → ⬜ guarded smoke ──→ ⬜ CLOSED BETA (capped exposure)
        │                                                            running IN PARALLEL with
  ┌─ ✅ subgraph spec → ⬜ scaffold → ⬜ deploy ─┐                  ⬜ SECURITY AUDIT → ⬜ remediation
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
- [ ] 🚧 **Actually run it.** Blocked on an **archive-capable `BSC_RPC`** — public dataseeds (`bsc-dataseed.*`, `publicnode`) only serve `latest`-tag state and fail forking with `missing trie node` / `historical state not available`. Use your own BSC node or a paid archive provider (QuickNode / Alchemy / Chainstack / Ankr BSC-archive). Then:
  ```bash
  # .env: BSC_RPC=<archive endpoint>   (optionally BSC_FORK_BLOCK=<recent block> to pin)
  BSC_FORK=1 npx hardhat node            # terminal 1 — persistent forked node
  npm run deploy:local                   # terminal 2 — deploy onto the fork (uses canonical PM)
  npm run smoke:local                    # launch a BYOL token + buy through the router on the fork
  ```
  Expect: deploy completes, `deployments/localhost.json` has `v4.poolManager = 0x28e2…e9df`, smoke launches + buys + registers volume against the real PoolManager.

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
- [ ] Deploy the subgraph: after mainnet deploy, `cd subgraph && npm i && npm run gen-networks && npm run build && npm run deploy:studio` (reads `deployments/bsc.json` addresses + `startBlock`).

## 5. Frontend Integration (⬜ — can run parallel with audit)

- [ ] Quoting via canonical **V4Quoter** (`quoteExactInputSingle` with the deterministic PoolKey) — see `FRONTEND.md §2.9`.
- [ ] Trade flow through **`LumoriaSwapRouter`** (passes `hookData` for rebate + per-user volume attribution).
- [ ] Pool state via **StateView** (`getSlot0`/`getLiquidity`); fee breakdown computed client-side.
- [ ] Launch wizard (`Generator.generateProject` + `predictTokenAddress`), creator dashboard (TaxHandler timelocks), holder rewards, FlatCurve raise pages — per `FRONTEND.md §3`.
- [ ] (Optional) Universal Router support — taxed identically, just no rebate/attribution.

## 6. Mainnet Deploy (⬜ — for the closed beta; audit runs in parallel)

- [ ] `.env`: `DEPLOYER_PK` (funded with enough BNB for ~14 deploys + hook mining), **`FEE_RECIPIENT` explicitly set**, `BSCSCAN_API_KEY`. Optionally `LUMORIA_OPERATORS` (comma-separated backend addresses) — unset ships module execution permissionless; see TOKENOMICS_V2 §6.2.
- [ ] `npm run deploy:bsc` → writes `deployments/bsc.json` (uses canonical PoolManager + periphery).
- [ ] `npm run verify:bsc` — verify all contracts on BscScan (note: PoolManager verify is best-effort; it's canonical/pre-verified on mainnet, the script try/catches it).
- [ ] `npm run smoke:bsc`-equivalent / a guarded first real launch — confirm launch + buy + volume on mainnet.
- [ ] Commit `deployments/bsc.json` (it is NOT gitignored — testnet/mainnet artifacts are meant to be committed).

## 7. Post-Deploy (⏸️ / ⬜)

- [ ] ⏸️ **Ownership handoff** — *deliberately deferred.* Deploy leaves the deployer EOA as owner of `Database` / `FeeReceiver` / `RebateContract`. Transfer to a multisig (or timelock) **once everything is set up and working**. Track here so it's not forgotten.
- [ ] Set up monitoring/alerting on hook + vault events (large taxes, failed trades from contract recipients, rebate drain).
- [ ] Submit the LumoriaHook to the **Uniswap routing-API hook allowlist** so pools are routable from app.uniswap.org (post-audit; go-to-market, not contract work).
- [ ] Publish addresses + docs for integrators.

---

*Keep this file in lock-step with `docs/ROADMAP.md`. When an item here lands, tick it and update the relevant doc.*
