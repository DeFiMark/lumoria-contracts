import { BigInt, BigDecimal, Bytes, Address, ethereum } from "@graphprotocol/graph-ts";
import {
  Token,
  User,
  Holder,
  Module,
  PlatformConfig,
  PlatformDayData,
  HolderDayData,
  SystemAddresses,
  TokenDayData,
  TokenHourData,
  TokenMinuteData,
} from "../generated/schema";
import { Database } from "../generated/Database/Database";

export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const ZERO_BD = BigDecimal.fromString("0");
export const BI_18 = BigInt.fromString("1000000000000000000");
export const BD_18 = BigDecimal.fromString("1000000000000000000");

export const ADDRESS_ZERO = Address.fromString("0x0000000000000000000000000000000000000000");
export const PLATFORM_ID = "1";

// Module type ids (mirror TaxHandler constants)
export const MODULE_REWARD = 0;
export const MODULE_BURN = 1;
export const MODULE_LIQUIDITY = 2;
export const MODULE_CREATOR = 3;

// time buckets
export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_5MIN = 300;

/** tx-hash:log-index — the canonical id for immutable log entities. */
export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function bytesToBD(value: BigInt): BigDecimal {
  return value.toBigDecimal();
}

/** Null-coalesce a nullable BigInt entity field to zero. */
export function nz(value: BigInt | null): BigInt {
  return value === null ? ZERO_BI : value as BigInt;
}

/** price = bnb / tokens (both 18-dec) as a human BigDecimal, or 0 if tokens == 0. */
export function priceFrom(bnb: BigInt, tokens: BigInt): BigDecimal {
  if (tokens.equals(ZERO_BI)) return ZERO_BD;
  return bnb.toBigDecimal().div(tokens.toBigDecimal());
}

export function getOrCreatePlatformConfig(): PlatformConfig {
  let p = PlatformConfig.load(PLATFORM_ID);
  if (p == null) {
    p = new PlatformConfig(PLATFORM_ID);
    p.platformFeeBps = ZERO_BI;
    p.totalFeesReceivedBnb = ZERO_BI;
    p.totalTokens = 0;
    p.totalVolumeBnb = ZERO_BI;
    p.creatorCount = 0;
    p.save();
  }
  return p as PlatformConfig;
}

export function getOrCreateUser(addr: Address): User {
  let u = User.load(addr.toHexString());
  if (u == null) {
    u = new User(addr.toHexString());
    u.save();
  }
  return u as User;
}

export function holderId(token: Address, holder: Address): string {
  return token.toHexString() + "-" + holder.toHexString();
}

/** Resolves PoolManager / Generator / VestingVault once from the Database. */
export function getOrCreateSystemAddresses(databaseAddr: Address): SystemAddresses {
  let s = SystemAddresses.load("1");
  if (s == null) {
    s = new SystemAddresses("1");
    let db = Database.bind(databaseAddr);
    let pm = db.try_poolManager();
    let gen = db.try_generator();
    let vv = db.try_vestingVault();
    s.poolManager = pm.reverted ? ADDRESS_ZERO : pm.value;
    s.generator = gen.reverted ? ADDRESS_ZERO : gen.value;
    s.vestingVault = vv.reverted ? ADDRESS_ZERO : vv.value;
    s.save();
  }
  return s as SystemAddresses;
}

/** Infra addresses that hold tokens but are NOT real holders (excluded from holderCount). */
export function isExcludedHolder(addr: Address, sys: SystemAddresses): boolean {
  if (addr.equals(ADDRESS_ZERO)) return true;
  if (addr.equals(changetype<Address>(sys.poolManager))) return true;
  if (addr.equals(changetype<Address>(sys.generator))) return true;
  if (addr.equals(changetype<Address>(sys.vestingVault))) return true;
  return false;
}

/** Creates a Module entity (no template spawn — callers spawn the template). */
export function getOrCreateModule(
  moduleAddr: Address,
  tokenId: string,
  taxHandler: Address,
  moduleType: i32,
  buyAlloc: BigInt,
  sellAlloc: BigInt,
  timestamp: BigInt
): Module {
  let m = Module.load(moduleAddr.toHexString());
  if (m == null) {
    m = new Module(moduleAddr.toHexString());
    m.token = tokenId;
    m.taxHandler = taxHandler;
    m.moduleType = moduleType;
    m.buyAllocation = buyAlloc;
    m.sellAllocation = sellAlloc;
    m.active = true;
    m.addedAt = timestamp;
    m.totalReceivedBnb = ZERO_BI;
  }
  return m as Module;
}

