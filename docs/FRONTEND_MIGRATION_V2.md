# Frontend Migration — Tokenomics V2 Phase A

**Status:** contracts landed, frontend NOT yet updated. This doc is the complete
work order. Nothing here has been applied to the UI.

**Audience:** whoever picks up the frontend next (human or agent). The frontend
lives in a sibling repo at `../control-project-x-v0` — a Next.js app that is
currently **mock-data driven** (`lib/demo-seed.ts`), with **no ABIs on disk** and
no on-chain reads. That is good news: most of this migration is *labels and
shapes*, not decoder rewrites. But the moment real ABIs are wired in, every item
below becomes load-bearing.

Source of truth for the contract behaviour: [`TOKENOMICS_V2.md`](./TOKENOMICS_V2.md).
Read §6.1, §7.1, §7.2 before touching module UI.

---

## 0. The one-paragraph summary

Two module contracts used to **push** value or make external calls while a trade
was executing, which meant a badly-configured module could revert every trade of
its token. They now **accrue**, and value moves only when someone pulls it. As a
consequence: **creator fees no longer land in the wallet by themselves — there is
now a Claim button to build**, and **burn / auto-LP / reward-conversion are now
explicit keeper transactions that take a slippage floor**.

Only the three functions that *swap* are permissioned. Everything else — claiming,
donating, syncing shares, crystallizing dividends — stays permissionless forever.

---

## 1. BREAKING: `CreatorFeeModule` is now accrue-and-pull

This is the only change that breaks an existing ABI.

### What changed

| Before | After |
|---|---|
| `TaxForwarded(address indexed recipient, uint256 amount)` | `TaxAccrued(address indexed recipient, uint256 amount, uint256 owedAfter)` |
| — | `TaxWithdrawn(address indexed recipient, uint256 amount)` |
| BNB arrived in the recipient wallet on every trade | BNB accrues in the module; recipient calls `withdraw()` |
| `totalPaid` = lifetime earned | `totalPaid` = lifetime **withdrawn** |
| — | `totalAccrued` = lifetime **earned** |
| — | `owed(address) → uint256` = claimable right now |

### Why

`receiveTax()` ran inside the Uniswap V4 swap callback and forwarded BNB with
`TransferHelper.safeTransferETH`, which does `require(success)`. A fee recipient
that was a contract without a payable `receive()` reverted **every single trade of
that token**, permanently. Under accrue-and-pull, `receiveTax()` cannot fail, and
only the recipient's own `withdraw()` can.

### Frontend work

1. **Add a Claim flow.** Creator dashboard needs `owed(recipient)` displayed and a
   button calling `withdraw()`. Without it, creators cannot access their fees.
2. **Split the earnings stat.** "Creator earnings" should show *claimable*
   (`owed`) next to *lifetime* (`totalAccrued`). Do **not** display `totalPaid` as
   "earnings" — it now means withdrawn.
3. **Recipient rotation caveat.** `setRecipient` moves the *future* stream. The
   previous recipient keeps their accrued `owed` balance and can still withdraw
   it. If the UI shows a rotation, it should say so.
4. **Drop the contract-recipient warning.** `DESIGN.md` used to require warning
   users that a contract recipient could break trading. That is no longer true —
   a contract recipient can now only fail to withdraw. Remove the scare copy.

---

## 2. BREAKING: module keeper calls now take slippage + deadline

All three module swaps previously executed with `amountOutMin = 0`, i.e. a free
sandwich for anyone watching the mempool. They now require a floor, and they are
executed **out of band by an operator**, never inside a trade.

| Contract | Before | After | Gated? |
|---|---|---|---|
| `BurnModule` | `executeBurn()` | `executeBurn(uint256 minTokensOut, uint256 deadline)` | yes |
| `LiquidityModule` | `executeLiquidity()` | `executeLiquidity(uint256 minTokensOut, uint256 minTokenLP, uint256 minBnbLP, uint256 deadline)` | yes |
| `RewardModule` | `triggerDistribution()` | **split in two** ↓ | |
| `RewardModule` | — | `processRewards()` | **no — permissionless, forever** |
| `RewardModule` | — | `convertAndDistribute(uint256 minRewardOut, uint256 deadline)` | yes |

