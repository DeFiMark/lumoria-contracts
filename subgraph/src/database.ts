import { Address, BigInt, DataSourceContext } from "@graphprotocol/graph-ts";
import {
  TokenRegistered,
  VolumeRegistered,
  PlatformFeeUpdated,
} from "../generated/Database/Database";
import { TaxHandler } from "../generated/Database/TaxHandler";
import { LumoriaToken as LumoriaTokenContract } from "../generated/Database/LumoriaToken";
import { RewardModule } from "../generated/Database/RewardModule";
import { PrizePool } from "../generated/Database/PrizePool";
import {
  LumoriaToken as LumoriaTokenTemplate,
  TaxHandler as TaxHandlerTemplate,
  CreatorFeeModule as CreatorFeeModuleTemplate,
  RewardModule as RewardModuleTemplate,
  BurnModule as BurnModuleTemplate,
  LiquidityModule as LiquidityModuleTemplate,
  MilestoneRewardModule as MilestoneRewardModuleTemplate,
  PrizePool as PrizePoolTemplate,
} from "../generated/templates";
import {
  Token,
  Module,
  Creator,
  ModuleAddress,
  UserVolume,
} from "../generated/schema";
import {
  ZERO_BI,
  ONE_BI,
  ZERO_BD,
  ADDRESS_ZERO,
  MODULE_REWARD,
  MODULE_BURN,
  MODULE_LIQUIDITY,
  MODULE_CREATOR,
  MODULE_MILESTONE,
  MODULE_PRIZE,
  getOrCreateSystemAddresses,
  getOrCreatePlatformConfig,
  getOrCreatePlatformDayData,
  getOrCreateModule,
  getOrCreateHolder,
} from "./helpers";

// ─── Bootstrap: a new token launch ──────────────────────────────────
// Fires in the SAME tx as the initial mint Transfer + initial ModuleAdded,
// which a freshly-spawned template would MISS — so we hydrate genesis state
// via contract calls here (see SUBGRAPH.md §3).

export function handleTokenRegistered(event: TokenRegistered): void {
  let tokenAddr = event.params.token;
  let creatorAddr = event.params.creator;
  let thAddr = event.params.taxHandler;
  let tokenId = tokenAddr.toHexString();
  let ts = event.block.timestamp;

  let sys = getOrCreateSystemAddresses(event.address);

  let token = Token.load(tokenId);
  if (token == null) token = new Token(tokenId);
  token.creator = creatorAddr;
  token.taxHandler = thAddr;
  token.decimals = 18;
  token.launchMode = 0; // overwritten by ProjectGenerated
  token.launchedAt = ts;
  token.launchTx = event.transaction.hash;
  token.renounced = false;
  token.totalSupply = ZERO_BI;
  token.holderCount = 0;
  token.totalVolumeBnb = ZERO_BI;
  token.attributedVolumeBnb = ZERO_BI;
  token.buyCount = ZERO_BI;
  token.sellCount = ZERO_BI;
  token.totalPlatformFeeBnb = ZERO_BI;
  token.totalTaxBnb = ZERO_BI;
  token.totalLiquidityLocked = ZERO_BI;
  token.lastPriceBnb = ZERO_BD;
  token.name = "";
  token.symbol = "";

  // Hydrate token metadata + supply (token.__init__ ran before registerToken).
  let lt = LumoriaTokenContract.bind(tokenAddr);
  let nm = lt.try_name();
  if (!nm.reverted) token.name = nm.value;
  let sym = lt.try_symbol();
  if (!sym.reverted) token.symbol = sym.value;
  let supply = lt.try_totalSupply();
  let totalSupply = supply.reverted ? ZERO_BI : supply.value;
  token.totalSupply = totalSupply;

  // Hydrate current fees.
  let th = TaxHandler.bind(thAddr);
  let bf = th.try_buyFee();
  if (!bf.reverted) token.buyFee = bf.value;
  else token.buyFee = ZERO_BI;
  let sf = th.try_sellFee();
  if (!sf.reverted) token.sellFee = sf.value;
  else token.sellFee = ZERO_BI;

  token.save();

  // Spawn token + taxHandler templates with context.
  let ctx = new DataSourceContext();
  ctx.setString("token", tokenId);
  ctx.setString("taxHandler", thAddr.toHexString());
  LumoriaTokenTemplate.createWithContext(tokenAddr, ctx);
  TaxHandlerTemplate.createWithContext(thAddr, ctx);

  // Hydrate the initial module set + spawn module templates.
  let countRes = th.try_getModuleCount();
  if (!countRes.reverted) {
    let count = countRes.value;
    for (let i = ZERO_BI; i.lt(count); i = i.plus(ONE_BI)) {
      let mRes = th.try_getModule(i);
      if (mRes.reverted) continue;
      let mc = mRes.value;
      let mAddr = mc.moduleAddress;
      let mType = mc.moduleType;

      let module = getOrCreateModule(
        mAddr,
        tokenId,
        thAddr,
        mType,
        mc.buyAllocation,
        mc.sellAllocation,
        ts
      );
      hydrateModuleSpecifics(module, mAddr, mType);
      module.save();

      let ma = new ModuleAddress(mAddr.toHexString());
      ma.token = tokenId;
      ma.moduleType = mType;
      ma.save();

      spawnModuleTemplate(mType, mAddr, ctx);
    }
  }

  // Seed the genesis holder (whoever holds the freshly-minted supply — the
  // Generator). The mint Transfer was missed by the just-spawned token
  // template; without this seed the first distribution Transfer would drive
  // the holder negative. The Generator is excluded from holderCount anyway.
  let genAddr = changetype<Address>(sys.generator);
  if (!genAddr.equals(ADDRESS_ZERO)) {
    let genHolder = getOrCreateHolder(tokenId, genAddr, ts);
    let bal = lt.try_balanceOf(genAddr);
    genHolder.balance = bal.reverted ? totalSupply : bal.value;
    genHolder.save();
  }

  // Platform aggregates.
  let pc = getOrCreatePlatformConfig();
  pc.totalTokens = pc.totalTokens + 1;
  let creator = Creator.load(creatorAddr.toHexString());
  if (creator == null) {
    creator = new Creator(creatorAddr.toHexString());
    creator.tokenCount = 0;
    pc.creatorCount = pc.creatorCount + 1; // first launch for this creator
  }
  creator.tokenCount = creator.tokenCount + 1;
  creator.save();
  pc.save();

  let pd = getOrCreatePlatformDayData(ts);
  pd.newTokens = pd.newTokens + 1;
  pd.save();
}

