# Permanent Single-Sided V4 Launch — Integration Specification

**Status:** implemented and locally verified in the worktree; frontend feature flag remains disabled; no production deployment, pointer rotation, Goldsky change, or Vercel change has occurred  
**Scope:** add a third launch mode without changing the behavior of BYOL or Flat Curve  
**Proposed mode:** `SINGLE_SIDED = 2`  
**Target:** native-BNB / Lumoria-token pools on the existing canonical Uniswap V4 `PoolManager`

---

## 0. Decision statement

Lumoria will add a third, additive launch mode that creates a fresh token and
immediately commits 100% of its supply to one permanently locked, token-only
Uniswap V4 concentrated-liquidity position.

This is **not** a custom bonding-curve contract, auction, presale, graduation
system, or migration mechanism. The V4 pool created at launch is the permanent
market. It uses the existing `LumoriaHook`, zero V4 LP fee, the existing
platform fee, and the token's existing buy/sell tax configuration.

User-facing range:

```text
STARTING_PRICE  →  effectively infinite BNB per token
```

Internal V4 range, because the canonical pool is ordered as native BNB
(`currency0`) / token (`currency1`) and V4 encodes token-per-BNB:

```text
MIN_USABLE_TICK  →  startTick
```

The position starts at `startTick`, entirely denominated in the token. Buys
move the price toward `MIN_USABLE_TICK`, convert tokens into BNB, and make the
token more expensive in BNB terms. Sells reverse that path. There is no normal
sell-out or graduation event: the remaining token inventory approaches zero as
the price rises.

---

## 1. Goals

1. Add `SINGLE_SIDED = 2` while preserving:
   - `BYOL = 0`;
   - `FLAT_CURVE = 1`;
   - all existing payloads, events, and launch-fee behavior for modes 0 and 1.
2. Require no BNB liquidity from the creator beyond the existing flat launch
   fee.
3. Commit the entire token supply to one standard V4 position in the launch
   transaction.
4. Open the existing Lumoria trading path immediately after deployment.
5. Keep all liquidity permanently locked.
6. Reuse the deployed `LumoriaHook` and existing tax/module flow.
7. Prevent later liquidity additions to single-sided launch pools through the
   authorized Lumoria vault.
8. Preserve existing token pages, liquidity statistics, BYOL launches, Flat
   Curve launches, and module operations during the infrastructure cutover.
9. Make the on-chain effective starting price deterministic and visible before
   wallet confirmation.

## 2. Non-goals

- No custom swap curve or custom-accounting hook.
- No presale, contribution window, hard cap, refund, or claim phase.
- No graduation threshold or migration into another pool.
- No creator withdrawal of pool BNB.
- No change to the platform trade-fee formula.
- No change to per-token buy/sell tax behavior.
- No attempt to enforce Lumoria taxes in unrelated external pools. The token is
  still a clean ERC-20; the tax guarantee applies to the canonical hooked pool.
- No removal or renumbering of existing launch modes.
- No Database storage migration unless implementation proves one is necessary.
- No Hook redeployment unless fork testing finds an incompatibility that cannot
  be handled by the vault.

---

## 3. Backward-compatibility contract

The implementation is acceptable only if all of the following remain true.

### 3.1 Stable mode identifiers

```solidity
enum LaunchMode {
    BYOL,          // 0 — unchanged
    FLAT_CURVE,    // 1 — unchanged
    SINGLE_SIDED   // 2 — appended
}
```

The values must be appended, never reordered. Existing subgraph records,
frontend filters, transactions, and integrations depend on 0 and 1.

### 3.2 BYOL remains byte-for-byte equivalent in behavior

- Payload remains `abi.encode(uint256 tokensForLP)`.
- `msg.value` remains `launchFeeBnb + bnbForLP`.
- `bnbForLP` remains strictly greater than zero.
- Creator allocations remain supported.
- `BYOLLaunched(token, tokensForLP, bnbForLP)` remains unchanged.
- Liquidity remains full-range and permanently locked.

### 3.3 Flat Curve remains byte-for-byte equivalent in behavior

- Payload remains the existing nine `uint256` values.
- `msg.value` remains exactly `launchFeeBnb`.
- Creator allocations remain supported.
- The existing FlatCurve clone, contribution, refund, launch, and claim state
  machine remains unchanged.
- `FlatCurveLaunched(token, flatCurve, hardCap)` remains unchanged.
- A successful raise still creates full-range, two-sided permanent liquidity.

### 3.4 Shared infrastructure remains compatible

The new vault must continue implementing the existing
`ILumoriaLiquidityVault.addLiquidityLocked` selector. The existing router,
FlatCurve, Generator BYOL branch, LiquidityModule, and integrations must not
need a new selector for their existing paths.

The existing hook reads `Database.liquidityVault()` live. After cutover it will
authorize the new vault. The new vault therefore becomes responsible for both:

- the existing full-range path used by BYOL, Flat Curve, and LiquidityModule;
- the new permanent single-sided initialization path.

