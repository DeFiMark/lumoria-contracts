# Lumoria — Module Build Handoff

**Hand this file to the team building the new tokenomics modules.**

You are building two new modules against a system that is **feature-complete,
tested (211 green), and about to deploy to BSC mainnet**. Nothing you build blocks
that deploy, and nothing you build requires changing a deployed contract. That is
by design, and §2 explains why it must stay that way.

**Read this file first, then [`TOKENOMICS_V2.md`](./TOKENOMICS_V2.md) §2 and §2B
for the full specs.** [`DESIGN.md`](./DESIGN.md) is the system reference;
[`TESTING.md`](./TESTING.md) is the test conventions; [`CLAUDE.md`](../CLAUDE.md)
has the repo discipline.

---

## 1. What you are building

| # | Deliverable | Type | Effort | Blocks |
|---|---|---|---|---|
| **B1** ✅ | `MilestoneRewardModule` | module 5 | shipped | nothing |
| **B2** ✅ | `IRandomnessProvider` + `TrustedOperatorRandomness` + `MockRandomness` | infra | shipped | B3's lottery mode |
| **B3** | `PrizePool` | module 4 | ~2 weeks | nothing |
| **B4** | Subgraph templates + operator scripts for both | — | ~1 week | — |

**Build in that order.** B1 is small and self-contained: it will calibrate you on
the invariants before you touch merkle proofs and epoch math. Do not start B3
until B1 is merged and green.

### B1 — MilestoneRewardModule (spec: §2B) ✅ SHIPPED

`contracts/modules/MilestoneRewardModule.sol` + 24 tests + subgraph template.
Shipped with one addition to the spec below: the **18-month public-release valve**
(§2B.2b) — after 540 days with no release, anyone can push the FULL balance to
holders (still only into the RewardModule); any release resets the clock.
`ITaxHandler` gained the `getModule(uint256)` declaration (the getter always
existed on the implementation — no deployed bytecode changed).

Accrues tax BNB. The token creator presses a button to release any amount of it to
**all holders**, whenever they like, with the milestone they are claiming recorded
as free text on-chain.

There is deliberately **no on-chain milestone check**. The safety property is
different and stronger:

> The only code path that moves BNB out of this contract sends it to the token's
> RewardModule. No `withdraw`, no `recipient`, no `sweep`, no admin escape. The
> creator's discretion is over timing and amount — **never over destination.**

**Your primary acceptance criterion:** an auditor can grep the contract, find
exactly one value-moving call, and see that its target is the RewardModule and is
not a parameter. If you add a second one, you have destroyed the module.

External surface, in full:

```solidity
function receiveTax() external payable;                                   // accrue only
function releaseRewards(uint256 amount, string calldata reason) external; // creator only
function getModuleType() external pure returns (uint8);                   // 5
function getStats() external view returns (bytes memory);
```

### B2 — Randomness (spec: §3) ✅ SHIPPED

`contracts/interfaces/IRandomnessProvider.sol` + `contracts/TrustedOperatorRandomness.sol`
+ `contracts/test-mocks/MockRandomness.sol`, 14 tests. Keys are consumer-scoped
(§3.2b) so a stranger cannot front-run a module's request and strand its epoch.
`commit` follows the platform operator registry; `reveal` is permissionless
(the seed preimage is the credential).

One **platform-wide** provider behind `IRandomnessProvider`, registered at
`Database.randomnessProvider` (the field exists already and is unread). Never a
per-token VRF subscription — that was rejected on cost and ops grounds.

Ship `TrustedOperatorRandomness` (commit–reveal + blockhash mixing) and
`MockRandomness`. `ChainlinkVRFRandomness` is a later drop-in via
`Database.setRandomnessProvider`, requiring **zero** module changes. That
swappability is the whole reason the interface exists — do not let a module import
Chainlink directly.

Order matters and is load-bearing: **the operator commits the seed hash before the
epoch's participants are known, and reveals after the epoch closes.** Get this
backwards and the operator can grind the winner.

### B3 — PrizePool (spec: §2)

Buyers earn tickets during an epoch; the pot pays out pro-rata, by weighted
lottery (≤10 winners), or to all holders.

The design decision that makes this possible without touching frozen code: **ticket
data is reconstructed off-chain from the `TokenPurchased` event the hook already
emits**, and settled on-chain via a merkle root. The module receives its BNB
through the unchanged `receiveTax()` and buckets it by `block.timestamp`.

