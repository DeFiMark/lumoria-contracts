# Lumoria Testing Guide

Living document. **Every code change should land with either a new test, an updated test, or an explicit note in the "Blocked" table below.** Keep this doc in sync with `ROADMAP.md` — a phase is not done until its tests are green.

---

## Quick Start

```bash
npm install              # one-time: installs Hardhat + toolbox + deps
npm run compile          # compile all contracts
npm test                 # run the full test suite
npm run test:only -- "TaxHandler"   # run just the TaxHandler file
npm run coverage         # solidity-coverage (slower)
```

Hardhat pins Solidity to `0.8.28` (project) with optimizer at 200 runs, `viaIR: true`, and `evmVersion: cancun` — Uniswap V4 core uses transient storage (EIP-1153), which BSC has supported since the Haber hardfork (June 2024). A second compiler entry (`0.8.26`, legacy pipeline) exists solely for `@uniswap/v4-core`'s `PoolManager.sol`, which pins that version exactly and is only compiled for local-test deployment (BSC mainnet uses the canonical PoolManager). The `hardhat` network allows unlimited contract size for the same reason. Tests run on the in-memory `hardhat` network with fresh state per test.

---

## Directory Structure

```
lumoria-contracts/
├── hardhat.config.js              ← Solidity 0.8.28 + 0.8.26 (v4-core), cancun, networks
├── scripts/lib/hook-miner.js      ← CREATE2 salt mining for the hook's flag-encoded address
├── test/
│   ├── fixtures/
│   │   └── deploy.js              ← shared deploy + launch helpers (IMPORT EVERYTHING FROM HERE)
│   ├── Database.test.js
│   ├── FeeReceiver.test.js
│   ├── LumoriaToken.test.js
│   ├── TaxHandler.test.js         ← orchestrator + timelock + batch module proposals
│   ├── V4Hook.test.js             ← hook fee math, bypass-proofing, exactOut rejection,
│   │                                 liquidity-lock invariants, rebate/volume attribution
│   ├── RebateContract.test.js     ← fund / topUp / credit / withdraw flows
│   ├── Generator.test.js          ← BYOL launch, FlatCurve wiring, predictTokenAddress, creator allocations
│   ├── FlatCurve.test.js          ← contribute / refund / launch (success + fail) / claim
│   ├── VestingVault.test.js       ← linear+cliff schedules, release timing, generator-gated creation
│   └── modules/
│       ├── CreatorFeeModule.test.js
│       ├── RewardModule.test.js   ← BNB and token modes (uses Lumoria router as external)
│       ├── BurnModule.test.js     ← config/guards + end-to-end executeBurn (real V4 swap)
│       ├── LiquidityModule.test.js← config/guards + end-to-end executeLiquidity (vault lock)
│       ├── MilestoneRewardModule.test.js ← destination lock, 18-month valve, real-swap invariant
│       └── PrizePool.test.js      ← epoch math, root-before-randomness ordering, merkle claims,
│   │                                 lottery range check, rollover matrix, challenge window
│   ├── operator/
│   │   └── Settlement.test.js     ← closed loop: real buys → tickets.js derivation → root → claim
└── contracts/
    └── test-mocks/
        ├── MockWBNB.sol           ← minimal WETH9 stand-in (legacy path marker only)
        ├── V4TestImports.sol      ← forces Hardhat to compile PoolManager for local deploys
        ├── Create2Deployer.sol    ← CREATE2 deployer for the mined hook address
        └── RawV4Caller.sol        ← simulates third-party routers / attackers hitting
                                      the PoolManager directly (bypass-proofing tests)
```

> The legacy `Factory.test.js` / `Pair.test.js` / `Router.test.js` were retired with the custom DEX (Phase 5). Their behavioral coverage (fee flow, slippage, rebate callout, volume) lives on in `V4Hook.test.js`.

New test files should follow the convention `test/<ContractName>.test.js` (top-level contracts) or `test/modules/<ModuleName>.test.js` (tokenomics modules). Mock contracts live in `contracts/test-mocks/` so Hardhat compiles them automatically.

