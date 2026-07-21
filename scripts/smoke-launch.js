/**
 * Post-deployment smoke test.
 *
 * Exercises the happy path end-to-end against a live deployment:
 *   1. Predict the token address via Generator.predictTokenAddress(salt).
 *   2. Launch a minimal BYOL token (1 module: CreatorFee @ 10000/10000 buy+sell)
 *      — this initializes the V4 pool and locks liquidity in the vault.
 *   3. Confirm it was registered in the Database + liquidity is vault-locked.
 *   4. Buy a small amount through the LumoriaSwapRouter (hook collects the
 *      platform fee + tax at the pool level) and assert volume registered.
 *
 * Run against a deployed system (reads deployments/<network>.json):
 *   npx hardhat run scripts/smoke-launch.js --network localhost
 *   npx hardhat run scripts/smoke-launch.js --network bscTestnet
 *
 * Assumes `deploy-base.js` has already run on this network.
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const BPS = 10000n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const MODULE_TYPE_CREATOR = 3;
const LAUNCH_MODE_BYOL = 0;

function loadDeployments() {
    const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`No deployments file for ${hre.network.name} — run deploy-base.js first`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
    const dep = loadDeployments();
    const [deployer] = await hre.ethers.getSigners();

    console.log(`\nSmoke-testing on: ${hre.network.name}`);
    console.log(`Deployer:         ${deployer.address}\n`);

    const generator = await hre.ethers.getContractAt("Generator", dep.core.generator);
    const database = await hre.ethers.getContractAt("Database", dep.core.database);
    const router = await hre.ethers.getContractAt("LumoriaSwapRouter", dep.core.router);
    const vault = await hre.ethers.getContractAt("LumoriaLiquidityVault", dep.core.liquidityVault);

    // Unique salt per run so repeat invocations don't collide.
    const salt = hre.ethers.id(`lumoria-smoke-${Date.now()}`);

    const predicted = await generator.predictTokenAddress(salt);
    console.log(`Predicted token address: ${predicted}`);

    // Single CreatorFee module at 100% buy + 100% sell. Payload: (address recipient).
    const creatorPayload = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [deployer.address],
    );
    const modules = [{
        moduleType: MODULE_TYPE_CREATOR,
        buyAllocation: Number(BPS),
        sellAllocation: Number(BPS),
        initPayload: creatorPayload,
    }];

    // BYOL payload: tokensForLP (half the supply for LP, the rest to creator).
    const tokensForLP = TOTAL_SUPPLY / 2n;
    const byolPayload = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256"],
        [tokensForLP],
    );

    const liquidityBNB = hre.ethers.parseEther("0.1");
    const buyBNB = hre.ethers.parseEther("0.01");
    // Flat anti-spam launch fee, paid on top of the LP seed.
    const launchFee = await database.launchFeeBnb();

    console.log(`\nLaunching BYOL token (0.1 BNB liquidity + ${hre.ethers.formatEther(launchFee)} BNB launch fee + tokensForLP=${tokensForLP})...`);
    const launchTx = await generator.generateProject(
        "SmokeToken",
        "SMOKE",
        500,  // 5% buy fee
        500,  // 5% sell fee
        modules,
        LAUNCH_MODE_BYOL,
        byolPayload,
        [], // no creator allocations in the smoke test
        salt,
        { value: liquidityBNB + launchFee },
    );
    const rcpt = await launchTx.wait();
    console.log(`  tx: ${rcpt.hash} (gas: ${rcpt.gasUsed})`);

    const isRegistered = await database.isLumoriaToken(predicted);
    if (!isRegistered) throw new Error(`Token ${predicted} was not registered`);
    console.log(`  ✓ token registered in Database`);

    const taxHandler = await database.tokenTaxHandler(predicted);
    console.log(`  taxHandler: ${taxHandler}`);

    const locked = await vault.lockedLiquidity(predicted);
    if (locked === 0n) throw new Error("No liquidity locked in the vault");
    console.log(`  ✓ V4 pool seeded — vault-locked liquidity: ${locked}`);

    // Buy through Router.
    console.log(`\nBuying through Router with ${hre.ethers.formatEther(buyBNB)} BNB...`);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const buyTx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, // amountOutMin — smoke test only
        [dep.wbnb, predicted],
        deployer.address,
        deadline,
        { value: buyBNB },
    );
    const buyRcpt = await buyTx.wait();
    console.log(`  tx: ${buyRcpt.hash} (gas: ${buyRcpt.gasUsed})`);

    const token = await hre.ethers.getContractAt("LumoriaToken", predicted);
    const balance = await token.balanceOf(deployer.address);
    console.log(`  Deployer token balance: ${hre.ethers.formatUnits(balance, 18)}`);

    const totalVolume = await database.tokenVolume(predicted);
    console.log(`  Registered volume: ${hre.ethers.formatEther(totalVolume)} BNB`);

    console.log("\n✓ Smoke test passed.\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
