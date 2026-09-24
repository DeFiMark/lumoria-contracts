# Launch protection and native VRF rollout

**VRF and the PrizePool master were deployed and activated on September 16.**
See [NATIVE_VRF_MAINNET.md](./NATIVE_VRF_MAINNET.md) for funding and receipts.
The four launch-protection replacements were verified on BscScan and activated
September 23 after a successful production-state BSC fork rehearsal. The current
hook, router, vault and VRF provider remain unchanged.

## Activated contracts

- New `Generator` and `TaxHandler` master: opt-in guard on single-sided launches.
- New `LumoriaToken` master: zero-value ERC20 transfers emit Transfer and succeed.
- New `RebateContract`: tax-adjusted output, buy-fee cap, guard pause.
- New `PrizePool` master: requested randomness cannot be discarded on timeout.
- `NativeVRFRandomness(database, coordinator, subscriptionId, keyHash,
  confirmations, requestFeeWei)`: immutable Chainlink v2.5 configuration.

Rehearse candidates on a BSC fork and testnet before any production pointer
changes. The local mock verifies accounting and lifecycle, not oracle service
availability or BSC subscription authorization.

## Existing test projects are retired

On September 23 the owner confirmed all six existing projects are disposable
tests and authorized a fresh cutover without migrating balances or supporting
old clones. Their addresses are recorded in `bsc-launch-protection.json` and the
rollout refuses activation if additional projects appear. No on-chain contracts
or locked liquidity are deleted. The old rebate funds remain at the old contract;
the new rebate service starts empty. This supersedes the migration prerequisite
below for these six projects only.

## Earlier migration assessment (superseded for these six test projects)

Inventory every funded pool and management-renounced token before changing
Database.rebateContract. A pointer change does not transfer balances. Renounced
pools cannot withdraw their old funding, and existing TaxHandlers cached the
old rebate address as a reward-share exclusion. Rotating the pointer without
resolving both would strand funds or change holder reward accounting. Do not
execute a global rebate cutover until that inventory has a reviewed migration.
New guard launches require the new rebate behavior wherever funded rebates are
enabled. The old hook itself remains compatible with the new rebate ABI.

### September 23 readiness check

Read-only mainnet inventory at block 123651133 confirms the old Generator,
RebateContract, TaxHandler master and token master are still selected. All six
registered projects remain management-enabled; four have funded rebate pools
(tokens beginning `0xd22E404B`, `0x6C9f1746`, `0x54e384a2`, `0x9A40ed97`). All
six handlers exclude the current rebate address. Recheck immediately before
cutover, since funding and renunciation can change.

The next rollout must coordinate creator withdrawals/re-funding for those four
pools and exclude the replacement rebate address on existing handlers before it
holds tokens. `excludeFromShares` is Generator-only; the current Generator does
not expose a general migration call. A narrowly scoped migration mechanism and
fork rehearsal are still needed. Changing master copies does not upgrade old
token/handler clones. Authorize the actual rebate caller on the replacement,
verify pointer changes and frontend capability discovery, then smoke-test a
new guarded launch and normal rebate buy.

The local suite passes 334 tests. Two opt-in BSC fork tests were skipped in this
check. This is implementation regression coverage, not a completed production
rehearsal or an independent security audit.

## September 23 candidate deployment and rehearsal

- Token master: `0xab1F77FE3504FE0d716a704061319bCa69977b26`
- TaxHandler master: `0x1BC9bf51a0b8850d1dC25a3d4d5Cd18A6fb55f75`
- RebateContract: `0xF3229A09FAb53834a5695FF03a5E8701C6580eB0`
- Generator: `0x67C1Eef556D0789a0e24893022a0E61b611a2Da2`

Hook authorization and existing starting-tick bounds are configured. VRF reserve
was read as **0.10597535456 BNB**, with the production adapter authorized. No VRF
funds were moved. The 334-test local suite passes. A separate production-state
fork ran the actual rollout script and passed guarded launch, protocol/project
split, paused rebates, expiry, exact corrected rebate payout, lower-fee cap,
zero-value ERC20 transfer and sell with the canonical deployed router/hook/vault.
Evidence: `deployments/fork-launch-protection.json`. Fork transactions are local
simulation receipts and are not mainnet transactions.

`scripts/deploy-launch-protection.js` supports LP_STAGE `deploy`, `verify`,
`activate`, `smoke-start`, `smoke-finish`; use Hardhat `--network bsc`. The `rehearse`
stage requires BSC_FORK=1 on Hardhat's in-memory network. Mainnet hashes are
journaled before broadcast and stages reuse receipts. Do not discard a journal
or retry an uncertain broadcast with a new deployment.

Completed: source verification, pointer activation, frontend address generation
and Goldsky 1.2.0 deployment. Frontend/operator/market-data updates are pushed
to main. The mainnet smoke runs in two phases across the seven-minute guard. Smoke uses a 0.005 BNB launch fee
at the current setting and 0.0012 BNB in buys plus gas, with 5% quote slippage.
Operator's Database/hook/router/VRF addresses do not change.

