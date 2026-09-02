/**
 * Deploys Permanent Single-Sided candidate contracts without mutating Database.
 *
 * This script intentionally does NOT call setLiquidityVault or setGenerator.
 * It writes deployments/<network>-single-sided-v2-candidate.json for verification,
 * fork rehearsal, multisig review, and the later cutover transaction preparation.
 *
 * Run:
 *   npx hardhat run scripts/deploy-single-sided-v2.js --network <network>
 *
 * Mainnet requires CONFIRM_V2_CANDIDATE_DEPLOY=YES. That opt-in authorizes only
 * contract deployment; pointer rotation remains a separate manual operation.
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployRaw } = require("./lib/raw-tx");

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
    const network = hre.network.name;
    if (network === "bsc" && process.env.CONFIRM_V2_CANDIDATE_DEPLOY !== "YES") {
        throw new Error("Set CONFIRM_V2_CANDIDATE_DEPLOY=YES to deploy candidates on BSC mainnet");
    }

    const baseFile = path.join(__dirname, "..", "deployments", `${network}.json`);
    if (!fs.existsSync(baseFile)) throw new Error(`Missing base deployment: ${baseFile}`);
    const base = readJson(baseFile);
    const [deployer] = await hre.ethers.getSigners();
    const database = await hre.ethers.getContractAt("Database", base.core.database);

    const poolManager = await database.poolManager();
    const hook = await database.hook();
    const legacyLiquidityVault = await database.liquidityVault();
    const legacyGenerator = await database.generator();
    const tokenMasterCopy = await database.tokenMasterCopy();

    if (poolManager.toLowerCase() !== base.v4.poolManager.toLowerCase()) {
        throw new Error(`PoolManager mismatch: Database=${poolManager}, manifest=${base.v4.poolManager}`);
    }
    if (hook.toLowerCase() !== base.core.hook.toLowerCase()) {
        throw new Error(`Hook mismatch: Database=${hook}, manifest=${base.core.hook}`);
    }

    // Generator V2 preserves the worktree's metadata-aware generateProject
    // ABI, which calls the metadata-aware LumoriaToken initializer. If the live
    // token master is still the pre-metadata build, deploy the new master as
    // part of this candidate (DEPLOY_TOKEN_MASTER=YES) so the cutover rotates
    // it FIRST, in the same sitting as the Generator. Between those two calls
    // the old Generator's 5-arg __init__ fails closed against the 6-arg master
    // — no half-initialised token is possible. Without the opt-in, refuse.
    const tokenArtifact = await hre.artifacts.readArtifact("LumoriaToken");
    const expectedTokenMasterCodeHash = hre.ethers.keccak256(tokenArtifact.deployedBytecode);
    const tokenMasterCode = await hre.ethers.provider.getCode(tokenMasterCopy);
    const tokenMasterCodeHash = hre.ethers.keccak256(tokenMasterCode);
    let tokenMasterCopyV2 = null;
    if (tokenMasterCodeHash !== expectedTokenMasterCodeHash) {
        if (process.env.DEPLOY_TOKEN_MASTER !== "YES") {
            throw new Error(
                "Database.tokenMasterCopy is not the compiled metadata-aware LumoriaToken; " +
                "set DEPLOY_TOKEN_MASTER=YES to include a new master in this candidate " +
                "(rotated first at cutover), or run scripts/migrate-metadata.js separately",
            );
        }
        // Resume support: a previous run may have broadcast the master before
        // crashing (see scripts/lib/raw-tx.js). Reuse it when its code matches.
        if (process.env.TOKEN_MASTER_V2_ADDRESS) {
            tokenMasterCopyV2 = hre.ethers.getAddress(process.env.TOKEN_MASTER_V2_ADDRESS);
            console.log(`Reusing already-deployed LumoriaToken master V2: ${tokenMasterCopyV2}`);
        } else {
            tokenMasterCopyV2 = (await deployRaw(hre, "LumoriaToken")).address;
        }
        const deployedHash = hre.ethers.keccak256(
            await hre.ethers.provider.getCode(tokenMasterCopyV2),
        );
        if (deployedHash !== expectedTokenMasterCodeHash) {
            throw new Error("Deployed token master code hash does not match the compiled artifact");
        }
    }

    const deployBlocks = [];
    const vaultDeploy = await deployRaw(
        hre, "LumoriaLiquidityVault", [poolManager, base.core.database, legacyLiquidityVault],
    );
    deployBlocks.push(vaultDeploy.receipt.blockNumber);
    const vault = await hre.ethers.getContractAt("LumoriaLiquidityVault", vaultDeploy.address);
    console.log(`  deployed Vault V2      ${vaultDeploy.address}  (block ${vaultDeploy.receipt.blockNumber})`);

    const generatorDeploy = await deployRaw(hre, "Generator", [base.core.database]);
    deployBlocks.push(generatorDeploy.receipt.blockNumber);
    const generator = await hre.ethers.getContractAt("Generator", generatorDeploy.address);
    console.log(`  deployed Generator V2  ${generatorDeploy.address}  (block ${generatorDeploy.receipt.blockNumber})`);
    const [minStartTick, maxStartTick] = await generator.singleSidedStartTickBounds();

    // LiquidityModule master V2 refuses `__init__` for single-sided tokens so
    // a post-launch `proposeModuleAdd` cannot strand BNB in a module whose
    // `executeLiquidity` the vault will always reject. Rotated with
    // Database.setModuleMasterCopy(2, ...) as the third cutover call.
    const liquidityModuleDeploy = await deployRaw(hre, "LiquidityModule");
    deployBlocks.push(liquidityModuleDeploy.receipt.blockNumber);
    const liquidityModule = await hre.ethers.getContractAt("LiquidityModule", liquidityModuleDeploy.address);
    console.log(`  deployed LiqModule V2  ${liquidityModuleDeploy.address}  (block ${liquidityModuleDeploy.receipt.blockNumber})`);
    const legacyLiquidityModuleMasterCopy = await database.moduleMasterCopies(2);

    // Subgraph start block for the V2 sources: the earliest V2 deployment.
    const block = Math.min(...deployBlocks);
    const candidate = {
        network,
        chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
        deployedAt: new Date().toISOString(),
        deploymentBlock: block,
        deployer: deployer.address,
        database: base.core.database,
        poolManager,
        hook,
        legacyLiquidityVault,
        legacyGenerator,
        tokenMasterCopy,
        tokenMasterCodeHash,
        expectedTokenMasterCodeHash,
        // null when the live master already matched; otherwise rotated FIRST.
        tokenMasterCopyV2,
        vaultV2: await vault.getAddress(),
        generatorV2: await generator.getAddress(),
        liquidityModuleMasterCopyV2: await liquidityModule.getAddress(),
        legacyLiquidityModuleMasterCopy,
        singleSidedStartTickBounds: {
            minStartTick: Number(minStartTick),
            maxStartTick: Number(maxStartTick),
        },
        constructorArgs: {
            vaultV2: [poolManager, base.core.database, legacyLiquidityVault],
            generatorV2: [base.core.database],
            liquidityModuleMasterCopyV2: [],
            tokenMasterCopyV2: [],
        },
        databasePointersRotated: false,
    };

    const out = path.join(
        __dirname,
        "..",
        "deployments",
        `${network}-single-sided-v2-candidate.json`,
    );
    fs.writeFileSync(out, JSON.stringify(candidate, null, 2));

    if (tokenMasterCopyV2) {
        console.log(`LumoriaToken master V2 candidate: ${tokenMasterCopyV2} (rotated FIRST at cutover)`);
    }
    console.log(`Vault V2 candidate:     ${candidate.vaultV2}`);
    console.log(`Generator V2 candidate: ${candidate.generatorV2}`);
    console.log(`LiquidityModule master V2 candidate: ${candidate.liquidityModuleMasterCopyV2}`);
    console.log(
        `Single-sided start tick bounds: [${candidate.singleSidedStartTickBounds.minStartTick}, ` +
        `${candidate.singleSidedStartTickBounds.maxStartTick}] (owner-tunable on Generator V2)`,
    );
    console.log(`Candidate manifest:     ${out}`);
    console.log("Database pointers were NOT changed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
