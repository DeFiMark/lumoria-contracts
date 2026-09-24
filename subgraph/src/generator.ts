import {
  ProjectGenerated,
  TokenMetadataInitialized,
  FlatCurveLaunched,
  SingleSidedLaunched,
  AllocationMinted,
  AllocationVested,
} from "../generated/Generator/Generator";
import { FlatCurve } from "../generated/Generator/FlatCurve";
import { FlatCurve as FlatCurveTemplate } from "../generated/templates";
import { Token, Raise, TokenAllocation } from "../generated/schema";
import { ZERO_BI, eventId } from "./helpers";
import {
  getOrCreateSingleSidedLaunch,
  setSingleSidedStartingPrice,
} from "./singleSided";

export function handleProjectGenerated(event: ProjectGenerated): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return; // bootstrap on TokenRegistered runs earlier in the tx
  token.name = event.params.name;
  token.symbol = event.params.symbol;
  token.launchMode = event.params.launchMode;
  // Store configured fees; temporary guard fees must not become stale at 90%.
  token.buyFee = event.params.buyFee;
  token.sellFee = event.params.sellFee;
  token.save();
}

/**
 * Launch-time display metadata, straight from the log.
 *
 * `handleTokenRegistered` already read the same three values off the token by
 * eth_call earlier in this transaction; this handler exists because the log is
 * the authoritative record of what the creator actually signed for, and it
 * costs one entity write to be independent of an RPC that could have answered
 * a `try_` call with a revert.
 */
export function handleTokenMetadataInitialized(event: TokenMetadataInitialized): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return; // bootstrap on TokenRegistered runs earlier in the tx
  token.image = event.params.image;
  token.socials = event.params.socials;
  token.metadataURI = event.params.contractURI;
  token.save();
}

export function handleFlatCurveLaunched(event: FlatCurveLaunched): void {
  let tokenId = event.params.token.toHexString();
  let fcAddr = event.params.flatCurve;
  let raiseId = fcAddr.toHexString();

  let raise = new Raise(raiseId);
  raise.token = tokenId;
  raise.flatCurve = fcAddr;
  raise.hardCap = event.params.hardCap;
  raise.totalRaised = ZERO_BI;
  raise.contributorCount = 0;
  raise.status = "ACTIVE";
  raise.liquidityBnb = null;
  raise.creatorBnb = null;

  // Hydrate the raise config (set in FlatCurve.__init__ before this event).
  let fc = FlatCurve.bind(fcAddr);
  let st = fc.try_startTime();
  raise.startTime = st.reverted ? ZERO_BI : st.value;
  let et = fc.try_endTime();
  raise.endTime = et.reverted ? ZERO_BI : et.value;
  let mn = fc.try_minContribution();
  raise.minContribution = mn.reverted ? ZERO_BI : mn.value;
  let mx = fc.try_maxContribution();
  raise.maxContribution = mx.reverted ? ZERO_BI : mx.value;
  let tp = fc.try_tokensForPresale();
  raise.tokensForPresale = tp.reverted ? ZERO_BI : tp.value;
  let tl = fc.try_tokensForLP();
  raise.tokensForLP = tl.reverted ? ZERO_BI : tl.value;
  raise.save();

  FlatCurveTemplate.create(fcAddr);

  let token = Token.load(tokenId);
  if (token != null) {
    token.raise = raiseId;
    token.launchMode = 1;
    token.save();
  }
}

export function handleSingleSidedLaunched(event: SingleSidedLaunched): void {
  let token = Token.load(event.params.token.toHexString());
  if (token == null) return;

  let launch = getOrCreateSingleSidedLaunch(
    token,
    event.block.timestamp,
    event.block.number
  );
  launch.tickUpper = event.params.startTick;
  launch.tokenAmountCommitted = event.params.tokenAmountCommitted;
  launch.liquidity = event.params.liquidity;
  setSingleSidedStartingPrice(launch, token, event.params.sqrtPriceX96);

  launch.save();
  token.save();
}

export function handleAllocationMinted(event: AllocationMinted): void {
  let a = new TokenAllocation(eventId(event));
  a.token = event.params.token.toHexString();
  a.beneficiary = event.params.beneficiary;
  a.amount = event.params.amount;
  a.locked = false;
  a.createdAt = event.block.timestamp;
  a.save();
}

export function handleAllocationVested(event: AllocationVested): void {
  let a = new TokenAllocation(eventId(event));
  a.token = event.params.token.toHexString();
  a.beneficiary = event.params.beneficiary;
  a.amount = event.params.amount;
  a.locked = true;
  // VestingVault.ScheduleCreated fired earlier in this tx → schedule exists.
  a.schedule = event.params.scheduleId.toString();
  a.createdAt = event.block.timestamp;
  a.save();
}
