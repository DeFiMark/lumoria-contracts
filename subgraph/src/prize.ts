// Shared PrizePool epoch machinery — the AssemblyScript mirror of
// PrizePool._advance() plus the reference ticket derivation.
//
// The mirror MUST reproduce the contract's math exactly: epochs are derived
// from timestamps, a queued length applies at the first boundary crossed, and
// skipped epochs keep the OLD length for the whole jump (n is computed once).
// Every PrizePool event that carries an epochId is used as an authoritative
// sync point for the money buckets, so a mirror bug can skew derived ticket
// stats but never the pot accounting.

import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Module, Token, PrizeEpoch, PrizeTicket } from "../generated/schema";
import { ZERO_BI, nz } from "./helpers";

/** Mirror of PrizePool._advance(). Mutates (does not save) the module. */
export function advancePrizeEpoch(m: Module, ts: BigInt): void {
  let len = m.prizeEpochLength;
  let start = m.prizeEpochStart;
  if (len === null || start === null) return;
  let lenV = len as BigInt;
  let startV = start as BigInt;
  if (lenV.equals(ZERO_BI)) return;
  if (ts.lt(startV.plus(lenV))) return;

  let n = ts.minus(startV).div(lenV);
  m.prizeEpochId = nz(m.prizeEpochId).plus(n);
  m.prizeEpochStart = startV.plus(n.times(lenV));

  let pending = m.prizePendingEpochLength;
  if (pending !== null && (pending as BigInt).gt(ZERO_BI)) {
    m.prizeEpochLength = pending as BigInt;
    m.prizePendingEpochLength = ZERO_BI;
  }
}

export function prizeEpochId(moduleId: string, epochId: BigInt): string {
  return moduleId + "-" + epochId.toString();
}

export function getOrCreatePrizeEpoch(m: Module, epochId: BigInt): PrizeEpoch {
  let id = prizeEpochId(m.id, epochId);
  let e = PrizeEpoch.load(id);
  if (e == null) {
    e = new PrizeEpoch(id);
    e.module = m.id;
    e.token = m.token;
    e.epochId = epochId;
    e.pot = ZERO_BI;
    e.paidOut = ZERO_BI;
    e.derivedTicketCount = ZERO_BI;
    e.derivedTotalWeight = ZERO_BI;
    e.rolledOver = false;
    e.invalidated = false;
  }
  return e as PrizeEpoch;
}

/**
 * The reference ticket derivation (§2.5): called from hook.ts for every
 * attributed, non-module-flow buy of a token that has an active PrizePool.
 * Tickets are append-only and never merged; weight is raw bnbIn (the optional
 * per-address cap is a root-build concern, not an indexing one).
 */
export function recordPrizeTicket(
  token: Token,
  buyer: Bytes,
  bnbIn: BigInt,
  tokensOut: BigInt,
  event: ethereum.Event
): void {
  let prizeAddr = token.prizePool;
  if (prizeAddr === null) return;
  let m = Module.load((prizeAddr as Bytes).toHexString());
  if (m == null || !m.active) return;

  advancePrizeEpoch(m, event.block.timestamp);
  m.save();

  let epoch = getOrCreatePrizeEpoch(m, nz(m.prizeEpochId));
  let index = epoch.derivedTicketCount;

  let t = new PrizeTicket(epoch.id + "-" + index.toString());
  t.epoch = epoch.id;
  t.index = index;
  t.buyer = buyer;
  t.weight = bnbIn;
  t.cumBefore = epoch.derivedTotalWeight;
  t.tokensBought = tokensOut;
  t.timestamp = event.block.timestamp;
  t.txHash = event.transaction.hash;
  t.save();

  epoch.derivedTicketCount = index.plus(BigInt.fromI32(1));
  epoch.derivedTotalWeight = epoch.derivedTotalWeight.plus(bnbIn);
  epoch.save();
}