## VRF activation

1. Select the official BSC coordinator, native-payment gas lane and appropriate
   confirmations from Chainlink's current supported-networks documentation.
2. Configure the main subscription under the platform's controlled owner. Add
   the adapter as consumer; maintain a native BNB operating reserve. Do not give
   the Railway operator subscription ownership or Database ownership.
3. Set an explicit fixed request charge at deployment. This is a service charge,
   not exact reimbursement of Chainlink's eventual bill. The whole charge goes
   into the subscription; the platform bears cost variance and maintains the
   reserve. Project deposits remain segregated in adapter escrow until charged.
4. Deploy the new PrizePool master for future modules. Existing lottery clones
   lack the non-cancellation guarantee and the adapter rejects them. Move future
   lottery allocations to new modules through the normal timelock, while
   finishing old obligations with their pinned provider. Renounced projects
   cannot replace modules; they need a separate migration decision.
5. Register compatible modules before removing them from their TaxHandler, so
   historical epochs retain funding authorization. The operator registers active
   compatible modules; registration and result delivery are permissionless.
6. Verify a funded testnet request, coordinator callback, delivery and winning
   claim. Confirm callback gas, subscription minimum balance, pricing and reserve
   alert thresholds under the chosen network configuration.
7. Rotate Database.randomnessProvider only after module migration is accounted
   for. Sync the operator address manifest; its preflight rejects pointer drift.
   Keep legacy seed backups for outstanding requests pinned to the old provider.

The operator cannot choose or replace a VRF word. It still constructs and posts
ticket roots; VRF does not remove that separate trust assumption. The six-hour
root challenge window and independent referee remain required. A requested draw
waits for its original outcome indefinitely: funding/provider incidents require
repair, not cancellation or weak-randomness fallback.

## Frontend and events

The wizard probes Generator.supportsSniperGuard; old 32-byte payloads still work.
Guard state comes from `TaxHandler.launchGuardState()` (including block timestamp)
every three seconds. Fee quotes continue to simulate the unchanged V4 hook.
The full Fees panel separates the extra protocol allocation from project routes.

`BuyTaxDistributed.amount` is the amount routed to modules; totalBuyTaxReceived
still counts the entire received tax. `SniperOverageDistributed` records the full
tax, protocol share and project share. Index this new event for historical guard
analytics; live fee displays do not depend on subgraph support.

VRF funding reads the Database's live provider; fixed request price, credit,
funding and creator withdrawal appear in the management console. The rebate
client probes V2 terms and retains the old formula on legacy contracts.

## External trading integrations

Exact-input V4 swaps can use the canonical PoolKey and V4Quoter. Exact-output is
unsupported. Empty hookData still permits trading and taxation, but supplies no
buyer attribution or rebate. Standard third-party LP management is incompatible
with Lumoria's permanent vault lock.

Uniswap Labs routing requires manual review/allowlisting for hooks using
beforeSwapReturnsDelta or afterSwapReturnsDelta. Lumoria uses both; do not claim
automatic visibility in the public Uniswap app. Submit the verified deployed
hook through their process:
https://support.uniswap.org/hc/en-us/articles/48291859140621-Routing-for-hooked-pools

## Indexer and client release

Goldsky `lumoria-bsc/1.2.0` grafts 1.1.0 at block 123653636, before the new
contracts were deployed. This preserves history while replaying every event from
the rollout. GeneratorLaunchProtection is additive; old factory/vault sources
remain indexed. Token.buyFee stores the configured base fee; live effective
fees use chain reads. SniperOverage records exact protocol/project splits.
The frontend and both Railway services map the former 1.1.0 production URL to
1.2.0 automatically; custom endpoints remain unchanged.

## Mainnet smoke result

Passed on 2026-09-24T00:04:11.596Z. Canary: `0x053457E241F73AE58512Ab8eEa88c0f61C845907`.
The first two buys verified the guard split and paused rebates. After expiry,
normal buy `0x5409517a5f69abca93111ac897d72098f3f1abd2d32f57911bbfeeb62149080a`
paid exactly received * 1500 / 8000; reducing the buy fee to 1000 bps capped
the rebate rate to 1000 bps. Sell `0x1d3da1efe37022119b191d64fac2fc672fe74106887bd0e1bfa07516f0d77042` succeeded with a quoted minimum output.
Zero-value ERC20 transfer succeeded. Receipts and source/code hashes are in
`deployments/bsc-launch-protection.json`; the canary is a disposable test token.
A production SSE candle was observed from the normal buy. That check exposed
USD volume in Codex live bars; the market service now explicitly requests
`volumeNativeToken`, matching native-BNB history.

The corrected stream was verified with a further 0.00001 BNB canary buy: it
delivered exactly 0.00000891 BNB candle volume (net of 1% platform fee and 10%
buy tax), explicitly labeled volumeCurrency=BNB. The receipt is recorded as
smokeNativeVolumeBuy. Total smoke buy input was 0.00121 BNB plus launch fee/gas.
