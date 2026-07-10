# Lumoria Tokenomics V2 — PrizePool, Milestones, Reward-by-Default

**Status:** Phase A (§7, §4.1, §4.2, §6.2, §6.3) is **implemented and green**.
The **MilestoneRewardModule** (§2B) is **implemented and green** (with one addition
to the original spec: the 18-month public-release valve, §2B.2b). The **PrizePool**
(§2) and the randomness provider (§3) remain **SPEC** — review before building.

> Building these? Start with **[`MODULE_BUILD_HANDOFF.md`](./MODULE_BUILD_HANDOFF.md)**,
> which is the work order, the invariants you must not break, and the open
> decisions. This document is the specification behind it.

This document specifies the next generation of Lumoria tokenomics modules — the
**PrizePool** (module type 4) and the **MilestoneRewardModule** (module type 5) — plus
the supporting changes needed to make reward distribution a default capability of
every launched token.

It also records a set of **pre-existing defects** discovered while designing this
work. They are independent of the PrizePool but must land before mainnet, because
they live in code that is frozen per-token at launch.

> Read [`DESIGN.md`](./DESIGN.md) first — this document assumes its vocabulary
> (Database, TaxHandler, modules, LumoriaHook, master copies, ERC-1167 clones).

---

## 0. TL;DR

- The **PrizePool** rewards *buyers* during an epoch (a day/week/etc.), funded from
  buy tax, sell tax, or both — the creator chooses via the existing per-side
  allocation bps. Two payout modes: **pro-rata** (split by BNB spent) or
  **lottery** (up to 10 weighted winners). A third mode pays **all holders** by
  delegating to the token's RewardModule.
- Tickets are **derived off-chain from the `TokenPurchased` event** the hook
  already emits, and settled on-chain via a **merkle root**. This means the
  PrizePool needs **zero changes** to `LumoriaHook`, `ITaxHandler`, or `IModule`.
- The **MilestoneRewardModule** accrues tax and holds it. The token's creator
  releases it to all holders whenever they choose, at whatever size, with the
  milestone they are claiming recorded as free text on-chain. Its safety comes not
  from gating the button but from the fact that **the only value-moving call in the
  contract targets the RewardModule** — no withdraw, no recipient, no escape hatch.
  Discretion over timing and amount; never over destination (§2B.2). After 18 months
  with no release, anyone may trigger a full-balance release — still only into the
  RewardModule (§2B.2b).
- Because nothing frozen changes, **tokens that have already launched can adopt
  both new modules** via the existing `TaxHandler.proposeModuleAdd`. This is the
  single most important property of the design.
- Three pre-existing defects — a hot-path external swap in `RewardModule`, a
  trade-bricking BNB transfer in `CreatorFeeModule`, and a missing share-exclusion
  set that would strand reflections once reward modules became universal — are
  **fixed** (§7). They lived in code that freezes per-token at launch, so they had
  to land before the first mainnet token.

---

## 1. WHY THIS SHAPE

### 1.1 The constraint that drove the design

Two layers of Lumoria age differently.

**Modules are cheap to change forever.** Register a new master copy via
`Database.setModuleMasterCopy(uint8, address)` and any token — including one
launched a year ago — can adopt it through `proposeModuleAdd`. `TaxHandler`
imposes no enum on module types; it only requires the master copy be non-zero
(`TaxHandler.sol:155`, `:457`).

**`LumoriaHook` and the `TaxHandler` code do not change, ever.** Each token gets
its own `TaxHandler` as an ERC-1167 clone bound to whatever master copy existed
at its launch; changing the master copy only affects future tokens. The hook is
worse: in Uniswap V4 the hook address is part of the `PoolKey`, so it *is* the
pool's identity. A new hook means a new pool — and the old pool's liquidity is
permanently locked in it by design (`ILumoriaLiquidityVault`, no removal path).
Once the first mainnet token has a pool, **the hook is immutable in practice.**

So: any capability that requires new information to flow from the hook into the
module layer must exist *before the first mainnet launch*, or it can never reach
the tokens launched before it.

### 1.2 The information the PrizePool needs, and where it already exists

The four shipped modules only ever needed **money**. `TaxHandler._distribute`
hands them BNB and that is the entire contract between them.

`RewardModule` was the first module that needed to know about **people** — holder
balances. Rather than build a general channel, the system hardwired one:
`LumoriaToken._transferFrom` calls `TaxHandler.setShare` (`LumoriaToken.sol:142`,
`:145`), which forwards only to modules whose type is `0` (`TaxHandler.sol:238`).

The PrizePool is the second module to need people-data, and it needs a *different*
fact: **who bought, and how much, during a window.** That fact exists in the hook
— `_afterSwap` decodes the buyer and already hands it to `RebateContract`
(`LumoriaHook.sol:260`, `:272`) — but it is never passed down. `receiveBuyTax()`
takes no arguments, and its own comment says why: *"Buyer unknown at this level."*

### 1.3 Two ways to close the gap, and why we chose the second

**Option A — on-chain trade channel.** Decode `hookData` in `_beforeSwap`, widen
`ITaxHandler.receiveBuyTax` to `(address buyer, uint256 bnbIn)`, add an `onBuy`
fan-out from `TaxHandler` to subscribing modules (mirroring `setShare`).

Trustless and clean. But it changes the hook, `ITaxHandler`, and `IModule` — all
frozen per §1.1. Every token launched before it ships is permanently excluded.

**Option B — off-chain ticketing, merkle settlement.** ✅ **CHOSEN**

The hook already emits everything required:

```solidity
emit TokenPurchased(token, user, bnbIn, platformFee, tax, tokensOut);
//                         ^^^^  ^^^^^                      ^^^^^^^^^
```

An operator reconstructs the epoch's ticket set from these logs, posts a merkle
root, and winners claim with a proof. The PrizePool receives its BNB through the
existing unchanged `receiveTax()` and buckets it by `block.timestamp`.

| | Option A | Option B |
|---|---|---|
| Changes to hook / `ITaxHandler` / `IModule` | Yes | **None** |
| Adoptable by already-launched tokens | No | **Yes** |
| Works when buy allocation is 0 bps | No¹ | **Yes** |
| Trust assumption | None | Operator posts a verifiable root |
| Ships before mainnet? | Must | Any time |

¹ `_distribute` skips modules whose share rounds to zero (`TaxHandler.sol:213`),
so a PrizePool funded only from *sell* tax would never be called on a buy and
could never record a ticket. Option B is immune — ticketing never touches the
tax path.

The trust cost is real and bounded. A fraudulent root steals one epoch's pot. But
the root is **deterministically derivable from public events**, so anyone can
recompute and verify it independently — which makes a challenge window genuinely
effective, unlike fraud proofs over private data. See §5.

---

## 2. PRIZEPOOL MODULE (Type 4)

### 2.1 Concept

Buyers accumulate tickets during an epoch. At epoch end the accumulated BNB pot
is paid out according to the configured mode.

- **Only buyers earn tickets.** Sellers never do.
- **Either side may fund the pot.** Buy tax, sell tax, both, or neither — set by
  the creator through the existing `buyAllocation` / `sellAllocation` bps on
  `ModuleConfig`. Funding sellers' tax into a buyers' prize is an explicitly
  supported and interesting configuration.
- **Ticket weight is BNB spent** (`bnbIn`, gross, pre-fee) — not tokens received.
  BNB spent is available at the moment the fee is taken, is what "a share of
  volume" means, and cannot be gamed by buying into price impact.
- Buys routed through third-party routers carry no `hookData`, so `user` is
  `address(0)` and they earn **no tickets**. This is a deliberate incentive to
  route through `LumoriaSwapRouter`.

### 2.2 Payout modes

Set at `__init__`, immutable thereafter.

| Mode | Value | Behavior |
|---|---|---|
| `PRO_RATA` | 0 | Pot split across all epoch buyers proportional to BNB spent. |
| `LOTTERY` | 1 | `k` winners (1..10) drawn weighted by BNB spent. Pot split equally among the `k` slots. |
| `ALL_HOLDERS` | 2 | Pot forwarded to the token's RewardModule via `donate()`. Reaches every non-excluded holder, not just buyers. |

