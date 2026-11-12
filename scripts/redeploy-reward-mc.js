/**
 * Delta deploy: replace the RewardModule master copy (type 0) with the
 * auto-claim version (`pushRewards`, DESIGN §6.1a).
 *
 * Master copies only affect FUTURE clones. Tokens launched before the rotation
 * keep their frozen claim-only RewardModule; the keeper detects that and skips
 * auto-claim for them.
 *
 * Run:  npx hardhat run scripts/redeploy-reward-mc.js --network bsc
 *       (set CONFIRM_REWARD_MC=YES to actually rotate the Database pointer;
 *        without it the script deploys nothing and only prints the plan)
 *
 * Updates deployments/<network>.json (masterCopies.reward, old one kept as
 * masterCopies.rewardV1).
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployRaw, callRaw } = require("./lib/raw-tx");

const REWARD_TYPE = 0;

async function main() {
    const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    const dep = JSON.parse(fs.readFileSync(file, "utf8"));
    const database = await hre.ethers.getContractAt("Database", dep.core.database);
    const deployer = new hre.ethers.Wallet(hre.network.config.accounts[0]).address;

    const owner = await database.getOwner();
    const current = await database.moduleMasterCopies(REWARD_TYPE);
    console.log(`\nRewardModule master-copy redeploy on ${hre.network.name}`);
    console.log(`  deployer        ${deployer}`);
    console.log(`  Database owner  ${owner}`);
    console.log(`  current MC (0)  ${current}`);
    if (owner.toLowerCase() !== deployer.toLowerCase()) throw new Error("Deployer is not Database owner");

    if (process.env.CONFIRM_REWARD_MC !== "YES") {
        console.log("\nPlan only — set CONFIRM_REWARD_MC=YES to deploy + rotate.");
        return;
    }

    const { address: mcAddr, receipt } = await deployRaw(hre, "RewardModule");
    console.log(`  RewardModule (new MC) → ${mcAddr} (tx ${receipt.hash})`);

    // Sanity: the new code really has pushRewards before anything points at it.
    const mc = await hre.ethers.getContractAt("RewardModule", mcAddr);
    await mc.pushRewards.staticCall([], 0n);

    const rot = await callRaw(hre, database, "setModuleMasterCopy", [REWARD_TYPE, mcAddr]);
    console.log(`  ✓ setModuleMasterCopy(REWARD, ${mcAddr}) — tx ${rot.hash}`);
    const after = await database.moduleMasterCopies(REWARD_TYPE);
    if (after.toLowerCase() !== mcAddr.toLowerCase()) throw new Error("Database pointer mismatch after rotation");

    dep.masterCopies.rewardV1 = dep.masterCopies.reward;
    dep.masterCopies.reward = mcAddr;
    fs.writeFileSync(file, JSON.stringify(dep, null, 2));
    console.log(`\n✓ Updated ${file}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