function hydrateModuleSpecifics(module: Module, mAddr: Address, mType: i32): void {
  if (mType == MODULE_REWARD) {
    let rm = RewardModule.bind(mAddr);
    let rt = rm.try_rewardToken();
    module.rewardToken = rt.reverted ? ADDRESS_ZERO : rt.value;
    let md = rm.try_minDistribution();
    module.minDistribution = md.reverted ? ZERO_BI : md.value;
    module.totalDividendsDistributed = ZERO_BI;
  } else if (mType == MODULE_BURN) {
    module.totalBurned = ZERO_BI;
    module.totalBnbSpent = ZERO_BI;
  } else if (mType == MODULE_LIQUIDITY) {
    module.totalLpLocked = ZERO_BI;
  } else if (mType == MODULE_MILESTONE) {
    module.totalReleased = ZERO_BI;
    // The module's __init__ ran in this same tx, so its 18-month clock
    // started now — no contract call needed.
    module.lastReleaseTime = module.addedAt;
  } else if (mType == MODULE_PRIZE) {
    hydratePrizeSpecifics(module, mAddr);
  }
  // interval / lastExecuted left null — the frontend reads them live, and
  // IntervalUpdated / Burn|LiquidityExecuted events fill them as they fire.
}

/** PrizePool config has no events — call-hydrate it (SUBGRAPH.md §3). The
 *  epoch mirror starts at (0, addedAt): __init__ ran in this same tx. Also
 *  points Token.prizePool at the module for hook.ts ticket derivation. */
export function hydratePrizeSpecifics(module: Module, mAddr: Address): void {
  let pp = PrizePool.bind(mAddr);
  let mode = pp.try_payoutMode();
  module.prizePayoutMode = mode.reverted ? 0 : mode.value;
  let wc = pp.try_winnerCount();
  module.prizeWinnerCount = wc.reverted ? 0 : wc.value;
  let hold = pp.try_holdRequirementBps();
  module.prizeHoldRequirementBps = hold.reverted ? ZERO_BI : hold.value;
  let len = pp.try_epochLength();
  module.prizeEpochLength = len.reverted ? ZERO_BI : len.value;
  module.prizePendingEpochLength = ZERO_BI;
  module.prizeEpochId = ZERO_BI;
  module.prizeEpochStart = module.addedAt;

  let token = Token.load(module.token);
  if (token != null) {
    token.prizePool = Address.fromString(module.id);
    token.save();
  }
}

function spawnModuleTemplate(mType: i32, mAddr: Address, ctx: DataSourceContext): void {
  if (mType == MODULE_CREATOR) {
    CreatorFeeModuleTemplate.createWithContext(mAddr, ctx);
  } else if (mType == MODULE_REWARD) {
    RewardModuleTemplate.createWithContext(mAddr, ctx);
  } else if (mType == MODULE_BURN) {
    BurnModuleTemplate.createWithContext(mAddr, ctx);
  } else if (mType == MODULE_LIQUIDITY) {
    LiquidityModuleTemplate.createWithContext(mAddr, ctx);
  } else if (mType == MODULE_MILESTONE) {
    MilestoneRewardModuleTemplate.createWithContext(mAddr, ctx);
  } else if (mType == MODULE_PRIZE) {
    PrizePoolTemplate.createWithContext(mAddr, ctx);
  }
}

// ─── Volume (every swap, via the hook) ──────────────────────────────

export function handleVolumeRegistered(event: VolumeRegistered): void {
  let tokenId = event.params.token.toHexString();
  let user = event.params.user;
  let amount = event.params.amount;

  let token = Token.load(tokenId);
  if (token == null) return;
  token.totalVolumeBnb = token.totalVolumeBnb.plus(amount);
  if (!user.equals(ADDRESS_ZERO)) {
    token.attributedVolumeBnb = token.attributedVolumeBnb.plus(amount);
    let uvId = tokenId + "-" + user.toHexString();
    let uv = UserVolume.load(uvId);
    if (uv == null) {
      uv = new UserVolume(uvId);
      uv.token = tokenId;
      uv.user = user;
      uv.volumeBnb = ZERO_BI;
    }
    uv.volumeBnb = uv.volumeBnb.plus(amount);
    uv.save();
  }
  token.save();

  let pc = getOrCreatePlatformConfig();
  pc.totalVolumeBnb = pc.totalVolumeBnb.plus(amount);
  pc.save();

  let pd = getOrCreatePlatformDayData(event.block.timestamp);
  pd.volumeBnb = pd.volumeBnb.plus(amount);
  pd.save();
}

export function handlePlatformFeeUpdated(event: PlatformFeeUpdated): void {
  let pc = getOrCreatePlatformConfig();
  pc.platformFeeBps = event.params.newFee;
  pc.save();
}