Read §1.3 of `TOKENOMICS_V2.md` before you argue for an on-chain trade callback.
That option was evaluated and rejected: it would require changing `LumoriaHook`,
`ITaxHandler` and `IModule`, all of which are frozen (§2 below).

### B4 — Subgraph + operators

New dynamic-data-source template per module, following the existing per-module
pattern in `subgraph/subgraph.yaml`. `helpers.ts` gains `MODULE_PRIZE = 4` and
`MODULE_MILESTONE = 5`; add branches to `hydrateModuleSpecifics` and
`spawnModuleTemplate` in `database.ts` and `taxHandler.ts`.

For the PrizePool the subgraph is not decoration — **it is the reference
implementation of ticket derivation**, and the thing that lets any third party
independently verify the operator's merkle root. Ship it with the module.

---

## 2. The frozen-layer rule — read this before writing any code

Two layers of Lumoria age differently, and confusing them is the one mistake that
cannot be undone.

**Modules are cheap to change forever.** Register a new master copy with
`Database.setModuleMasterCopy(uint8, address)` and *any* token — including one
launched a year earlier — can adopt it through `TaxHandler.proposeModuleAdd`.
`TaxHandler` enforces no enum on module types; it only requires the master copy be
non-zero. This is why both your modules can ship after mainnet.

**`LumoriaHook` and the `TaxHandler` code cannot change.** Each token gets its own
`TaxHandler` as an ERC-1167 clone bound to whatever master copy existed at *its*
launch. Worse, in Uniswap V4 the hook's address is part of the `PoolKey` — it *is*
the pool's identity — and pool liquidity is permanently locked with no removal
path. Deploy a new hook and every existing pool is orphaned.

**Therefore:**

- ✅ You may add new module contracts, new interfaces, new standalone contracts.
- ✅ You may add functions to `IDatabase` / `ITaxHandler` **interfaces** where the
  getter already exists on the implementation (e.g. `totalBuyTaxReceived`) — this
  changes no deployed bytecode.
- ❌ You may **not** change `LumoriaHook`, `IModule`, `ITaxHandler`'s existing
  function signatures, or `TaxHandler`'s logic. If you think you need to, stop and
  escalate — there is almost certainly an off-chain reconstruction (that is exactly
  how the PrizePool avoids it).

---

## 3. Invariants you must not break

These were established the hard way. Two of them fixed live trade-bricking bugs.

### 3.1 `receiveTax()` may only accrue state and emit events

It runs **inside the Uniswap V4 swap callback**, on a real trader's transaction,
with no try/catch and no gas cap anywhere on the path from `LumoriaHook._forward`
down through `TaxHandler._distribute`.

- No value transfers out.
- No external calls.
- No unbounded loops.

A module that reverts here **bricks all trading for its token, permanently.** A
module that calls back into the router here trips both the PoolManager lock and the
TaxHandler reentrancy guard. Heavy work goes in a separate, out-of-band transaction.

`RewardModule` violated this (it swapped on an external router inside the callback)
and `CreatorFeeModule` violated this (it pushed BNB with `require(success)`, so a
fee recipient without a payable `receive()` reverted every trade). Both are fixed.
Do not reintroduce either shape.

### 3.2 Do not add `try/catch` around module dispatch

It looks like a safety net. It is not. The 63/64 gas rule lets an attacker supply
exactly enough gas that the module sub-call OOGs while the outer transaction
survives — the catch swallows it, the trade succeeds, and the tax is silently
skipped. That converts a loud failure into a quiet theft.

The invariant in §3.1 is the fix. There is no gas floor either, deliberately:
without `try/catch`, an OOG reverts the whole transaction, which is loud and
correct.

### 3.3 Swaps take a real slippage floor and are operator-gated

A caller-supplied `minOut` protects the *caller's* funds. A module swap spends the
**module's** BNB, so an arbitrary caller has no incentive to pick a good floor —
they pass 1 wei and sandwich their own call.

Any function that swaps must therefore: require `minOut > 0`, take a `deadline`,
re-verify the output against its own measured balance delta (the router is not
trusted), and gate on the platform operator registry:

```solidity
IDatabase db = IDatabase(database);
if (db.operatorCount() == 0) return;            // permissionless by default
if (db.isOperator(msg.sender)) return;          // Lumoria backend
require(block.timestamp >= readyAt + PUBLIC_FALLBACK_DELAY, "Operator window");
```

**Neither of your modules swaps.** MilestoneReward donates; PrizePool pays BNB. So
neither takes an operator gate for this reason. Know the rule anyway — if you find
yourself adding a swap, this is the shape.