---

## 4. Standard V4 mechanism

### 4.1 Pool identity is unchanged

```solidity
PoolKey({
    currency0: Currency.wrap(address(0)),
    currency1: Currency.wrap(token),
    fee: 0,
    tickSpacing: 60,
    hooks: IHooks(database.hook())
})
```

This is the same key used by the current hook, router, and vault. No parallel
pool, alternate fee tier, or alternate hook is introduced.

### 4.2 Position shape

The position is:

```text
tickLower = MIN_USABLE_TICK
tickUpper = startTick
current tick at initialization = startTick
```

Where:

```solidity
MIN_USABLE_TICK = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
```

At the exact upper boundary, the position is out of range and entirely
`currency1`, which is the Lumoria token. A BNB-to-token buy moves leftward in
V4's internal price orientation, crosses into the position, and activates its
liquidity.

V4's minimum tick is finite, but the corresponding user-facing BNB-per-token
price is astronomically high. Product copy may say “starting price to
effectively infinity,” but technical documentation must say “to the minimum
usable V4 tick.”

### 4.3 Launch transaction

The entire operation remains atomic:

1. Clone the token deterministically.
2. Clone and initialize its TaxHandler and modules.
3. Initialize the token; the Generator receives the full 1 billion supply.
4. Register the token in Database.
5. Charge the existing flat launch fee.
6. Validate the single-sided launch payload and module restrictions.
7. Transfer the full token supply to the current liquidity vault.
8. The vault verifies the canonical pool is uninitialized.
9. The vault initializes the pool at `sqrtPrice(startTick)`.
10. The vault adds one `[MIN_USABLE_TICK, startTick]` position using tokens only.
11. Any unavoidable integer-rounding dust is permanently accounted for under
    the dust policy in §6.6.
12. Emit the vault and Generator launch events.
13. Emit the existing `ProjectGenerated(..., launchMode = 2)` event.

Any failure reverts token creation, registration, fee transfer, pool
initialization, and position creation together.

### 4.4 Trading after launch

No special trading endpoint is introduced.

**Buy:**

1. User supplies gross BNB through the existing router or another V4 router.
2. `LumoriaHook.beforeSwap` takes the platform fee and buy tax.
3. Net BNB enters the V4 position.
4. Tokens leave the position for the buyer.
5. The post-swap price and trade are emitted by the existing hook.

**Sell:**

1. Seller supplies tokens.
2. The position releases gross BNB.
3. `LumoriaHook.afterSwap` takes the platform fee and sell tax.
4. Net BNB reaches the seller.
5. Tokens return to the position and the price moves toward the starting price.

The BNB accumulated by buys is position principal. It is not a creator raise,
is never transferred to the creator, and has no withdrawal path.

---

## 5. Starting-price representation

### 5.1 Canonical payload

Recommended V1 payload:

```solidity
abi.encode(int24 startTick)
```

Use an aligned tick as the canonical on-chain input rather than accepting an
arbitrary decimal price or raw `sqrtPriceX96`.

Reasons:

- the pool already fixes `tickSpacing = 60`;
- all effective prices are tick-rounded anyway;
- a tick is deterministic and compact;
- the contract can validate it without logarithmic price conversion;
- the preview can show the exact price the transaction will create.

### 5.2 Validation

The vault must require:

- `startTick % TICK_SPACING == 0`;
- `startTick > MIN_USABLE_TICK`;
- `startTick <= MAX_USABLE_TICK`;
- the computed liquidity is nonzero and fits `uint128`;
- the pool has not been initialized;
- the token is registered as a Lumoria token;
- the token has not previously used the single-sided initialization path.

The Generator additionally enforces conservative platform-level minimum and
maximum starting-price bounds. Those limits protect users from unusably low
liquidity depth, accidental unit inversion, and values at the edge of TickMath.
They live on Generator V2 as `singleSidedMinStartTick` /
`singleSidedMaxStartTick` (read both with `singleSidedStartTickBounds()`), are
tunable by `Database.owner()` through `setSingleSidedStartTickBounds`, and
default to ticks `148_200..196_260`, i.e. a starting FDV between roughly
3 BNB and 366 BNB (about $2k to $250k at ~$690/BNB). A lower tick is a
higher FDV (`fdvBnb = 1e9 / 1.0001^tick`). Out-of-window launches revert with
`"Gen: start tick out of bounds"`; the vault's wider TickMath window is not the
product limit. The defaults are sensible starting values, not a final
economic decision — retune without redeploying as BNB moves.

### 5.3 Frontend conversion

The user should not type a tick. The UI accepts one of:

- starting price in BNB per token; or preferably
- starting fully diluted value in BNB, because total supply is fixed at 1B.

Conversion must account for pool orientation:

```text
userPrice = BNB / token
poolPrice = token / BNB = 1 / userPrice
```

The result is rounded to the nearest permitted tick according to an explicitly
documented direction. The preview must show:

