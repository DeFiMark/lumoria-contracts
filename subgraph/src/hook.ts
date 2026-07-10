import { Address } from "@graphprotocol/graph-ts";
import {
  TokenPurchased,
  TokenSold,
  LumoriaPoolInitialized,
} from "../generated/LumoriaHook/LumoriaHook";
import { Token, Trade, ModuleAddress } from "../generated/schema";
import {
  ZERO_BI,
  ONE_BI,
  ADDRESS_ZERO,
  eventId,
  priceFrom,
  poolPriceBnbPerToken,
  updateCandles,
} from "./helpers";

function isModule(addr: Address): boolean {
  if (addr.equals(ADDRESS_ZERO)) return false;
  return ModuleAddress.load(addr.toHexString()) != null;
}

export function handleTokenPurchased(event: TokenPurchased): void {
  let tokenId = event.params.token.toHexString();
  let token = Token.load(tokenId);
  if (token == null) return;

  let buyer = event.params.buyer;
  let bnbIn = event.params.bnbIn;
  let tokensOut = event.params.tokensOut;
  let moduleFlow = isModule(buyer);

  // Execution price (fee-inclusive) vs. pool mark price (exact, post-swap).
  // The hook emits sqrtPriceX96 + tick directly — no PoolManager indexing needed.
  let price = priceFrom(bnbIn, tokensOut);
  let sqrtPriceX96 = event.params.sqrtPriceX96;
  let poolPrice = poolPriceBnbPerToken(sqrtPriceX96);

  let t = new Trade(eventId(event));
  t.token = tokenId;
  t.trader = buyer;
  t.attributed = !buyer.equals(ADDRESS_ZERO);
  t.isModuleFlow = moduleFlow;
  t.kind = "buy";
  t.bnbIn = bnbIn;
  t.tokensOut = tokensOut;
  t.platformFee = event.params.platformFee;
  t.taxTaken = event.params.taxTaken;
  t.priceBnbPerToken = price;
  t.sqrtPriceX96 = sqrtPriceX96;
  t.tick = event.params.tick;
  t.poolPriceBnbPerToken = poolPrice;
  t.timestamp = event.block.timestamp;
  t.blockNumber = event.block.number;
  t.txHash = event.transaction.hash;
  t.save();

  token.buyCount = token.buyCount.plus(ONE_BI);
  token.totalPlatformFeeBnb = token.totalPlatformFeeBnb.plus(event.params.platformFee);
  token.totalTaxBnb = token.totalTaxBnb.plus(event.params.taxTaken);
  if (!moduleFlow) {
    token.lastPriceBnb = poolPrice;
  }
  token.save();

  // OHLC + organic volume: exclude module-recursion trades (§1e).
  // Candles use the POOL price, not the execution price — a 98%-tax token would
  // otherwise render a chart of its own fee stack rather than of its market.
  if (!moduleFlow) {
    updateCandles(tokenId, poolPrice, bnbIn, event.block.timestamp);
  }
}

export function handleTokenSold(event: TokenSold): void {
  let tokenId = event.params.token.toHexString();
  let token = Token.load(tokenId);
  if (token == null) return;

  let seller = event.params.seller;
  let bnbOut = event.params.bnbOut;
  let tokensIn = event.params.tokensIn;
  let moduleFlow = isModule(seller);
  let price = priceFrom(bnbOut, tokensIn);
  let sqrtPriceX96 = event.params.sqrtPriceX96;
  let poolPrice = poolPriceBnbPerToken(sqrtPriceX96);

  let t = new Trade(eventId(event));
  t.token = tokenId;
  t.trader = seller;
  t.attributed = !seller.equals(ADDRESS_ZERO);
  t.isModuleFlow = moduleFlow;
  t.kind = "sell";
  t.bnbOut = bnbOut;
  t.tokensIn = tokensIn;
  t.platformFee = event.params.platformFee;
  t.taxTaken = event.params.taxTaken;
  t.priceBnbPerToken = price;
  t.sqrtPriceX96 = sqrtPriceX96;
  t.tick = event.params.tick;
  t.poolPriceBnbPerToken = poolPrice;
  t.timestamp = event.block.timestamp;
  t.blockNumber = event.block.number;
  t.txHash = event.transaction.hash;
  t.save();

  token.sellCount = token.sellCount.plus(ONE_BI);
  token.totalPlatformFeeBnb = token.totalPlatformFeeBnb.plus(event.params.platformFee);
  token.totalTaxBnb = token.totalTaxBnb.plus(event.params.taxTaken);
  if (!moduleFlow) {
    token.lastPriceBnb = poolPrice;
  }
  token.save();

  if (!moduleFlow) {
    updateCandles(tokenId, poolPrice, bnbOut, event.block.timestamp);
  }
}

export function handleLumoriaPoolInitialized(event: LumoriaPoolInitialized): void {
  let tokenId = event.params.token.toHexString();
  let token = Token.load(tokenId);
  if (token == null) return;
  token.poolId = event.params.poolId;
  token.save();
}
