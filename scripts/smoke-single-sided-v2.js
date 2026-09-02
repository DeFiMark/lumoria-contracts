/**
 * Post-cutover canary for Permanent Single-Sided mode.
 *
 * Required environment:
 *   SMOKE_SINGLE_SIDED=YES
 *   SINGLE_SIDED_START_TICK=<approved aligned int24>
 *   SINGLE_SIDED_SMOKE_BUY_BNB=<approved decimal BNB amount>
 *   SINGLE_SIDED_SMOKE_BUY_FEE_BPS=<approved integer bps>
 *   SINGLE_SIDED_SMOKE_SELL_FEE_BPS=<approved integer bps>
 *
 * The script refuses to run unless Database already points at the candidate
 * Generator V2 and Vault V2. It launches one token, buys, and sells half the
 * purchased tokens. It never rotates infrastructure pointers.
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function load(name) {
    const file = path.join(__dirname, "..", "deployments", name);
    if (!fs.existsSync(file)) throw new Error(`Missing deployment file: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
    if (process.env.SMOKE_SINGLE_SIDED !== "YES") {
        throw new Error("Set SMOKE_SINGLE_SIDED=YES after approving the canary parameters");
    }
    const required = [
        "SINGLE_SIDED_START_TICK",
        "SINGLE_SIDED_SMOKE_BUY_BNB",
        "SINGLE_SIDED_SMOKE_BUY_FEE_BPS",
        "SINGLE_SIDED_SMOKE_SELL_FEE_BPS",
    ];
    const missing = required.filter((name) => process.env[name] === undefined);
    if (missing.length > 0) {
        throw new Error(`Missing approved canary parameters: ${missing.join(", ")}`);
    }

    const base = load(`${hre.network.name}.json`);
    const candidate = load(`${hre.network.name}-single-sided-v2-candidate.json`);
    const [operator] = await hre.ethers.getSigners();
    const database = await hre.ethers.getContractAt("Database", base.core.database);
    const generator = await hre.ethers.getContractAt("Generator", candidate.generatorV2);
    const vault = await hre.ethers.getContractAt("LumoriaLiquidityVault", candidate.vaultV2);
    const router = await hre.ethers.getContractAt("LumoriaSwapRouter", base.core.router);

    if ((await database.generator()).toLowerCase() !== candidate.generatorV2.toLowerCase()) {
        throw new Error("Database.generator is not the reviewed Generator V2 candidate");
    }
    if ((await database.liquidityVault()).toLowerCase() !== candidate.vaultV2.toLowerCase()) {
        throw new Error("Database.liquidityVault is not the reviewed Vault V2 candidate");
    }

    const startTick = Number(process.env.SINGLE_SIDED_START_TICK);
    if (!Number.isInteger(startTick) || startTick % 60 !== 0) {
        throw new Error("SINGLE_SIDED_START_TICK must be an aligned integer tick");
    }
    const [minStartTick, maxStartTick] = await generator.singleSidedStartTickBounds();
    if (startTick < Number(minStartTick) || startTick > Number(maxStartTick)) {
        throw new Error(
            `SINGLE_SIDED_START_TICK ${startTick} is outside Generator V2 bounds ` +
            `[${minStartTick}, ${maxStartTick}]`,
        );
    }
    const buyAmount = hre.ethers.parseEther(process.env.SINGLE_SIDED_SMOKE_BUY_BNB);
    const buyFeeBps = Number(process.env.SINGLE_SIDED_SMOKE_BUY_FEE_BPS);
    const sellFeeBps = Number(process.env.SINGLE_SIDED_SMOKE_SELL_FEE_BPS);
    if (
        !Number.isInteger(buyFeeBps)
            || !Number.isInteger(sellFeeBps)
            || buyFeeBps < 0
            || sellFeeBps < 0
            || buyFeeBps > 9800
            || sellFeeBps > 9800
    ) throw new Error("Canary fees must be integer basis points within the existing 0..9800 cap");
    const launchFee = await database.launchFeeBnb();
    const salt = hre.ethers.id(`lumoria-single-sided-canary-${Date.now()}`);
    const tokenAddress = await generator.predictTokenAddress(salt);
    const payload = hre.ethers.AbiCoder.defaultAbiCoder().encode(["int24"], [startTick]);
    const creatorPayload = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [operator.address],
    );
    const modules = [{
        moduleType: 3,
        buyAllocation: 10000,
        sellAllocation: 10000,
        initPayload: creatorPayload,
    }];

    const launch = await generator.generateProject(
        "Lumoria Single-Sided Canary",
        "LSSC",
        buyFeeBps,
        sellFeeBps,
        modules,
        2,
        payload,
        [],
        salt,
        { image: "", socials: "", contractURI: "" },
        { value: launchFee },
    );
    const launchReceipt = await launch.wait();
    const position = await vault.singleSidedPosition(tokenAddress);
    if (!(await vault.isSingleSided(tokenAddress))) throw new Error("Vault did not mark mode 2");
    if (position.tickUpper !== BigInt(startTick)) throw new Error("Unexpected position upper tick");
    if ((await vault.totalBnbLocked(tokenAddress)) !== 0n) throw new Error("Seed consumed BNB");

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const buy = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [base.wbnb, tokenAddress],
        operator.address,
        deadline,
        { value: buyAmount },
    );
    await buy.wait();

    const token = await hre.ethers.getContractAt("LumoriaToken", tokenAddress);
    const bought = await token.balanceOf(operator.address);
    if (bought === 0n) throw new Error("First buy returned zero tokens");
    const sellAmount = bought / 2n;
    await (await token.approve(await router.getAddress(), sellAmount)).wait();
    const sell = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        0,
        [tokenAddress, base.wbnb],
        operator.address,
        deadline,
    );
    await sell.wait();

    console.log(`Canary token: ${tokenAddress}`);
    console.log(`Launch tx:    ${launchReceipt.hash}`);
    console.log("Permanent Single-Sided launch/buy/sell smoke passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
