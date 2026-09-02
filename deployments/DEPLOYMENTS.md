# Lumoria — Deployment Registry

## v1.2 — Permanent Single-Sided V2 (2026-09-02) — CURRENT

All four contracts are deployed and BscScan-verified on BSC mainnet and the
Database was rotated to them at **block 119472210** (cutover txs:
`setTokenMasterCopy` `0xd19f7c9e…68e2`, `setLiquidityVault` `0x93abb228…3241`,
`setGenerator` `0x1f95a45c…10dc`, `setModuleMasterCopy(2)` `0xdeacf7cf…46e1`;
legacy analytics matched for all 3 pre-existing tokens before the Generator
rotated). `bsc.json` now carries the live pointers, with the v1.1 addresses
retained under `previous.singleSidedV2Cutover` for the subgraph's historical
sources. Candidate manifest:
[`bsc-single-sided-v2-candidate.json`](./bsc-single-sided-v2-candidate.json)
(`databasePointersRotated: true`).

| | Address | Note |
|---|---|---|
| LumoriaToken master V2 (metadata-aware) | `0x472CDE197a6bD37D7EA77d388FFC9Eb0cBaaDC53` | rotated **first** (`setTokenMasterCopy`); launches fail closed until the Generator follows |
| LumoriaLiquidityVault V2 | `0x0fD6C47b9218a127D786d2dD0299712d34eD6d75` | `legacyVault = 0x6d19…6F31`; aggregates legacy analytics |
| Generator V2 (modes 0/1/2 + metadata) | `0xBE9190d1C247964852b5817f26fb6927843D94a5` | start-tick window `[148200, 196260]` ≈ 366 → 3 BNB FDV, owner-tunable |
| LiquidityModule master V2 (type 2) | `0x7AA2FCAf696279340BAbDf04d2b5a93a8621b649` | refuses `__init__` for single-sided tokens |
| Deployment block (subgraph V2 start) | `119461440` | |
| Subgraph | Goldsky `lumoria-bsc/1.1.0` (additive `GeneratorV2` + `LumoriaLiquidityVaultV2` sources) | frontend `NEXT_PUBLIC_SUBGRAPH_URL` must move to the 1.1.0 endpoint |

Cutover = four owner calls in this order (script: `npm run cutover:v2:bsc`
with `CONFIRM_V2_CUTOVER=YES`; read-only preview: `prepare-cutover:v2:bsc`):
`setTokenMasterCopy(token V2)` → `setLiquidityVault(vault V2)` (legacy
analytics compared for every registered token before continuing) →
`setGenerator(generator V2)` → `setModuleMasterCopy(2, module V2)`. The
sequence was rehearsed end to end on a mainnet fork (`test/SingleSidedV4Fork.test.js`
plus the scripts themselves via `FORK_USE_DEPLOYER_PK=1`).

Rollback before the first mode-2 launch: restore all four pointers. After a
mode-2 launch: restore only the Generator; keep Vault V2 (it owns the
permanent position and aggregates history).

Deploy/cutover scripts sign and poll via raw RPC (`scripts/lib/raw-tx.js`) —
the configured RPC answers pending contract-creations with `to: ""`, which
crashes ethers/hardhat-ethers after broadcast (same quirk as the v1 note
below).

Every production/testnet deployment gets one section here plus a frozen JSON
snapshot in `archive/` (`<network>-<date>-<git sha>.json`). The live artifact
(`<network>.json`) always reflects the CURRENT deployment; the archive never
changes. When redeploying, add a new section at the top and a new archive file
— never edit old entries.

---

## v1.1 — BSC Mainnet delta (2026-07-21) — CURRENT

PrizePool master copy replaced (no tokens existed yet, so no clone drift):
`rootPoster == address(0)` now delegates root posting to the **platform
operator registry** (`Database.isOperator` — owner-managed, rotatable) instead
of reverting at init; a non-zero rootPoster remains an explicit per-token
override, and there is deliberately NO permissionless fallback (unsettled
epochs roll over). The launch wizard always passes zero and no longer
surfaces the field.

| | |
|---|---|
| PrizePool master copy (type 4) | `0xc53D1dA4c98C837d2b43EDDDC2E9933c92dCACbb` (verified; replaces `0x8bf6…A008`, kept in `bsc.json` as `masterCopies.prizePoolV1`) |
| Platform operator registered | `0x7868fA54d5a96A31Cd07eDE9E6D2A280De9ef484` — flips module execution to operator-first (1h public fallback) and is the root-posting authority for operator-settled prize pools |
| Script | `scripts/redeploy-prizepool-mc.js` |

