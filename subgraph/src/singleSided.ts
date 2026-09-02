import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { SingleSidedLaunch, Token } from "../generated/schema";
import { BD_18, ZERO_BD, ZERO_BI, poolPriceBnbPerToken } from "./helpers";

const EMPTY_POOL_ID = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
);

/**
 * Both V2 contracts emit in the launch transaction. The Vault log normally
 * arrives first, but either handler can bootstrap a complete entity so a
 * partial RPC replay never produces a non-null schema violation.
 */
export function getOrCreateSingleSidedLaunch(
  token: Token,
  timestamp: BigInt,
  blockNumber: BigInt
): SingleSidedLaunch {
  let launch = SingleSidedLaunch.load(token.id);
  if (launch == null) {
    launch = new SingleSidedLaunch(token.id);
    launch.token = token.id;
    launch.poolId = token.poolId === null
      ? EMPTY_POOL_ID
      : token.poolId as Bytes;
    launch.tickLower = 0;
    launch.tickUpper = 0;
    launch.sqrtPriceX96 = ZERO_BI;
    launch.startingPriceBnbPerToken = ZERO_BD;
    launch.startingFdvBnb = ZERO_BD;
    launch.tokenAmountCommitted = ZERO_BI;
    launch.liquidity = ZERO_BI;
    launch.dustBurned = ZERO_BI;
    launch.launchedAt = timestamp;
    launch.launchedAtBlock = blockNumber;
  }

  token.singleSidedLaunch = launch.id;
  token.launchMode = 2;
  return launch as SingleSidedLaunch;
}

/**
 * A mode-2 pool has NO liquidity above its start tick (the single position is
 * `[MIN_USABLE_TICK, startTick]`). A raw V4 router can still push slot0 into
 * that empty region with a zero-fill sell that consumes nothing, which would
 * otherwise print a near-zero token price as the pool mark. Any sqrtPrice
 * above the start price therefore means "every BNB has been drained", and
 * the honest mark for that state is the starting price itself. Trade
 * entities keep the raw values; only the derived mark/candles are clamped.
 * Full-range (mode 0/1) pools can never leave their range, so this is a no-op
 * for them.
 */
export function clampSingleSidedMark(token: Token, sqrtPriceX96: BigInt): BigInt {
  if (token.singleSidedLaunch === null) return sqrtPriceX96;
  let launch = SingleSidedLaunch.load(token.id);
  if (launch == null || launch.sqrtPriceX96.equals(ZERO_BI)) return sqrtPriceX96;
  return sqrtPriceX96.gt(launch.sqrtPriceX96) ? launch.sqrtPriceX96 : sqrtPriceX96;
}

/** Price exists as soon as slot0 is initialized, before the first trade. */
export function setSingleSidedStartingPrice(
  launch: SingleSidedLaunch,
  token: Token,
  sqrtPriceX96: BigInt
): void {
  let price = poolPriceBnbPerToken(sqrtPriceX96);
  launch.sqrtPriceX96 = sqrtPriceX96;
  launch.startingPriceBnbPerToken = price;
  launch.startingFdvBnb = price
    .times(token.totalSupply.toBigDecimal())
    .div(BD_18);
  // lastPriceBnb is the current pool mark, not merely a trade-derived value.
  token.lastPriceBnb = price;
}