- requested starting price/FDV;
- actual tick-rounded starting price/FDV;
- rounding difference;
- total token amount committed;
- initial BNB principal: zero;
- launch fee;
- buy and sell fee stack.

---

## 6. Contract changes

### 6.1 `contracts/interfaces/IGenerator.sol`

Changes:

1. Append `SINGLE_SIDED` to `LaunchMode`.
2. Add a new event without changing existing events:

```solidity
event SingleSidedLaunched(
    address indexed token,
    int24 startTick,
    uint160 sqrtPriceX96,
    uint256 tokenAmountCommitted,
    uint128 liquidity
);
```

The existing `generateProject` signature remains unchanged. The launch payload
continues to be mode-specific bytes.

### 6.2 `contracts/Generator.sol` → Generator V2 deployment

The contract is not a proxy. Build and deploy a new Generator implementation,
then rotate `Database.generator` after verification.

The two existing branches should be copied without behavioral edits. Add an
explicit third branch; do not use a catch-all `else` for Flat Curve.

Recommended dispatch:

```solidity
if (launchMode == LaunchMode.BYOL) {
    _launchBYOL(...);                       // unchanged
} else if (launchMode == LaunchMode.FLAT_CURVE) {
    require(msg.value == launchFee, "Gen: no BNB on FLAT_CURVE");
    _launchFlatCurve(...);                  // unchanged
} else if (launchMode == LaunchMode.SINGLE_SIDED) {
    require(msg.value == launchFee, "Gen: no BNB on SINGLE_SIDED");
    _launchSingleSided(...);
} else {
    revert("Gen: bad launch mode");
}
```

`_launchSingleSided` responsibilities:

1. Decode `int24 startTick`.
2. Require `allocations.length == 0`.
3. Reject an initial LiquidityModule (`moduleType == 2`).
4. Confirm the configured vault supports the new interface.
5. Transfer `TOTAL_SUPPLY` to the vault.
6. Call `initializeSingleSided(token, startTick)`.
7. Emit `SingleSidedLaunched` with the effective values returned by the vault.

The creator receives zero tokens at launch. Creator ownership of metadata and
TaxHandler management remains unchanged.

### 6.3 `contracts/interfaces/ILumoriaLiquidityVault.sol`

Preserve every existing selector and add:

```solidity
function initializeSingleSided(address token, int24 startTick)
    external
    returns (
        uint256 tokenAmount,
        uint128 liquidity,
        uint160 sqrtPriceX96
    );

function isSingleSided(address token) external view returns (bool);

function singleSidedPosition(address token)
    external
    view
    returns (
        int24 tickLower,
        int24 tickUpper,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 tokenAmount,
        uint256 dustBurned
    );
```

The final interface may return a struct if that improves ABI ergonomics, but the
stored facts and behavior must remain the same.

### 6.4 `contracts/v4/LumoriaLiquidityVault.sol` → Vault V2 deployment

The current vault is not upgradeable and requires nonzero BNB plus full-range
liquidity. Deploy a new vault that supports both legacy and single-sided paths.

It must preserve the existing constructor dependencies:

- canonical PoolManager;
- Database.

It should also receive the old vault address as an immutable `legacyVault` for
historical-stat aggregation.

New storage, conceptually:

```solidity
address public immutable legacyVault;

mapping(address => bool) internal _isSingleSided;
mapping(address => SingleSidedPosition) internal _singleSidedPositions;

mapping(address => uint128) internal _newLockedLiquidity;
mapping(address => uint256) internal _newTotalBnbLocked;
mapping(address => uint256) internal _newTotalTokensLocked;
```

The existing public analytics selectors must return legacy plus new values:

```text
lockedLiquidity(token)  = oldVault.lockedLiquidity(token)  + V2 additions
totalBnbLocked(token)    = oldVault.totalBnbLocked(token)    + V2 additions
totalTokensLocked(token) = oldVault.totalTokensLocked(token) + V2 additions
```

This is required so switching `Database.liquidityVault()` does not make old
token pages appear to lose their locked liquidity.

### 6.5 Legacy full-range path in Vault V2

`addLiquidityLocked` must retain current behavior for ordinary tokens:

- router-only;
- nonzero BNB and token amounts;
- lazy pool initialization at the implied ratio;
- full-range position;
- dust refund;
- existing event semantics;
- no removal path.

Add one new guard:

```solidity
if (_isSingleSided[token]) revert AdditionalLiquidityDisabled();
```

This ensures BYOL, Flat Curve, and LiquidityModule continue working while a
single-sided launch remains one position.

### 6.6 Single-sided path in Vault V2

`initializeSingleSided` must:

1. Be callable only by `Database.generator()`.
2. Be non-reentrant.
3. Require `msg.value == 0`.
4. Require the token is registered.
5. Require `_isSingleSided[token] == false`.
6. Require the canonical pool is uninitialized (`sqrtPriceX96 == 0`).
7. Validate and store the mode before external calls.
8. Compute `sqrtPriceX96 = TickMath.getSqrtPriceAtTick(startTick)`.
9. Initialize the canonical pool at that value.
10. Compute the maximum liquidity supportable by the vault's full token
    balance over `[MIN_USABLE_TICK, startTick]` using the standard Uniswap
    `LiquidityAmounts` library.
