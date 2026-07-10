import { Address, BigInt, Bytes, DataSourceContext, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  FeesUpdated,
  FeeChangeProposed,
  FeeChangeCancelled,
  ModuleAdded,
  ModuleRemoved,
  ModuleUpdated,
  ModuleChangeProposed,
  ModuleRebalanceProposed,
  ModuleChangeCancelled,
  ManagementRenounced,
} from "../generated/templates/TaxHandler/TaxHandler";
import { RewardModule } from "../generated/templates/TaxHandler/RewardModule";
import {
  CreatorFeeModule as CreatorFeeModuleTemplate,
  RewardModule as RewardModuleTemplate,
  BurnModule as BurnModuleTemplate,
  LiquidityModule as LiquidityModuleTemplate,
  MilestoneRewardModule as MilestoneRewardModuleTemplate,
  PrizePool as PrizePoolTemplate,
} from "../generated/templates";
import { hydratePrizeSpecifics } from "./database";
import {
  Token,
  Module,
  ModuleAddress,
  ModuleEvent,
  FeeChange,
  PendingChange,
} from "../generated/schema";
import {
  ZERO_BI,
  ADDRESS_ZERO,
  MODULE_REWARD,
  MODULE_BURN,
  MODULE_LIQUIDITY,
  MODULE_CREATOR,
  MODULE_MILESTONE,
  MODULE_PRIZE,
  eventId,
  getOrCreateModule,
} from "./helpers";

function ctxTokenId(): string {
  return dataSource.context().getString("token");
}

function ctxTaxHandler(): Address {
  return Address.fromString(dataSource.context().getString("taxHandler"));
}

// ─── Fees ───────────────────────────────────────────────────────────

export function handleFeesUpdated(event: FeesUpdated): void {
  let tokenId = ctxTokenId();
  let token = Token.load(tokenId);
  if (token == null) return;

  token.buyFee = event.params.newBuyFee;
  token.sellFee = event.params.newSellFee;

  // Execute→executed inference (§10.12): a FeesUpdated whose new values match a
  // pending fee change is the timelocked execution; otherwise it's instant.
  let kind = "instant";
  let pcId = tokenId + "-fee";
  let pc = PendingChange.load(pcId);
  if (
    pc != null &&
    pc.status == "pending" &&
    pc.newBuyFee !== null &&
    pc.newSellFee !== null &&
    (pc.newBuyFee as BigInt).equals(event.params.newBuyFee) &&
    (pc.newSellFee as BigInt).equals(event.params.newSellFee)
  ) {
    kind = "timelocked";
    pc.status = "executed";
    pc.save();
    token.pendingFeeChange = null;
  }
  token.save();

  let fc = new FeeChange(eventId(event));
  fc.token = tokenId;
  fc.oldBuyFee = event.params.oldBuyFee;
  fc.newBuyFee = event.params.newBuyFee;
  fc.oldSellFee = event.params.oldSellFee;
  fc.newSellFee = event.params.newSellFee;
  fc.kind = kind;
  fc.timestamp = event.block.timestamp;
  fc.save();
}

export function handleFeeChangeProposed(event: FeeChangeProposed): void {
  let tokenId = ctxTokenId();
  let token = Token.load(tokenId);
  if (token == null) return;

  let pcId = tokenId + "-fee";
  let pc = new PendingChange(pcId);
  pc.token = tokenId;
  pc.kind = "fee";
  pc.newBuyFee = event.params.newBuyFee;
  pc.newSellFee = event.params.newSellFee;
  pc.effectiveTime = event.params.effectiveTime;
  pc.proposedAt = event.block.timestamp;
  pc.proposedTx = event.transaction.hash;
  pc.status = "pending";
  pc.save();

  token.pendingFeeChange = pcId;
  token.save();
}

export function handleFeeChangeCancelled(event: FeeChangeCancelled): void {
  let tokenId = ctxTokenId();
  let pc = PendingChange.load(tokenId + "-fee");
  if (pc != null) {
    pc.status = "cancelled";
    pc.save();
  }
  let token = Token.load(tokenId);
  if (token != null) {
    token.pendingFeeChange = null;
    token.save();
  }
}

// ─── Modules ────────────────────────────────────────────────────────
// Initial modules are hydrated in database.ts (their ModuleAdded fires before
// this template exists). So ModuleAdded here is always a LATER, post-launch add.

