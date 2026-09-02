/** Verifies candidate V2 contracts from the candidate deployment manifest. */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const hre = require("hardhat");

function verify(address, args, contract) {
    const cli = path.join(__dirname, "..", "node_modules", "hardhat", "internal", "cli", "bootstrap.js");
    const argv = [cli, "verify", "--network", hre.network.name, "--contract", contract, address, ...args];
    execFileSync(process.execPath, argv, { stdio: "inherit" });
}

async function main() {
    const file = path.join(
        __dirname,
        "..",
        "deployments",
        `${hre.network.name}-single-sided-v2-candidate.json`,
    );
    if (!fs.existsSync(file)) throw new Error(`Missing candidate deployment: ${file}`);
    const candidate = JSON.parse(fs.readFileSync(file, "utf8"));

    verify(
        candidate.vaultV2,
        candidate.constructorArgs.vaultV2,
        "contracts/v4/LumoriaLiquidityVault.sol:LumoriaLiquidityVault",
    );
    verify(
        candidate.generatorV2,
        candidate.constructorArgs.generatorV2,
        "contracts/Generator.sol:Generator",
    );
    if (candidate.tokenMasterCopyV2) {
        verify(candidate.tokenMasterCopyV2, [], "contracts/LumoriaToken.sol:LumoriaToken");
    }
    if (candidate.liquidityModuleMasterCopyV2) {
        verify(
            candidate.liquidityModuleMasterCopyV2,
            candidate.constructorArgs.liquidityModuleMasterCopyV2 || [],
            "contracts/modules/LiquidityModule.sol:LiquidityModule",
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