11. Add that position through `PoolManager.unlock` and settle token only.
12. Assert the BNB delta is exactly zero.
13. Record the position and aggregate analytics.
14. Emit a dedicated event.

Recommended vault event:

```solidity
event SingleSidedPositionLocked(
    address indexed token,
    PoolId indexed poolId,
    int24 tickLower,
    int24 tickUpper,
    uint160 sqrtPriceX96,
    uint256 tokenAmount,
    uint128 liquidity,
    uint256 dustBurned
);
```

**Rounding dust policy:** liquidity conversion may leave a tiny token remainder.
The implementation must not refund it to the creator. Preferred policy:

1. maximize liquidity without exceeding the available token balance;
2. burn the remainder from the vault;
3. emit `dustBurned`;
4. assert the vault holds no unaccounted token balance after completion.

This makes 100% of the final circulating supply position-backed while avoiding
a creator-controlled dust recovery path.

### 6.7 `contracts/v4/LumoriaHook.sol`

**Planned change: none.**

The hook already:

- validates the canonical PoolKey;
- allows only `Database.liquidityVault()` to initialize or add liquidity;
- permanently rejects removal;
- rejects donations;
- taxes exact-input buys and sells in BNB;
- reads the current TaxHandler and platform configuration live;
- emits post-swap price and trade data.

The hook does not assume full-range liquidity. The new position is therefore an
ordinary V4 position from the hook's perspective.

If testing discovers a Hook change is required, stop and rescope. A new hook
address creates a different PoolKey and would be a materially larger migration.

### 6.8 `contracts/v4/LumoriaSwapRouter.sol`

**Planned change: none.**

The current buy path already uses:

```solidity
sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
```

That is the correct direction for BNB-to-token buys across the proposed
position. The current sell path also moves in the correct reverse direction.

Required tests must prove:

- the first buy crosses from the exact upper boundary into active liquidity;
- exact-input accounting settles correctly;
- extremely large buys either execute or revert atomically without stranded
  deltas;
- V4Quoter returns usable values from the initial boundary;
- ordinary and third-party-router swaps retain identical tax behavior.

Only add Router V2 if one of these tests demonstrates a real incompatibility.

### 6.9 `contracts/Database.sol`

**Planned code change: none.**

Deployment uses existing owner setters:

- `setLiquidityVault(VaultV2)`;
- `setGenerator(GeneratorV2)`.

Launch-mode-specific state lives in Vault V2 and in emitted events. Avoiding a
Database redeploy keeps every registered token and infrastructure reference
intact.

### 6.10 `contracts/TaxHandler.sol` and modules

**Planned core change: none.**

The Generator must reject LiquidityModule type 2 for a single-sided launch.
Other shipped modules remain compatible:

- RewardModule: compatible;
- BurnModule: compatible;
- CreatorFeeModule: compatible;
- PrizePool: compatible;
- MilestoneRewardModule: compatible.

Rebate funding remains technically possible later, but the creator owns no
tokens at launch. They would need to buy tokens before funding the rebate
contract. The launch UI must not promise a pre-funded token rebate.

Post-launch module addition is a caveat. An existing TaxHandler can propose a
LiquidityModule later. Vault V2 will still prevent that module from adding
liquidity, so the market invariant is safe, but the module would be unusable.
The frontend must hide/disable that option for mode 2. A future TaxHandler
master-copy guard may be added separately if on-chain rejection is required;
it is not necessary to protect pool liquidity.

---

## 7. On-chain invariants

The implementation and tests must establish:

1. **Mode stability:** BYOL is 0, Flat Curve is 1, Single Sided is 2.
2. **Fresh pool:** a single-sided launch reverts if its canonical pool is
   already initialized.
3. **Zero-BNB seed:** initial position creation consumes exactly zero BNB.
4. **Full commitment:** all final token supply is either in the position or
   burned as bounded rounding dust.
5. **One position policy:** the authorized vault cannot add a second position
   for a mode-2 token.
6. **No removal:** no caller, including the vault, can remove liquidity.
7. **No donation:** PoolManager donation remains disabled.
8. **Correct starting price:** slot0 equals the sqrt price derived from the
   emitted aligned start tick.
9. **Price direction:** buys increase BNB-per-token price; sells decrease it.
10. **Tax preservation:** buy and sell platform/token tax math is unchanged.
11. **Router independence:** raw PoolManager-compatible routes remain taxed.
12. **Permanent pool:** no migration, graduation, or creator withdrawal path
    exists.
13. **Legacy behavior:** all mode-0 and mode-1 tests remain green unchanged.
14. **Historical analytics:** old tokens retain their locked-liquidity totals
    after the Database vault pointer is rotated.
