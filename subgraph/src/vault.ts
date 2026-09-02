import {
  PoolInitialized,
  LiquidityLocked,
  SingleSidedPositionLocked,
} from "../generated/LumoriaLiquidityVault/LumoriaLiquidityVault";
import { Token } from "../generated/schema";
import {
  getOrCreateSingleSidedLaunch,
  setSingleSidedStartingPrice,
} from "./singleSided";

export function handlePoolInitialized(event: PoolInitialized): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  token.poolId = event.params.poolId;
  token.save();
}

export function handleLiquidityLocked(event: LiquidityLocked): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  // totalLocked is cumulative (only ever grows — no removal path).
  token.totalLiquidityLocked = event.params.totalLocked;
  token.save();
}

export function handleSingleSidedPositionLocked(
  event: SingleSidedPositionLocked
): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return;

  let launch = getOrCreateSingleSidedLaunch(
    token,
    event.block.timestamp,
    event.block.number
  );
  launch.poolId = event.params.poolId;
  launch.tickLower = event.params.tickLower;
  launch.tickUpper = event.params.tickUpper;
  launch.tokenAmountCommitted = event.params.tokenAmount;
  launch.liquidity = event.params.liquidity;
  launch.dustBurned = event.params.dustBurned;
  setSingleSidedStartingPrice(launch, token, event.params.sqrtPriceX96);

  token.poolId = event.params.poolId;
  token.totalLiquidityLocked = event.params.liquidity;
  launch.save();
  token.save();
}
