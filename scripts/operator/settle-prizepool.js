// PrizePool epoch settlement — derive tickets, build the merkle root, post it.
//
//   PRIZE_POOL=0x... EPOCH_ID=3 npx hardhat run scripts/operator/settle-prizepool.js --network bsc
//
// Env:
//   PRIZE_POOL   the PrizePool clone address                    (required)
//   EPOCH_ID     the ENDED epoch to settle                      (required)
//   FROM_BLOCK   first block to scan for TokenPurchased         (default 0; set to the token's launch block)
//   DRY_RUN      "1" = derive + print, do not transact          (default off)
//   OUT          path to write the full settlement JSON (root,
//                entries, per-entry proofs) for the frontend    (optional)
//
// The signer (DEPLOYER_PK via hardhat.config) must be the pool's rootPoster
// unless DRY_RUN=1. Anyone can run a dry run and compare the printed root to
// the one on-chain — that independent recomputation is the entire trust model
// (TOKENOMICS_V2 §5); a mismatch during the 6h challenge window is what
// invalidateRoot exists for.
//
// ORDER REMINDER: postRoot always precedes drawRandomness (the contract
// enforces it). For LOTTERY pools, run scripts/operator/randomness.js commit
// BEFORE the epoch's buyers are known, and reveal only after the draw.

const fs = require("fs");
const { ethers } = require("hardhat");
const { deriveTickets, PRIZE_ABI } = require("./lib/tickets");
const {
    buildProRataSettlement,
    buildLotterySettlement,
} = require("../lib/merkle");

const MODE_NAMES = ["PRO_RATA", "LOTTERY", "ALL_HOLDERS"];

async function main() {
    const prizePoolAddr = process.env.PRIZE_POOL;
    const epochId = process.env.EPOCH_ID;
    if (!prizePoolAddr || epochId === undefined) {
        throw new Error("PRIZE_POOL and EPOCH_ID env vars are required");
    }
    const fromBlock = Number(process.env.FROM_BLOCK || 0);
    const dryRun = process.env.DRY_RUN === "1";

    const { tickets, window, config } = await deriveTickets(prizePoolAddr, epochId, { fromBlock });
    console.log(`PrizePool ${prizePoolAddr} — epoch ${epochId} (${MODE_NAMES[config.payoutMode]})`);
    console.log(`  window  [${window.start}, ${window.end})`);
    console.log(`  tickets ${tickets.length}`);

    if (config.payoutMode === 2) {
        console.log("ALL_HOLDERS pools have no root — call settleAllHolders(epochId) directly.");
        return;
    }

    let settlement;
    if (config.payoutMode === 0) {
        settlement = buildProRataSettlement(tickets.length ? tickets : []);
    } else {
        settlement = buildLotterySettlement(tickets, { maxWeightBps: config.maxWeightBps });
    }
    const root = tickets.length ? settlement.root : ethers.ZeroHash;
    const totalWeight = tickets.length ? settlement.totalWeight : 0n;
    const ticketCount = tickets.length;

    console.log(`  root        ${root}`);
    console.log(`  totalWeight ${totalWeight}`);

    if (process.env.OUT) {
        fs.writeFileSync(process.env.OUT, JSON.stringify({
            prizePool: prizePoolAddr,
            epochId: String(epochId),
            mode: MODE_NAMES[config.payoutMode],
            window: { start: String(window.start), end: String(window.end) },
            root,
            totalWeight: String(totalWeight),
            ticketCount,
            entries: (settlement?.entries ?? []).map((e, i) => ({
                ...Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)])),
                proof: config.payoutMode === 0
                    ? settlement.proofFor(e.account).proof
                    : settlement.proofFor(i).proof,
            })),
        }, null, 2));
        console.log(`  wrote ${process.env.OUT}`);
    }

    if (dryRun) {
        console.log("DRY_RUN — not posting.");
        return;
    }

    const [signer] = await ethers.getSigners();
    if (signer.address.toLowerCase() !== config.rootPoster.toLowerCase()) {
        throw new Error(`signer ${signer.address} is not rootPoster ${config.rootPoster}`);
    }
    const prize = new ethers.Contract(prizePoolAddr, [
        ...PRIZE_ABI,
        "function postRoot(uint256 epochId, bytes32 root, uint256 totalWeight, uint256 ticketCount)",
    ], signer);

    const tx = await prize.postRoot(epochId, root, totalWeight, ticketCount);
    console.log(`  postRoot tx ${tx.hash}`);
    await tx.wait();
    console.log("  posted. LOTTERY pools: drawRandomness opens after the 6h challenge window.");
}

main().catch((e) => { console.error(e); process.exit(1); });
