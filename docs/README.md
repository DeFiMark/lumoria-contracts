# Lumoria Documentation

This folder contains everything needed to understand and continue building the Lumoria system.

## Read These First (in order)

1. **[DESIGN.md](./DESIGN.md)** — The comprehensive system specification. What we're building, every contract, every event, all architectural decisions, security considerations. **Source of truth for the "what".**

2. **[ROADMAP.md](./ROADMAP.md)** — The phased build plan. What's done, what's in progress, what's next. Includes detailed step-by-step implementation guide for the current phase. **Source of truth for "where we are".**

3. **[FRONTEND.md](./FRONTEND.md)** — UI + subgraph integration notes. Events, reads, writes, entity sketch, user flows. **Source of truth for how clients use the contracts.**

4. **[TESTING.md](./TESTING.md)** — Hardhat test setup, fixture pattern, coverage table, Blocked list. **Source of truth for what's verified.**

5. **[SUBGRAPH.md](./SUBGRAPH.md)** — complete contract/event/entity spec for scaffolding the subgraph (every event, dynamic-template model, gotchas, schema). **Source of truth for what to index.**

6. **[FRONTEND_HANDOFF.md](./FRONTEND_HANDOFF.md)** — **self-contained** single-file brief for the frontend agent (which lives in a separate repo): the full available-data inventory + the complete subgraph schema + event list inlined, plus a mock-data → real-data **drift-audit** mandate and report format. **Hand this one file — and nothing else — to the frontend team.**

See also **[`../LAUNCH.md`](../LAUNCH.md)** at the repo root — the pre-mainnet launch checklist / working todo list.

## Current Status

See the "Progress" section in [ROADMAP.md](./ROADMAP.md). At a glance:

- ✅ **Phase 1** — Core Infrastructure: interfaces, Database, LumoriaToken, FeeReceiver
- ✅ **Phase 2** — Tax System: TaxHandler + 4 modules (Creator, Reward, Burn, Liquidity)
- ✅ **Phase 3** — DEX Refactor: Factory, Pair, Router, RebateContract *(DEX superseded by Phase 5)*
- ✅ **Phase 4** — Launch System: Generator, FlatCurve
- ✅ **Phase 5** — Uniswap V4 Migration: LumoriaHook + LiquidityVault + SwapRouter on the canonical V4 PoolManager (all five phases complete; pre-mainnet audit pending)

## Repo Layout

```
lumoria-contracts/
├── docs/                    ← you are here
│   ├── README.md            ← this file
│   ├── DESIGN.md            ← full system spec
│   ├── ROADMAP.md           ← phased build plan + current status
│   ├── FRONTEND.md          ← UI + subgraph integration notes
│   ├── TESTING.md           ← Hardhat setup + coverage + Blocked list
│   ├── SUBGRAPH.md          ← contract/event/entity spec for the subgraph
│   └── FRONTEND_HANDOFF.md  ← frontend-agent brief: data inventory + drift audit
├── contracts/
│   ├── Database.sol         ← central registry (Phase 1 ✅, V4 refs in Phase 5)
│   ├── LumoriaToken.sol     ← ERC20 master copy (Phase 1 ✅)
│   ├── FeeReceiver.sol      ← platform fee collector (Phase 1 ✅)
│   ├── TaxHandler.sol       ← orchestrator (Phase 2 ✅)
│   ├── Generator.sol        ← single-tx launches (Phase 4 ✅)
│   ├── FlatCurve.sol        ← presale with refunds (Phase 4 ✅)
│   ├── RebateContract.sol   ← buy rebates (Phase 3 ✅)
│   ├── v4/                  ← Uniswap V4 layer (Phase 5 ✅)
│   │   ├── LumoriaHook.sol            ← pool-level fee stack, one hook for all pools
│   │   ├── LumoriaLiquidityVault.sol  ← sole LP owner, permanently locked
│   │   └── LumoriaSwapRouter.sol      ← thin V4 router (legacy ILumoriaRouter interface)
│   ├── modules/
│   │   ├── CreatorFeeModule.sol   ← Type 3 (Phase 2 ✅)
│   │   ├── RewardModule.sol       ← Type 0 (Phase 2 ✅)
│   │   ├── BurnModule.sol         ← Type 1 (Phase 2 ✅)
│   │   └── LiquidityModule.sol    ← Type 2 (Phase 2 ✅)
│   ├── interfaces/          ← all interfaces
│   ├── lib/                 ← reusable libraries
│   └── test-mocks/          ← MockWBNB, V4TestImports, Create2Deployer, RawV4Caller (test-only)
├── test/
│   ├── fixtures/deploy.js   ← shared deploy + launch helpers (incl. local PoolManager + hook mining)
│   ├── V4Hook.test.js       ← hook fee math, bypass-proofing, lock invariants
│   ├── Database.test.js / FeeReceiver / LumoriaToken / TaxHandler / Rebate / Generator / FlatCurve
│   └── modules/             ← one file per module
├── scripts/                 ← deployment tooling (see docs/TESTING.md § Deployment)
│   ├── deploy-base.js       ← full system deploy + Database wiring (canonical V4 on bsc)
│   ├── smoke-launch.js      ← post-deploy happy-path check
│   ├── verify.js            ← BscScan verification pass
│   └── lib/hook-miner.js    ← CREATE2 salt mining for the hook address
├── deployments/             ← <network>.json artifacts (hardhat/localhost gitignored)
├── legacy/                  ← reference-only (ExampleToken/Generator + retired V2 DEX) — not compiled
├── LAUNCH.md                ← pre-mainnet launch checklist (the working todo list)
├── hardhat.config.js
└── package.json
```

## Conventions

- Solidity version: `0.8.28` (pinned; plus a `0.8.26` compiler entry solely for Uniswap's PoolManager in local tests)
- Cloned contracts use `__init__(...)` pattern (ERC-1167 minimal proxies)
- All events designed for subgraph indexing (see DESIGN.md section 13)
- Chain target: BNB Chain (BSC) — tokens trade against **native BNB** in Uniswap V4 pools (canonical PoolManager `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`)

## For Fresh Contributors / AI Agents

1. Read [DESIGN.md](./DESIGN.md) end-to-end first.
2. Read [ROADMAP.md](./ROADMAP.md) to understand current state.
3. Skim [FRONTEND.md](./FRONTEND.md) and [TESTING.md](./TESTING.md) to see what the UI/subgraph team expects and what's under test.
4. Pick up work from the first unchecked item in the current phase.
5. **Update all four docs in lock-step** as you progress. A phase isn't done until DESIGN + ROADMAP + FRONTEND + TESTING all reflect reality. See [CLAUDE.md](../CLAUDE.md) for the discipline.