---

## The Fixture Pattern

All state setup lives in **one place**: `test/fixtures/deploy.js`. Two reasons:

1. **Speed** — `loadFixture()` snapshots EVM state after the first run and restores it for every subsequent `it()` block. Without this, deploying the base system for every test would dominate runtime.
2. **Drift protection** — if the base stack changes (e.g. a new module master copy added in Phase 3), one edit in `deploy.js` updates every test.

### `deployBase()`
Deploys: `MockWBNB` (path-marker only), `Database`, `FeeReceiver`, all master copies (`LumoriaToken`, `TaxHandler`, all 4 modules), a **local Uniswap V4 `PoolManager`**, the **`LumoriaHook`** (via `Create2Deployer` + JS salt mining so the address carries the hook-permission bits), the **`LumoriaLiquidityVault`**, the shared **`VestingVault`**, the **`LumoriaSwapRouter`**, `RebateContract` (hook authorized as creditor), `FlatCurve` master copy, and the `Generator`. Wires everything into the Database (incl. `setVestingVault`) and sets the `owner` signer as the Generator stand-in so tests can call `registerToken` (and, since `owner` is the Generator stand-in, `VestingVault.createSchedule`). Returns `{ signers, wbnb, database, feeReceiver, poolManager, hook, vault, vestingVault, router, rebate, generator, create2Deployer, masterCopies }`.

### Launching a token

Because modules encode their `taxHandler` address in their init payload, launching a token is a **three-step dance** (helpers exported from `deploy.js`):

```js
const { deployBase, loadFixture, prepareTokenShells, initializeToken,
        buildCreatorFeeInitData, MODULE_TYPE } = require("./fixtures/deploy");

const base = await loadFixture(deployBase);

// 1. Deploy uninitialized Token + TaxHandler clones.
const shells = await prepareTokenShells(base);

// 2. Build module init payloads using the real taxHandler address.
const modules = [{
    moduleType: MODULE_TYPE.CREATOR,
    buyAllocation: 10000,
    sellAllocation: 10000,
    initPayload: buildCreatorFeeInitData(shells.taxHandlerAddr, base.signers.creator.address),
}];

// 3. Initialize both contracts + register in Database.
await initializeToken(base, shells, {
    name: "Test", symbol: "TST", pair: base.signers.user3.address,
    creator: base.signers.creator,
    buyFee: 500, sellFee: 500, modules,
});
```

In Phase 4 the `Generator` contract does this in one atomic call; the JS helpers mirror what it will do, so tests exercise the same logical flow.

### Payload builders (use these — don't hand-encode)
Modules infer `taxHandler` from `msg.sender` at `__init__` — payloads don't carry it.
- `buildCreatorFeeInitData(recipientAddr)`
- `buildRewardInitData({ token, rewardToken?, externalRouter?, externalWBNB?, minDistribution? })`
- `buildBurnInitData({ token, database, burnInterval })`
- `buildLiquidityInitData({ token, database, liquidityInterval })`
- `farDeadline()` — far-future deadline for `executeBurn` / `executeLiquidity` / `convertAndDistribute`, which take `(minOut…, deadline)`. `processRewards()` takes none — it never swaps.

Operators are **platform-wide**, not part of any init payload: `database.setOperator(addr, true)` (owner only). `deployBase()` registers none, so module execution is permissionless in tests unless a test opts in.

### V4 helpers
- `poolKeyFor(base, tokenAddr)` / `poolIdFor(base, tokenAddr)` — the canonical pool identity (deterministic; no registry).
- `launchTokenWithPool(base, cfg)` (alias `launchTokenWithPair`) — full launch incl. optional `initialLiquidity: { tokens, bnb }`, seeded through `router.addLiquidityETH` (pool lazily initialized, liquidity vault-locked). Returns `{ ..., poolId, pairAddr }` where `pairAddr` is the PoolManager address.
- `scripts/lib/hook-miner.js` — `mineHookSalt` / `deployHookViaCreate2`, shared by fixtures and deploy scripts.

