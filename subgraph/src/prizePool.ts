import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  TaxReceived,
  EpochLengthQueued,
  EpochLengthApplied,
  RootPosted,
  RootInvalidated,
  RandomnessFulfilled,
  PrizeClaimed,
  LotteryClaimed,
  PotRolledOver,
  DonatedToRewards,
} from "../generated/templates/PrizePool/PrizePool";
import { Module, PrizeClaim } from "../generated/schema";
import { eventId } from "./helpers";
import { advancePrizeEpoch, getOrCreatePrizeEpoch } from "./prize";

// Money buckets are keyed by the EVENT's epochId — authoritative — while the
// module's mirror fields advance alongside for ticket derivation.

export function handlePrizeTaxReceived(event: TaxReceived): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  advancePrizeEpoch(m, event.block.timestamp);

  let epoch = getOrCreatePrizeEpoch(m, event.params.epochId);
  epoch.pot = epoch.pot.plus(event.params.amount);
  epoch.save();

  m.totalReceivedBnb = m.totalReceivedBnb.plus(event.params.amount);
  m.save();
}

export function handleEpochLengthQueued(event: EpochLengthQueued): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.prizePendingEpochLength = event.params.newLength;
  m.save();
}

export function handleEpochLengthApplied(event: EpochLengthApplied): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  // The mirror applies the pending length itself at the boundary; this event
  // is the authoritative sync point in case the mirror drifted.
  m.prizeEpochLength = event.params.newLength;
  m.prizePendingEpochLength = BigInt.fromI32(0);
  m.prizeEpochId = event.params.epochId;
  m.save();
}

export function handleRootPosted(event: RootPosted): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let epoch = getOrCreatePrizeEpoch(m, event.params.epochId);
  epoch.root = event.params.root;
  epoch.totalWeight = event.params.totalWeight;
  epoch.ticketCount = event.params.ticketCount;
  epoch.rootPostedAt = event.block.timestamp;
  epoch.save();
}

export function handleRootInvalidated(event: RootInvalidated): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let epoch = getOrCreatePrizeEpoch(m, event.params.epochId);
  epoch.invalidated = true;
  epoch.save();
}

export function handleRandomnessFulfilled(event: RandomnessFulfilled): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let epoch = getOrCreatePrizeEpoch(m, event.params.epochId);
  epoch.randomWord = event.params.randomWord;
  epoch.save();
}

export function handlePrizeClaimed(event: PrizeClaimed): void {
  recordClaim(event, event.params.epochId, event.params.account, event.params.amount, null);
}

export function handleLotteryClaimed(event: LotteryClaimed): void {
  recordClaim(event, event.params.epochId, event.params.winner, event.params.amount, event.params.slot);
}

function recordClaim(
  event: ethereum.Event,
  epochId: BigInt,
  account: Address,
  amount: BigInt,
  slot: BigInt | null
): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let epoch = getOrCreatePrizeEpoch(m, epochId);
  epoch.paidOut = epoch.paidOut.plus(amount);
  epoch.save();

  let c = new PrizeClaim(eventId(event));
  c.epoch = epoch.id;
  c.account = account;
  c.amount = amount;
  c.slot = slot;
  c.timestamp = event.block.timestamp;
  c.save();
}

export function handlePotRolledOver(event: PotRolledOver): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;

  let from = getOrCreatePrizeEpoch(m, event.params.fromEpoch);
  // A sweep ("unclaimed") moves only the remainder of an epoch that settled
  // fine — it must NOT be marked rolled over.
  if (event.params.reason != "unclaimed") {
    from.rolledOver = true;
    from.rolloverReason = event.params.reason;
  }
  from.save();

  let to = getOrCreatePrizeEpoch(m, event.params.toEpoch);
  to.pot = to.pot.plus(event.params.amount);
  to.save();
}

export function handleDonatedToRewards(event: DonatedToRewards): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  let epoch = getOrCreatePrizeEpoch(m, event.params.epochId);
  epoch.settledAt = event.block.timestamp;
  epoch.paidOut = epoch.paidOut.plus(event.params.amount);
  epoch.save();
}