15. **Admin trust disclosure:** the Database owner can still rotate the
    authorized vault. “No additional liquidity” is enforced by the configured
    Vault V2, not immutable against a future malicious Database owner.

---

## 8. Creator allocations and token ownership

Single-sided V1 is deliberately strict:

```text
100% initial supply → permanent V4 position
0% → creator wallet
0% → immediate allocations
0% → vesting schedules
0% → pre-funded rebate inventory
```

Therefore:

- `allocations.length` must be zero for mode 2;
- the frontend must hide the allocation editor or display it as unavailable;
- the preview must state that the creator receives no token allocation;
- metadata and TaxHandler management still belong to the creator;
- creator revenue can still be received through CreatorFeeModule;
- users, including the creator, may acquire tokens through the market normally.

Allowing a configurable pool percentage later would be a separate mode/version.
It should not weaken the 100%-commitment promise of this mode.

---

## 9. Frontend integration

Primary repository: `control-project-x-v0`.

### 9.1 Domain and form model

Update:

- `lib/domain.ts` → add `SINGLE_SIDED: 2` and the display label;
- `lib/launch/form.ts` → add a discriminated single-sided configuration with
  requested start FDV/price and canonical `startTick`;
- `lib/launch/payloads.ts` → encode exactly `abi.encode(int24 startTick)`;
- `lib/launch/orchestration.ts` → mode 2 sends exactly the current launch fee;
- budget helpers → mode 2 commits total supply and has no creator remainder;
- validation → allocations empty, no LiquidityModule, valid bounded aligned
  tick.

Avoid binary `BYOL ? ... : FLAT_CURVE` branches. Convert every launch-mode
conditional to an explicit three-mode switch so mode 2 cannot accidentally be
treated as Flat Curve.

### 9.2 Launch strategy UI

Add a third option:

```text
Permanent Single-Sided
Launch with 100% of supply in permanently locked V4 liquidity and no initial BNB.
```

Mode-2 controls:

- starting FDV in BNB, or starting BNB/token price;
- exact rounded value preview;
- fee summary;
- permanent 100% supply commitment disclosure.

Do not show:

- presale dates;
- hard cap;
- min/max contribution;
- creator liquidity BNB;
- token allocation split;
- graduation or migration progress.

### 9.3 Preview and confirmation

Required confirmation copy:

- “100% of the final token supply will be committed to one permanently locked
  V4 position.”
- “The pool begins with zero BNB. BNB principal accumulates as users buy.”
- “There is no graduation, migration, or liquidity withdrawal.”
- “The effective starting price is tick-rounded to X.”
- “The creator receives no initial token allocation.”

### 9.4 Token, manage, and discover pages

- Add a `Permanent Single-Sided` launch label.
- Do not fall back to BYOL for unknown nonzero modes.
- Show initial/effective starting price, current price, BNB principal, remaining
  pool token balance, and permanent-lock status.
- Hide Flat Curve contribution UI for mode 2.
- Hide BYOL seed controls for mode 2.
- Hide LiquidityModule add/manage actions for mode 2.
- Keep normal buy/sell, chart, fee, holder, module, and management views.
- Add mode 2 to Discover filters.

### 9.5 ABI and generated references

- Extract the Generator V2 and Vault V2 ABIs.
- Preserve all old selectors and events in generated references.
- Update deployment constants only after on-chain cutover values are known.
- Regenerate `REF_LAUNCH`, subgraph schema references, and integration docs.

---

## 10. Subgraph integration

### 10.1 Schema

At minimum, add a `SingleSidedLaunch` entity linked one-to-one with `Token`:

```graphql
type SingleSidedLaunch @entity {
  id: ID!                       # token address
  token: Token!
  poolId: Bytes!
  tickLower: Int!
  tickUpper: Int!
  sqrtPriceX96: BigInt!
  startingPriceBnbPerToken: BigDecimal!
  startingFdvBnb: BigDecimal!
  tokenAmountCommitted: BigInt!
  liquidity: BigInt!
  dustBurned: BigInt!
  launchedAt: BigInt!
  launchedAtBlock: BigInt!
}
```

Update the existing Token comment and client types:

```text
launchMode: 0 BYOL, 1 FlatCurve, 2 Permanent Single-Sided
```

### 10.2 Data sources

Keep old static data sources for historical replay and add:

- Generator V2 at its deployment block;
- Vault V2 at its deployment block.

Do not replace the old addresses in a way that drops old launch or liquidity
events during a full reindex.

### 10.3 Handlers

- `ProjectGenerated` continues setting `Token.launchMode`.
- `SingleSidedLaunched` creates/initializes the mode-specific record.
- `SingleSidedPositionLocked` fills the authoritative pool/tick/liquidity/dust
  fields.
- Existing hook trade handlers remain unchanged.
- Existing BYOL and Flat Curve handlers remain unchanged.

### 10.4 Metrics semantics

At launch:

