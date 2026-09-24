# Native BNB VRF: mainnet deployment, September 16, 2026

The live Database now points to Chainlink VRF v2.5 through
`0xf0eBe3E3bC668361145335aB7746C7b0eF5e984b`. Future type-4 modules clone
PrizePool `0x5811C309c1B5C7B696519b53A5f55584B7aeb246`, which prevents cancellation
after requesting randomness. Both contracts are verified on BscScan.

## Funding

Send **native BNB on BNB Smart Chain (chain 56)** directly to
`0xf0eBe3E3bC668361145335aB7746C7b0eF5e984b` to fund the shared operating reserve.
The `receive()` function forwards it to Chainlink; `fundReserve()` does the same.
Do not send WBNB, LINK, or BNB on another chain to this address.

The reserve started with **0.10597535456 BNB**, recovered from the completed
canary. It is separate from project escrow. Project sponsors call
`fundProject(token)` with BNB (the management UI already supports this).
Each draw moves a fixed **0.001 BNB** project charge into the subscription;
only the creator may withdraw unspent project credit. This fixed charge is
not exact reimbursement of Chainlink's final bill.

The selected 200-gwei lane, 100,000 callback gas and 60% native premium imply
an estimated maximum-cost reserve of roughly **0.096 BNB per pending request**,
using 200,000 verification gas. Keep extra headroom for concurrent draws and
cost variation; 0.1 BNB is the operator's low-reserve alert threshold, not a
guarantee of capacity. The initial canary waited at 0.006 BNB and completed
after topping up to 0.106 BNB; its actual oracle charge was 0.00002464544 BNB.

Subscription ID:
`85606171843725943547584415503275777821741697391597895161659698914265676495536`

Coordinator: `0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9`.
Confirmations: 10. Key hash:
`0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4`.

Subscription owner is the platform deployer
`0x7F062E13f09dbFf8CB0433F0E777470107113A74`, not the Railway operator.
This is still a governance trust boundary: the subscription owner can manage
consumers and cancel eligible subscriptions. The adapter itself has no admin
withdrawal or word override. Database ownership still controls future provider
selection. A requested epoch pins its provider permanently.

## Evidence and migration

- 333-test full contract suite passed; an additional VRF winning-claim test
  passed in the seven-test targeted suite. Fork coordinator rehearsal passed.
- Mainnet canary request, actual oracle callback, and permissionless delivery
  succeeded. It used the same adapter code and settings as production, with
  an isolated canary consumer/registry. This was not a live project lottery.
- Inventory of every registered TaxHandler's historical ModuleAdded logs found
  one pro-rata PrizePool and no lottery modules. Old provider request count was
  zero. No historical lottery migration or pending reveal was required.
- New master activation: `0x42a918b2ca4ca97c123c45251831f28a3f5bc9e6ccc29c2990bcea4e7256b188`.
- Provider activation: `0x4bdad6576b0e02311f62848d860c7023857137cf807398bbf07cc92296f893e6`.
- Addresses, constructor args, receipt hashes, canary outcome and reserve
  recovery are saved in `deployments/bsc-native-vrf.json` and `bsc.json`.

The operator still derives and posts ticket roots. The challenge window and
independent root verification remain necessary; VRF removes operator choice
and selective withholding of the random word, not ticket-set trust.

Frontend ABI/address manifests and the operator manifest have been synced
locally. Deploy the updated frontend/operator builds to publish those changes;
this contract rollout does not itself deploy either service. Old operator
builds correctly stop on a randomness-provider address mismatch.

This September 16 rollout activated the VRF adapter and PrizePool master only.
The separate sniper-guard, rebate, Token and TaxHandler rollout was activated
on September 23; see LAUNCH_PROTECTION_ROLLOUT.md. Existing hook, router, vault
and VRF configuration remain in place. The reserve was rechecked at
0.10597535456 BNB before that rollout.

## Operations

`scripts/deploy-native-vrf.js` journals each broadcast hash before waiting for
the receipt. Stages: `canary`, `fund-canary`, `status`, `deploy`, `move-reserve`,
`activate`. Re-running a stage resumes its recorded transactions. Do not reuse
this journal for an unrelated deployment.

`scripts/inspect-vrf-rollout.js` reads live pointers, funding and migration
inventory. `scripts/verify-native-vrf.js` verifies all candidate/canary sources.
`VRF_STAGE=status` only delivers the already fulfilled canary; it never rerolls.
No testnet deployment was attempted because the deployer had zero testnet BNB.

Official references:
- https://docs.chain.link/vrf/v2-5/supported-networks#bnb-chain-mainnet
- https://docs.chain.link/vrf/v2-5/billing
