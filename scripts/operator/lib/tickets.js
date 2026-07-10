// Ticket derivation for PrizePool settlement — the operator-side mirror of
// the subgraph's reference derivation (subgraph/src/prize.ts) and of
// TOKENOMICS_V2 §2.5:
//
//   one ticket per TokenPurchased log where
//     - token   == the PrizePool's token
//     - user    != address(0)              (third-party-router buys earn none)
//     - user    is not a module clone of this token (module buybacks are
//               tax recursion, not participants — they could never claim)
//     - the log's block timestamp falls inside the epoch window
//
// Tickets are append-only and never merged. Weight is raw bnbIn; the optional
// per-address cap is applied at root-build time by scripts/lib/merkle.js.

const { ethers } = require("hardhat");

const PRIZE_ABI = [
    "function token() view returns (address)",
    "function taxHandler() view returns (address)",
    "function database() view returns (address)",
    "function payoutMode() view returns (uint8)",
    "function winnerCount() view returns (uint8)",
    "function maxWeightBps() view returns (uint256)",
    "function rootPoster() view returns (address)",
    "function epochLength() view returns (uint256)",
    "function pendingEpochLength() view returns (uint256)",
    "function currentEpochId() view returns (uint256)",
    "function currentEpochStart() view returns (uint256)",
    "function liveEpochId() view returns (uint256)",
    "event EpochLengthApplied(uint256 indexed epochId, uint256 newLength)",
];

const TAXHANDLER_ABI = [
    "function getModuleCount() view returns (uint256)",
    "function getModule(uint256) view returns (tuple(address moduleAddress, uint8 moduleType, uint256 buyAllocation, uint256 sellAllocation, bool active))",
];

const DATABASE_ABI = ["function hook() view returns (address)"];

const HOOK_ABI = [
    "event TokenPurchased(address indexed token, address indexed buyer, uint256 bnbIn, uint256 platformFee, uint256 taxTaken, uint256 tokensOut, uint160 sqrtPriceX96, int24 tick)",
];

/**
 * Compute [start, end) for `epochId`, anchored at the contract's stored
 * (currentEpochId, currentEpochStart, epochLength) and walked across every
 * EpochLengthApplied segment.
 *
 * Refuses two genuinely ambiguous cases rather than guessing:
 *  - an epoch older than the first on-chain length change (the initial length
 *    is only in the init payload), and
 *  - forward extrapolation past the anchor while a pending length change is
 *    queued (the contract applies it at the first ADVANCE past the boundary,
 *    which depends on transaction timing, not state).
 */
async function epochWindow(prize, epochId) {
    const e = BigInt(epochId);
    const cid = await prize.currentEpochId();
    const cstart = await prize.currentEpochStart();
    const clen = await prize.epochLength();
    const pending = await prize.pendingEpochLength();

    const applied = (await prize.queryFilter(prize.filters.EpochLengthApplied()))
        .map((l) => ({ epochId: l.args.epochId, newLength: l.args.newLength }))
        .sort((a, b) => (a.epochId < b.epochId ? -1 : 1));

    // Length in force for a given epoch: the newLength of the latest applied
    // change at or before it; before the first change it is the init length,
    // which is only observable if no change ever happened (then == clen).
    function lengthFor(epoch) {
        let len = null;
        for (const a of applied) {
            if (a.epochId <= epoch) len = a.newLength;
            else break;
        }
        if (len !== null) return len;
        if (applied.length === 0) return clen;
        throw new Error(
            `epoch ${epoch} predates the first epoch-length change; ` +
            `derive its window from the subgraph (PrizeEpoch/PrizeTicket) instead`,
        );
    }

    let start;
    if (e <= cid) {
        // Walk backward from the anchor, segment-aware.
        start = cstart;
        for (let k = cid - 1n; k >= e; k--) start -= lengthFor(k);
    } else {
        if (pending !== 0n) {
            throw new Error(
                "cannot extrapolate past the stored epoch anchor while an epoch-length " +
                "change is queued — wait for on-chain state to advance (any receiveTax), " +
                "or derive the window from the subgraph",
            );
        }
        start = cstart + (e - cid) * clen;
    }
    const end = start + lengthFor(e);
    return { start, end };
}

/** All module-clone addresses of the token, lowercased — excluded from tickets. */
async function moduleAddressesOf(taxHandler) {
    const n = await taxHandler.getModuleCount();
    const out = new Set();
    for (let i = 0n; i < n; i++) {
        const m = await taxHandler.getModule(i);
        out.add(m.moduleAddress.toLowerCase());
    }
    return out;
}

/**
 * Derive the ticket list for (prizePool, epochId).
 * Returns { tickets, window, config } where tickets is
 * [{ account, weight, tokensBought }] in log order.
 */
async function deriveTickets(prizePoolAddr, epochId, { fromBlock = 0 } = {}) {
    const prize = new ethers.Contract(prizePoolAddr, PRIZE_ABI, ethers.provider);
    const token = (await prize.token()).toLowerCase();
    const taxHandler = new ethers.Contract(await prize.taxHandler(), TAXHANDLER_ABI, ethers.provider);
    const db = new ethers.Contract(await prize.database(), DATABASE_ABI, ethers.provider);
    const hook = new ethers.Contract(await db.hook(), HOOK_ABI, ethers.provider);

    const window = await epochWindow(prize, epochId);
    const excluded = await moduleAddressesOf(taxHandler);

    const logs = await hook.queryFilter(
        hook.filters.TokenPurchased(token),
        fromBlock,
        "latest",
    );

    // Timestamp filter needs block times; cache per block.
    const blockTs = new Map();
    async function tsOf(blockNumber) {
        if (!blockTs.has(blockNumber)) {
            blockTs.set(blockNumber, BigInt((await ethers.provider.getBlock(blockNumber)).timestamp));
        }
        return blockTs.get(blockNumber);
    }

    const tickets = [];
    for (const log of logs) {
        const buyer = log.args.buyer;
        if (buyer === ethers.ZeroAddress) continue;
        if (excluded.has(buyer.toLowerCase())) continue;
        const ts = await tsOf(log.blockNumber);
        if (ts < window.start || ts >= window.end) continue;
        tickets.push({
            account: buyer,
            weight: log.args.bnbIn,
            tokensBought: log.args.tokensOut,
        });
    }

    return {
        tickets,
        window,
        config: {
            payoutMode: Number(await prize.payoutMode()),
            winnerCount: Number(await prize.winnerCount()),
            maxWeightBps: await prize.maxWeightBps(),
            rootPoster: await prize.rootPoster(),
        },
    };
}

module.exports = { deriveTickets, epochWindow, PRIZE_ABI };
