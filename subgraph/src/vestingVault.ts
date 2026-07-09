import {
  ScheduleCreated,
  TokensReleased,
} from "../generated/VestingVault/VestingVault";
import { VestingSchedule, VestingRelease } from "../generated/schema";
import { ZERO_BI, eventId, getOrCreateUser } from "./helpers";

export function handleScheduleCreated(event: ScheduleCreated): void {
  let id = event.params.id.toString();
  let vs = new VestingSchedule(id);
  vs.token = event.params.token.toHexString();
  vs.beneficiary = event.params.beneficiary;
  vs.user = getOrCreateUser(event.params.beneficiary).id;
  vs.total = event.params.total;
  vs.released = ZERO_BI;
  vs.start = event.params.start; // uint64 → BigInt
  vs.cliff = event.params.cliff;
  vs.duration = event.params.duration;
  vs.createdAt = event.block.timestamp;
  vs.save();
}

export function handleTokensReleased(event: TokensReleased): void {
  let id = event.params.id.toString();
  let vs = VestingSchedule.load(id);
  if (vs == null) return;
  vs.released = vs.released.plus(event.params.amount);
  vs.save();

  let vr = new VestingRelease(eventId(event));
  vr.schedule = id;
  vr.beneficiary = event.params.beneficiary;
  vr.amount = event.params.amount;
  vr.timestamp = event.block.timestamp;
  vr.save();
}