`ALL_HOLDERS` requires a RewardModule that implements `donate()` (§4). If none is
found on the token at settlement, the pot **rolls over** rather than reverting.

### 2.3 Epoch model

Epochs are derived from timestamps, not advanced by a keeper. A keeper outage
makes settlement *late*, never *wrong*.

```solidity
uint256 public epochLength;         // seconds
uint256 public pendingEpochLength;  // 0 = none queued
uint256 public currentEpochId;
uint256 public currentEpochStart;

function _advance() internal {
    uint256 len = epochLength;
    if (block.timestamp < currentEpochStart + len) return;
    uint256 n = (block.timestamp - currentEpochStart) / len;
    currentEpochId   += n;
    currentEpochStart += n * len;
    if (pendingEpochLength != 0) {
        epochLength = pendingEpochLength;
        pendingEpochLength = 0;
        emit EpochLengthApplied(currentEpochId, epochLength);
    }
}
```

`_advance()` runs at the top of `receiveTax()` and every settlement entry point.
It is O(1), performs no external calls, and cannot revert. Epochs skipped because
no tax arrived were necessarily empty, so the multi-epoch jump loses nothing.

**Epoch length is changeable, safely.** `setEpochLength(uint256)` is creator-only
and queues `pendingEpochLength`, which takes effect at the **next boundary**. It
can never shorten or lengthen an epoch already in flight — that would let a
creator move the settlement goalposts after seeing the ticket set. Bounds:
`MIN_EPOCH = 1 hours`, `MAX_EPOCH = 30 days`. No timelock: cadence is not
economics, matching `BurnModule.setInterval` precedent.

### 2.4 Funding

```solidity
function receiveTax() external payable override {
    require(msg.sender == taxHandler, "Only taxHandler");
    _advance();
    epochPot[currentEpochId] += msg.value;
    emit TaxReceived(currentEpochId, msg.value);
}
```

No external calls. No value out. Two SSTOREs and an event. This satisfies the
swap-path invariant (§6.1).

### 2.5 Ticketing (off-chain, verifiable)

For epoch `e`, a ticket is emitted for every `TokenPurchased` log where:

- `token == address(this).token`
- `user != address(0)`
- the log's block timestamp falls in `[epochStart(e), epochStart(e) + length(e))`

Tickets are **append-only and never merged** — a buyer with three buys has three
tickets. This keeps cumulative weights monotonic, which is what makes the lottery
proof O(1).

```
ticket[i] = { index: i, account, weight: bnbIn, tokensBought: tokensOut, cumBefore }
cumBefore[0] = 0
cumBefore[i] = cumBefore[i-1] + weight[i-1]
totalWeight  = cumBefore[n-1] + weight[n-1]
```

**Optional weight cap.** If `maxWeightBps != 0`, a single account's total weight
is capped at `maxWeightBps` of `totalWeight`, computed off-chain and committed in
the root. This bounds whale dominance in `LOTTERY` mode, where weighting by BNB
otherwise lets a whale simply buy the odds.

### 2.6 Settlement — ordered so the operator cannot grind

The ordering is load-bearing. **The root is committed before randomness exists.**

**Phase 1 — `postRoot(epochId, root, totalWeight, ticketCount)`**
Callable once per epoch, only after the epoch has ended, only by `rootPoster`.
Rejects if the epoch has already been settled.

**Phase 2 — `drawRandomness(epochId)`** *(LOTTERY only)*
Requires `roots[epochId] != 0`. Calls `IRandomnessProvider.requestRandomness`.
The provider calls back `fulfillRandomness(epochId, word)`.

**Phase 3 — claims.** Permissionless, pull-based, O(1) each.

`PRO_RATA` and `ALL_HOLDERS` skip Phase 2 entirely.

### 2.7 Claims

**Pro-rata.** Leaf: `keccak256(abi.encode(account, weight, tokensBought))`.

```solidity
function claim(uint256 epochId, uint256 weight, uint256 tokensBought, bytes32[] calldata proof)
```

Verifies the proof, enforces the hold requirement (below), pays
`epochPot[e] * weight / totalWeight[e]`, and marks `claimed[e][msg.sender]`.

**Lottery.** Leaf: `keccak256(abi.encode(index, account, weight, cumBefore, tokensBought))`.

```solidity
function claimLottery(
    uint256 epochId, uint256 slot,
    uint256 index, uint256 weight, uint256 cumBefore, uint256 tokensBought,
    bytes32[] calldata proof
)
```

On-chain the contract recomputes `r = uint256(keccak256(abi.encode(randomWord[e], slot))) % totalWeight[e]`
and requires `cumBefore <= r < cumBefore + weight`. That single range check, plus
the merkle proof, proves the claimant owns the winning ticket. No scanning, no
stored ticket array.

A slot can only be claimed once. The *same account* may win multiple slots — that
is correct behavior for weighted sampling with replacement, and it is not a bug.

**Hold requirement (anti-snipe).** `holdRequirementBps`, set at init:

```solidity
if (holdRequirementBps != 0) {
    uint256 required = (tokensBought * holdRequirementBps) / BPS;
    require(IERC20(token).balanceOf(msg.sender) >= required, "Sold before claim");
}
```

`10000` means "still holds everything you bought." `0` disables it. This is the
lever that stops buying in the last block of an epoch and dumping in the next.
It carries a real cost — a buyer who moved tokens to a cold wallet cannot claim —
so it is a creator decision, not a default we impose silently. **Recommended
default: `10000`.**

### 2.8 Rollover

The pot rolls into `epochId + 1`, rather than reverting or stranding, whenever:

- `totalWeight == 0` (nobody bought)
- `epochPot[e] < minPot`
- `ticketCount < minParticipants`
- `ALL_HOLDERS` mode and no RewardModule with `donate()` exists on the token
- randomness was never fulfilled before `randomnessDeadline` (§5.2)
- the claim window elapsed with slots or shares unclaimed

Rolling over on missing randomness is deliberate: a weak fallback source is worse
than a delayed prize.

### 2.9 Settle bounty

`settleBountyBps` (0..500) of the pot is paid to whoever calls `postRoot`, and to
whoever triggers `drawRandomness`. This removes the dependency on our own operator
staying alive — the same reasoning that makes `executeBurn` and `executeLiquidity`
permissionless today.

### 2.10 Init payload

```solidity
abi.decode(payload, (
    address token,
    address database,
    uint8   payoutMode,          // 0 PRO_RATA | 1 LOTTERY | 2 ALL_HOLDERS
    uint256 epochLength,         // MIN_EPOCH..MAX_EPOCH
    uint8   winnerCount,         // 1..10, LOTTERY only
    uint256 holdRequirementBps,  // 0..10000
    uint256 maxWeightBps,        // 0 = uncapped
    uint256 minPot,
    uint256 minParticipants,
    uint256 settleBountyBps,     // 0..500
    address rootPoster
))
```

`taxHandler` is inferred from `msg.sender`, per the established convention.

### 2.11 Events

```solidity
event TaxReceived(uint256 indexed epochId, uint256 amount);
event EpochLengthQueued(uint256 newLength);
event EpochLengthApplied(uint256 indexed epochId, uint256 newLength);
event RootPosted(uint256 indexed epochId, bytes32 root, uint256 totalWeight, uint256 ticketCount);
event RandomnessRequested(uint256 indexed epochId, uint256 requestId);
event RandomnessFulfilled(uint256 indexed epochId, uint256 randomWord);
event PrizeClaimed(uint256 indexed epochId, address indexed account, uint256 amount);
event LotteryClaimed(uint256 indexed epochId, uint256 indexed slot, address indexed winner, uint256 amount);
event PotRolledOver(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount, string reason);
event DonatedToRewards(uint256 indexed epochId, address rewardModule, uint256 amount);
```

---

## 2B. MILESTONE REWARD MODULE (Type 5)

