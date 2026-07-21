/**
 * Delta deploy: replace the PrizePool master copy (type 4) and optionally
 * register platform operators.
 *
 * Why: rootPoster == address(0) now delegates root posting to the platform
 * operator registry (Database.isOperator) instead of reverting at init.
 * Master copies only affect FUTURE clones; no token existed yet when this ran.
 *
 * Run:  BSC_RPC=https://bsc-dataseed.binance.org npx hardhat run scripts/redeploy-prizepool-mc.js --network bsc
 * Env:  LUMORIA_OPERATORS — comma-separated operator addresses to register (optional).
 *
 * Updates deployments/<network>.json (masterCopies.prizePool + operators list).
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    const dep = JSON.parse(fs.readFileSync(file, "utf8"));

    console.log(`\nPrizePool master-copy redeploy on ${hre.network.name}`);
    console.log(`Deployer: ${deployer.address}`);

    const database = await hre.ethers.getContractAt("Database", dep.core.database);

    const PrizePool = await hre.ethers.getContractFactory("PrizePool");
    const mc = await PrizePool.deploy();
    await mc.waitForDeployment();
    const mcAddr = await mc.getAddress();
    console.log(`  PrizePool (new MC)     → ${mcAddr}`);

    let tx = await database.setModuleMasterCopy(4, mcAddr);
    await tx.wait();
    console.log(`  ✓ setModuleMasterCopy(PRIZE, ${mcAddr})`);

    const operators = (process.env.LUMORIA_OPERATORS || "")
        .split(",").map((a) => a.trim()).filter(Boolean);
    for (const op of operators) {
        tx = await database.setOperator(op, true);
        await tx.wait();
        console.log(`  ✓ setOperator(${op}, true)`);
    }

    dep.masterCopies.prizePoolV1 = dep.masterCopies.prizePool; // keep the old one findable
    dep.masterCopies.prizePool = mcAddr;
    dep.operators = [...new Set([...(dep.operators || []), ...operators])];
    fs.writeFileSync(file, JSON.stringify(dep, null, 2));
    console.log(`\n✓ Updated ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
