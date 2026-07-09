import { FeeReceived } from "../generated/FeeReceiver/FeeReceiver";
import { getOrCreatePlatformConfig, getOrCreatePlatformDayData } from "./helpers";

// FeeReceived fires on every BNB inflow to the FeeReceiver (receiveFee emits
// it alongside TokenFeeReceived, and the plain receive() emits it too), so it
// is the single, non-double-counting source for the platform fee total.
export function handleFeeReceived(event: FeeReceived): void {
  let amount = event.params.amount;

  let pc = getOrCreatePlatformConfig();
  pc.totalFeesReceivedBnb = pc.totalFeesReceivedBnb.plus(amount);
  pc.save();

  let pd = getOrCreatePlatformDayData(event.block.timestamp);
  pd.feesBnb = pd.feesBnb.plus(amount);
  pd.save();
}
