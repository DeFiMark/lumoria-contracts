import {
  TaxAccrued,
  TaxWithdrawn,
  RecipientUpdated,
} from "../generated/templates/CreatorFeeModule/CreatorFeeModule";
import { Module, CreatorFeeAccrual, CreatorFeeWithdrawal } from "../generated/schema";
import { eventId } from "./helpers";

// The CreatorFeeModule accrues during the swap and pays out later, on demand
// (docs/TOKENOMICS_V2.md §7.2). `totalReceivedBnb` therefore tracks lifetime
// EARNINGS, and `totalWithdrawnBnb` tracks lifetime PAYOUTS. The difference is
// the amount currently claimable across all recipients.

export function handleTaxAccrued(event: TaxAccrued): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalReceivedBnb = m.totalReceivedBnb.plus(event.params.amount);
  m.recipient = event.params.recipient;
  m.save();

  let a = new CreatorFeeAccrual(eventId(event));
  a.module = m.id;
  a.recipient = event.params.recipient;
  a.amount = event.params.amount;
  a.owedAfter = event.params.owedAfter;
  a.timestamp = event.block.timestamp;
  a.save();
}

export function handleTaxWithdrawn(event: TaxWithdrawn): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalWithdrawnBnb = m.totalWithdrawnBnb.plus(event.params.amount);
  m.save();

  let w = new CreatorFeeWithdrawal(eventId(event));
  w.module = m.id;
  w.recipient = event.params.recipient;
  w.amount = event.params.amount;
  w.timestamp = event.block.timestamp;
  w.save();
}

export function handleRecipientUpdated(event: RecipientUpdated): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.recipient = event.params.newRecipient;
  m.save();
}
