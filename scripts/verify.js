/**
 * BscScan verification helper.
 *
 * Reads deployments/<network>.json and calls `hardhat verify` for every
 * contract with the correct constructor arguments. Master copies have no
 * constructor args; core contracts do.
 *
 * Requires ETHERSCAN_API_KEY in env — Etherscan V2 unified key, covers BSC
 * (see hardhat.config.js).
 *
 * Run:
 *   npx hardhat run scripts/verify.js --network bscTestnet
 *   npx hardhat run scripts/verify.js --network bsc
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const hre = require("hardhat");

function loadDeployments() {
    const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`No deployments file for ${hre.network.name} — run deploy-base.js first`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function verify(address, args, contract) {
    const argsStr = args.map((a) => `"${a}"`).join(" ");
    const contractFlag = contract ? `--contract ${contract}` : "";
    const cmd = `npx hardhat verify --network ${hre.network.name} ${contractFlag} ${address} ${argsStr}`.trim();
    console.log(`\n> ${cmd}`);
    try {
        execSync(cmd, { stdio: "inherit" });
    } catch (e) {
        // Already-verified / already-submitted are non-fatal. Everything else we surface.
        const msg = String(e.message || "");
        if (msg.includes("Already Verified") || msg.includes("already verified")) {
            console.log("  (already verified — skipping)");
        } else {
            console.error(`  ✗ verification failed: ${msg}`);
        }
    }
}

async function main() {
    if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        throw new Error("verify.js only makes sense on public networks (bsc, bscTestnet)");
    }

    const dep = loadDeployments();
    const { core, masterCopies, v4, wbnb, feeRecipient, deployer } = dep;

    console.log(`Verifying on: ${hre.network.name}\n`);

    // ── Core (constructor args required) ───────────────────────────
    verify(core.database, [wbnb]);
    verify(core.feeReceiver, [feeRecipient]);
    verify(core.rebateContract, [core.database]);
    verify(core.create2Deployer, []);
    verify(core.hook, [v4.poolManager, core.database], "contracts/v4/LumoriaHook.sol:LumoriaHook");
    verify(core.liquidityVault, [v4.poolManager, core.database], "contracts/v4/LumoriaLiquidityVault.sol:LumoriaLiquidityVault");
    verify(core.vestingVault, [core.database], "contracts/VestingVault.sol:VestingVault");
    verify(core.router, [v4.poolManager, core.database], "contracts/v4/LumoriaSwapRouter.sol:LumoriaSwapRouter");
    verify(core.generator, [core.database]);
    verify(core.randomnessProvider, [core.database], "contracts/TrustedOperatorRandomness.sol:TrustedOperatorRandomness");

    // PoolManager: only ours to verify when we deployed it (bscTestnet).
    // On bsc mainnet the canonical Uniswap deployment is already verified.
    if (v4.poolManagerDeployedByUs) {
        verify(v4.poolManager, [deployer], "@uniswap/v4-core/src/PoolManager.sol:PoolManager");
    }

    // ── Master copies (no constructor args) ────────────────────────
    verify(masterCopies.token, []);
    verify(masterCopies.taxHandler, []);
    verify(masterCopies.flatCurve, []);
    verify(masterCopies.creatorFee, []);
    verify(masterCopies.reward, []);
    verify(masterCopies.burn, []);
    verify(masterCopies.liquidity, []);
    verify(masterCopies.prizePool, [], "contracts/modules/PrizePool.sol:PrizePool");
    verify(masterCopies.milestone, [], "contracts/modules/MilestoneRewardModule.sol:MilestoneRewardModule");

    console.log("\n✓ Verification pass complete.\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