**Status:** ✅ Implemented (`contracts/modules/MilestoneRewardModule.sol`), tested
(`test/modules/MilestoneRewardModule.test.js`), subgraph template shipped. The
18-month public-release valve (§2B.2b) was added to the original spec during the
build, per the module work order.

### 2B.1 Concept

Accrues tax BNB and holds it. The team releases it to **all holders**, in whatever
amount and at whatever moment they choose, typically on hitting a milestone they
announce (holder count, market cap, a listing, a product launch — anything). The
stated reason is recorded on-chain in the release event.

There is **no on-chain milestone check.** The button is entirely at the creator's
discretion: early, late, partial, or never.

### 2B.2 Where the safety actually comes from

Not from gating the button. From the destination:

> **The only code path that moves BNB out of this contract sends it to the token's
> RewardModule, which pays every non-excluded holder pro-rata.** There is no
> `withdraw`, no `recipient`, no `sweep`, no owner escape hatch, no admin
> function. The creator's discretion is over *timing and amount* — never over
> *destination*.

A creator who decides they want this BNB cannot have it. The worst they can do is
never press the button — and even that is now bounded by the 18-month valve
(§2B.2b): the funds sit visibly on-chain, unreachable by anyone *as personal
funds*, and eventually releasable to holders by anyone at all.

That is a stronger guarantee than an on-chain milestone gate would have delivered,
and it is trivially auditable: **verify that the contract contains exactly one
value-moving call, and that its target is the RewardModule.** Everything else is
bookkeeping. (The test suite pins this as an ABI allowlist — any new external
function fails the "destination lock" test until reviewed against this section.)

### 2B.2b The 18-month public-release valve

The original spec accepted stranding: a creator who never presses the button
leaves the BNB idle forever. That posture is now bounded:

> **If no release has happened for 18 months (540 days), `publicRelease()` opens
> to anyone.** It releases the ENTIRE balance — full, not partial — still only
> into the RewardModule. Any release, creator or public, restarts the clock.

Design notes, in case they come up in review:

- The clock starts at `__init__` and is reset by **every** release. A creator who
  releases even occasionally keeps the button theirs indefinitely — the valve only
  opens on genuine abandonment.
- The public path releases the **full balance** deliberately. If it accepted an
  amount, a hostile caller could release 1 wei, reset the clock, and keep the
  remainder locked for another 18 months. All-or-nothing removes the grief.
- The public caller gains nothing: destination is still not a parameter, and the
  release event records `by`, so the subgraph can distinguish a creator release
  from a valve release. The valve's fixed on-chain `reason` is
  `"18-month public release"`.
- `publicRelease` on an empty module reverts (`Bad amount`) rather than resetting
  the clock — an empty release must not push the next real one out 18 months.
- The valve turns "idle capital, forever" into "holders eventually get paid".
  The UI should surface `publicReleaseAt()` next to the accrued balance.

> Worth knowing why we did *not* gate on metrics, in case it comes up in the audit:
> the two milestones people actually care about cannot be enforced. Holder count is
> not on-chain at all (the subgraph derives it by replaying `Transfer`s, and dusting
> ten thousand wallets costs only gas). Market cap needs a spot price, which is
> flash-loan manipulable inside a single transaction. A gate on either would have
> been theatre. The destination lock is real.

### 2B.3 Interface

```solidity
/// Runs inside the V4 swap callback. Accrues only. See §6.1.
function receiveTax() external payable;

/// CREATOR ONLY. Sends `amount` to the token's RewardModule, which distributes it
/// pro-rata to every non-excluded holder. `reason` is free text, recorded in the
/// event as the team's public claim about which milestone was hit.
///
/// This is the ONLY function in the contract that moves value, and its
/// destination is not a parameter.
function releaseRewards(uint256 amount, string calldata reason) external;

/// ANYONE, but only after 18 months with no release (§2B.2b). Releases the
/// ENTIRE balance into the RewardModule and restarts the clock.
function publicRelease() external;
```

That is the entire external surface, plus `getModuleType()` / `getStats()` and the
views (`totalAccrued`, `totalReleased`, `lastReleaseTime`, `publicReleaseAt`).

Checks in `releaseRewards`:

```
msg.sender == ITaxHandler(taxHandler).creator()      // "Only creator"
amount > 0 && amount <= address(this).balance        // "Bad amount"
rewardModule != address(0)                           // "No reward module"
```

Partial releases are the norm — "we hit 1,000 holders, releasing 20%" is just
`releaseRewards(balance / 5, "1000 holders")`. Milestones live in the `reason`
string and in the team's announcements, not in `require` statements.

### 2B.4 Resolving the RewardModule

At release time (not at init — the module set can change), walk the TaxHandler:

```solidity
uint256 n = ITaxHandler(taxHandler).getModuleCount();
for (uint256 i; i < n; ++i) {
    ModuleConfig memory m = ITaxHandler(taxHandler).getModule(i);
    if (m.moduleType == MODULE_REWARD) return m.moduleAddress;   // first match
}
revert("No reward module");
```

Bounded by `MAX_MODULES = 10`. Then `IRewardModule(rm).donate{value: amount}()`.

This is why `donate()` was added in §4.1, and it is the concrete reason
**reward-by-default matters**: a MilestoneRewardModule on a token with no
RewardModule can never release. The launch wizard must pair them, and §4.3's
exclusion set must be in place or the released BNB partly accrues to system
contracts that can never claim it.

Note `donate()` behaves correctly in both reward modes: BNB mode distributes
immediately once `minDistribution` is met; token mode accrues until the next
`convertAndDistribute`. Neither can revert the release.

### 2B.5 Init payload

```solidity
abi.decode(payload, (address token))
```

`taxHandler` is inferred from `msg.sender`; `creator` is read live from
`ITaxHandler(taxHandler).creator()`, which is immutable. Nothing else is needed —
the module has no configuration, which is precisely why it has no attack surface.

### 2B.6 Events

```solidity
event TaxReceived(uint256 amount, uint256 totalAccrued);
event RewardsReleased(
    address indexed by,
    address indexed rewardModule,
    uint256 amount,
    uint256 remaining,
    string  reason
);
```

`reason` is the team's on-chain, timestamped, immutable claim about what they
achieved. The subgraph should surface it verbatim on the token page next to the
amount — it is the accountability record.

### 2B.7 Security notes

- `receiveTax` accrues and emits. Nothing else. §6.1 applies without exception.
- **No swap anywhere**, therefore no operator gate and no slippage floor (§6.3).
- **No withdrawal path of any kind.** This is the load-bearing property. Any future
  change that adds one destroys the module's entire guarantee.
- `nonReentrant` on `releaseRewards` and `publicRelease` (they make an external
  call to `donate`).
- `TaxHandler.renounceManagement()` does not disable releases — `creator` is
  immutable. A renounced token with this module is *more* trustworthy: tokenomics
  frozen, funds still only reachable by holders.
- **Stranding is bounded, not accepted.** A creator who never presses the button
  leaves the BNB idle for at most 18 months, after which anyone can push it to
  holders (§2B.2b). Still mitigate in the UI: show accrued-but-unreleased BNB and
  `publicReleaseAt()` prominently on the token page.

### 2B.8 `getStats()`

```solidity
abi.encode(totalAccrued, totalReleased, address(this).balance, lastReleaseTime)
```

---

## 3. RANDOMNESS

### 3.1 Why not a Chainlink consumer per token

A VRF subscription per token is untenable across hundreds of tokens — both the
LINK cost and the operational burden of funding and managing each one.

The fix is to stop putting randomness in the module. Put it behind an interface
and register **one platform-level provider** in the `Database`, exactly as `hook`,
`router`, and `feeReceiver` already are:

```solidity
interface IRandomnessProvider {
    function requestRandomness(bytes32 requestKey) external returns (uint256 requestId);
}
interface IRandomnessConsumer {
    function fulfillRandomness(bytes32 requestKey, uint256 randomWord) external;
}
```

`Database.randomnessProvider` + `setRandomnessProvider(address)` (owner-only).
Modules resolve it **at settlement time**, so swapping the implementation is
instant and global, and no deployed module or token needs to change.

