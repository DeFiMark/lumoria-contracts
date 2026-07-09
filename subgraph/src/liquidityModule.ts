import {
  LiquidityAdded,
  IntervalUpdated,
} from "../generated/templates/LiquidityModule/LiquidityModule";
import { Module, LiquidityInjection } from "../generated/schema";
import { eventId, nz } from "./helpers";

export function handleLiquidityAdded(event: LiquidityAdded): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalLpLocked = nz(m.totalLpLocked).plus(event.params.lpTokens);
  m.lastExecuted = event.params.timestamp;
  m.save();

  let l = new LiquidityInjection(eventId(event));
  l.module = m.id;
  l.bnbAmount = event.params.bnbAmount;
  l.tokenAmount = event.params.tokenAmount;
  l.liquidity = event.params.lpTokens;
  l.timestamp = event.params.timestamp;
  l.save();
}

export function handleLiquidityIntervalUpdated(event: IntervalUpdated): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.interval = event.params.newInterval;
  m.save();
}