## v1 — BSC Mainnet (2026-07-21)

| | |
|---|---|
| **Network** | BSC mainnet (chainId 56) |
| **Git commit** | `fcf3cbe` — flat launch fee + typed FeeReceiver + Phase B wiring |
| **Deployer / owner** | `0x7F062E13f09dbFf8CB0433F0E777470107113A74` (EOA — multisig handoff pending, LAUNCH.md §7) |
| **startBlock** | `111199483` |
| **Artifact** | [`bsc.json`](./bsc.json) · frozen copy [`archive/bsc-2026-07-21-fcf3cbe.json`](./archive/bsc-2026-07-21-fcf3cbe.json) |
| **Subgraph** | Goldsky `lumoria-bsc/1.0.2` — `https://api.goldsky.com/api/public/project_cmg2x3lrvy37d01vq4bsnbtig/subgraphs/lumoria-bsc/1.0.2/gn` |
| **Config at deploy** | `platformFeeBps = 100` (1%) · `launchFeeBnb = 0.005 BNB` · operators: none (permissionless) · FeeReceiver recipient = deployer |

### Core

| Contract | Address |
|---|---|
| Database | `0x9af6a42a78Fe4Ec3c7eFDFF3a2D52ecb5aad0d47` |
| FeeReceiver | `0xaEdF41a52eF535267f6516C91998119a028555af` |
| RebateContract | `0x7fFfDbdD4eD1b6D635Fe66a73862d80b37b02718` |
| LumoriaHook | `0x0C2fCddDbcd5ae744F1ef26D9e09F4338533Eaec` (CREATE2, salt `0x…5806`) |
| LumoriaLiquidityVault | `0x6d1930E4b9b8D1bCe27E0d6DF4A7120bdc7A6F31` |
| VestingVault | `0x7fdCa82323b77C7fb11a674F4b75782Fb1bd5d53` |
| LumoriaSwapRouter | `0x3C973aF48d54429A55E74E3E8eEC42eC886925A8` |
| Generator | `0xCe5eD020D36aC8Ca1D87319769819E8aCE7723f2` |
| Create2Deployer | `0xd9377878F74273A81f9313cbE98BD8339809281B` |
| TrustedOperatorRandomness | `0xc0Dba880FaECEA0187C0e4478282fB3d7A1a28b1` |

### Master copies (ERC-1167 clone sources)

| Contract | Address |
|---|---|
| LumoriaToken | `0x05D1Ba49AfB0DC2fF01DC1787Ce451a2b4A771eD` |
| TaxHandler | `0x7d7D34618b81dB957EE7DfBea860Cc1c0d0663F9` |
| FlatCurve | `0xCEBf6612c34ce6A3850344C54AFe40D052d78E7e` |
| CreatorFeeModule (type 3) | `0xdd57e227cc4136f8c7aa7b555959Df784D334D4D` |
| RewardModule (type 0) | `0x82b75c622B225104ba9AEdF3294B779dD097C599` |
| BurnModule (type 1) | `0x551C2BFd3fa41BDe1a9d916003919A5BFB2229A7` |
| LiquidityModule (type 2) | `0x3a14505476741040418F17c96c21CD0cb0B431A8` |
| PrizePool (type 4) | `0x8bf6999bbfF8223F9840b04121C22A658ba2A008` |
| MilestoneRewardModule (type 5) | `0x6755792De457b5ABCf7f5C8A2dF655d8B5854Cf2` |

### Canonical Uniswap V4 (not ours — reference)

| Contract | Address |
|---|---|
| PoolManager | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` |
| UniversalRouter | `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` |
| V4Quoter | `0x9f75dd27d6664c475b90e105573e550ff69437b0` |
| StateView | `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4` |
| PositionManager | `0x7a4a5c919ae2541aed11041a1aeee68f1287f95b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

### Notes

- One orphaned `Database` at `0xC5Aa9ABFdFc539735c78AA5BEc7b0492F5d275ab`
  (deployer nonce 0): the first deploy attempt crashed on an
  Alchemy-BNB/ethers-v6 pending-tx format quirk (`to: ""` vs `null`) after
  broadcasting only that one tx. Unused, unwired, harmless. Deploys go
  through a standard RPC (`BSC_RPC=https://bsc-dataseed.binance.org`);
  Alchemy stays for fork rehearsals.
- No smoke launch run yet — a guarded first real launch permanently locks
  its seed BNB, so it's a deliberate step (LAUNCH.md §6).
