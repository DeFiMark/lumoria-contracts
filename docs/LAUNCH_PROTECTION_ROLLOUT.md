# Launch protection and native VRF rollout

**VRF and the PrizePool master were deployed and activated on September 16.**
See [NATIVE_VRF_MAINNET.md](./NATIVE_VRF_MAINNET.md) for funding and receipts.
The other launch-protection changes remain local. Existing clone contracts retain
their deployed code. Keep the current hook, router, vault, and pool IDs.

## Candidate contracts

- New `Generator` and `TaxHandler` master: opt-in guard on single-sided launches.
- New `LumoriaToken` master: zero-value ERC20 transfers emit Transfer and succeed.
- New `RebateContract`: tax-adjusted output, buy-fee cap, guard pause.
- New `PrizePool` master: requested randomness cannot be discarded on timeout.
- `NativeVRFRandomness(database, coordinator, subscriptionId, keyHash,
  confirmations, requestFeeWei)`: immutable Chainlink v2.5 configuration.

Rehearse candidates on a BSC fork and testnet before any production pointer
changes. The local mock verifies accounting and lifecycle, not oracle service
availability or BSC subscription authorization.

## Rebate migration is a prerequisite

Inventory every funded pool and management-renounced token before changing
Database.rebateContract. A pointer change does not transfer balances. Renounced
pools cannot withdraw their old funding, and existing TaxHandlers cached the
old rebate address as a reward-share exclusion. Rotating the pointer without
resolving both would strand funds or change holder reward accounting. Do not
execute a global rebate cutover until that inventory has a reviewed migration.
New guard launches require the new rebate behavior wherever funded rebates are
enabled. The old hook itself remains compatible with the new rebate ABI.

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
