import { Address, BigInt } from "@graphprotocol/graph-ts";
import { Transfer } from "../generated/templates/LumoriaToken/LumoriaToken";
import { Token, Holder, SystemAddresses } from "../generated/schema";
import {
  ZERO_BI,
  ADDRESS_ZERO,
  getOrCreateHolder,
  getOrCreateHolderDayData,
  isExcludedHolder,
} from "./helpers";

export function handleTransfer(event: Transfer): void {
  let tokenId = event.address.toHexString();
  let token = Token.load(tokenId);
  if (token == null) return;

  let from = event.params.from;
  let to = event.params.to;
  let value = event.params.value;
  let ts = event.block.timestamp;

  let sys = SystemAddresses.load("1");
  let poolManager = sys != null ? changetype<Address>(sys.poolManager) : ADDRESS_ZERO;

  // Burn: tokens sent to 0x0 reduce supply.
  if (to.equals(ADDRESS_ZERO)) {
    token.totalSupply = token.totalSupply.minus(value);
  }

  let holderCount = token.holderCount;

  if (!from.equals(ADDRESS_ZERO)) {
    let h = getOrCreateHolder(tokenId, from, ts);
    let before = h.balance;
    h.balance = before.minus(value);
    if (h.balance.lt(ZERO_BI)) h.balance = ZERO_BI; // floor (guards genesis edge)
    h.lastSeen = ts;
    let excluded = sys != null ? isExcludedHolder(from, sys) : from.equals(ADDRESS_ZERO);
    if (!excluded && before.gt(ZERO_BI) && h.balance.equals(ZERO_BI)) {
      holderCount = holderCount - 1;
    }
    h.save();
    getOrCreateHolderDayData(tokenId, from, h.balance, ts);
  }

  if (!to.equals(ADDRESS_ZERO)) {
    let h = getOrCreateHolder(tokenId, to, ts);
    if (to.equals(poolManager)) h.isPool = true;
    let before = h.balance;
    h.balance = before.plus(value);
    h.lastSeen = ts;
    let excluded = sys != null ? isExcludedHolder(to, sys) : false;
    if (!excluded && before.equals(ZERO_BI) && h.balance.gt(ZERO_BI)) {
      holderCount = holderCount + 1;
    }
    h.save();
    getOrCreateHolderDayData(tokenId, to, h.balance, ts);
  }

  if (holderCount < 0) holderCount = 0;
  token.holderCount = holderCount;
  token.save();
}