- BNB principal is zero;
- token-side committed liquidity is the full final supply;
- price exists because slot0 is initialized, even before the first trade;
- volume is zero;
- the market is tradable after the transaction is confirmed.

Do not label zero initial BNB as “unfunded,” “not launched,” or “no liquidity.”

---

## 11. Deployment and cutover plan

No live addresses change until all local and BSC-fork tests pass.

### Phase A — build and verify locally

1. Implement Vault V2 with the unchanged legacy path and new seed path.
2. Implement Generator V2 with explicit three-mode dispatch.
3. Update interfaces, deployment scripts, verification scripts, and artifacts.
4. Add full unit/integration/invariant coverage.
5. Update frontend and subgraph behind a disabled feature flag.

### Phase B — BSC production-state fork rehearsal

Fork from a recent BSC block and impersonate the Database owner only in the
test environment.

1. Deploy Vault V2 with the live Database, PoolManager, and old vault.
2. Deploy Generator V2.
3. Set `Database.liquidityVault(VaultV2)` on the fork.
4. Prove a new BYOL launch still succeeds.
5. Prove a new Flat Curve can be created and finalized successfully.
6. Prove LiquidityModule can add to an existing non-mode-2 pool through V2.
7. Confirm old token liquidity views equal their pre-cutover values.
8. Set `Database.generator(GeneratorV2)`.
9. Launch a mode-2 token and execute real buy/sell flows through the live
   canonical PoolManager.
10. Confirm all event payloads and subgraph handlers against fork receipts.

### Phase C — production deployment

Recommended order:

1. Deploy and verify Vault V2.
2. Deploy and verify Generator V2.
3. Deploy the new subgraph version with old and new data-source addresses;
   verify it is healthy and synced.
4. Update frontend ABIs/constants but keep mode 2 feature-flagged off.
5. Call `Database.setLiquidityVault(VaultV2)`.
6. Immediately smoke-test existing reads and a minimal legacy-mode liquidity
   operation.
7. Call `Database.setGenerator(GeneratorV2)`.
8. Run BYOL and Flat Curve smoke tests.
9. Run one controlled single-sided canary launch with conservative fees and
   starting price.
10. Buy and sell the canary through the production UI and a raw V4-compatible
    route.
11. Confirm Goldsky entities, candles, platform metrics, and liquidity views.
12. Enable the frontend feature flag.

### Phase D — rollback posture

Before the first mode-2 launch, both pointers can be restored to the old
contracts.

After the first mode-2 launch:

- trading does not depend on the Generator or vault pointer, so existing
  single-sided pools continue to trade;
- disable new mode-2 launches by hiding the feature and rotating the Generator
  back if necessary;
- keep Vault V2 configured unless the incident specifically requires otherwise,
  because it owns the new positions and aggregates historical analytics;
- never attempt to move or remove liquidity—the hook prohibits it.

---

## 12. Required test plan

### 12.1 Generator V2

- enum values remain 0, 1, 2;
- BYOL success and every existing BYOL revert case remain unchanged;
- Flat Curve success and every existing Flat Curve revert case remain unchanged;
- mode 2 requires exactly the launch fee;
- mode 2 rejects extra BNB;
- mode 2 rejects allocations;
- mode 2 rejects initial LiquidityModule type 2;
- mode 2 transfers the full supply to Vault V2;
- mode 2 emits the new event plus unchanged common events;
- invalid/unsupported launch modes revert explicitly;
- deterministic address prediction remains unchanged.

### 12.2 Vault V2 legacy regression

- existing two-sided first initialization matches current math;
- subsequent full-range additions work;
- only Router can call legacy add;
- dust refunds match current behavior;
- analytics equal old values plus V2 additions;
- existing tokens can receive new full-range liquidity after cutover;
- the old vault cannot add after the Database pointer changes;
- no removal path exists.

### 12.3 Single-sided initialization

- only current Generator can call;
- registered fresh token required;
- zero BNB required;
- aligned and bounded start tick required;
- preinitialized pool rejected;
- second initialization rejected;
- position bounds exactly equal minimum usable tick and start tick;
- slot0 starts at the emitted sqrt price;
- BNB consumed equals zero;
- token amount plus dust burned equals pre-seed total supply;
- vault has no unexplained token balance;
- legacy `addLiquidityLocked` reverts for the mode-2 token;
- direct PoolManager additions still fail the hook gate;
- removal and donation always revert.

### 12.4 Trading and tax integration

- first buy from exact upper-bound initialization succeeds;
- first buy pays exact platform and buy tax;
- first buy outputs tokens and increases BNB-per-token price;
- repeated buys are monotonic in the expected direction;
- sells pay exact platform and sell tax;
- sells restore token inventory and move price toward the start;
- Lumoria router preserves buyer/seller attribution;
- raw/third-party route remains taxed with zero-address attribution;
- rebate behavior is unchanged when funded later;
- V4Quoter returns correct post-fee amounts before the first trade;
- min-out and deadline protections remain effective;
- very large exact-input buys settle or revert atomically;
- round-trip behavior preserves pool solvency subject to fees and rounding.

