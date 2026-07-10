// TrustedOperatorRandomness commit / reveal driver.
//
//   MODE=commit PRIZE_POOL=0x... EPOCH_ID=3 npx hardhat run scripts/operator/randomness.js --network bsc
//   MODE=reveal PRIZE_POOL=0x... EPOCH_ID=3 npx hardhat run scripts/operator/randomness.js --network bsc
//
// Env:
//   MODE         commit | reveal                                (required)
//   PRIZE_POOL   the consuming PrizePool clone                  (required)
//   EPOCH_ID     the epoch the randomness is for                (required)
//   SEED_DIR     where seed files live (default .randomness-seeds/, gitignored)
//
// ORDER IS THE SECURITY MODEL (TOKENOMICS_V2 §3): commit BEFORE the epoch's
// buyers are known — at or before the epoch starts — and reveal only after
// postRoot + drawRandomness. Committing late lets the ticket set inform the
// seed; revealing without a prior commit is impossible on-chain.
//
// The seed file is the only copy. Losing it before reveal means the epoch
// rolls over at the randomness deadline (funds delayed, never stuck).

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const PROVIDER_ABI = [
    "function commit(bytes32 scopedKey, bytes32 seedHash)",
    "function reveal(address consumer, bytes32 requestKey, bytes32 seed)",
    "function scopedKeyFor(address consumer, bytes32 requestKey) pure returns (bytes32)",
    "function seedHashes(bytes32) view returns (bytes32)",
];
const PRIZE_ABI = ["function database() view returns (address)"];
const DB_ABI = ["function randomnessProvider() view returns (address)"];

async function main() {
    const mode = process.env.MODE;
    const prizePool = process.env.PRIZE_POOL;
    const epochId = process.env.EPOCH_ID;
    if (!mode || !prizePool || epochId === undefined) {
        throw new Error("MODE, PRIZE_POOL and EPOCH_ID env vars are required");
    }
    const seedDir = process.env.SEED_DIR || ".randomness-seeds";
    fs.mkdirSync(seedDir, { recursive: true });
    const seedFile = path.join(seedDir, `${prizePool.toLowerCase()}-${epochId}.seed`);

    const [signer] = await ethers.getSigners();
    const prize = new ethers.Contract(prizePool, PRIZE_ABI, ethers.provider);
    const db = new ethers.Contract(await prize.database(), DB_ABI, ethers.provider);
    const providerAddr = await db.randomnessProvider();
    if (providerAddr === ethers.ZeroAddress) throw new Error("Database.randomnessProvider is unset");
    const provider = new ethers.Contract(providerAddr, PROVIDER_ABI, signer);

    const requestKey = ethers.toBeHex(BigInt(epochId), 32); // PrizePool uses bytes32(epochId)
    const scopedKey = await provider.scopedKeyFor(prizePool, requestKey);

    if (mode === "commit") {
        if (fs.existsSync(seedFile)) throw new Error(`seed already exists: ${seedFile}`);
        const seed = ethers.hexlify(ethers.randomBytes(32));
        fs.writeFileSync(seedFile, seed, { mode: 0o600 });
        const tx = await provider.commit(scopedKey, ethers.keccak256(seed));
        console.log(`committed ${ethers.keccak256(seed)} for epoch ${epochId} — tx ${tx.hash}`);
        await tx.wait();
        console.log(`seed saved to ${seedFile} — required at reveal time, keep it safe`);
    } else if (mode === "reveal") {
        const seed = fs.readFileSync(seedFile, "utf8").trim();
        const onchain = await provider.seedHashes(scopedKey);
        if (onchain !== ethers.keccak256(seed)) {
            throw new Error("local seed does not match the on-chain commit");
        }
        const tx = await provider.reveal(prizePool, requestKey, seed);
        console.log(`revealed epoch ${epochId} — tx ${tx.hash}`);
        await tx.wait();
    } else {
        throw new Error(`unknown MODE '${mode}' (commit | reveal)`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
