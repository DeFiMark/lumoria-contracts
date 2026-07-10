# Lumoria Frontend Data Handoff — Mock-Data → Real-Data Drift Audit

**You are the frontend agent, working in the Lumoria frontend repo.** The Lumoria smart contracts + subgraph are defined in a *separate* contracts repo you don't have access to — **but you don't need it. This file is fully self-contained.** Everything you need to know about the available data is below.

The UI currently renders **mock data**. Your job: map **every datum the UI displays** to a real data source listed here, and **report back the drift** — anything the UI shows that the contracts/subgraph don't (yet) provide.

> **Status note:** the subgraph is *specified* (entities in Appendix A) but is being **built in parallel**. Treat the entities in Appendix A as the agreed, available-soon query surface. The on-chain reads (§2a/§2b) exist today.

---

## 1. Your task

For **each screen / component / widget** in the current (mock-data) UI:

1. List every distinct **datum it displays** (e.g. "24h volume", "holder count", "your claimable rewards", "next-burn countdown", "rebate tokens remaining", "raise progress %", a price candle, fee %, a pending-change countdown, …).
2. **Map each datum to a source** from §2:
   - a **direct contract read** (§2a, live state), or
   - an **off-chain V4 read** (§2b, quotes / pool price), or
   - a **subgraph entity field** (§2c + Appendix A, history & aggregates), or
   - **client-derivable** (computed from the above).
3. **Flag anything with no source** — that's the drift you report (§3, §4).

The goal is to surface drift **before mainnet deploy**, while it's cheap to fix.

---

## 2. The complete available-data surface

This is everything the UI can source. Exact subgraph field names are in **Appendix A**; the raw events behind them in **Appendix B**.

### 2a. Direct on-chain reads (live "about now" state — available today)
- **Database** (one singleton): `isLumoriaToken(token)`, `tokenCreator(token)`, `tokenTaxHandler(token)`, `allTokens(i)`/`allTokensLength()`, `platformFeeBps()`, infra addresses (`router/poolManager/hook/liquidityVault/feeReceiver/rebateContract/wbnb/generator`), `userVolume(token,user)`, `tokenVolume(token)`.
- **Token** (ERC20, one per token): `name/symbol/decimals/totalSupply/balanceOf/allowance`, plus `pair`(=PoolManager addr), `taxHandler`, `creator`.
- **TaxHandler** (one per token): `buyFee()`, `sellFee()`, `getModuleCount()`/`getModule(i)`, `shares(h)`/`totalShares()`, **`pendingFeeChange()`**, **`pendingModuleChange()`**, `pendingRebalanceLength()`/`pendingRebalance(i)`, `totalBuyTaxReceived()`/`totalSellTaxReceived()`.
- **Modules** (per module, via `getStats()` + public vars):
  - Creator: `recipient`, `totalPaid`.
  - Reward: **`getUnpaidRewards(holder)` — live claimable; ALWAYS a direct read, never subgraph**, `rewardToken`, `minDistribution`, `dividendsPerShare`, totals.
  - Burn: `burnInterval`, `lastBurnTime`, `totalBurned`, `totalBNBSpent` → "next burn in X" = `lastBurnTime + burnInterval − now`.
  - Liquidity: `liquidityInterval`, `lastLiquidityTime`, `totalLPLocked`, totals.
