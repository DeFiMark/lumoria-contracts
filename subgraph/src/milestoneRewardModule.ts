import {
  TaxReceived,
  RewardsReleased,
} from "../generated/templates/MilestoneRewardModule/MilestoneRewardModule";
import { Module, MilestoneRelease } from "../generated/schema";
import { eventId, nz } from "./helpers";

export function handleMilestoneTaxReceived(event: TaxReceived): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalReceivedBnb = m.totalReceivedBnb.plus(event.params.amount);
  m.save();
}

export function handleRewardsReleased(event: RewardsReleased): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalReleased = nz(m.totalReleased).plus(event.params.amount);
  m.lastReleaseTime = event.block.timestamp;
  m.save();

  let r = new MilestoneRelease(eventId(event));
  r.module = m.id;
  r.by = event.params.by;
  r.rewardModule = event.params.rewardModule;
  r.amount = event.params.amount;
  r.remaining = event.params.remaining;
  r.reason = event.params.reason;
  r.timestamp = event.block.timestamp;
  r.save();
}