### 12.5 Module compatibility

- CreatorFeeModule receives tax normally;
- RewardModule receives/distributes normally;
- BurnModule can buy and burn normally;
- PrizePool ticket/event flow remains intact;
- MilestoneRewardModule remains intact;
- initial LiquidityModule selection is rejected for mode 2;
- a post-launch LiquidityModule cannot add liquidity to mode 2;
- all modules remain available for BYOL and Flat Curve.

### 12.6 Frontend and subgraph

- form/payload tests cover all three modes explicitly;
- no binary fallback interprets mode 2 as Flat Curve or BYOL;
- exact tick-rounding fixtures cover normal and boundary prices;
- wallet value is correct for each mode;
- mode-2 receipt parser identifies common and specific events;
- subgraph replay preserves historical mode 0/1 entities;
- mode-2 entity is complete at launch;
- initial price exists before first trade;
- Discover filters and labels work for all modes;
- platform metrics do not count pool initialization as trade volume.

### 12.7 Security testing

- reentrancy attempts through token, fee receiver, and callbacks;
- malicious direct vault calls;
- duplicate/crafted initialization;
- price inversion and tick-boundary fuzzing;
- maximum supply and `uint128` liquidity bounds;
- one-wei and dust-rounding cases;
- raw PoolManager bypass attempts;
- admin pointer-change scenarios;
- invariant/fuzz testing for zero-BNB seed, no removal, no second liquidity,
  and exact tax accounting.

---

## 13. Security and trust notes

### 13.1 No-extra-liquidity promise

Vault V2 can enforce one position for mode 2. The hook also blocks direct
third-party liquidity changes by requiring the current Database vault.

However, Database ownership can rotate `liquidityVault` to another address.
Therefore the strongest honest statement under the current architecture is:

> The configured Lumoria Vault V2 permanently rejects additional liquidity for
> this token, and the Lumoria hook rejects all other liquidity providers and all
> removals. The platform owner retains the existing ability to rotate system
> infrastructure.

An immutable guarantee against the Database owner would require a new hook or
renouncing/limiting Database control, which is outside this additive scope.

### 13.2 External pools

Lumoria taxes cannot be bypassed within the canonical hooked pool. Because the
token has clean ERC-20 transfers, holders can create unrelated pools elsewhere.
Those external pools do not use LumoriaHook and are outside the tax guarantee.

### 13.3 MEV and first-buy ordering

The lowest price is available to the first buyer. This is normal permissionless
AMM behavior and can attract sniping. No anti-bot mechanism is included because
the current hook is reused unchanged and router-only restrictions would be
bypassable through another V4 router.

If first-block restrictions are required, that is a hook-level feature and must
be scoped separately before implementation.

### 13.4 Starting-price safety

The UI and contracts must prevent accidental token/BNB inversion and absurd
ticks. Display the exact rounded starting FDV before signature. The canary
launch must use a reviewed value and low tax configuration. On-chain, the
Generator's owner-tunable start-tick window (§5.2) rejects inverted or absurd
values; the smoke script refuses a `SINGLE_SIDED_START_TICK` outside it.

### 13.5 Empty-range price marks

A mode-2 position covers `[MIN_USABLE_TICK, startTick]` only. A raw V4 router
that settles just the consumed amount can push `slot0` above `startTick` with
a zero-fill sell: no funds move and no tax is owed, but the hook's `TokenSold`
then reports a near-`MAX_SQRT_PRICE` mark. The Lumoria router cannot do this
(it settles `amountIn` up front). The subgraph clamps the derived pool mark
and candles to the starting price for single-sided tokens whenever the
reported `sqrtPriceX96` exceeds the launch value (`clampSingleSidedMark`);
`Trade` rows keep the raw event values. Rejecting the swap on-chain would
require a new hook (the hook address is part of every PoolKey), so it is
deliberately handled off-chain.

### 13.6 Post-launch LiquidityModule

The Generator rejects a LiquidityModule at launch; the `LiquidityModule`
master additionally refuses `__init__` for any token the configured vault
reports as single-sided (`"Single-sided token"`), so the creator's
`proposeModuleAdd` → `executeModuleChange` path cannot strand BNB in a module
whose `executeLiquidity` the vault will always reject. The master tolerates a
legacy vault without `isSingleSided` (treated as not single-sided), so it may
be rotated with `Database.setModuleMasterCopy(2, ...)` in the same cutover
batch.

---

## 14. Observability and operations

Monitor:

- single-sided launch success/revert rate;
- first-buy success rate;
- start tick and actual initialized price;
- token amount committed and dust burned;
- BNB principal accumulated;
- token inventory remaining in PoolManager;
- price and volume from existing hook events;
- attempted additional-liquidity reverts;
- subgraph lag and `_meta.hasIndexingErrors`;
- discrepancies between legacy+V2 vault views and indexed totals.

Alert on:

