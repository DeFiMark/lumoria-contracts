/**
 * Read-only cutover preparation. Validates candidate wiring and prints the two
 * Database calldata payloads in the required order. It sends no transaction.
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
    const file = path.join(
        __dirname,
        "..",
        "deployments",
        `${hre.network.name}-single-sided-v2-candidate.json`,
    );
    if (!fs.existsSync(file)) throw new Error(`Missing candidate deployment: ${file}`);
    const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
    const database = await hre.ethers.getContractAt("Database", candidate.database);
    const vault = await hre.ethers.getContractAt("LumoriaLiquidityVault", candidate.vaultV2);
    const generator = await hre.ethers.getContractAt("Generator", candidate.generatorV2);

    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    if (chainId !== candidate.chainId) throw new Error("Candidate chainId no longer matches this network");
    if ((await database.poolManager()).toLowerCase() !== candidate.poolManager.toLowerCase()) {
        throw new Error("Database PoolManager changed after candidate deployment");
    }
    if ((await database.hook()).toLowerCase() !== candidate.hook.toLowerCase()) {
        throw new Error("Database Hook changed after candidate deployment");
    }
    if ((await database.liquidityVault()).toLowerCase() !== candidate.legacyLiquidityVault.toLowerCase()) {
        throw new Error("Database liquidity vault changed; deploy a fresh aggregation candidate");
    }
    if ((await database.generator()).toLowerCase() !== candidate.legacyGenerator.toLowerCase()) {
        throw new Error("Database Generator changed after candidate deployment");
    }
    if (!candidate.tokenMasterCopy || !candidate.expectedTokenMasterCodeHash) {
        throw new Error("Candidate predates the metadata-master prerequisite; deploy a fresh candidate");
    }
    if ((await database.tokenMasterCopy()).toLowerCase() !== candidate.tokenMasterCopy.toLowerCase()) {
        throw new Error("Database token master changed after candidate deployment");
    }
    // Either the live master already matches the compiled metadata-aware
    // token, or the candidate carries a new master that is rotated FIRST.
    const effectiveTokenMaster = candidate.tokenMasterCopyV2 || candidate.tokenMasterCopy;
    const effectiveTokenMasterCodeHash = hre.ethers.keccak256(
        await hre.ethers.provider.getCode(effectiveTokenMaster),
    );
    if (effectiveTokenMasterCodeHash !== candidate.expectedTokenMasterCodeHash) {
        throw new Error("Token master to be live after cutover is not compatible with Generator V2 metadata initialization");
    }

    if ((await hre.ethers.provider.getCode(candidate.vaultV2)) === "0x") throw new Error("Vault V2 has no code");
    if ((await hre.ethers.provider.getCode(candidate.generatorV2)) === "0x") throw new Error("Generator V2 has no code");
    if ((await vault.poolManager()).toLowerCase() !== candidate.poolManager.toLowerCase()) {
        throw new Error("Vault V2 PoolManager mismatch");
    }
    if ((await vault.database()).toLowerCase() !== candidate.database.toLowerCase()) {
        throw new Error("Vault V2 Database mismatch");
    }
    if ((await vault.legacyVault()).toLowerCase() !== candidate.legacyLiquidityVault.toLowerCase()) {
        throw new Error("Vault V2 legacy vault mismatch");
    }
    if ((await generator.getDatabase()).toLowerCase() !== candidate.database.toLowerCase()) {
        throw new Error("Generator V2 Database mismatch");
    }
    if (!candidate.liquidityModuleMasterCopyV2) {
        throw new Error("Candidate predates the LiquidityModule master V2; deploy a fresh candidate");
    }
    if ((await hre.ethers.provider.getCode(candidate.liquidityModuleMasterCopyV2)) === "0x") {
        throw new Error("LiquidityModule master V2 has no code");
    }
    if ((await database.moduleMasterCopies(2)).toLowerCase()
        !== candidate.legacyLiquidityModuleMasterCopy.toLowerCase()) {
        throw new Error("Database LiquidityModule master changed after candidate deployment");
    }

    const [minStartTick, maxStartTick] = await generator.singleSidedStartTickBounds();
    console.log(`Database target: ${candidate.database}`);
    console.log(
        `Generator V2 single-sided start tick bounds: [${minStartTick}, ${maxStartTick}] ` +
        "(review against the approved FDV window; retune with setSingleSidedStartTickBounds)",
    );
    if (candidate.tokenMasterCopyV2) {
        console.log("0. setTokenMasterCopy(LumoriaTokenMasterV2)  — FIRST; launches fail closed until step 2");
        console.log(database.interface.encodeFunctionData("setTokenMasterCopy", [candidate.tokenMasterCopyV2]));
    }
    console.log("1. setLiquidityVault(VaultV2)");
    console.log(database.interface.encodeFunctionData("setLiquidityVault", [candidate.vaultV2]));
    console.log("2. setGenerator(GeneratorV2)");
    console.log(database.interface.encodeFunctionData("setGenerator", [candidate.generatorV2]));
    console.log("3. setModuleMasterCopy(2, LiquidityModuleMasterV2)");
    console.log(database.interface.encodeFunctionData(
        "setModuleMasterCopy", [2, candidate.liquidityModuleMasterCopyV2],
    ));
    console.log("No transaction was sent.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
