import {
  PoolInitialized,
  LiquidityLocked,
} from "../generated/LumoriaLiquidityVault/LumoriaLiquidityVault";
import { Token } from "../generated/schema";

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