/** Loads (or creates) a Holder. `isPool` should be set by the caller on creation. */
export function getOrCreateHolder(
  tokenId: string,
  holder: Address,
  timestamp: BigInt
): Holder {
  let id = tokenId + "-" + holder.toHexString();
  let h = Holder.load(id);
  if (h == null) {
    h = new Holder(id);
    h.token = tokenId;
    h.user = getOrCreateUser(holder).id;
    h.address = holder;
    h.balance = ZERO_BI;
    h.isPool = false;
    h.firstSeen = timestamp;
    h.lastSeen = timestamp;
  }
  return h as Holder;
}

// ─── Platform day data ───────────────────────────────────────────────

export function dayStart(timestamp: BigInt): i32 {
  let t = timestamp.toI32();
  return (t / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function getOrCreatePlatformDayData(timestamp: BigInt): PlatformDayData {
  let day = dayStart(timestamp);
  let id = day.toString();
  let d = PlatformDayData.load(id);
  if (d == null) {
    d = new PlatformDayData(id);
    d.date = day;
    d.volumeBnb = ZERO_BI;
    d.feesBnb = ZERO_BI;
    d.newTokens = 0;
  }
  return d as PlatformDayData;
}

export function getOrCreateHolderDayData(
  tokenId: string,
  holder: Address,
  balance: BigInt,
  timestamp: BigInt
): void {
  let day = dayStart(timestamp);
  let id = holder.toHexString() + "-" + tokenId + "-" + day.toString();
  let d = HolderDayData.load(id);
  if (d == null) {
    d = new HolderDayData(id);
    d.holder = holder;
    d.token = tokenId;
    d.date = day;
  }
  d.balance = balance; // end-of-day snapshot (last write wins for the day)
  d.save();
}

// ─── OHLCV candles (organic trades only — callers must skip isModuleFlow) ──

export function updateCandles(
  tokenId: string,
  price: BigDecimal,
  volumeBnb: BigInt,
  timestamp: BigInt
): void {
  let t = timestamp.toI32();

  // daily
  let dStart = (t / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  let dId = tokenId + "-" + dStart.toString();
  let day = TokenDayData.load(dId);
  if (day == null) {
    day = new TokenDayData(dId);
    day.token = tokenId;
    day.date = dStart;
    day.open = price;
    day.high = price;
    day.low = price;
    day.volumeBnb = ZERO_BI;
    day.txCount = ZERO_BI;
  }
  if (price.gt(day.high)) day.high = price;
  if (price.lt(day.low)) day.low = price;
  day.close = price;
  day.volumeBnb = day.volumeBnb.plus(volumeBnb);
  day.txCount = day.txCount.plus(ONE_BI);
  day.save();

  // hourly
  let hStart = (t / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  let hId = tokenId + "-" + hStart.toString();
  let hour = TokenHourData.load(hId);
  if (hour == null) {
    hour = new TokenHourData(hId);
    hour.token = tokenId;
    hour.periodStart = hStart;
    hour.open = price;
    hour.high = price;
    hour.low = price;
    hour.volumeBnb = ZERO_BI;
    hour.txCount = ZERO_BI;
  }
  if (price.gt(hour.high)) hour.high = price;
  if (price.lt(hour.low)) hour.low = price;
  hour.close = price;
  hour.volumeBnb = hour.volumeBnb.plus(volumeBnb);
  hour.txCount = hour.txCount.plus(ONE_BI);
  hour.save();

  // 5-minute
  let mStart = (t / SECONDS_PER_5MIN) * SECONDS_PER_5MIN;
  let mId = tokenId + "-" + mStart.toString();
  let min = TokenMinuteData.load(mId);
  if (min == null) {
    min = new TokenMinuteData(mId);
    min.token = tokenId;
    min.periodStart = mStart;
    min.open = price;
    min.high = price;
    min.low = price;
    min.volumeBnb = ZERO_BI;
    min.txCount = ZERO_BI;
  }
  if (price.gt(min.high)) min.high = price;
  if (price.lt(min.low)) min.low = price;
  min.close = price;
  min.volumeBnb = min.volumeBnb.plus(volumeBnb);
  min.txCount = min.txCount.plus(ONE_BI);
  min.save();
}