### Enum helpers
- `MODULE_TYPE.REWARD` (0), `MODULE_TYPE.BURN` (1), `MODULE_TYPE.LIQUIDITY` (2), `MODULE_TYPE.CREATOR` (3)
- `CHANGE_TYPE.ADD` (0), `CHANGE_TYPE.REMOVE` (1), `CHANGE_TYPE.UPDATE` (2)

### Signer aliases
`base.signers` gives you: `owner`, `feeRecipient`, `creator`, `user1`, `user2`, `user3`, `keeper`, `rest`.

---

## Test Conventions

- **`describe` per external function / logical area**, `it` per behavior. One assertion concern per `it` where practical.
- **Use `loadFixture(deployBase)`** as the first line of every test that needs the system. Never re-deploy by hand — snapshots are much faster.
- **Time manipulation**: `const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers"); await time.increase(86400);` for timelock tests. Constant `ONE_DAY = 24 * 60 * 60` lives in `TaxHandler.test.js` — copy/import as needed.
- **Pending tests** for blocked flows: use `it("TODO: ...")` with no body (Mocha marks them pending). Don't `.skip()` — `TODO:` makes the reason greppable.
- **Revert matchers**: prefer `.to.be.revertedWith("message")` when the message is stable. Use `.to.be.reverted` only when the revert comes from a nested call and the message may change.
- **Event matchers**: `.to.emit(contract, "EventName").withArgs(...)`. Always assert the expected args when they're deterministic.
- **Balance deltas**: for ETH-transfer tests, subtract `gasUsed * gasPrice` when the sender is a signer (see `RewardModule.test.js` → `claimReward`).

---

## Coverage Status