### 3.4 Only swaps are gated

Work that merely costs gas to churn stays permissionless forever: claims,
donations, share syncs, dividend crystallization, PrizePool claims,
MilestoneReward's accrual. Where a function would mix a gated and an ungated
concern, **split it into two functions** so the permission boundary is visible in
the ABI rather than buried in a branch. `RewardModule.processRewards()` vs
`convertAndDistribute()` is the worked example.

The full permission matrix is `TOKENOMICS_V2.md` §6.3.

### 3.5 Value moves by pull, not push

Every payout path in the system is accrue-and-pull. A recipient that cannot accept
BNB must only be able to break its own withdrawal, never a trade and never another
user's claim. `TransferHelper.safeTransferETH` does `require(success)` — that is
fine on a withdrawal, fatal anywhere in the tax path.

For the PrizePool this is not optional: you cannot push BNB to N winners in one
transaction without a single bad recipient reverting the whole settlement.

### 3.6 Allocation and slot budget

Buy and sell allocations must each sum to exactly `10000` bps across active
modules, enforced at propose *and* execute time. Adding a module to a live token
means rebalancing the others down atomically via the `rebalance` array on
`proposeModuleAdd`. `MAX_MODULES = 10`, and each of your modules consumes a slot.

### 3.7 Never add a liquidity-removal path

Anywhere. Vault, hook, router, module. "Liquidity can never leave" is a
load-bearing trust guarantee, and the hook reverts all removals and donations.

---

## 4. What already exists that you should use, not rebuild

| You need | Use | Not |
|---|---|---|
| Pay every holder pro-rata | `IRewardModule(rm).donate{value: x}()` | a second dividend accumulator |
| Find a token's RewardModule | walk `ITaxHandler.getModuleCount()` / `getModule(i)` for `moduleType == 0` | a registry |
| Know who a token's creator is | `ITaxHandler(taxHandler).creator()` (immutable) | an owner field |
| Reach the Database from a module without one | `ITaxHandler(taxHandler).database()` | a new init param |
| Know if an address earns rewards | `ITaxHandler.isExcludedFromShares(addr)` | your own exclusion list |
| Buyer identity + BNB spent per trade | the hook's `TokenPurchased(token, user, bnbIn, …)` event, off-chain | a hook change |
| Platform-wide randomness | `Database.randomnessProvider()` | a per-token VRF subscription |
| Trusted keeper identity | `Database.isOperator(addr)` / `operatorCount()` | a per-module operator field |

**A RewardModule added to a live token starts blind** — `setShare` only fires on
transfer, so pre-existing holders have no share in it until they next transact.
`RewardModule.sync(address[] holders)` backfills from `balanceOf` and is
permissionless and self-verifying. Any flow that adds a reward module to an
existing token must call it. This matters directly for B1: a MilestoneRewardModule
is useless without a RewardModule to donate into.

---

## 5. Test requirements

`npm test` must pass. Follow `TESTING.md` conventions: `loadFixture(deployBase)`,
payload builders from `test/fixtures/deploy.js`, mocks under
`contracts/test-mocks/`. Per `CLAUDE.md`, update `DESIGN.md`, `ROADMAP.md`,
`FRONTEND.md`, `TESTING.md` and `SUBGRAPH.md` **in lock-step** — a phase is not
done until the docs reflect reality.

Beyond per-function coverage, these are the tests that actually matter:

**B1 — MilestoneReward**
- The contract has exactly one value-moving call. Assert it: a creator cannot
  extract BNB by any route. Try `withdraw`, `selfdestruct`-adjacent paths, a
  malicious `reason` string, reentrancy through `donate`.
- `releaseRewards` from a non-creator reverts. From the creator with
  `amount > balance` reverts. With `amount == 0` reverts.
- On a token with no RewardModule, reverts with `No reward module`.
- After `TaxHandler.renounceManagement()`, releases still work.
- A full-supply holder receives essentially the whole release; an excluded system
  contract (RebateContract) receives nothing.
- `receiveTax` cannot revert and makes no external call, with a real V4 swap
  driving it.

**B2 — Randomness**
- Reveal without a prior commit reverts. A reveal that does not hash to the commit
  reverts. Randomness cannot be fulfilled twice.
- A withheld reveal past the deadline rolls the epoch over rather than freezing it.

**B3 — PrizePool**
- `drawRandomness` before `postRoot` reverts. This ordering is what stops the
  operator grinding the winner; test it explicitly.
