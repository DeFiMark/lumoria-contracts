import { Address } from "@graphprotocol/graph-ts";
import {
  ContributionMade,
  ContributionRefunded,
  RaiseLaunched,
  RaiseFailed,
  TokensClaimed,
} from "../generated/templates/FlatCurve/FlatCurve";
import { Raise, Contribution } from "../generated/schema";
import { ZERO_BI } from "./helpers";

function contributionId(raiseId: string, contributor: Address): string {
  return raiseId + "-" + contributor.toHexString();
}

function getOrCreateContribution(raiseId: string, contributor: Address): Contribution {
  let id = contributionId(raiseId, contributor);
  let c = Contribution.load(id);
  if (c == null) {
    c = new Contribution(id);
    c.raise = raiseId;
    c.contributor = contributor;
    c.grossContributed = ZERO_BI;
    c.netContributed = ZERO_BI;
    c.refunded = ZERO_BI;
    c.claimed = ZERO_BI;
  }
  return c as Contribution;
}

export function handleContributionMade(event: ContributionMade): void {
  let raiseId = event.address.toHexString();
  let raise = Raise.load(raiseId);
  if (raise == null) return;
  raise.totalRaised = event.params.totalRaised; // authoritative running total

  let c = Contribution.load(contributionId(raiseId, event.params.contributor));
  let isNew = c == null;
  let con = getOrCreateContribution(raiseId, event.params.contributor);
  con.grossContributed = con.grossContributed.plus(event.params.grossAmount);
  con.netContributed = con.netContributed.plus(event.params.netAmount);
  con.save();

  if (isNew) raise.contributorCount = raise.contributorCount + 1;
  raise.save();
}

export function handleContributionRefunded(event: ContributionRefunded): void {
  let raiseId = event.address.toHexString();
  let con = getOrCreateContribution(raiseId, event.params.contributor);
  con.refunded = con.refunded.plus(event.params.refundAmount);
  con.save();
}

export function handleRaiseLaunched(event: RaiseLaunched): void {
  let raise = Raise.load(event.address.toHexString());
  if (raise == null) return;
  raise.status = "SUCCESS";
  raise.totalRaised = event.params.totalRaised;
  raise.liquidityBnb = event.params.liquidityBNB;
  raise.creatorBnb = event.params.creatorBNB;
  raise.save();
}

export function handleRaiseFailed(event: RaiseFailed): void {
  let raise = Raise.load(event.address.toHexString());
  if (raise == null) return;
  raise.status = "FAILED";
  raise.totalRaised = event.params.totalRaised;
  raise.save();
}

export function handleTokensClaimed(event: TokensClaimed): void {
  let raiseId = event.address.toHexString();
  let con = getOrCreateContribution(raiseId, event.params.contributor);
  con.claimed = con.claimed.plus(event.params.tokenAmount);
  con.save();
}
