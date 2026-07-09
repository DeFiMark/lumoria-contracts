import {
  TaxForwarded,
  RecipientUpdated,
} from "../generated/templates/CreatorFeeModule/CreatorFeeModule";
import { Module, CreatorFeeForward } from "../generated/schema";
import { eventId } from "./helpers";

export function handleTaxForwarded(event: TaxForwarded): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.totalReceivedBnb = m.totalReceivedBnb.plus(event.params.amount);
  m.recipient = event.params.recipient;
  m.save();

  let f = new CreatorFeeForward(eventId(event));
  f.module = m.id;
  f.recipient = event.params.recipient;
  f.amount = event.params.amount;
  f.timestamp = event.block.timestamp;
  f.save();
}

export function handleRecipientUpdated(event: RecipientUpdated): void {
  let m = Module.load(event.address.toHexString());
  if (m == null) return;
  m.recipient = event.params.newRecipient;
  m.save();
}