`minTokensOut` / `minRewardOut` **must be > 0**. Passing zero reverts with
`Zero minTokensOut` / `Zero minRewardOut`.

**`triggerDistribution` no longer exists.** It was replaced by two functions so the
permission boundary is visible in the ABI rather than hidden in a branch:

- `processRewards()` — BNB mode only. Pure bookkeeping, no swap, no params, never
  gated. This is the "refresh rewards" button. Reverts in token mode.
- `convertAndDistribute(minRewardOut, deadline)` — token mode only. Swaps on the
  external router, so it is operator-gated. Reverts in BNB mode.

**Only swaps are gated.** Everything that merely costs gas to churn —
`processRewards`, `donate`, `sync`, `claimReward`, `CreatorFeeModule.withdraw` —
is permissionless forever, whether or not operators are registered. The full
permission matrix is `TOKENOMICS_V2.md` §6.3.

### The operator model — platform-wide, NOT per token

A caller-supplied `minOut` protects the *caller's* funds. These swaps spend the
**module's** BNB, so an arbitrary caller has no incentive to choose a good floor —
they can pass 1 wei and sandwich their own call. Execution authority therefore
comes from a platform allowlist:

```solidity
Database.isOperator(address) → bool     // owner-managed, platform-wide
Database.operatorCount()     → uint256
Database.setOperator(address, bool)     // onlyOwner
event OperatorUpdated(address indexed operator, bool allowed)
```

- `operatorCount == 0` → **everything is permissionless**, exactly as before. This
  is the default, and it is the current on-chain state.
- A registered operator (our backend) executes as soon as the interval elapses.
- Anyone else may execute one hour after that (`PUBLIC_FALLBACK_DELAY`), so an
  operator outage delays a burn but never strands the BNB.

**Token creators cannot appoint operators.** There is no `setOperator` on any
module. Do not build a creator-facing operator UI.

### Frontend work

1. **Quote before executing.** Any UI that offers "trigger burn" / "add liquidity
   now" / token-mode "convert rewards" must first quote the swap (V4Quoter,
   `quoteExactInputSingle` with the deterministic PoolKey — see `FRONTEND.md §2.9`)
   and pass `expectedOut * (1 - tolerance)` as the floor. A hardcoded `1` works
   on testnet and is a real vulnerability on mainnet. `processRewards()` needs
   none of this — it takes no arguments and cannot be sandwiched.
2. **Deadline.** Use `block.timestamp + N minutes`, same as any swap UI.
3. **Gate the public trigger button.** Read `Database.operatorCount()`. If it is
   non-zero and the caller is not an operator, the button only works once
   `readyAt + 1h` has passed — otherwise it reverts with `Operator window`.
   Showing "next burn due at …" is usually a better surface than a button.
4. **These are keeper actions, not user actions.** Consider whether they belong in
   the public UI at all, or only in an internal operator console. See §6.

---

## 2b. NEW: the hook now emits pool price — build charts off it

`LumoriaHook`'s two trade events gained a post-swap price:

```solidity
event TokenPurchased(..., uint256 tokensOut, uint160 sqrtPriceX96, int24 tick);
event TokenSold(...,     uint256 bnbOut,    uint160 sqrtPriceX96, int24 tick);
```

