# Lumoria — Claude Code Handoff

**Start here:** read [`docs/README.md`](./docs/README.md) — it's the index to everything.

## TL;DR

Lumoria is a curated token launchpad on BNB Chain with modular tokenomics, trading on **Uniswap V4 pools** governed by a custom **LumoriaHook** (the custom V2 DEX was retired in Phase 5 — see `legacy/`). Token creators launch tax-on-transfer tokens; taxes are collected as native BNB **at the pool level by the hook on every swap, regardless of router** (not as tokens) and distributed to pluggable modules (rewards, burn, auto-liquidity, creator fees). All pool liquidity is permanently locked in the LumoriaLiquidityVault (no removal code path exists).

## Required Reading (in order)

1. **[docs/DESIGN.md](./docs/DESIGN.md)** — the comprehensive system specification (what we're building, every contract, every event, all decisions). Source of truth for the "what".
2. **[docs/ROADMAP.md](./docs/ROADMAP.md)** — the phased build plan + current progress. Source of truth for "where we are" and "what to build next".
3. **[docs/FRONTEND.md](./docs/FRONTEND.md)** — the UI/subgraph integration notes. Events, direct reads, subgraph entities, canonical user flows. Source of truth for how clients use the contracts.
4. **[docs/TESTING.md](./docs/TESTING.md)** — Hardhat test setup + conventions + coverage status. Source of truth for what's verified.

## How to Continue the Work

1. Read the four docs above.
2. Find the first unchecked item (⬜) under the current phase in ROADMAP.md.
3. Follow the detailed implementation spec for that item.
4. After completing each item, update **all four docs in lock-step**:
   - **DESIGN.md** — reflect any spec changes and flip the contract-inventory status.
   - **ROADMAP.md** — tick the checkbox; advance the phase banner if the phase is done.
   - **FRONTEND.md** — add/update the contract's section (events, reads, writes, subgraph notes).
   - **TESTING.md** — update the coverage table; move rows off the "Blocked" list if they're now testable.
5. Land working tests for any new contract behavior. No "I'll test later" — `npm test` must pass before a phase is marked done.

This lock-step discipline is what lets a future session (or a fresh contributor) pick up mid-flight without archaeology.

## Project Conventions

- Solidity `0.8.28` (pinned; a second `0.8.26` compiler entry exists solely for Uniswap's `PoolManager.sol` in local tests)
- `evmVersion: cancun` — V4 core needs transient storage; BSC has had Cancun opcodes since the Haber hardfork (June 2024)
- Cloned contracts use `__init__(...)` pattern (ERC-1167 minimal proxies, no constructors for state)
- Every contract emits rich events for subgraph indexing
- Chain target: BNB Chain (BSC) — tokens paired against **native BNB** in V4 pools (`currency0 = address(0)`); `Database.wbnb` survives only as the legacy path-marker modules use
- The hook's permissions are encoded in the low 14 bits of its address — it MUST be deployed via CREATE2 with a mined salt (`scripts/lib/hook-miner.js`). If you change `getHookPermissions()`, update `LUMORIA_HOOK_FLAGS` in the miner to match.
- Hardhat test suite under `test/` — `npm test` after every contract change; keep coverage in `docs/TESTING.md` accurate
- Test mocks live under `contracts/test-mocks/`; legacy reference code lives under `legacy/` (outside the Hardhat sources dir)

## Don't

- Don't edit the files under `legacy/` (`ExampleToken.sol`, `ExampleGenerator.sol`, retired `Factory/Pair/Router` + their interfaces) — reference only
- Don't add tax logic to `LumoriaToken.sol` — it's intentionally a clean ERC20; all tax logic lives in LumoriaHook + TaxHandler
- Don't add a liquidity-removal path anywhere (vault, hook, router) — "liquidity can never leave" is a load-bearing trust guarantee
- Don't support exactOutput swaps in the hook without a full fee-math review — the fee-on-specified-output case was deliberately excluded
- Don't change Phase-1 interfaces without first updating DESIGN.md + FRONTEND.md to match
- Don't skip the test suite. If a change is genuinely untestable without Phase N work, log it in the "Blocked" table in TESTING.md with a `TODO:` test stub