| Contract | Unit | Integration | Notes |
|---|---|---|---|
| `Database.sol` | ✅ | ✅ | admin (incl. poolManager/hook/vault setters), registry, hook-gated volume (zero-user skip), master copies |
| `FeeReceiver.sol` | ✅ | — | receive / receiveFee / receiveTradeFee / receiveLaunchFee / withdraw / setRecipient |
| `LumoriaToken.sol` | ✅ | ✅ | init, transfer, approve/transferFrom, burn, setShare forwarding, **pair-exclusion** (pair = PoolManager) |
| `TaxHandler.sol` | ✅ | ✅ | init, fee timelock (**incl. §7.6 pending-disarm regression + §7.7 per-change increase cap**), batch module proposals, distribution math, setShare, **renounceManagement freeze (B6)**, **share-exclusion set (V2 §7.3)**, **dust sweep skips 0-bps modules (V2 §7.5)** |
| `CreatorFeeModule.sol` | ✅ | ✅ | init (taxHandler from msg.sender), **accrue-and-pull `receiveTax`/`withdraw` (V2 §7.2)**, recipient rotation keeps old accrual claimable, **regression: contract recipient with no `receive()` cannot brick trading** |
| `RewardModule.sol` | ✅ | ✅ | BNB mode + token mode (external router = LumoriaSwapRouter over V4), **`donate()` (V2 §4.1)**, **`sync()` backfill (V2 §4.2)**, **regression: token-mode `receiveTax` never calls the external router (V2 §7.1)** |
| `BurnModule.sol` | ✅ | ✅ | config + guards + end-to-end `executeBurn` via a real V4 swap, **slippage floor + deadline + operator window & liveness fallback (V2 §6.2)**, **buyback tax re-enters `receiveTax` and terminates** |
| `LiquidityModule.sol` | ✅ | ✅ | config + guards + end-to-end `executeLiquidity` (vault-locked liquidity), **slippage floors + deadline (V2 §6.2)** |
| `MilestoneRewardModule.sol` | ✅ | ✅ | init guards, taxHandler-only accrual, creator-only release + `No reward module` + renounce-immunity, **destination lock pinned as an ABI allowlist**, full-supply-holder claim + system-contract exclusion, **18-month public valve (open/reset/full-balance/empty-revert)**, real V4 buy+sell drives `receiveTax` (swap-path invariant) |
| `PrizePool.sol` | ✅ | ✅ | init bounds, epoch math (multi-epoch jumps, queued length applies only at the next boundary), **`drawRandomness` before `postRoot` reverts** + challenge-window ordering, merkle claims (forged leaf, cross-epoch replay, someone-else's-proof all fail), **lottery range check (adjacent rejected, duplicate slot rejected, same account × two slots accepted)**, hold requirement (dump→revert, hold→pay), **full §2.8 rollover matrix — no BNB stranded**, `invalidateRoot` window, ALL_HOLDERS delegation to `donate()`, bounties, real V4 buy/sell cycle cannot revert |
| operator loop (`tickets.js` + `merkle.js`) | ✅ | ✅ | real router buys → log-derived tickets (unattributed + module-flow buys excluded) → root → on-chain claims at exact pro-rata amounts |
| `v4/LumoriaHook.sol` | ✅ | ✅ | **post-swap `sqrtPriceX96`/`tick` on both trade events, with the exact `2^192/sqrt^2` price formula pinned numerically**, buy/sell fee math to the wei, 98% + 0% taxes, multi-pool isolation, exactOut rejection, **bypass-proofing via raw PoolManager swaps**, pool-creation/liquidity/donate gates, rebate + volume attribution |
| `v4/LumoriaLiquidityVault.sol` | ✅ | ✅ | router-only entry, lazy pool init at implied price, locked-liquidity growth, dust refunds (implicit in module flows) |
| `v4/LumoriaSwapRouter.sol` | ✅ | ✅ | buy/sell exactIn, amountOutMin + deadline guards, addLiquidityETH delegation, non-Lumoria rejection |
| `RebateContract.sol` | ✅ | ✅ | fund / topUp / credit / withdraw, silent-exit, re-activation (creditor = hook), **renounce freeze (Q1): rate/withdraw/re-fund blocked, top-up + credit stay open** |
| `Generator.sol` | ✅ | ✅ | BYOL flow (V4 pool init + vault lock), FlatCurve wiring, predictTokenAddress, post-launch tradability, **creator allocations (B2): immediate + vested, over-allocation revert, FlatCurve path** |
| `FlatCurve.sol` | ✅ | ✅ | contribute / refund / launch (success + fail, V4 pool seed) / claim / withdrawOnFailure |
| `VestingVault.sol` | ✅ | ✅ | generator-gated `createSchedule` + validations, linear+cliff vesting math, `release` (full/partial/double), permissionless poke, beneficiary index |

| `Database.sol` → `randomnessProvider` | ✅ | — | default zero, owner-gated setter, `RandomnessProviderUpdated` (V2 §7.4) |
| `TrustedOperatorRandomness.sol` | ✅ | ✅ | commit (operator-gated, no re-commit, zero-hash rejected), request (no-commit revert, consumer-scoped keys stop front-run squatting), reveal (no-request/bad-preimage/double-fulfill reverts, word = keccak(seed, prev blockhash), permissionless), `MockRandomness` auto + manual modes (V2 §3) |
| `Database.sol` → operator registry | ✅ | ✅ | `setOperator` owner-gated, `operatorCount` honest across redundant grants/revokes, zero-address rejected; modules gate on it (V2 §6.2) |
| `Generator.sol` → FlatCurve exclusion | ✅ | ✅ | the launched FlatCurve is excluded from shares **before** it receives presale tokens (V2 §7.3) |

**Tokenomics V2 Phase A** lives in `test/TokenomicsV2.test.js` (32 tests). It exercises the substrate changes that freeze per-token at launch, including two named regressions for bugs that could brick trading: `RevertingRouter` (§7.1) and `RejectingRecipient` (§7.2). Both mocks live in `contracts/test-mocks/`.

### Blocked — add tests once unblocked

None currently. All Phase 1-5 contracts — plus the Phase-6 vesting/allocations/renounce work (incl. the rebate renounce-freeze), the Tokenomics-V2 Phase-A substrate changes, the entire Phase B (MilestoneRewardModule, randomness provider, PrizePool, operator settlement loop), the typed FeeReceiver interface (`receiveTradeFee`/`receiveLaunchFee` with hook/FlatCurve/Generator context), and the flat launch fee (`Database.launchFeeBnb` + both launch modes) — are under test (**298 tests green**).

---

## Deployment Scripts

Three scripts under `scripts/` cover the full deploy → verify → smoke-test loop. All three read/write `deployments/<network>.json` so they share state cleanly.

| Script | Purpose |
|---|---|
| `scripts/deploy-base.js` | Deploys WBNB marker (mock locally, canonical on BSC), Database, FeeReceiver, RebateContract, all master copies; resolves the **canonical V4 PoolManager on bsc** (`0x28e2ea090877bf75740558f6bfb36a5ffee9e9df`) or deploys one on testnet/local; mines + CREATE2-deploys the **LumoriaHook**; deploys **LiquidityVault**, **LumoriaSwapRouter**, Generator. Wires Database, authorizes the hook as Rebate creditor. Writes `deployments/<network>.json` (incl. canonical UniversalRouter/V4Quoter/StateView on bsc for the frontend). |
| `scripts/smoke-launch.js` | Post-deploy happy-path check: predicts a token address, launches a BYOL token (1 CreatorFee module) onto a V4 pool, asserts vault-locked liquidity, buys through the LumoriaSwapRouter, asserts registration + volume. |
| `scripts/verify.js` | BscScan verification pass: reads deployments file, runs `hardhat verify` with correct constructor args for every contract (incl. the CREATE2-deployed hook). Verifies our own PoolManager only when we deployed it (testnet). |
| `scripts/lib/hook-miner.js` | Shared CREATE2 salt mining for the hook's flag-encoded address. |

### npm scripts

```bash
npm run node              # start a persistent localhost node (port 8545)
npm run deploy:local      # LOCALHOST_URL override supported for non-default ports
npm run deploy:testnet    # requires DEPLOYER_PK in .env
npm run deploy:bsc        # mainnet
npm run smoke:local
npm run smoke:testnet
npm run verify:testnet    # requires BSCSCAN_API_KEY
npm run verify:bsc
```

### Env vars (see `.env.example`)

- `DEPLOYER_PK` — private key for testnet/mainnet deploys.
- `FEE_RECIPIENT` — platform fee recipient; defaults to deployer.
- `BSCSCAN_API_KEY` — for `verify.js`.
- `LOCALHOST_URL` — override if the local node runs on a non-default port.

### Validation done

- Deploy + smoke test have been run end-to-end against a persistent `hardhat node` (V4 era, 2026-06-09): a 5% tax token launches onto a V4 pool (~1.37M gas incl. pool init + vault lock), gets registered, receives a hook-taxed buy through the LumoriaSwapRouter (~332k gas incl. tax distribution), and registers volume — all in one clean pass.
- `deployments/hardhat.json` and `deployments/localhost.json` are gitignored (ephemeral). Commit `deployments/bsc.json` + `deployments/bscTestnet.json` once they exist.

---

## Adding a New Test File

1. Pick the right location (`test/` or `test/modules/`).
2. Import from `./fixtures/deploy` — do **not** re-deploy by hand.
3. Wrap setup in a local helper (`launchWithXYZ()`) if it's reused inside the file.
4. Run `npm run test:only -- "YourSuite"` while iterating.
5. Update the Coverage Status table above when the suite is green.

---

## Adding a Test When You Touch a Contract

Every PR that modifies a contract should also:

- Add/update at least one test that would have caught the change if mis-implemented.
- Run the **full** suite (`npm test`) — not just your file. Modules share state via the fixture; a change in one area can break another.
- Update the Coverage Status table above if the scope changes.

If you intentionally skip tests (e.g. a gas-only refactor), note it in the PR description and add a `TODO:` test block with what should be tested later.

---

## What We Don't Test (By Choice)

- **Ownable / ReentrancyGuard** — well-known library primitives, covered by integration tests exercising their modifiers.
- **Cloneable assembly** — ERC-1167 is standard; the deployed clones are exercised through every launch.
- **Pure gas benchmarks** — add with `hardhat-gas-reporter` later if we need to regression-protect a critical path.
