/**
 * Lumoria base deployment (Uniswap V4 era).
 *
 * Order (dependencies bottom-up):
 *   1. WBNB marker             — canonical address on bsc/bscTestnet; MockWBNB locally.
 *                                 (Pools are native-BNB; this is only the legacy
 *                                 path-marker the modules use.)
 *   2. Database(wbnb)
 *   3. FeeReceiver(platformRecipient)
 *   4. RebateContract(database)
 *   5. Master copies            — Token, TaxHandler, FlatCurve, 4 modules
 *   6. Uniswap V4 PoolManager   — CANONICAL address on bsc; deployed fresh on
 *                                 bscTestnet/local (BUSL-1.1 permits non-production
 *                                 use; Uniswap has no official BSC-testnet deployment).
 *   7. Create2Deployer + LumoriaHook — the hook's permissions are encoded in the
 *                                 low 14 bits of its address, so it is deployed
 *                                 via CREATE2 with a salt mined off-chain.
 *   8. LumoriaLiquidityVault(poolManager, database)
 *   8b. VestingVault(database)  — shared singleton custodying vested creator allocations
 *   9. LumoriaSwapRouter(poolManager, database)
 *  10. Generator(database)
 *  11. Wire everything into Database via onlyOwner setters
 *  12. Authorize the HOOK as a RebateContract creditor (the hook sees every
 *      buy regardless of router, so it owns rebate crediting now)
 *
 * Writes deployments/<network>.json for downstream tooling (verify,
 * smoke-launch, subgraph, frontend).
 *
 * Run:
 *   npx hardhat run scripts/deploy-base.js --network localhost
 *   npx hardhat run scripts/deploy-base.js --network bscTestnet
 *   npx hardhat run scripts/deploy-base.js --network bsc
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployHookViaCreate2 } = require("./lib/hook-miner");

// Canonical WBNB addresses (https://docs.bnbchain.org)
const WBNB_ADDRESSES = {
    bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    bscTestnet: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
};

// Canonical Uniswap V4 deployments on BNB Chain (chain id 56).
// Source: https://docs.uniswap.org/contracts/v4/deployments
const UNISWAP_V4_BSC = {
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
    v4Quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
    positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

const MODULE_TYPE = {
    REWARD: 0,
    BURN: 1,
    LIQUIDITY: 2,
    CREATOR: 3,
};

async function deployContract(name, args = []) {
    const Factory = await hre.ethers.getContractFactory(name);
    const c = await Factory.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(`  ${name.padEnd(22)} → ${addr}`);
    return c;
}

async function main() {
    const networkName = hre.network.name;
    const [deployer] = await hre.ethers.getSigners();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    // Treat chainId 56 as BSC mainnet even when the network name is
    // "hardhat"/"localhost" — i.e. a mainnet FORK rehearsal — so the deploy
    // exercises the REAL canonical PoolManager + periphery, not a local copy.
    const isBscMainnet = networkName === "bsc" || chainId === 56;
    // Chain height just before any Lumoria contract exists — the subgraph's
    // manifest startBlock (no indexable Lumoria event can precede it).
    const startBlock = await hre.ethers.provider.getBlockNumber();

    console.log(`\nDeploying Lumoria (V4) to: ${networkName}`);
    console.log(`Deployer:                  ${deployer.address}`);
    const bal = await hre.ethers.provider.getBalance(deployer.address);
    console.log(`Balance:                   ${hre.ethers.formatEther(bal)} BNB\n`);

    // ── 1. WBNB marker ────────────────────────────────────────────
    let wbnb;
    if (WBNB_ADDRESSES[networkName]) {
        wbnb = WBNB_ADDRESSES[networkName];
        console.log(`WBNB marker (canonical) → ${wbnb}`);
    } else if (isBscMainnet) {
        wbnb = WBNB_ADDRESSES.bsc;
        console.log(`WBNB marker (canonical, fork) → ${wbnb}`);
    } else {
        console.log("Deploying MockWBNB (local network)...");
        const mock = await deployContract("MockWBNB");
        wbnb = await mock.getAddress();
    }

    // Platform fee recipient — defaults to deployer; override with FEE_RECIPIENT env var.
    const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
    console.log(`FeeReceiver recipient:  ${feeRecipient}\n`);

    // ── 2-4. Core system contracts ────────────────────────────────
    console.log("Deploying core contracts...");
    const database = await deployContract("Database", [wbnb]);
    const databaseAddr = await database.getAddress();
    const feeReceiver = await deployContract("FeeReceiver", [feeRecipient]);
    const rebate = await deployContract("RebateContract", [databaseAddr]);

    // ── 5. Master copies ──────────────────────────────────────────
    console.log("\nDeploying master copies...");
    const tokenMC = await deployContract("LumoriaToken");
    const taxHandlerMC = await deployContract("TaxHandler");
    const flatCurveMC = await deployContract("FlatCurve");
    const creatorMC = await deployContract("CreatorFeeModule");
    const rewardMC = await deployContract("RewardModule");
    const burnMC = await deployContract("BurnModule");
    const liquidityMC = await deployContract("LiquidityModule");

    // ── 6. Uniswap V4 PoolManager ─────────────────────────────────
    let poolManagerAddr;
    let poolManagerDeployedByUs = false;
    if (isBscMainnet) {
        poolManagerAddr = UNISWAP_V4_BSC.poolManager;
        console.log(`\nPoolManager (canonical BSC) → ${poolManagerAddr}`);
    } else {
        console.log("\nDeploying PoolManager (no canonical deployment on this network)...");
        const pm = await deployContract("PoolManager", [deployer.address]);
        poolManagerAddr = await pm.getAddress();
        poolManagerDeployedByUs = true;
    }

    // ── 7. LumoriaHook via CREATE2 (mined address) ────────────────
    console.log("\nDeploying Create2Deployer + mining hook address...");
    const create2Deployer = await deployContract("Create2Deployer");
    const { hook, address: hookAddr, salt: hookSalt } =
        await deployHookViaCreate2(create2Deployer, poolManagerAddr, databaseAddr);
    console.log(`  LumoriaHook            → ${hookAddr} (salt ${hookSalt})`);

    // ── 8-10. Vault + Router + Generator ──────────────────────────
    console.log("\nDeploying vault, vesting vault, router, generator...");
    const vault = await deployContract("LumoriaLiquidityVault", [poolManagerAddr, databaseAddr]);
    const vestingVault = await deployContract("VestingVault", [databaseAddr]);
    const router = await deployContract("LumoriaSwapRouter", [poolManagerAddr, databaseAddr]);
    const generator = await deployContract("Generator", [databaseAddr]);

    // ── 11. Wire into Database ────────────────────────────────────
    console.log("\nWiring Database...");
    const tx = async (label, call) => {
        const t = await call;
        await t.wait();
        console.log(`  ✓ ${label}`);
    };

    await tx("setPoolManager",        database.setPoolManager(poolManagerAddr));
    await tx("setHook",               database.setHook(hookAddr));
    await tx("setLiquidityVault",     database.setLiquidityVault(await vault.getAddress()));
    await tx("setVestingVault",       database.setVestingVault(await vestingVault.getAddress()));
    await tx("setRouter",             database.setRouter(await router.getAddress()));
    await tx("setGenerator",          database.setGenerator(await generator.getAddress()));
    await tx("setFeeReceiver",        database.setFeeReceiver(await feeReceiver.getAddress()));
    await tx("setRebateContract",     database.setRebateContract(await rebate.getAddress()));
    await tx("setTokenMasterCopy",    database.setTokenMasterCopy(await tokenMC.getAddress()));
    await tx("setTaxHandlerMasterCopy", database.setTaxHandlerMasterCopy(await taxHandlerMC.getAddress()));
    await tx("setFlatCurveMasterCopy",  database.setFlatCurveMasterCopy(await flatCurveMC.getAddress()));
    await tx("setModuleMasterCopy(REWARD)",    database.setModuleMasterCopy(MODULE_TYPE.REWARD, await rewardMC.getAddress()));
    await tx("setModuleMasterCopy(BURN)",      database.setModuleMasterCopy(MODULE_TYPE.BURN, await burnMC.getAddress()));
    await tx("setModuleMasterCopy(LIQUIDITY)", database.setModuleMasterCopy(MODULE_TYPE.LIQUIDITY, await liquidityMC.getAddress()));
    await tx("setModuleMasterCopy(CREATOR)",   database.setModuleMasterCopy(MODULE_TYPE.CREATOR, await creatorMC.getAddress()));

    // ── 12. Authorize the HOOK on RebateContract ──────────────────
    console.log("\nAuthorizing hook as rebate creditor...");
    await tx(
        "rebate.setAuthorizedCreditor(hook, true)",
        rebate.setAuthorizedCreditor(hookAddr, true)
    );

    // ── 13. Platform operators (optional) ─────────────────────────
    //
    // While `Database.operatorCount() == 0`, every module action is
    // permissionless — burns, auto-LP and reward conversion can be triggered by
    // anyone once their interval elapses. Registering the FIRST operator flips
    // the whole system to "operator-first, public after a 1h fallback delay".
    //
    // Set LUMORIA_OPERATORS to a comma-separated list of backend addresses to
    // enable that. Leave it unset to ship permissionless.
    const operatorList = (process.env.LUMORIA_OPERATORS || "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);

    if (operatorList.length > 0) {
        console.log("\nRegistering platform operators...");
        for (const op of operatorList) {
            await tx(`database.setOperator(${op}, true)`, database.setOperator(op, true));
        }
    } else {
        console.log("\nNo LUMORIA_OPERATORS set — module execution stays permissionless.");
    }

    // ── Write deployments artifact ────────────────────────────────
    const deployments = {
        network: networkName,
        chainId,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        startBlock,
        wbnb,
        feeRecipient,
        core: {
            database:        databaseAddr,
            feeReceiver:     await feeReceiver.getAddress(),
            rebateContract:  await rebate.getAddress(),
            hook:            hookAddr,
            liquidityVault:  await vault.getAddress(),
            vestingVault:    await vestingVault.getAddress(),
            router:          await router.getAddress(),
            generator:       await generator.getAddress(),
            create2Deployer: await create2Deployer.getAddress(),
        },
        v4: {
            poolManager: poolManagerAddr,
            poolManagerDeployedByUs,
            hookSalt,
            // Canonical periphery for frontend integration (quoting, routing).
            // Only meaningful on bsc mainnet.
            ...(isBscMainnet ? {
                universalRouter: UNISWAP_V4_BSC.universalRouter,
                v4Quoter: UNISWAP_V4_BSC.v4Quoter,
                stateView: UNISWAP_V4_BSC.stateView,
                positionManager: UNISWAP_V4_BSC.positionManager,
                permit2: UNISWAP_V4_BSC.permit2,
            } : {}),
        },
        masterCopies: {
            token:       await tokenMC.getAddress(),
            taxHandler:  await taxHandlerMC.getAddress(),
            flatCurve:   await flatCurveMC.getAddress(),
            creatorFee:  await creatorMC.getAddress(),
            reward:      await rewardMC.getAddress(),
            burn:        await burnMC.getAddress(),
            liquidity:   await liquidityMC.getAddress(),
        },
    };

    const outDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const outFile = path.join(outDir, `${networkName}.json`);
    fs.writeFileSync(outFile, JSON.stringify(deployments, null, 2));
    console.log(`\n✓ Wrote ${outFile}\n`);
    console.log("Deployment complete.\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
