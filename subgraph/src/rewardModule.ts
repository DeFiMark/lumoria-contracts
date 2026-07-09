import {
  TaxReceived,
  DividendsDistributed,
  RewardClaimed,
} from "../generated/templates/RewardModule/RewardModule";
import { Module, RewardClaim } from "../generated/schema";
import { eventId, nz } from "./helpers";

export function handleRewardTaxReceived(event: TaxReceived): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalReceivedBnb = m.totalReceivedBnb.plus(event.params.amount);
  m.save();
}

export function handleDividendsDistributed(event: DividendsDistributed): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalDividendsDistributed = nz(m.totalDividendsDistributed).plus(event.params.rewardAmount);
  m.save();
}

export function handleRewardClaimed(event: RewardClaimed): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let c = new RewardClaim(eventId(event));
  c.module = m.id;
  c.holder = event.params.holder;
  c.amount = event.params.amount;
  c.timestamp = event.block.timestamp;
  c.save();
}