> `Database` is a singleton deployed once. Adding this field is free **now** and
> impossible later without redeploying the registry and losing `isLumoriaToken`.
> It must land pre-mainnet even though the PrizePool itself need not.

### 3.2 `TrustedOperatorRandomness` — the v1 implementation

A bare "backend posts a number" is not randomness; the operator sees the ticket
set and can pick the winner. Commit–reveal with blockhash mixing costs nothing
extra and closes that:

1. **Commit** — at or before the start of epoch `e`, the operator submits
   `seedHash = keccak256(seed)`. The seed is fixed before any buys are known.
2. **Reveal** — at settlement, the operator submits `seed`. The contract checks
   `keccak256(seed) == seedHash` and computes
   `word = keccak256(abi.encode(seed, blockhash(block.number - 1)))`.

The operator cannot grind the winner at reveal time (the seed is committed) and
cannot precompute it at buy time (the future blockhash is unknown). If the reveal
never arrives before `randomnessDeadline`, the epoch **rolls over** — a withheld
reveal delays a prize, it does not freeze or steal one.

Residual risk: BSC validators have some influence over `blockhash`. This is
acceptable for a closed beta with capped exposure, must be disclosed, and
disappears entirely when the provider is swapped for VRF. **This is the one place
in the system where a trusted party can affect who gets paid.** Say so publicly.

### 3.3 Other implementations

- `MockRandomness` — instant deterministic fulfillment, for the Hardhat suite.
- `ChainlinkVRFRandomness` — one subscription for the whole platform. Drop-in via
  `Database.setRandomnessProvider`. No module changes.

---

## 4. REWARD-BY-DEFAULT

The goal: every project ships with a RewardModule so that *any* module — the
PrizePool's `ALL_HOLDERS` mode, or anything built later — can pay every holder
without reimplementing pro-rata accounting.

This works today (a 0-bps module is legal and `_distribute` skips zero shares),
but three things must land first.

### 4.0 How a distribution actually reaches 10,000 holders

It never iterates them. Confirming the structure, because it is the thing that
makes reward-by-default affordable at all.

`RewardModule` is a classic **dividends-per-share accumulator**. A distribution is
one storage write, and it costs exactly the same for 10 holders as for 100,000:

```solidity
dividendsPerShare += (amount * PRECISION) / totalSharesTracked;   // PRECISION = 1e36
```

Each holder carries a checkpoint of where that accumulator stood the last time
their position was reconciled:

```solidity
// _crystallize(holder) — called on every share change, and on claim
live = shares[holder] * (dividendsPerShare - dividendCheckpoint[holder]) / PRECISION;
creditedDividends[holder] += live;
dividendCheckpoint[holder] = dividendsPerShare;
```

Crystallization is *lazy*. It happens when the holder's balance changes (the token
calls `setShare` on both sides of every transfer) or when they claim. It has to:
once a holder's share changes, the accumulator can no longer reconstruct what they
were owed at the old balance.

Payout is **pull**. `claimReward()` sends `credited − withdrawn` to `msg.sender`,
who pays their own gas. **BNB is never pushed to a list of holders** — that is
impossible at scale and one bad recipient would revert the batch.

So the whole flow is: tax arrives → `dividendsPerShare` moves once → every holder's
entitlement is implicitly updated → each holder claims when they feel like it.
`MilestoneRewardModule.releaseRewards` and the PrizePool's `ALL_HOLDERS` mode both
just call `donate()`, which lands in the same accumulator. Nothing loops.

**Precision.** The integer division discards a remainder. With `PRECISION = 1e36`
and `totalSharesTracked ≈ 1e27` (1B tokens × 1e18), the un-credited residue per
distribution is below `1e-9` wei, and each holder's own floor division loses under
1 wei. Across 100k holders that is ~`1e5` wei — about `1e-13` BNB. Negligible, but
it does accumulate as unclaimable dust in the module. Not worth engineering around.

**One correction worth making.** Holder share tracking does **not** depend on a
RewardModule existing. `TaxHandler` maintains `_shares[holder]` and `_totalShares`
for *every* token, fed by `setShare` on every transfer, whether or not any module
consumes it. And holder *lists* come from the subgraph indexing `Transfer`, not
from any contract. So "we need a RewardModule to track holders" isn't the reason —
the tracking is already there.

The real reasons for reward-by-default are narrower and still good:

1. **A distribution sink that always exists.** Any module — Milestone, PrizePool,
   anything built later — can `donate()` and reach every holder, with no
   per-token check for whether the plumbing is present.
2. **No `sync()` backfill.** A RewardModule added *after* launch starts blind
   (`setShare` only fires on transfer), so pre-existing holders must be backfilled.
   A module present from block zero never has that problem.
3. **`MilestoneRewardModule` cannot function without one.** It has exactly one
   value-moving call and its destination is the RewardModule (§2B.4).