**This changes where the candle chart gets its data from.** Previously the only
options were to index the canonical Uniswap V4 PoolManager (a global singleton
carrying every V4 swap on BSC, which you'd filter down to our pools) or to
reconstruct price from trade amounts. Now the hook alone gives you price, volume,
fee breakdown and per-user attribution in one event stream, for our pools only.

### The two prices are different, and it matters

| Field | Meaning | Use for |
|---|---|---|
| `Trade.priceBnbPerToken` | **Execution** price — what this trader actually paid or received, after the platform fee and the token's tax | A fills / trade-history view |
| `Trade.poolPriceBnbPerToken` | **Pool mark** price immediately after the swap, exact, undistorted by fees | **The candle chart.** `TokenDayData` / `TokenHourData` / `TokenMinuteData` are built from this |

Charting execution price on a high-tax token renders its fee stack, not its
market — buys and sells would straddle the true price by the tax spread and the
candles would look like a permanent bid/ask oscillation. Use the pool mark.

Conversion (currency0 = BNB, currency1 = token, both 18 decimals):

```
poolPriceBnbPerToken = 2^192 / sqrtPriceX96^2
```

Implemented as `poolPriceBnbPerToken()` in `subgraph/src/helpers.ts`, and pinned
by a numeric assertion in `test/V4Hook.test.js` so an inverted price can't ship.
`tick` is carried alongside for anyone who prefers log-space bucketing.

### Frontend work

1. **Query `poolPriceBnbPerToken` for charts**, `priceBnbPerToken` for fills.
2. **Drop any plan to index the PoolManager.** `SUBGRAPH.md` now says not to.
3. `Token.lastPriceBnb` is now the pool mark, not the last execution price. If the
   UI shows a "current price", this is the one.
4. For an intra-trade live price (no new trade yet), `StateView.getSlot0(poolId)`
   remains the right direct read — same `sqrtPriceX96`, same formula.

---

## 2c. NEW: fee changes are bounded, and pending state must be visible

Two `TaxHandler` changes, both frozen-at-launch, both landed:

- **A single proposal may no longer raise a fee by more than `MAX_FEE_INCREASE_PER_CHANGE`
  (1000 bps).** Escalating 5% → 98% now takes ~10 sequential proposals, each with
  its own 24h public notice. Reverts: `Buy increase too large` /
  `Sell increase too large`. The launch wizard should surface the cap when a
  creator edits fees post-launch.
- **An instant fee *decrease* now cancels any armed fee *increase*.** It emits
  `FeeChangeCancelled` alongside `FeesUpdated`.

**The UI must show pending fee changes next to current fees, always.** The reason
this matters: before the fix, a creator could arm 98%, instantly drop to 0% so
every page read "0% fees", let buyers in, and execute the armed increase a day
later. The contract now disarms it — but a token page that shows only
`buyFee()` / `sellFee()` and never `pendingFeeChange()` is still hiding a
24-hour countdown from users who need it.

Render: **current fee**, and if `pendingFeeChange().pending`, a banner —
*"Buy fee rises to X% in 14h 22m"* — sourced from `pendingFeeChange()` or the
subgraph's `PendingChange` entity. This is the surface that makes "you can raise
fees, but only in public, and only slowly" real to a user.

---

## 3. Launch wizard: init payloads are UNCHANGED, but one new validation

`Generator.generateProject` takes `ModuleInitData[]`, whose `initPayload` is an
`abi.encode` blob **whose shape differs per module type**. All four shapes are
unchanged (operators are platform-wide, so nothing per-module was added):

```
RewardModule     abi.encode(token, rewardToken, externalRouter, externalWBNB, minDistribution)
BurnModule       abi.encode(token, database, burnInterval)
LiquidityModule  abi.encode(token, database, liquidityInterval)
CreatorFeeModule abi.encode(recipient)
```

New init-time validation: **`RewardModule` rejects `rewardToken == token`**
(`Reward token = token`). A self-rewarding token's distribution swap would
re-enter its own tax path mid-distribution. The launch wizard must not offer the
token itself as a reward asset.

Reference implementation of these encoders: `test/fixtures/deploy.js` →
`buildRewardInitData` / `buildBurnInitData` / `buildLiquidityInitData`.

---

## 4. New reads and writes worth surfacing

| Contract | Member | Use |
|---|---|---|
| `RewardModule` | `donate() payable` | permissionless — anyone can top up a token's reward pool. A nice "boost rewards" button. |
| `RewardModule` | `sync(address[] holders)` | permissionless backfill. **Required** for any reward module added *after* launch, which otherwise starts blind. Feed it holder addresses from the subgraph. |
| `RewardModule` | `lastDistributionTime` | keeper status / "next distribution due" |
| `Database` | `isOperator(address)`, `operatorCount()` | gate the public "trigger" buttons (§2) |
| `TaxHandler` | `isExcludedFromShares(address) → bool` | holder tables should not show excluded system contracts (RebateContract, FlatCurve, VestingVault, LiquidityVault, module clones, the pool) as reward-earning holders |
| `TaxHandler` | `ExcludedFromShares(address)` event | subgraph: mark `Holder.excluded` |
| `Database` | `randomnessProvider()` | unset today; PrizePool (§ TOKENOMICS_V2 §3) will read it |

### `getStats()` shapes changed

`RewardModule`, `BurnModule` and `LiquidityModule` each appended fields to their
`abi.encode(...)` blob. **Nothing currently decodes `getStats()`** — not the
subgraph, not the frontend (the subgraph uses typed ABI bindings instead). So
this is free *unless* you build a decoder. If you do, read the current shape from
source; do not trust `FRONTEND.md`'s older listing.

---

## 5. Concrete file map in `control-project-x-v0`

The app is mock-driven, so the coupling is shallow. These are the places that
encode module semantics today:

| File | Line(s) | What's there | Action |
|---|---|---|---|
| `lib/constants.ts` | ~41–57 | `FEE_BREAKDOWN_TYPES` = `burn / rewards / liquidity` | **Already drifted** — missing `creator`. Add it. Later add `prizePool`. |
| `components/create/fee-structure-step.tsx` | ~28–52 | `FeeFieldKey = "burn"｜"rewards"｜"liquidity"｜"creatorRevenue"` + label registry + default breakdown objects (~82–83) | The de-facto module registry. Extend when a module type is added. |
| `components/create/tokenomics-step.tsx` | — | token distribution allocations | Not the tax-module enum. Leave alone. |
| `components/trading/*`, `components/portfolio/*` | — | "reward / liquidity / burn" as copy + reward-claim UI | Reward claim UI is real and stays. Add creator-fee claim (§1). |
| `lib/demo-seed.ts` | — | all mock data | Source of every number on screen today. |
| — | — | no `*abi*` files exist | When ABIs land, generate from `artifacts/`, don't hand-write. |

Note `documentation/` in that repo contains **stale copies** of
`CONTRACTS_SUBGRAPH_DRIFT_REPORT.md` and `FRONTEND_HANDOFF.md`. They predate this
migration. Re-copy from `lumoria-contracts/docs/` rather than reading them.

---

## 6. Design question to resolve before building

**Do we turn the operator registry on for the beta?**

The contracts support both, and the switch is a single owner transaction
(`Database.setOperator`), reversible, affecting every token at once:

- **Operators registered (recommended for mainnet).** Our backend watches
  `TaxReceived`, waits for the interval, quotes the swap, and calls
  `executeBurn(minOut, deadline)` with a sane floor. No public UI needed. The
  one-hour fallback means a backend outage degrades to permissionless rather than
  to stuck funds.
- **No operators (current on-chain state).** Everything is permissionless
  immediately. Someone must still compute `minOut` client-side, and any caller can
  pass a bad floor and sandwich the module's own buyback. Cheaper to build, worse
  economics.

`deploy-base.js` reads `LUMORIA_OPERATORS` (comma-separated) and registers them
if set; unset ships permissionless.

If we register operators, the burn/LP trigger buttons should live in an internal
console, not the public token page — and the token page should instead show *when
the next burn is due* (`lastBurnTime + burnInterval`) and the module's pending BNB
balance.

This is also the shape the **PrizePool** (TOKENOMICS_V2 §2) will need: an operator
posting merkle roots and revealing randomness. Worth building the keeper harness
once, for all four jobs.

---

## 7. Not yet built (do not migrate for these)

Listed so nobody wires them prematurely:

- **PrizePool (module type 4)** — spec only, TOKENOMICS_V2 §2. Will add a
  `prizePool` entry to `FEE_BREAKDOWN_TYPES`, epoch/ticket/claim UI, and a merkle
  claim flow.
- **`IRandomnessProvider`** — spec only, TOKENOMICS_V2 §3. `Database.randomnessProvider`
  exists and returns `address(0)`.
- **Fee ratchet** — proposed, not implemented: making `buyFee`/`sellFee`
  monotonically decreasing would delete `proposeFeeChange`'s increase path and the
  entire `pendingFeeChange` timelock UI. **Do not build the fee-increase timelock
  UI until this is decided** — it may be deleted outright.

---

*Keep in lock-step with `TOKENOMICS_V2.md`, `FRONTEND.md`, and `SUBGRAPH.md`.*