- Merkle: a forged leaf fails; a leaf from epoch `e` cannot be replayed at `e+1`.
- Lottery range check: only the ticket whose `[cumBefore, cumBefore+weight)`
  contains `r` is accepted for a given slot. Adjacent tickets rejected. Duplicate
  slot claims rejected. The same account winning two slots is *accepted* — that is
  correct for weighted sampling with replacement, not a bug.
- Every rollover condition in §2.8, verifying no BNB is stranded.
- Epoch math: multi-epoch jumps with no activity; a queued epoch-length change
  applies at the next boundary and can never shorten an epoch in flight.
- Hold requirement: buy, dump, claim reverts. Buy, hold, claim succeeds.
- Swap-path invariant: a full buy/sell cycle with the PrizePool installed cannot
  revert regardless of pot state.

---

## 6. Open decisions — resolve before you build the affected part

Full table with reasoning: `TOKENOMICS_V2.md` §12.

**Settled, do not relitigate:**
- MilestoneReward has **no on-chain milestone gate**. Safety is the destination
  lock. Holder count is not on-chain; market cap is flash-loan manipulable.
- MilestoneReward is **token-creator only**. Not the platform operator.
- PrizePool ticket weight is **BNB spent**, not tokens received. It is available
  where the fee is taken, it is what "share of volume" means, and it cannot be
  gamed via price impact.
- The PrizePool's `ALL_HOLDERS` mode **delegates to the RewardModule**. Do not
  build a second pro-rata accumulator.

**Still open, and they change what you build:**

| # | Question | Recommendation |
|---|---|---|
| 1 | PrizePool `holdRequirementBps` default | `10000` — you must still hold what you bought. This is the anti-snipe lever. |
| 2 | Per-address weight cap in lottery mode | Offer it, default uncapped, document whale dominance |
| 3 | `challengeWindow` after `postRoot` | 6h; must exceed the time to independently recompute a root from public events |
| 4 | Multisig on `Database.owner()` before PrizePool ships | **Recommended.** `rootPoster` and `invalidateRoot` extend a hot deployer EOA's blast radius to prize payouts |
| 5 | Cap `CreatorFeeModule`'s aggregate allocation | Unresolved. A creator can already route 10000 bps to themselves via `proposeModuleUpdate`; this is the real rug lever, and restricting module *adds* does not touch it |

**Closes at mainnet — these cannot be added after the first pool exists:**

| # | Question | Answer |
|---|---|---|
| 6a | Emit `sqrtPriceX96` + `tick` in the hook's `TokenPurchased` / `TokenSold`? | **Leaning yes.** ~2.6k gas/swap, no storage. Lets the subgraph read price from *our hook* rather than indexing the canonical PoolManager for the candle chart. Charts work without it (the V4 `Swap` event already carries both), so it is an optimization — but an unretrofittable one. `TOKENOMICS_V2.md` §13.1. |
| 6b | Store an on-chain price observation for trustless buybacks? | **No.** Only covers our own pool (`convertAndDistribute` swaps externally), a lagged-tick floor either allows sandwiches or bricks burns on a volatile memecoin, and it taxes every trade to protect an occasional keeper action. The operator registry is reversible; the hook is not. §13.2. |
| 7 | Fee ratchet (fees may only decrease)? | **No — settled.** The guarantee it was meant to buy already holds: fees cannot rise without 24h of public on-chain notice. **Build the fee-timelock UI.** Instead, fix §7.6 (below) and consider §7.7. §13.3. |

**Newly found, blocks `deploy:bsc`:**

- 🔴 **`TaxHandler` §7.6** — an instant fee *decrease* does not disarm a pending fee
  *increase*. A creator can arm 98%, instantly drop to 0% so the token page reads
  "0% fees", let people buy, then execute the armed increase 24h later. Every step
  is technically public; no UI shows it. `TaxHandler` is frozen per-token at launch,
  so this must land before the first mainnet token. Not yet fixed.

---

## 7. System-wide status and uncertainties

### Done and verified
- All contracts feature-complete. **211 tests green** from a clean `npm ci`;
  compiles clean on pinned Solidity `0.8.28` / `evmVersion: cancun`.
- `graph codegen` + `graph build` pass.
- `deploy-base.js` + `smoke-launch.js` run end-to-end against a local V4
  PoolManager: BYOL launch, pool seed, buy through the router, volume registered.
- Tokenomics V2 Phase A landed: two trade-bricking bugs fixed, share-exclusion set,
  slippage floors, platform operator registry, `Database.randomnessProvider`.