export function handleModuleAdded(event: ModuleAdded): void {
  let tokenId = ctxTokenId();
  let thAddr = ctxTaxHandler();
  let mAddr = event.params.moduleAddress;
  let mType = event.params.moduleType;

  let m = getOrCreateModule(
    mAddr,
    tokenId,
    thAddr,
    mType,
    event.params.buyAlloc,
    event.params.sellAlloc,
    event.block.timestamp
  );
  m.active = true;
  if (mType == MODULE_REWARD) {
    let rm = RewardModule.bind(mAddr);
    let rt = rm.try_rewardToken();
    m.rewardToken = rt.reverted ? ADDRESS_ZERO : rt.value;
    let md = rm.try_minDistribution();
    m.minDistribution = md.reverted ? ZERO_BI : md.value;
    m.totalDividendsDistributed = ZERO_BI;
  } else if (mType == MODULE_MILESTONE) {
    m.totalReleased = ZERO_BI;
    // __init__ ran in this same tx — the 18-month clock starts now.
    m.lastReleaseTime = event.block.timestamp;
  } else if (mType == MODULE_PRIZE) {
    hydratePrizeSpecifics(m, mAddr);
  }
  m.save();

  let ma = ModuleAddress.load(mAddr.toHexString());
  if (ma == null) {
    ma = new ModuleAddress(mAddr.toHexString());
    ma.token = tokenId;
    ma.moduleType = mType;
    ma.save();
  }

  let ctx = new DataSourceContext();
  ctx.setString("token", tokenId);
  ctx.setString("taxHandler", thAddr.toHexString());
  if (mType == MODULE_CREATOR) CreatorFeeModuleTemplate.createWithContext(mAddr, ctx);
  else if (mType == MODULE_REWARD) RewardModuleTemplate.createWithContext(mAddr, ctx);
  else if (mType == MODULE_BURN) BurnModuleTemplate.createWithContext(mAddr, ctx);
  else if (mType == MODULE_LIQUIDITY) LiquidityModuleTemplate.createWithContext(mAddr, ctx);
  else if (mType == MODULE_MILESTONE) MilestoneRewardModuleTemplate.createWithContext(mAddr, ctx);
  else if (mType == MODULE_PRIZE) PrizePoolTemplate.createWithContext(mAddr, ctx);

  moduleEvent(event, tokenId, "added", mAddr, mType, event.params.buyAlloc, event.params.sellAlloc);
}

export function handleModuleRemoved(event: ModuleRemoved): void {
  let m = Module.load(event.params.moduleAddress.toHexString());
  if (m != null) {
    m.active = false;
    m.save();
  }
  // Removing the active PrizePool stops ticket derivation for the token.
  let token = Token.load(ctxTokenId());
  if (token != null && token.prizePool !== null) {
    if ((token.prizePool as Bytes).equals(event.params.moduleAddress)) {
      token.prizePool = null;
      token.save();
    }
  }
  moduleEvent(event, ctxTokenId(), "removed", event.params.moduleAddress, event.params.moduleType, null, null);
}

export function handleModuleUpdated(event: ModuleUpdated): void {
  let m = Module.load(event.params.moduleAddress.toHexString());
  if (m != null) {
    m.buyAllocation = event.params.buyAlloc;
    m.sellAllocation = event.params.sellAlloc;
    m.save();
  }
  moduleEvent(event, ctxTokenId(), "updated", event.params.moduleAddress, event.params.moduleType, event.params.buyAlloc, event.params.sellAlloc);
}

export function handleModuleChangeProposed(event: ModuleChangeProposed): void {
  let tokenId = ctxTokenId();
  let token = Token.load(tokenId);
  if (token == null) return;

  let pcId = tokenId + "-module";
  let pc = new PendingChange(pcId);
  pc.token = tokenId;
  pc.kind = "module";
  pc.changeType = event.params.changeType;
  pc.moduleType = event.params.moduleType;
  pc.effectiveTime = event.params.effectiveTime;
  pc.proposedAt = event.block.timestamp;
  pc.proposedTx = event.transaction.hash;
  pc.status = "pending";
  pc.save();

  token.pendingModuleChange = pcId;
  token.save();

  moduleEvent(event, tokenId, "proposed", null, event.params.moduleType, event.params.buyAlloc, event.params.sellAlloc);
}

export function handleModuleRebalanceProposed(event: ModuleRebalanceProposed): void {
  // Same tx as ModuleChangeProposed — attach the rebalance arrays to it.
  let tokenId = ctxTokenId();
  let pc = PendingChange.load(tokenId + "-module");
  if (pc == null) return;
  pc.rebalanceIndices = event.params.indices;
  pc.rebalanceBuyAllocs = event.params.buyAllocs;
  pc.rebalanceSellAllocs = event.params.sellAllocs;
  pc.save();
}

export function handleModuleChangeCancelled(event: ModuleChangeCancelled): void {
  let tokenId = ctxTokenId();
  let pc = PendingChange.load(tokenId + "-module");
  if (pc != null) {
    pc.status = "cancelled";
    pc.save();
  }
  let token = Token.load(tokenId);
  if (token != null) {
    token.pendingModuleChange = null;
    token.save();
  }
}

// ─── Renounce (B6) ──────────────────────────────────────────────────

export function handleManagementRenounced(event: ManagementRenounced): void {
  let tokenId = ctxTokenId();
  let token = Token.load(tokenId);
  if (token == null) return;
  token.renounced = true;
  token.renouncedAt = event.params.timestamp;

  // Renounce clears any in-flight pending change on-chain.
  let fee = PendingChange.load(tokenId + "-fee");
  if (fee != null && fee.status == "pending") {
    fee.status = "cancelled";
    fee.save();
  }
  let mod = PendingChange.load(tokenId + "-module");
  if (mod != null && mod.status == "pending") {
    mod.status = "cancelled";
    mod.save();
  }
  token.pendingFeeChange = null;
  token.pendingModuleChange = null;
  token.save();
}

// ─── helper ─────────────────────────────────────────────────────────

function moduleEvent(
  event: ethereum.Event,
  tokenId: string,
  kind: string,
  module: Address | null,
  moduleType: i32,
  buyAlloc: BigInt | null,
  sellAlloc: BigInt | null
): void {
  let me = new ModuleEvent(eventId(event));
  me.token = tokenId;
  me.kind = kind;
  if (module !== null) me.module = module as Address;
  me.moduleType = moduleType;
  me.buyAllocation = buyAlloc;
  me.sellAllocation = sellAlloc;
  me.timestamp = event.block.timestamp;
  me.save();
}