- any mode-2 launch consuming nonzero BNB during position creation;
- any second `ModifyLiquidity` event for a mode-2 pool;
- any mode-2 pool without the expected `SingleSidedPositionLocked` event;
- any old token whose reported locked liquidity decreases after cutover;
- any trade that succeeds without expected hook fee events.

---

## 15. Work breakdown

### Contract package

- [ ] Extend `IGenerator` enum/event definitions.
- [ ] Extend `ILumoriaLiquidityVault`.
- [ ] Build Vault V2 with legacy aggregation and both liquidity paths.
- [ ] Build Generator V2 with explicit three-mode dispatch.
- [ ] Update fixture deployment and helpers.
- [ ] Update BSC deployment/verification artifacts.
- [ ] Add unit, integration, fork, and invariant tests.

### Subgraph

- [ ] Add Generator V2 and Vault V2 ABIs/data sources.
- [ ] Add single-sided schema and handlers.
- [ ] Preserve legacy sources for replay.
- [ ] Update generated schema/reference documentation.
- [ ] Deploy a new Goldsky version and verify full sync.

### Frontend

- [ ] Add launch mode 2 to domain types and filters.
- [ ] Add start-FDV/price-to-tick conversion with test fixtures.
- [ ] Add mode-specific payload/value calculation.
- [ ] Add strategy, preview, confirmation, and receipt states.
- [ ] Disable allocations and LiquidityModule for mode 2.
- [ ] Add token/manage/discover mode-2 presentations.
- [ ] Update extracted ABIs and deployment addresses.
- [ ] Add feature flag and production canary controls.

### Documentation and operations

- [ ] Update `DESIGN.md`, `ROADMAP.md`, `FRONTEND.md`, `SUBGRAPH.md`, and
  `TESTING.md` as implementation lands.
- [ ] Add the BSC-fork cutover rehearsal to `LAUNCH.md`.
- [ ] Document production addresses and cutover block.
- [ ] Add monitoring for launch and liquidity invariants.
- [ ] Obtain security review before enabling public launches.

---

## 16. Acceptance criteria

The feature is complete only when:

1. A creator can choose BYOL, Flat Curve, or Permanent Single-Sided.
2. Existing BYOL and Flat Curve tests and production behavior remain unchanged.
3. A mode-2 launch pays only the flat launch fee and seeds zero BNB.
4. Its full final supply is committed to one locked standard V4 position.
5. The first buy succeeds through the current swap router and pays existing
   taxes exactly.
6. A sell reverses through the same position and pays existing taxes exactly.
7. No graduation, migration, or liquidity-removal path exists.
8. Vault V2 rejects all later liquidity additions for the mode-2 token.
9. Old token locked-liquidity views remain correct after vault rotation.
10. The subgraph is healthy, caught up, and exposes complete mode-2 data.
11. The frontend shows exact tick-rounded start price and the permanent 100%
    commitment before signature.
12. A production-state BSC fork and controlled mainnet canary both pass.
13. Security review has no unresolved critical/high finding in Generator V2,
    Vault V2, or their PoolManager callback/settlement paths.

---

## 17. Recommended implementation order

1. Lock the remaining product parameters in §18.
2. Prototype only the Vault V2 single-sided mint in tests.
3. Prove first buy and sell with the unchanged hook/router.
4. Add Vault V2 legacy aggregation and regression tests.
5. Add Generator V2 mode 2 while preserving old branches.
6. Complete all contract and BSC-fork tests.
7. Update subgraph and verify historical replay.
8. Update frontend behind a feature flag.
9. Run a full production-state fork cutover rehearsal.
10. Security review.
11. Production deploy, legacy-mode smoke tests, controlled canary, then enable.

---

## 18. Remaining approval items

These are product parameters, not architectural unknowns:

- [ ] Final public name: recommended **Permanent Single-Sided**.
- [ ] Whether the creator enters starting price or starting FDV; recommended
  starting FDV in BNB with price shown underneath.
- [x] Minimum allowed starting FDV/price — default ≈ 3 BNB (tick 196_260),
  owner-tunable on Generator V2 (§5.2). Confirm or retune before the canary.
- [x] Maximum allowed starting FDV/price — default ≈ 366 BNB (tick 148_200),
  owner-tunable on Generator V2 (§5.2). Confirm or retune before the canary.
- [ ] Tick rounding direction and copy; recommended round conservatively and
  show the exact result before signature.
- [ ] Maximum permitted initial buy/sell tax for this launch mode, if different
  from the global TaxHandler limits.
- [x] Post-launch LiquidityModule is rejected on-chain by the new
  `LiquidityModule` master (§13.6) — no TaxHandler change needed; rotate with
  `setModuleMasterCopy(2, ...)`. The UI still hides the control.
- [ ] Exact wording of the Database-owner infrastructure-rotation disclosure.
- [ ] Canary token parameters and launch operator.

Everything else in this document can be implemented additively without
removing or redesigning BYOL or Flat Curve.