### Not done — ordered by risk

0. 🔴 **`TaxHandler` §7.6 is unfixed** and freezes at launch. See the decision table
   above. This is the only known correctness defect in the system.
1. **No security audit.** The hook is the centerpiece: it runs on every swap and
   handles up to 98% of swap flow. Prior art to brief the auditor with: Cork
   Protocol (May 2025) and Bunni (Sep 2025), both hook-logic bugs, not V4-core
   failures. Scope must include `LumoriaHook`, `LumoriaLiquidityVault`,
   `VestingVault`, `LumoriaSwapRouter`, `TaxHandler`, `Generator`,
   `RebateContract`, and the CREATE2 deploy/trust chain.
2. **Slither has never been run.** Cheap, unticked.
3. **`npm run coverage` has never been run.** The script exists; we have no
   line/branch numbers, only a test count.
4. **The mainnet branch of `deploy-base.js` has never executed.** It selects the
   canonical PoolManager and periphery on `chainId == 56`. Local and testnet both
   take the other branch. This is the single code path that will spend real BNB
   and the one that has never run. The BSC-fork rehearsal (`LAUNCH.md` §2) is
   blocked only on an archive-capable RPC — free tiers exist. This is a
   fifteen-minute unblock, not a project.
5. **The subgraph has never indexed a real deployment.** It builds; it has never
   run against a chain.
6. **No end-to-end lifecycle rehearsal.** `smoke-launch.js` covers launch → buy.
   Nothing exercises sell → `executeBurn` → `executeLiquidity` → `claimReward` →
   creator `withdraw` → module add/remove timelock → `renounceManagement` in one
   pass, or the FlatCurve lifecycle end to end. The `CreatorFeeModule` bug would
   have been caught on day one by such a script.
7. **`Database.owner()` is a hot deployer EOA.** Multisig deferred. A compromised
   key can repoint `hook` / `router` / `feeReceiver`, and — once the PrizePool
   ships — post fraudulent merkle roots.
8. **The frontend has not been migrated.** See `FRONTEND_MIGRATION_V2.md`. The
   `CreatorFeeModule` ABI change is breaking: creator fees no longer arrive
   automatically, and a Claim button must be built. The UI repo is still mock-data
   driven with no ABIs on disk.
9. **No fuzz or invariant tests.** Worth considering for the fee math (to the wei),
   the "liquidity can never leave" invariant, exactOutput rejection, and
   unattributed swaps still being fully taxed. Hardhat unit/integration only today.
10. **No gas benchmark.** Reward-by-default makes `setShare` fan out to a reward
   module on both sides of every transfer. We have never measured what that costs a
   plain transfer. Benchmark it (0 vs 1 reward module) before committing to
   default-on. `TOKENOMICS_V2.md` §4.0.

### Known accepted risks
- A creator can route 10000 bps of both buy and sell tax to a `CreatorFeeModule`
  they control, behind a 24h timelock. `renounceManagement()` is the counter-story,
  not a restriction on the API. See open decision #5.
- Wash trading is possible against volume-based metrics anywhere they appear, but
  costs the 1% platform fee plus the token's own tax on each leg.
- MilestoneReward funds are unreachable if the creator never presses the button.
  Provably unreachable by *anyone*, including them — idle capital, not counterparty
  risk.

---

## 8. Don'ts (from `CLAUDE.md`, plus what we learned)

- Don't edit anything under `legacy/` — reference only.
- Don't add tax logic to `LumoriaToken.sol`. It is intentionally a clean ERC20; all
  tax logic lives in `LumoriaHook` + `TaxHandler`.
- Don't add a liquidity-removal path anywhere.
- Don't support `exactOutput` swaps in the hook without a full fee-math review.
- Don't change the hook's `getHookPermissions()` without updating
  `LUMORIA_HOOK_FLAGS` in `scripts/lib/hook-miner.js` — the permissions are encoded
  in the low 14 bits of the hook's mined CREATE2 address.
- Don't skip the test suite. If something is genuinely untestable, log it in the
  Blocked table in `TESTING.md` with a `TODO:` stub.
- Don't put a swap, an external call, or a value transfer in `receiveTax()`.
- Don't add `try/catch` around module dispatch.
- Don't give `MilestoneRewardModule` a withdrawal path. Ever.

---

*Keep in lock-step with `TOKENOMICS_V2.md`, `DESIGN.md`, `TESTING.md`, `LAUNCH.md`.*
