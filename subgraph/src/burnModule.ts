import {
  BurnExecuted,
  IntervalUpdated,
} from "../generated/templates/BurnModule/BurnModule";
import { Module, BurnExecution } from "../generated/schema";
import { eventId, nz } from "./helpers";

export function handleBurnExecuted(event: BurnExecuted): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalBurned = nz(m.totalBurned).plus(event.params.tokensBurned);
  m.totalBnbSpent = nz(m.totalBnbSpent).plus(event.params.bnbSpent);
  m.lastExecuted = event.params.timestamp;
  m.save();

  let b = new BurnExecution(eventId(event));
  b.module = m.id;
  b.bnbSpent = event.params.bnbSpent;
  b.tokensBurned = event.params.tokensBurned;
  b.timestamp = event.params.timestamp;
  b.save();
}

export function handleBurnIntervalUpdated(event: IntervalUpdated): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.interval = event.params.newInterval;
  m.save();
}
