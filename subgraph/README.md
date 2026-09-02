# Lumoria Subgraph

The Graph subgraph for the Lumoria launchpad (Uniswap V4 + LumoriaHook) on BNB Chain.
Scaffolded from [`../docs/SUBGRAPH.md`](../docs/SUBGRAPH.md) — that doc is the source of
truth for every event, entity, and indexing gotcha; this is its implementation.

## Layout

```
subgraph/
├── schema.graphql        ← all entities (docs/SUBGRAPH.md §6)
├── subgraph.yaml         ← legacy sources plus deployed additive V2 sources
├── networks.json         ← addresses + startBlock (generated post-deploy)
├── abis/                 ← extracted from ../artifacts (generated)
├── scripts/
│   ├── extract-abis.js   ← pulls ABIs out of the Hardhat artifacts
│   └── gen-networks.js   ← builds networks.json and materializes deployed V2 sources
└── src/
    ├── helpers.ts        ← shared getters / ids / candle + holder-day aggregation
    ├── database.ts       ← BOOTSTRAP: TokenRegistered → hydrate fees/modules/supply,
    │                        spawn templates, seed genesis (the same-tx ordering trap)
    ├── generator.ts      ← ProjectGenerated, FlatCurveLaunched, allocations
    ├── hook.ts           ← TokenPurchased/Sold → Trade + OHLC candles (price source)
    ├── token.ts          ← Transfer → Holder balances + holderCount (pool/gen/vault excluded)
    ├── taxHandler.ts     ← fees, modules, pending-change timelock, renounce
    ├── vault.ts          ← pool init + locked-liquidity TVL
    ├── feeReceiver.ts    ← platform fee total
    ├── rebate.ts         ← per-token rebate pools + credits
    ├── vestingVault.ts   ← vesting schedules + releases
    ├── creatorFeeModule.ts / rewardModule.ts / burnModule.ts / liquidityModule.ts
    └── flatCurve.ts      ← raise lifecycle
```

## Build + deploy

> Prereq: deploy the contracts first (`npm run deploy:bsc` in the parent repo)
> so `deployments/bsc.json` exists with addresses + `startBlock`.

```bash
cd subgraph
npm install

# 1. Pull ABIs from ../artifacts (run `npx hardhat compile` in the parent first)
#    and generate networks.json from ../deployments/bsc.json
npm run extract-abis
npm run gen-networks

# 2. Codegen + build (validates schema + mappings against the ABIs)
npm run codegen
npm run build            # = graph build --network bsc (injects addresses/startBlock)

# 3. Deploy (Subgraph Studio — set your deploy key / slug first)
graph auth <deploy-key>
npm run deploy:studio
```

For a local Graph Node: `npm run create:local && npm run deploy:local`.

### Additive V2 data sources

The checked-in manifest keeps every legacy Generator and vault source active.
`npm run gen-networks` additionally looks for
`../deployments/<network>-single-sided-v2-candidate.json` with the following
deployment-produced fields:

```json
{
  "generatorV2": "0x...",
  "vaultV2": "0x...",
  "deploymentBlock": 123
}
```

When all three fields exist, the script inserts separate `GeneratorV2` and
`LumoriaLiquidityVaultV2` sources at that block and adds their coordinates to
`networks.json`. When they do not exist, it leaves the active manifest
legacy-only; it never invents or activates a zero-address source. CI or a
rehearsal can override the file with `GENERATOR_V2_ADDRESS`,
`LIQUIDITY_VAULT_V2_ADDRESS`, and `SINGLE_SIDED_START_BLOCK` (all three are
required together).

## Status — validated (codegen + build green)

`graph codegen` and `graph build` both pass: every manifest event signature
matches the compiled ABIs, the schema is valid, and all 14 AssemblyScript
mappings compile to wasm. What remains is purely deploy-side — `gen-networks`
(needs `deployments/bsc.json`), then `graph build --network bsc` + deploy, then
indexing against the live contracts to confirm the queries the UI needs.

## Indexing notes (see docs/SUBGRAPH.md §10 for the full list)

- **Same-tx ordering trap** — initial `ModuleAdded` + the mint `Transfer` fire
  *before* `TokenRegistered`; `database.ts` hydrates that genesis state via
  contract calls and seeds the Generator's holder balance so distributions
  don't drive it negative.
- **`isModuleFlow`** — `hook.ts` flags trades whose buyer/seller is a known
  module (tracked via the `ModuleAddress` entity) and excludes them from OHLC
  candles + `lastPriceBnb` so module-recursion doesn't distort price/volume.
- **holderCount** excludes the PoolManager, Generator, VestingVault, and 0x0
  (resolved once into the `SystemAddresses` entity at bootstrap).
- **Pending-change execute→executed** is inferred in `handleFeesUpdated`
  (matches the pending change's new values) — the most delicate handler.
- **Vesting `releasable`** is time-derived and intentionally NOT stored — read
  `VestingVault.releasable(id)` or compute client-side from start/cliff/duration.
- **Platform fee total** comes only from `FeeReceiver.FeeReceived` (fires on
  every inflow); `TokenFeeReceived` is intentionally unindexed to avoid
  double-counting.