**What it costs.** A RewardModule present on every token means `setShare` fans out
to it on *both sides of every transfer*, each fan-out doing a `_crystallize` plus a
share update — several storage writes per transfer that a plain ERC20 wouldn't pay.
In the steady state (no distribution since the holder's last checkpoint) the
checkpoint SSTORE rewrites the same value and is cheap, so this is less bad than it
first looks. **We have never measured it.** Before shipping reward-by-default, add
a gas benchmark for `transfer` with 0 / 1 reward modules attached — `npm run
coverage` and a gas reporter have both never been run (§7 of
`MODULE_BUILD_HANDOFF.md`).

### 4.1 `RewardModule.donate()`

`receiveTax()` is `onlyTaxHandler`, so nothing else can fund rewards. Add:

```solidity
function donate() external payable nonReentrant {
    if (rewardToken == address(0)) pendingBNB += msg.value;
    emit Donated(msg.sender, msg.value);
}
```

Permissionless. Useful well beyond the PrizePool — anyone can top up a token's
reward pool.

### 4.2 `RewardModule.sync(address[] holders)`

**A RewardModule added after launch starts blind.** `setShare` only fires on
transfer, so a newly-added reward module has `totalSharesTracked == 0` and only
learns about a holder when they next move tokens. Existing holders would be
silently excluded from every distribution until they happen to transact.

```solidity
function sync(address[] calldata holders) external {
    for (uint256 i; i < holders.length; ++i) {
        _crystallize(holders[i]);
        uint256 bal = IERC20(token).balanceOf(holders[i]);
        // ... update shares/totalSharesTracked, skipping excluded addresses
    }
}
```

Permissionless and self-verifying — it reads `balanceOf` directly, so a caller
supplying a bogus list cannot inflate anyone's share. Holder lists come from the
subgraph. This is required for *any* reward module adopted via `proposeModuleAdd`,
not just for the PrizePool.

### 4.3 Share-exclusion set — **required, and it is a `TaxHandler` change**

Today exactly two addresses are excluded from share tracking: the pair/PoolManager
(`LumoriaToken.sol:141-145`) and the VestingVault (`TaxHandler.sol:227`).

The moment a RewardModule ships on every token, these begin accruing reflections
that **can never be claimed**:

| Address | Holds | Why it strands |
|---|---|---|
| `RebateContract` | per-token `fundedBalance` (`RebateContract.sol:94`) | Persistent, potentially large. No claim path. |
| `FlatCurve` | unclaimed presale tokens until each contributor calls claim (`FlatCurve.sol:242`) | Live once `launch()` seeds the pool and trading begins. Anything never claimed strands forever. |
| `LiquidityModule` | token dust left between rounds, by design | Small, permanent. |
| module clones generally | transient mid-tx balances | Harmless today, but free to exclude and safer. |

Proposed: a `mapping(address => bool) _excludedFromShares` on `TaxHandler`,
checked in `setShare` alongside the existing vault check.

- `rebateContract` — known at `__init__`, cache it like `_vestingVault`.
- module clones — mark in `__init__` and `_executeAdd` as they are created.
- `FlatCurve` — **not knowable at `TaxHandler.__init__`**, because the Generator
  clones it afterwards. Needs `excludeFromShares(address)` callable once by
  `IDatabase(database).generator()`, invoked from `_launchFlatCurve`.

`lib/EnumerableSet.sol` is already in the repo, unused, kept "for future use"
per `LAUNCH.md`. A plain mapping plus an `ExcludedFromShares` event is sufficient
unless the subgraph needs to enumerate; prefer the mapping.

> This is a `TaxHandler` change, therefore frozen per-token at launch (§1.1).
> **It must land before the first mainnet token, or those tokens can never have
> correct reward-by-default accounting.**

---

## 5. OPERATOR MODEL

Not everything needs to be atomic. Three things run off-chain:

| Job | Trigger | Trust | Failure mode |
|---|---|---|---|
| Commit randomness seed | epoch start | operator | epoch rolls over |
| Post merkle root | epoch end | operator (`rootPoster`) | epoch unsettled until posted |
| Reveal seed / draw | after root | operator, anyone after bounty | epoch rolls over |
| Claim | anytime in window | none (permissionless, pull) | — |

**The root is the trust boundary.** It is derived deterministically from public
`TokenPurchased` logs, so any third party can recompute it and detect a
fraudulent one. For v1:

- `rootPoster` is a platform-controlled address.
- A `challengeWindow` (suggested 6h) elapses between `postRoot` and the first
  claim, during which `Database.owner()` may `invalidateRoot(epochId)` — which
  rolls the pot over rather than paying out.

This is *verifiable*, not *enforced*. A bonded fraud-proof game is the natural
v2, and Option A (§1.3) is the trustless end state if it is ever worth the
frozen-layer cost. Document the posture honestly in user-facing material.

**Note the admin-key dependency.** Per `LAUNCH.md §3`, `Database.owner()` is a hot
deployer EOA today, and multisig is deferred. `rootPoster` and `invalidateRoot`
extend that key's blast radius to prize payouts. Consider bringing the multisig
forward before the PrizePool ships, independent of the beta.

---

## 6. INVARIANTS

### 6.1 Nothing in the swap path transfers value or calls out

`TaxHandler._distribute` (`TaxHandler.sol:198`) runs inside the `PoolManager`
unlock callback, with **no try/catch and no gas cap** anywhere on the path from
`LumoriaHook._forward` (`:332`) down. A module that reverts bricks all trading for
that token.

**`try/catch` is the wrong fix and must not be added.** The 63/64 rule lets a
caller supply exactly enough gas that the module sub-call OOGs while the outer
transaction survives — the catch swallows it and the trade succeeds with the tax
silently skipped. That converts a loud failure into a quiet theft.

The correct fix is the invariant: **`receiveTax()` may only accrue state and emit
events.** No value out, no external calls, no unbounded loops. It is stated
normatively in the `IModule` natspec and enforced by review.

> A `gasleft()` floor was considered and deliberately **not** added. A floor only
> earns its keep alongside `try/catch`, where it defends against the OOG-grief
> above. Without `try/catch`, an out-of-gas sub-call simply reverts the whole
> transaction — loud, not silent — so a floor would add hot-path cost to defend
> against nothing.

Claims are always pull-based; the forgiving `.call` pattern belongs only on the
withdrawal side, where a failure harms only the caller.

Two modules violated this. Both are fixed — see §7.1 and §7.2.

### 6.2 No module swap runs with a zero slippage floor, and none runs inline

Three modules swap: `BurnModule` (buyback), `LiquidityModule` (auto-LP), and
`RewardModule` in token mode. All three previously passed `amountOutMin = 0` —
a standing invitation to sandwich the module's own trade.

Two rules now hold:

1. **Swaps never execute inside a trade.** `receiveTax()` accrues; a separate
   transaction does the work. `RewardModule` was the last violator (§7.1).
2. **Swaps take a caller-supplied floor and deadline**, and the floor must be
   non-zero wherever a swap actually happens. The router's own `amountOutMin`
   check is not trusted alone — each module re-verifies against its measured
   balance delta, because the external router is outside this system.

**Why a caller-supplied floor is not enough on its own.** `executeBurn` spends the
*module's* accumulated BNB, not the caller's. An arbitrary caller therefore has no
incentive to pick a good floor — they pass 1 wei, sandwich their own call, and
keep the difference. `require(minOut > 0)` guards against an honest keeper being
lazy; it is not a defence against an adversary. Flash loans make any
in-transaction spot-price check useless for the same reason.

That leaves exactly two ways to bound the swap on-chain: **trust the caller** (an
operator allowlist, floor computed off-chain) or **derive the floor from a
manipulation-resistant reference** (an oracle). V4 pools have no built-in oracle;
the only place to put one is `LumoriaHook`, whose address is baked into every
`PoolKey` and therefore cannot change after the first pool exists. See §12 #8.

We chose the allowlist. Execution authority lives in a **platform-wide operator
registry on the `Database`** — never a per-token setting, because a token creator
appointing their own executor gains nothing and adds a trust surface:

```
Database.isOperator(address)   // owner-managed
Database.operatorCount()

_requireExecutor(readyAt):
    if (operatorCount == 0)      return;   // permissionless by default
    if (isOperator(msg.sender))  return;   // Lumoria backend, immediately
    require(block.timestamp >= readyAt + PUBLIC_FALLBACK_DELAY);  // 1h liveness valve
```

Three consequences worth stating plainly:

- **The system is permissionless until we switch the backend on.** With no
  operators registered, every module action behaves exactly as it did before.
- **Registering the first operator is a system-wide flip**, in one owner
  transaction, affecting every token at once. Revoking the last one flips it back.
- **An absent backend delays a burn; it never strands the BNB.** After the
  fallback delay anyone may execute. Exposure to a sandwich therefore exists only
  during a backend outage, and is bounded by the module's interval.

`RewardModule` in token mode swaps on an **external** router (e.g. PancakeSwap),
where our hook never runs. No on-chain price reference can ever exist for it, so
it is gated by the same registry regardless of what we do about an oracle.

**Why the loop is bounded.** A module's buyback re-enters this token's tax path —
the hook taxes every swap, including ours — routing a slice of the buy tax back
into that module's `receiveTax()`. It terminates one level deep precisely because
`receiveTax()` only accrues. The IModule invariant is not merely a gas nicety; it
is what makes module-initiated swaps safe. This is covered by a test that asserts
`BurnExecuted` and `TaxReceived` both fire in one `executeBurn`.

For the same reason `RewardModule.receiveTax` carries **no** reentrancy guard: a
guard there would revert whenever a module-initiated swap re-entered the tax path.
It is safe unguarded because its only caller is the TaxHandler, whose
`receiveBuyTax`/`receiveSellTax` are themselves `nonReentrant`. Relatedly, a token
may not reward itself (`rewardToken == token` is rejected at init) — that swap
would re-enter this module mid-distribution.

### 6.3 Permission taxonomy — only swaps are gated

The operator registry exists for exactly one reason: a swap spends the *module's*
BNB, so its slippage floor cannot be trusted from an arbitrary caller. **Nothing
else is gated.** Work that merely costs gas to churn — crystallizing dividends,
syncing shares, claiming, donating — stays permissionless forever, whether or not
operators are registered.

Where a function would otherwise mix the two, it is **split**, so the permission
boundary is legible from the ABI rather than buried in a branch:

| Caller | Can call |
|---|---|
| **Token creator only** | `TaxHandler.proposeFeeChange` / `execute` / `cancel`, `proposeModuleAdd`/`Remove`/`Update`, `renounceManagement`; `BurnModule.setInterval`; `LiquidityModule.setInterval`; `RebateContract.fundRebate` / `withdraw` |
| **Fee recipient only** | `CreatorFeeModule.setRecipient` |
| **Platform owner only** | `Database.setOperator`, `setRandomnessProvider`, all `set*MasterCopy` / infra setters, `setPlatformFeeBps` |
| **Anyone, always** | `RewardModule.processRewards` · `donate` · `sync` · `claimReward` · `CreatorFeeModule.withdraw` (own balance) · `FlatCurve.contribute` / `claim` / `refund` · `VestingVault.release` · *(planned)* `PrizePool` claims |
| **Operator-gated, public after 1h** | `BurnModule.executeBurn` · `LiquidityModule.executeLiquidity` · `RewardModule.convertAndDistribute` — **the three that swap, and only those** |
| *(planned)* **Operator only** | `PrizePool.postRoot` · randomness reveal — trusted attestation, not a swap. See §5 |

Note where `MilestoneRewardModule.releaseRewards` lands: **token creator only.** It
never swaps, so it takes no operator gate and no slippage floor. It is creator-gated
purely to give the team discretion over *when* — and it is safe to hand them that
discretion because the destination is not a parameter (§2B.2). The platform operator
has no role in this module at all.

`RewardModule` shows the split concretely:

```solidity
function processRewards() external;                      // no swap → permissionless, forever
function convertAndDistribute(uint256 minOut, uint256 deadline) external;  // swaps → gated
```

Each reverts if called in the wrong mode, so neither can silently no-op. A
BNB-mode module has no reachable gated function at all: its distribution is pure
accumulator arithmetic, and `receiveTax` already performs it inline.

### 6.4 Allocation sum

Unchanged: buy and sell allocations each sum to exactly 10000 bps across active
modules, enforced at propose and execute time. Adding the PrizePool to a live
token means rebalancing existing modules down, atomically, via the `rebalance`
array on `proposeModuleAdd`.

### 6.5 Module slot budget

`MAX_MODULES = 10`, and the allocation sums must hit exactly 10000 bps on each
side. A token running reward-by-default + creator fee + burn + auto-LP + PrizePool
+ MilestoneRewardModule is already at six. Multiple `CreatorFeeModule` instances (the
canonical "team + marketing + treasury" split) eat the rest quickly. Worth
surfacing the remaining slot count in the launch wizard.

---

## 7. PRE-MAINNET PREREQUISITES

Defects in code that freezes per-token at launch. They exist whether or not the
PrizePool is ever built, and none can be fixed for a token after it launches.

**All of §7.1–§7.7 are ✅ shipped**, with regression coverage in
`test/TokenomicsV2.test.js` and `test/TaxHandler.test.js`. **217 tests green.**

### 7.1 `RewardModule` performed an external swap inside the swap callback ✅

`receiveTax()` called `_tryDistribute()` unconditionally. In **token mode**
(`rewardToken != address(0)`) that performed an external router swap — inside the
V4 swap callback, charged to whichever trader happened to buy. It reverted their
trade if the external pair was thin or missing, and priced arbitrary gas onto
every buy.

**Fixed:** `receiveTax()` distributes only in BNB mode, which is a pure
accumulator update with no external calls. Token mode accrues and defers the swap
to `convertAndDistribute(minRewardOut, deadline)` (§6.3).

*Regression:* a token-mode module pointed at a `RevertingRouter` must still accept
`receiveBuyTax`; only the keeper's `convertAndDistribute()` fails.

### 7.2 `CreatorFeeModule` could brick every trade ✅

`receiveTax()` forwarded BNB via `TransferHelper.safeTransferETH`, which does
`require(success)` (`TransferHelper.sol:48`). A fee recipient that was a contract
without a payable `receive()` **reverted every single trade of that token.**

**Fixed:** accrue-and-pull. `receiveTax()` credits `owed[recipient]`; the
recipient calls `withdraw()`. Balances are keyed by account, so rotating the
recipient never strands the previous one's accrual.

> ⚠️ **Breaking ABI change.** `TaxForwarded(recipient, amount)` is replaced by
> `TaxAccrued(recipient, amount, owedAfter)` + `TaxWithdrawn(recipient, amount)`.
> `totalPaid` now means *withdrawn*; `totalAccrued` means *earned*. Clients must
> call `withdraw()` — fees no longer arrive unprompted. Subgraph and
> `FRONTEND.md` updated accordingly.

*Regression:* a `RejectingRecipient` (no `receive()`) must not revert `receiveTax`.

### 7.3 Share-exclusion set ✅

Implemented as `TaxHandler._excludedFromShares` + `isExcludedFromShares(address)`.
Populated at `__init__` with the VestingVault, RebateContract and LiquidityVault;
extended with every module clone as it is created (including via
`_executeAdd`); and extended once by the Generator with the token's FlatCurve,
before that FlatCurve receives any tokens. `excludeFromShares` is **generator-only**
— an owner able to exclude arbitrary holders could zero anyone's rewards.

Excluding an address that already holds shares zeroes them and propagates the
zero to every reward module, so exclusion is safe to apply late.

### 7.4 `Database.randomnessProvider` ✅

Added with an owner-gated `setRandomnessProvider` and `RandomnessProviderUpdated`.
Left unset (`address(0)`) by `deploy-base.js` until a provider exists — no module
reads it yet.

### 7.5 Dust-sweep rule interacted badly with 0-bps modules ✅

`_distribute` gave the **last** module the full remainder. A 0-bps module sitting
last — the natural configuration for a default RewardModule funded only by
donations — silently collected it.

**Fixed:** shares are computed into memory first (one storage read per module),
and the remainder is swept to the last module with a **non-zero** allocation on
that side. The `sum == 10000` invariant guarantees one exists.

---

### 7.6 An instant fee decrease did not disarm a pending fee increase ✅

`proposeFeeChange` has two paths. If **both** fees are decreasing (or unchanged) it
applies them immediately and `return`s — on the sound reasoning that a decrease can
never harm a holder. Otherwise it arms `pendingFeeChange` behind the 24h timelock.

The instant path **returns without touching `pendingFeeChange`.** A previously
armed increase therefore survives, and stays executable the moment its timelock
matures.

**The resulting bait-and-switch:**

```
t=0     proposeFeeChange(9800, 9800)   → armed, FeeChangeProposed emitted, 24h clock starts
t=1m    proposeFeeChange(0, 0)         → INSTANT. Fees are now 0%. FeesUpdated emitted.
                                          The 9800 change is still armed. Nothing says so.
t=2m    Token page reads buyFee()/sellFee() → "0% / 0%". Traders pile in.
t=24h   executeFeeChange()             → fees are 98% / 98%.
```

Every step is technically public. But a trader who checks the *current* fee — which
is what every UI shows — sees 0% and has no reason to inspect `pendingFeeChange`.
The 24h notice was given for a proposal that the creator then visibly appeared to
abandon.

**Fix (choose one, both are small):**

- `proposeFeeChange`'s instant path clears `pendingFeeChange` and emits
  `FeeChangeCancelled`. A new proposal supersedes the old one. *(Recommended —
  friendlier, and it matches what a creator lowering fees actually intends.)*
- Or `require(!pendingFeeChange.pending)` on the instant path, forcing an explicit
  `cancelFeeChange()` first.

Either way the UI must also surface pending changes next to current fees, always.

> This lives in `TaxHandler`, which is cloned and frozen per token at launch. It
> **must land before the first mainnet token** or those tokens carry the trap
> forever. Same category as §7.1 and §7.2.

### 7.7 Cap the size of a single fee increase ✅

Related, and it is the strongest form of the "you can, but publicly and slowly"
philosophy that settled §12 #7.

Today a creator can propose `5% → 98%` in one step. The 24h notice is real, but it
is a single notice, and it lands on holders who are asleep, travelling, or simply
not watching a `FeeChangeProposed` event.

A per-change cap changes the shape of that entirely:

```solidity
require(newBuyFee <= _buyFee + MAX_FEE_INCREASE_PER_CHANGE, "Increase too large");  // e.g. 500 bps
```

Launch fees stay unconstrained (`__init__` may set anything ≤ `MAX_FEE`, and that
is public at launch). But *post-launch* escalation from 5% to 98% would require ~19
sequential proposals, each with its own 24h public notice — roughly three weeks of
visible, unambiguous, on-chain intent. Nobody gets surprised.

Also a `TaxHandler` change, therefore pre-mainnet. See §12 #7.

---

## 8. MODULE MUTABILITY — RECOMMENDATION

An open question was whether to drop post-launch module add/remove and permit
only allocation tweaks, to reduce complexity.

**Recommendation: keep all three of `proposeModuleAdd` / `Remove` / `Update`.**

- Restricting to "value tweaks only" **does not reduce trust risk.**
  `proposeModuleUpdate` already lets a creator route 10000 bps to
  `CreatorFeeModule` on both sides. The economic worst case is identical to
  removing every other module.
- `proposeModuleAdd` **is** the opt-in mechanism for new tokenomics. It is the
  reason an already-launched token can adopt the PrizePool (§1.3). Removing it
  means every future module reaches only tokens launched after it.
- `proposeModuleRemove` is the only genuine complexity sink — swap-and-pop index
  volatility, `forbiddenIdx` validation, "cannot remove last", and the subgraph's
  track-by-address gotcha — and it is nearly redundant with setting a module to
  0 bps. It is the sole reasonable deletion candidate, but the code is written
  and tested, so deleting it buys only audit surface.

**The trust lever worth adding instead:** cap `CreatorFeeModule`'s aggregate
allocation (suggested ≤5000 bps per side, enforced in `_requireAllocationsSum`).
That constrains the actual rug vector. Restricting module adds does not.

The existing trust story remains `renounceManagement()` — one-way, freezes fees
and modules forever. That is the guarantee to market, not a narrower API.

---

## 9. SUBGRAPH ADDITIONS

New dynamic-data-source template for `PrizePool`, following the existing
per-module template pattern (`subgraph.yaml` templates section).

New entities:

- `PrizeEpoch` — id `token-epochId`, pot, totalWeight, ticketCount, root, mode,
  randomWord, settledAt, rolledOver, rolloverReason
- `PrizeTicket` — id `token-epochId-index`, buyer, weight, tokensBought
  (indexed from `TokenPurchased`, the same source the operator uses — this is what
  makes the root independently verifiable from the subgraph alone)
- `PrizeClaim` — id `token-epochId-account`, amount, slot (lottery)

For `MilestoneRewardModule`, a second template and:

- `MilestoneRelease` — id `tx-logIndex`, module, amount, remaining, `reason`
  (verbatim), timestamp. The `reason` string is the team's public, timestamped,
  immutable accountability record — surface it on the token page.
- `Module.totalAccrued`, `Module.totalReleased`

Update `helpers.ts` with `MODULE_PRIZE = 4` and `MODULE_MILESTONE = 5`, and the
`hydrateModuleSpecifics` / `spawnModuleTemplate` branches in `database.ts` and
`taxHandler.ts`. Bump the `# 0..3` comments in `schema.graphql`.

The subgraph becomes the reference implementation of ticket derivation. Ship it
alongside the module, not after.

---

## 10. TESTING PLAN

Beyond per-function unit coverage:

- **Epoch math** — multi-epoch jumps with no activity; `pendingEpochLength`
  applied exactly at a boundary; a queued change cannot affect an in-flight epoch.
- **Merkle** — proof verification for both leaf shapes; a forged leaf fails; a
  leaf from epoch `e` cannot be replayed against epoch `e+1`.
- **Lottery range check** — the winning ticket's `[cumBefore, cumBefore+weight)`
  is the *only* range accepted for a given `slot`; adjacent tickets are rejected.
  Duplicate slot claims rejected; same account winning two slots accepted.
- **Ordering** — `drawRandomness` before `postRoot` reverts. Randomness cannot be
  fulfilled twice.
- **Rollover** — each of the six conditions in §2.8, verifying the pot lands in
  `epochId + 1` and no BNB is stranded.
- **Hold requirement** — buy, sell everything, claim reverts. Buy, hold, claim
  succeeds.
- **Swap-path invariant** — a full buy/sell cycle with the PrizePool installed
  costs bounded gas and cannot revert regardless of pot state. Assert
  `receiveTax` makes no external call (gas-bound assertion).
- **Regression for §7.1/§7.2** — a token-mode RewardModule and a
  contract-recipient CreatorFeeModule must both leave trading functional.

`npm test` must stay green. Per `CLAUDE.md`, update `DESIGN.md`, `ROADMAP.md`,
`FRONTEND.md`, `TESTING.md`, and `SUBGRAPH.md` in lock-step.

---

## 11. ROLLOUT SEQUENCE

**Phase A — pre-mainnet, blocking. ✅ COMPLETE.**
`§7.1` RewardModule hot-path swap · `§7.2` CreatorFeeModule pull · `§7.3`
exclusion set · `§7.4` `Database.randomnessProvider` · `§7.5` dust rule ·
`§4.1` `donate()` · `§4.2` `sync()` · `§6.2` slippage floors on every module swap +
the platform operator registry (`Database.isOperator` / `operatorCount`),
`RewardModule.receiveTax` unguarded, self-reward rejected · `§6.3` only swaps are
gated; `triggerDistribution` split into permissionless `processRewards()` and
gated `convertAndDistribute()`.

These touch `TaxHandler`, `Database`, `Generator`, and two module master copies —
all frozen at first launch. Landed before `deploy:bsc`. They sit inside the audit
scope named in `LAUNCH.md §3`, so landing them now avoids paying for a re-audit
of the delta.

Verified: **206 tests green** (up from 175); `graph codegen` + `graph build` pass;
`deploy-base.js` + `smoke-launch.js` run end-to-end against a local V4
PoolManager (BYOL launch + buy through the router).

Frontend consequences are catalogued in [`FRONTEND_MIGRATION_V2.md`](./FRONTEND_MIGRATION_V2.md) —
nothing in the UI repo has been changed yet.

Still outstanding before mainnet, from `LAUNCH.md`: the BSC-fork rehearsal
(blocked on an archive RPC), a Slither pass, and the deploy itself.

**Phase B — any time, including after mainnet.**

- ✅ **B1 · MilestoneRewardModule (type 5)** — shipped, with the 18-month public
  valve (§2B.2b) and a subgraph template. No randomness, no swap, no merkle, no
  configuration. Accrue, and one creator-gated call that donates to the
  RewardModule (plus the valve, which is the same call opened to anyone after
  540 days of inactivity).
- **B2 · PrizePool (type 4)** — ~2 weeks. Epoch bucketing, merkle settlement,
  three payout modes, pull claims, rollover.
- **B3 · Randomness** — `IRandomnessProvider` + `TrustedOperatorRandomness`
  (commit–reveal) + `MockRandomness`. Blocks only the PrizePool's `LOTTERY` mode.
- **B4 · Subgraph + operator scripts** for both.

Phase B changes nothing frozen. It can ship during or after the closed beta, and
**tokens launched in the beta can adopt both modules retroactively** via
`proposeModuleAdd`. That is the entire point of the Option B design.

Sequence B1 → B3 → B2 so the randomness interface exists before the module that
consumes it, and so the team lands one whole module before tackling merkle proofs.

**Phase C — trust hardening, as volume justifies.**
`ChainlinkVRFRandomness` swapped in via `Database.setRandomnessProvider` ·
bonded challenge game on `postRoot` · multisig on `Database.owner()`.

---

## 12. OPEN DECISIONS

| # | Decision | Recommendation |
|---|---|---|
| 1 | `holdRequirementBps` default | `10000` (must still hold what you bought) |
| 2 | Per-address weight cap in `LOTTERY` | Offer it; default uncapped; document whale dominance |
| 3 | Cap `CreatorFeeModule` aggregate allocation | Yes — ≤5000 bps/side. This is the real rug lever (§8) |
| 4 | Payout denomination | BNB. Buying tokens to distribute reintroduces a swap in the settle path |
| 5 | `challengeWindow` length | 6h; must exceed the time to independently recompute a root |
| 6 | Multisig before PrizePool ships? | Recommended — `rootPoster` + `invalidateRoot` widen hot-key blast radius (§5) |
| 7 | Delete `proposeModuleRemove`? | No — keep. See §8 |
| 7b | **Fee ratchet — make fees monotonically decreasing?** | **No. Settled: keep the ability to raise, behind the existing 24h timelock.** See §13.3. The guarantee that motivated the ratchet — *fees can never get worse without public notice* — **already holds today**. The ratchet would remove a legitimate capability and buy nothing. Two real hardenings instead: fix §7.6 (an instant decrease must disarm a pending increase — this is an actual bait-and-switch today) and consider §7.7 (cap the per-change increase). Build the fee-timelock UI; it is the right surface. |
| ~~8a~~ | ~~Emit price data in the hook's trade events?~~ | ✅ **Done.** `TokenPurchased` / `TokenSold` now carry the post-swap `sqrtPriceX96` + `tick`. The subgraph builds candles from the pool mark and never indexes the canonical PoolManager. §13.1. |
| 8b | **Store an on-chain price observation in the hook so buybacks become trustlessly permissionless?** | **No. Recommended against.** See §13.2. Only covers our own pool — `RewardModule.convertAndDistribute` swaps on an external router the hook never sees, so the operator can never be fully removed. Recurring gas on every trade to protect an occasional keeper action. And a lagged-tick floor on a memecoin either allows sandwiches (wide band) or bricks legitimate burns during normal volatility (tight band). The operator registry is reversible; the hook is not. |
| 9 | **MilestoneReward: gate the button on an on-chain metric?** | **No — settled.** Holder count is not on-chain and market cap is flash-loan manipulable, so a gate on the metrics anyone cares about would be theatre. Safety comes from the destination lock instead (§2B.2). The claimed milestone is recorded as free text in `RewardsReleased.reason`. |
| 10 | **MilestoneReward: can anyone but the creator release?** | **No.** Token creator only, read live from the immutable `ITaxHandler.creator()`. Not the platform operator, not a keeper. Discretion belongs to the team that launched the token. |
| 11 | **MilestoneReward: stranded funds if the creator never presses?** | **Bounded by the 18-month valve (§2B.2b).** After 540 days with no release, anyone can release the full balance — still only into the RewardModule. Idle capital for at most 18 months, never counterparty risk. UI still shows accrued BNB + `publicReleaseAt()`. |
| 12 | **MilestoneReward on a token with no RewardModule?** | `releaseRewards` reverts with `No reward module`. The launch wizard MUST pair them. This is the concrete argument for reward-by-default (§4). |

---

---

## 13. RESOLVED DESIGN QUESTIONS (the reasoning, not just the verdict)

### 13.1 Chart data: where does OHLC come from?

**The canonical V4 PoolManager already emits everything a candle chart needs.**

```solidity
// @uniswap/v4-core/src/interfaces/IPoolManager.sol:91
event Swap(
    PoolId indexed id, address indexed sender,
    int128 amount0, int128 amount1,
    uint160 sqrtPriceX96,   // ← price, per swap
    uint128 liquidity,
    int24 tick,             // ← price, per swap
    uint24 fee
);
```

So charts do **not** require a hook change. Two ways to get the data:

**Option 1 — index the canonical PoolManager, filter by our PoolIds.** Zero
contract change, works today, already sketched in `SUBGRAPH.md` as optional. The
cost is that the subgraph must process *every* Uniswap V4 swap on BSC and discard
the ones that aren't ours. Cheap now; grows with V4 adoption, and it makes our
indexing latency a function of a contract we don't control.

**Option 2 — have the hook include the post-swap price in its own events.** In
`_afterSwap`, read `StateLibrary.getSlot0(poolManager, poolId)` and add
`sqrtPriceX96` and `tick` to `TokenPurchased` / `TokenSold`. Roughly one cold
SLOAD (~2.1k gas) plus two extra event words (~0.5k) ≈ **2.6k gas per swap, no
storage**. The subgraph then indexes only our hook and gets price, volume, fees and
per-user attribution from a single event stream — which is a materially nicer OHLC
source than joining two contracts.

At 1 gwei and BNB at $600, 2.6k gas is about **$0.0016 per trade**.

> **This is a hook change, therefore pre-mainnet or never.** The hook's address is
> part of every `PoolKey`; a new hook means new pools, and the old pools' liquidity
> is permanently locked in them.

**Recommendation: do Option 2, before `deploy:bsc`.** It is cheap insurance against
a dependency we can't fix later, and Option 1 remains a working fallback if we
skip it. Note that **emitting price does not create an on-chain oracle** — events
are not readable from a contract. §13.2 is a separate question.

### 13.2 Why we are *not* adding an on-chain price observation

The proposal was: store `(tick, blockNumber)` in the hook so `executeBurn` and
`executeLiquidity` can derive their own slippage floor on-chain from the previous
block's tick, killing atomic sandwiches without any trusted operator.

Four reasons not to:

1. **It only covers our own pool.** `RewardModule.convertAndDistribute` swaps on an
   *external* router (PancakeSwap), which our hook never observes. That function
   stays operator-gated no matter what. The oracle buys us two of the three gated
   functions, so the trusted operator never actually goes away.
2. **A lagged-tick floor is a poor fit for this asset class.** The floor must be a
   tolerance band around a stale tick. On a freshly launched memecoin, price
   routinely moves double-digit percentages within a block. A band wide enough not
   to brick `executeBurn` during normal volatility is wide enough to sandwich
   through; a band tight enough to prevent sandwiching will revert legitimate burns
   whenever the market moves. There is no comfortable setting.
3. **The cost is borne by the wrong people.** Every trader pays gas on every trade,
   forever, to protect an occasional keeper action whose worst-case exposure is
   already bounded by the module's interval and by the operator's presence.
4. **The asymmetry of reversibility.** The operator registry is a single owner
   transaction away from being switched off (`setOperator(addr, false)` →
   `operatorCount == 0` → everything permissionless). The hook can never be
   changed. Prefer the reversible mechanism.

The residual exposure with the operator model is: during a backend outage lasting
more than `PUBLIC_FALLBACK_DELAY` (1h), a public caller may execute a burn with a
bad floor and sandwich it. That is bounded by the interval and by whatever BNB has
accrued. It is not a rug vector — the operator can never take the funds, only
choose the moment.

**If buyback MEV proves material during the beta, the fix is not a hook oracle — it
is to keep the operator, or to cap BNB spent per execution.** Both are available
after mainnet. The oracle is not.

### 13.3 Fees: timelock everything, don't ratchet

The original proposal (§12 #7) was to make `buyFee` / `sellFee` monotonically
decreasing — "you can lower fees, never raise them."

**Rejected, because the guarantee it was meant to deliver already exists.** A fee
increase today requires `proposeFeeChange` → `FeeChangeProposed(newBuy, newSell,
effectiveTime)` emitted publicly → **24 hours** → `executeFeeChange`. A trader's
quote can therefore never get worse without a full day of on-chain notice. That is
exactly *"You CAN do it, but it's publicly visible for 24 hours and people can
react before it takes effect."* It is built, tested, and shipping.

The ratchet would remove a legitimate capability — a project that genuinely needs
to raise its sell tax to defend against a specific attack, with a day's notice —
and would buy holders nothing they don't already have.

**Should decreases be timelocked too, for uniformity?** Recommended **no**. A
decrease cannot harm anyone, and the instant path is the safety valve for a
misconfigured launch (someone ships with a 98% sell tax by accident and needs to
fix it *now*, not tomorrow). Uniformity is a UI concern, and the UI can simply
render "current fee" alongside "pending change, effective in Xh" — which it must do
regardless.

**But the current implementation has a hole**, and it is the reason the fee UI must
show pending state prominently: an instant decrease does not disarm a pending
increase. A creator can arm 98%, instantly drop to 0%, let people buy, and execute
the armed increase a day later. Full write-up and fix in **§7.6**. It lives in
`TaxHandler` and therefore must land pre-mainnet.

**And the strongest version of this philosophy is §7.7:** cap how far a single
proposal may raise a fee (e.g. +500 bps). Then escalating 5% → 98% requires ~19
sequential public 24h notices — about three weeks of unmistakable on-chain intent —
instead of one notice that a sleeping holder can miss. Launch fees stay
unconstrained, because those are public at launch. Post-launch escalation becomes
slow and loud. That is the mechanism that actually delivers the intent.

*Keep in lock-step with `DESIGN.md`, `ROADMAP.md`, `LAUNCH.md`, `SUBGRAPH.md`.*
