import { Address, BigInt } from "@graphprotocol/graph-ts";
import {
  Transfer,
  ImageUpdated,
  SocialsUpdated,
  ContractURIUpdated,
  LumoriaToken as LumoriaTokenContract,
} from "../generated/templates/LumoriaToken/LumoriaToken";
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

// ─── Display metadata (creator edits, until renounce freezes them) ───
//
// Launch-time values arrive via Database.TokenRegistered / the Generator's
// TokenMetadataInitialized — this template is created DURING the launch
// transaction and so cannot observe events emitted earlier in it. These
// handlers only carry post-launch edits.

export function handleImageUpdated(event: ImageUpdated): void {
  let token = Token.load(event.address.toHexString());
  if (token == null) return;
  token.image = event.params.image;
  token.save();
}

export function handleSocialsUpdated(event: SocialsUpdated): void {
  let token = Token.load(event.address.toHexString());
  if (token == null) return;
  token.socials = event.params.socials;
  token.save();
}

/**
 * ERC-7572 defines `ContractURIUpdated()` with NO arguments — the new URI is
 * only obtainable by re-reading the contract, so this is the one metadata
 * handler that must make a call.
 */
export function handleContractURIUpdated(event: ContractURIUpdated): void {
  let token = Token.load(event.address.toHexString());
  if (token == null) return;
  let uri = LumoriaTokenContract.bind(event.address).try_contractURI();
  // A reverted read would otherwise blank a URI that is still live on chain.
  if (uri.reverted) return;
  token.metadataURI = uri.value;
  token.save();
}