- **RebateContract** (one singleton): `getRebate(token)` → `{ rebateBps, fundedBalance, creator, active }` (live "X% — Y tokens remaining").
- **FlatCurve** (one per raise): `token`, `hardCap`, `totalRaised`, `contributions(user)`, `claimed(user)`, `launched`/`failed`, `minContribution`/`maxContribution`/`tokensForPresale`/`tokensForLP`/`liquidityBps`/`creatorBps`/`startTime`/`endTime`. (Time-states PENDING/ACTIVE/CAPPED/ENDED/SUCCESS/FAILED are **derived client-side** from these — see §2d.)
- **LiquidityVault**: `lockedLiquidity(token)`, `totalBnbLocked(token)`, `totalTokensLocked(token)` ("liquidity locked forever" stats).
- **Generator**: `predictTokenAddress(salt)` (preview a launch's token address), `getDatabase()`.
- **FeeReceiver**: `totalReceived()`, `feesByToken(token)`, `recipient()`.

### 2b. Off-chain V4 reads (canonical Uniswap-V4 periphery on BSC — addresses provided at deploy)
- **V4Quoter** → `quoteExactInputSingle({ poolKey, zeroForOne, exactAmount, hookData:"0x" })` returns the **tax-accurate** expected output for the trade widget (already nets platform fee + token tax). **exactInput only** (exactOutput reverts).
- **StateView** → `getSlot0(poolId)` → `sqrtPriceX96` (price = `(sqrtPriceX96/2^96)^2` token-per-BNB), `getLiquidity(poolId)`.
- **PoolKey/PoolId** are deterministic: `PoolKey = { currency0: 0x0 (native BNB), currency1: token, fee: 0, tickSpacing: 60, hooks: <hook> }`, `PoolId = keccak256(abi.encode(PoolKey))`. The subgraph also gives you `Token.poolId` directly.

### 2c. Subgraph (history, aggregates, lists, charts) — full schema in Appendix A
At a glance, queryable: **Token** (list/cards: fees, holderCount, volumes, fees collected, TVL, poolId, launchMode), **Trade** feed (buy/sell, amounts, fees, price, rebateCredited, attributed, isModuleFlow), **TokenDayData/TokenHourData** (OHLCV candles), **Holder**/**User** (balances, holder lists, cross-token holdings), **Module** + activity (RewardClaim/BurnExecution/LiquidityInjection/CreatorFeeForward), **FeeChange/ModuleEvent/PendingChange** (creator dashboard history + live pending banners), **Rebate/RebateCredit**, **Raise/Contribution**, **UserVolume**, **PlatformConfig**.

### 2d. Known boundaries (don't mis-flag these as drift)
- **Live claimable rewards** = `RewardModule.getUnpaidRewards` direct read, *never* subgraph (it moves between distributions).
- **Trade quotes** = V4Quoter, not subgraph.
- **FlatCurve time-states** = client-derived from reads (no event fires when a raise window merely opens/closes).
- **Per-user attribution** (rebates, `userVolume`, `Trade.trader`) only exists for swaps routed through the Lumoria swap router; aggregator/Universal-Router trades are taxed but show `trader = 0x0` and earn no rebate.
- **Pool LP fee is 0**; all economics are the platform fee (default 1%) + the token's buy/sell tax, both taken in BNB by the hook on every swap.

---

## 3. How to classify each drift item

- **Type A — subgraph-only**: the data exists on-chain or in an emitted event (Appendix B), but no subgraph entity/field exposes it yet. → cheap; propose the entity + field.
- **Type B — contract change** ⚠️: the datum has **no event (Appendix B) AND no read (§2a)**. → must be flagged **before the mainnet deploy** — adding events/views later means redeploying contracts, and pool liquidity is **permanently locked**. State exactly what's missing and why a read won't suffice.
- **Type C — client-side / cosmetic**: derivable from existing sources, or purely presentational. → no backend change; note the derivation.

---

## 4. What to report back

Reply with a **drift report** — and **if there's no drift, say so explicitly** (a valid, useful answer):

```
## Lumoria UI — Data Drift Report

### Type B — contract changes needed BEFORE deploy (if any)
| UI element | Datum displayed | Why no read/event suffices | Suggested event or view |

### Type A — subgraph additions
| UI element | Datum displayed | Nearest existing source | Suggested entity.field |

### Type C — client-side / cosmetic (brief)
| UI element | Datum | Derivation from §2 |

### Fully covered (confirmation)
- <screens whose every datum maps cleanly to §2 / Appendix A>
```

Prioritize **Type B** — those are the only items that can block the mainnet deploy.

---

## Appendix A — Subgraph queryable entities (the GraphQL schema)

This is exactly what the subgraph will expose. Map UI data to these fields.

```graphql
type Token @entity {
    id: ID!                       # token address
    creator: Bytes!  taxHandler: Bytes!  poolId: Bytes
    name: String!  symbol: String!  decimals: Int!
    launchMode: Int!              # 0 BYOL, 1 FlatCurve
    launchedAt: BigInt!  launchTx: Bytes!
    buyFee: BigInt!  sellFee: BigInt!     # current (bps)
    totalSupply: BigInt!
    holderCount: Int!             # excludes PoolManager + 0x0
    totalVolumeBnb: BigInt!       # all routes
    attributedVolumeBnb: BigInt!  # only our-router (hookData) trades
    buyCount: BigInt!  sellCount: BigInt!
    totalPlatformFeeBnb: BigInt!  totalTaxBnb: BigInt!
    totalLiquidityLocked: BigInt! # V4 liquidity units (monotonic)
    pendingFeeChange: PendingChange
    pendingModuleChange: PendingChange
    rebate: Rebate
    raise: Raise
    modules: [Module!]! @derivedFrom(field: "token")
    trades: [Trade!]! @derivedFrom(field: "token")
    holders: [Holder!]! @derivedFrom(field: "token")
    feeHistory: [FeeChange!]! @derivedFrom(field: "token")
    moduleHistory: [ModuleEvent!]! @derivedFrom(field: "token")
}

type Holder @entity {
    id: ID!                       # token-addr:holder-addr
    token: Token!  user: User!  address: Bytes!
    balance: BigInt!
    isPool: Boolean!              # true for PoolManager — suppress in lists
    firstSeen: BigInt!  lastSeen: BigInt!
}

type User @entity {               # cross-token holder dashboard
    id: ID!                       # user address
    holdings: [Holder!]! @derivedFrom(field: "user")
}

type Trade @entity(immutable: true) {
    id: ID!                       # tx-hash:log-index
    token: Token!  trader: Bytes! # 0x0 if unattributed
    attributed: Boolean!          # trader != 0x0
    isModuleFlow: Boolean!        # synthetic module trade — exclude from OHLC/organic volume
    kind: String!                 # "buy" | "sell"
    bnbIn: BigInt  bnbOut: BigInt  tokensIn: BigInt  tokensOut: BigInt
    platformFee: BigInt!  taxTaken: BigInt!
    priceBnbPerToken: BigDecimal!
    rebateCredited: BigInt        # bonus tokens from rebate (buys), same tx
    timestamp: BigInt!  blockNumber: BigInt!  txHash: Bytes!
}

type Module @entity {
    id: ID!                       # module address
    token: Token!  taxHandler: Bytes!
    moduleType: Int!              # 0 REWARD, 1 BURN, 2 LIQUIDITY, 3 CREATOR
    buyAllocation: BigInt!  sellAllocation: BigInt!  active: Boolean!  addedAt: BigInt!
    totalReceivedBnb: BigInt!
    rewardToken: Bytes  totalDividendsDistributed: BigInt   # Reward
    totalBurned: BigInt  totalBnbSpent: BigInt              # Burn
    totalLpLocked: BigInt                                   # Liquidity
    recipient: Bytes                                        # Creator (current)
    minDistribution: BigInt                                 # Reward
    interval: BigInt  lastExecuted: BigInt                  # Burn/Liquidity (countdowns)
    forwards: [CreatorFeeForward!]! @derivedFrom(field: "module")  # Creator per-recipient
}

type PendingChange @entity {
    id: ID!                       # token-addr + "fee"|"module"
    token: Token!  kind: String!  # "fee" | "module"
    newBuyFee: BigInt  newSellFee: BigInt
    changeType: Int  moduleType: Int            # module: 0 ADD 1 REMOVE 2 UPDATE
    rebalanceIndices: [BigInt!]  rebalanceBuyAllocs: [BigInt!]  rebalanceSellAllocs: [BigInt!]
    effectiveTime: BigInt!  proposedAt: BigInt!  proposedTx: Bytes!
    status: String!               # "pending" | "executed" | "cancelled"
}

type FeeChange @entity(immutable: true) {
    id: ID!  token: Token!
    oldBuyFee: BigInt!  newBuyFee: BigInt!  oldSellFee: BigInt!  newSellFee: BigInt!
    kind: String!                 # "instant" | "timelocked"
    timestamp: BigInt!
}

type ModuleEvent @entity(immutable: true) {
    id: ID!  token: Token!
    kind: String!                 # "added"|"removed"|"updated"|"proposed"|"cancelled"
    module: Bytes  moduleType: Int  buyAllocation: BigInt  sellAllocation: BigInt
    timestamp: BigInt!
}

type RewardClaim @entity(immutable: true)   { id: ID! module: Module! holder: Bytes! amount: BigInt! timestamp: BigInt! }
type BurnExecution @entity(immutable: true) { id: ID! module: Module! bnbSpent: BigInt! tokensBurned: BigInt! timestamp: BigInt! }
type LiquidityInjection @entity(immutable: true) { id: ID! module: Module! bnbAmount: BigInt! tokenAmount: BigInt! liquidity: BigInt! timestamp: BigInt! }
type CreatorFeeForward @entity(immutable: true) { id: ID! module: Module! recipient: Bytes! amount: BigInt! timestamp: BigInt! }

type Rebate @entity {
    id: ID!                       # token address
    token: Token!  creator: Bytes!
    rebateBps: BigInt!  fundedBalance: BigInt!  active: Boolean!  totalCreditedTokens: BigInt!
    credits: [RebateCredit!]! @derivedFrom(field: "rebate")
}
type RebateCredit @entity(immutable: true) {
    id: ID!  rebate: Rebate!  token: Token!  buyer: Bytes!  amount: BigInt!  timestamp: BigInt!
}

type Raise @entity {
    id: ID!                       # flatCurve address
    token: Token!  flatCurve: Bytes!
    hardCap: BigInt!  totalRaised: BigInt!  contributorCount: Int!
    startTime: BigInt!  endTime: BigInt!  minContribution: BigInt!  maxContribution: BigInt!
    tokensForPresale: BigInt!  tokensForLP: BigInt!     # stranded if FAILED
    status: String!               # "ACTIVE" | "SUCCESS" | "FAILED" (time-states derived client-side)
    liquidityBnb: BigInt  creatorBnb: BigInt
    contributions: [Contribution!]! @derivedFrom(field: "raise")
}
type Contribution @entity {
    id: ID!                       # raise-addr:contributor
    raise: Raise!  contributor: Bytes!
    grossContributed: BigInt!  netContributed: BigInt!  refunded: BigInt!  claimed: BigInt!
}

type UserVolume @entity {         # attributed (our-router) volume only
    id: ID!  token: Token!  user: Bytes!  volumeBnb: BigInt!
}

type TokenDayData @entity {       # daily OHLCV candle
    id: ID!  token: Token!  date: Int!
    open: BigDecimal!  high: BigDecimal!  low: BigDecimal!  close: BigDecimal!  volumeBnb: BigInt!  txCount: BigInt!
}
type TokenHourData @entity {      # intraday OHLCV candle (for the trade widget)
    id: ID!  token: Token!  periodStart: Int!
    open: BigDecimal!  high: BigDecimal!  low: BigDecimal!  close: BigDecimal!  volumeBnb: BigInt!  txCount: BigInt!
}

type PlatformConfig @entity {     # singleton id="1"
    id: ID!  platformFeeBps: BigInt!  totalFeesReceivedBnb: BigInt!  totalTokens: Int!
}
```

---

## Appendix B — Contract events (the raw layer; use to tell Type A from Type B)

If a datum you need is in an event below but NOT yet an entity field in Appendix A → **Type A** (cheap subgraph add). If it's in neither here nor §2a → **Type B** (contract change).

- **Database**: `TokenRegistered(token, creator, taxHandler)`, `VolumeRegistered(token, user, amount)`, `PlatformFeeUpdated(old, new)`, `ModuleMasterCopySet(type, copy)`, `MasterCopyUpdated(copyType, newCopy)`, `{Generator,Router,PoolManager,Hook,LiquidityVault,FeeReceiver,RebateContract}Updated(old, new)`.
- **Generator**: `ProjectGenerated(token, taxHandler, creator, name, symbol, buyFee, sellFee, launchMode)`, `BYOLLaunched(token, platformFee, tokensForLP, bnbForLP)`, `FlatCurveLaunched(token, flatCurve, hardCap)`.
- **LumoriaHook** (every trade, any router): `TokenPurchased(token, buyer, bnbIn, platformFee, taxTaken, tokensOut, sqrtPriceX96, tick)`, `TokenSold(token, seller, tokensIn, platformFee, taxTaken, bnbOut, sqrtPriceX96, tick)`, `LumoriaPoolInitialized(token, poolId)`. The trailing `sqrtPriceX96`/`tick` are the post-swap pool mark — the OHLC source.
- **LiquidityVault**: `PoolInitialized(token, poolId, sqrtPriceX96)`, `LiquidityLocked(token, bnbAmount, tokenAmount, liquidity, totalLocked)`.
- **FeeReceiver**: `FeeReceived(from, amount)`, `TokenFeeReceived(token, amount)`, `FeesWithdrawn(recipient, amount)`, `RecipientUpdated(old, new)`.
- **TaxHandler** (per token): `BuyTaxDistributed(token, amount, buyer=0x0)`, `SellTaxDistributed(token, amount, seller=0x0)`, `ShareUpdated(holder, old, new)`, `ModuleAdded(type, addr, buyAlloc, sellAlloc)`, `ModuleRemoved(type, addr)`, `ModuleUpdated(type, addr, buyAlloc, sellAlloc)`, `FeesUpdated(oldBuy, newBuy, oldSell, newSell)`, `FeeChangeProposed(newBuy, newSell, effectiveTime)`, `FeeChangeCancelled()`, `ModuleChangeProposed(changeType, type, buyAlloc, sellAlloc, effectiveTime)`, `ModuleRebalanceProposed(indices[], buyAllocs[], sellAllocs[])`, `ModuleChangeCancelled()`.
- **RebateContract**: `RebateFunded(token, creator, amount, rebateBps)`, `RebateToppedUp(token, amount, newBalance)`, `RebateCredited(token, buyer, tokenAmount)`, `RebateBpsUpdated(token, old, new)`, `RebateWithdrawn(token, amount)`, `RebateDeactivated(token)`, `CreditorUpdated(creditor, authorized)`.
- **Token** (per token, ERC20): `Transfer(from, to, value)`, `Approval(owner, spender, value)`.
- **RewardModule**: `TaxReceived(amount)`, `DividendsDistributed(rewardAmount, bnbSpent)`, `RewardClaimed(holder, amount)`, `ShareUpdated(holder, old, new)`.
- **BurnModule**: `TaxReceived(amount, pendingBNB)`, `BurnExecuted(bnbSpent, tokensBurned, timestamp)`, `IntervalUpdated(old, new)`.
- **LiquidityModule**: `TaxReceived(amount, pendingBNB)`, `LiquidityAdded(bnbAmount, tokenAmount, lpTokens, timestamp)`, `IntervalUpdated(old, new)`.
- **CreatorFeeModule**: `TaxAccrued(recipient, amount, owedAfter)`, `TaxWithdrawn(recipient, amount)`, `RecipientUpdated(old, new)`. **Fees now ACCRUE, not push** — the recipient must call `withdraw()`. Reads: `owed(address)` = claimable, `totalAccrued` = lifetime earned, `totalPaid` = lifetime withdrawn.
- **FlatCurve**: `ContributionMade(contributor, gross, net, totalRaised)`, `ContributionRefunded(contributor, refund)`, `PlatformFeeTaken(amount)`, `RaiseLaunched(token, totalRaised, liquidityBNB, liquidityTokens, creatorBNB)`, `RaiseFailed(token, totalRaised)`, `TokensClaimed(contributor, tokenAmount)`.

---

*Self-contained: hand only this file to the frontend agent. Route any Type-B findings it returns to the contracts owner before deploy.*
