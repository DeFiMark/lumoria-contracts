import { Address } from "@graphprotocol/graph-ts";
import {
  RebateFunded,
  RebateToppedUp,
  RebateCredited,
  RebateBpsUpdated,
  RebateWithdrawn,
  RebateDeactivated,
} from "../generated/RebateContract/RebateContract";
import { Rebate, RebateCredit, Token } from "../generated/schema";
import { ZERO_BI, eventId } from "./helpers";

function getOrCreateRebate(tokenAddr: Address): Rebate {
  let id = tokenAddr.toHexString();
  let r = Rebate.load(id);
  if (r == null) {
    r = new Rebate(id);
    r.token = id;
    r.creator = Address.zero();
    r.rebateBps = ZERO_BI;
    r.fundedBalance = ZERO_BI;
    r.active = false;
    r.totalCreditedTokens = ZERO_BI;
    let token = Token.load(id);
    if (token != null) {
      token.rebate = id;
      token.save();
    }
  }
  return r as Rebate;
}

export function handleRebateFunded(event: RebateFunded): void {
  let r = getOrCreateRebate(event.params.token);
  r.creator = event.params.creator;
  r.rebateBps = event.params.rebateBps;
  r.active = true;
  r.fundedBalance = r.fundedBalance.plus(event.params.amount);
  r.save();
}

export function handleRebateToppedUp(event: RebateToppedUp): void {
  let r = getOrCreateRebate(event.params.token);
  r.fundedBalance = event.params.newBalance; // authoritative
  if (r.fundedBalance.gt(ZERO_BI)) r.active = true;
  r.save();
}

export function handleRebateCredited(event: RebateCredited): void {
  let r = getOrCreateRebate(event.params.token);
  r.fundedBalance = r.fundedBalance.minus(event.params.tokenAmount);
  if (r.fundedBalance.lt(ZERO_BI)) r.fundedBalance = ZERO_BI;
  r.totalCreditedTokens = r.totalCreditedTokens.plus(event.params.tokenAmount);
  if (r.fundedBalance.equals(ZERO_BI)) r.active = false;
  r.save();

  let c = new RebateCredit(eventId(event));
  c.rebate = r.id;
  c.token = event.params.token.toHexString();
  c.buyer = event.params.buyer;
  c.amount = event.params.tokenAmount;
  c.timestamp = event.block.timestamp;
  c.save();
}

export function handleRebateBpsUpdated(event: RebateBpsUpdated): void {
  let r = getOrCreateRebate(event.params.token);
  r.rebateBps = event.params.newBps;
  r.save();
}

export function handleRebateWithdrawn(event: RebateWithdrawn): void {
  let r = getOrCreateRebate(event.params.token);
  r.fundedBalance = r.fundedBalance.minus(event.params.amount);
  if (r.fundedBalance.lt(ZERO_BI)) r.fundedBalance = ZERO_BI;
  if (r.fundedBalance.equals(ZERO_BI)) r.active = false;
  r.save();
}

export function handleRebateDeactivated(event: RebateDeactivated): void {
  let r = getOrCreateRebate(event.params.token);
  r.active = false;
  r.save();
}
