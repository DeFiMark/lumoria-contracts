/**
 * Executes the Permanent Single-Sided V2 cutover from the Database OWNER key.
 *
 * Order (each call is read back before the next is sent):
 *   0. setTokenMasterCopy(tokenMasterCopyV2)        — only if the candidate
 *      carries one. Launches fail closed between 0 and 2 (old Generator's
 *      5-arg __init__ vs the 6-arg master), never half-initialise.
 *   1. setLiquidityVault(vaultV2)                    — then legacy analytics
 *      for every registered token are compared old-vault vs V2 aggregation.
 *   2. setGenerator(generatorV2)
 *   3. setModuleMasterCopy(2, liquidityModuleMasterCopyV2)
 *
 * Afterwards deployments/<network>.json is updated so the frontend's
 * `extract-abis` picks up the live pointers, with the legacy addresses kept
 * under `previous.singleSidedV2Cutover` (the subgraph retains them as
 * historical data sources), and the candidate manifest is stamped
 * `databasePointersRotated: true`.
 *
 * Run (after prepare-single-sided-v2-cutover.js has been reviewed):
 *   CONFIRM_V2_CUTOVER=YES npx hardhat run scripts/execute-single-sided-v2-cutover.js --network <network>
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { callRaw } = require("./lib/raw-tx");

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
    if (process.env.CONFIRM_V2_CUTOVER !== "YES") {
        throw new Error("Set CONFIRM_V2_CUTOVER=YES after reviewing prepare-single-sided-v2-cutover.js output");
    }
    const network = hre.network.name;
    const baseFile = path.join(__dirname, "..", "deployments", `${network}.json`);
    const candidateFile = path.join(__dirname, "..", "deployments", `${network}-single-sided-v2-candidate.json`);
    if (!fs.existsSync(baseFile)) throw new Error(`Missing base deployment: ${baseFile}`);
    if (!fs.existsSync(candidateFile)) throw new Error(`Missing candidate deployment: ${candidateFile}`);
    const base = readJson(baseFile);
    const candidate = readJson(candidateFile);
    if (candidate.databasePointersRotated) throw new Error("Candidate is already marked as rotated");

    const [signer] = await hre.ethers.getSigners();
    const database = await hre.ethers.getContractAt("Database", candidate.database);
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    if (chainId !== candidate.chainId) throw new Error("Candidate chainId no longer matches this network");

    const owner = await database.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(`Database owner is ${owner}, not the signer ${signer.address}`);
    }

    // Pre-flight: the world must still look exactly like it did at candidate time.
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    if (!same(await database.liquidityVault(), candidate.legacyLiquidityVault)) {
        throw new Error("Database liquidity vault already changed; aborting");
    }
    if (!same(await database.generator(), candidate.legacyGenerator)) {
        throw new Error("Database Generator already changed; aborting");
    }
    if (!same(await database.tokenMasterCopy(), candidate.tokenMasterCopy)) {
        throw new Error("Database token master already changed; aborting");
    }
    if (!same(await database.moduleMasterCopies(2), candidate.legacyLiquidityModuleMasterCopy)) {
        throw new Error("Database LiquidityModule master already changed; aborting");
    }
    for (const [label, addr] of [
        ["vaultV2", candidate.vaultV2],
        ["generatorV2", candidate.generatorV2],
        ["liquidityModuleMasterCopyV2", candidate.liquidityModuleMasterCopyV2],
        ["tokenMasterCopyV2", candidate.tokenMasterCopyV2],
    ]) {
        if (!addr) continue;
        if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`${label} has no code`);
    }
    const effectiveTokenMaster = candidate.tokenMasterCopyV2 || candidate.tokenMasterCopy;
    const effectiveHash = hre.ethers.keccak256(await hre.ethers.provider.getCode(effectiveTokenMaster));
    if (effectiveHash !== candidate.expectedTokenMasterCodeHash) {
        throw new Error("Post-cutover token master would not match the compiled metadata-aware LumoriaToken");
    }

    const oldVault = await hre.ethers.getContractAt("LumoriaLiquidityVault", candidate.legacyLiquidityVault);
    const vaultV2 = await hre.ethers.getContractAt("LumoriaLiquidityVault", candidate.vaultV2);
    const tokenCount = Number(await database.allTokensLength());
    const snapshot = [];
    for (let i = 0; i < tokenCount; i++) {
        const token = await database.allTokens(i);
        snapshot.push({
            token,
            liquidity: await oldVault.lockedLiquidity(token),
            bnb: await oldVault.totalBnbLocked(token),
            tokens: await oldVault.totalTokensLocked(token),
        });
    }

    const txHashes = {};
    // Raw sends: sign locally, broadcast, poll receipts (see lib/raw-tx.js).
    const send = async (label, method, args) => {
        const receipt = await callRaw(hre, database, method, args);
        txHashes[label] = receipt.hash;
        console.log(`  ✓ ${label}  ${receipt.hash}  (block ${receipt.blockNumber})`);
        return receipt;
    };

    console.log(`Cutover on ${network} from owner ${signer.address}`);
    console.log(`  database ${candidate.database}`);

    if (candidate.tokenMasterCopyV2) {
        await send("setTokenMasterCopy", "setTokenMasterCopy", [candidate.tokenMasterCopyV2]);
        if (!same(await database.tokenMasterCopy(), candidate.tokenMasterCopyV2)) {
            throw new Error("Read-back mismatch after setTokenMasterCopy — STOP and inspect");
        }
    }

    const vaultReceipt = await send("setLiquidityVault", "setLiquidityVault", [candidate.vaultV2]);
    if (!same(await database.liquidityVault(), candidate.vaultV2)) {
        throw new Error("Read-back mismatch after setLiquidityVault — STOP and inspect");
    }
    for (const s of snapshot) {
        const l = await vaultV2.lockedLiquidity(s.token);
        const b = await vaultV2.totalBnbLocked(s.token);
        const t = await vaultV2.totalTokensLocked(s.token);
        if (l !== s.liquidity || b !== s.bnb || t !== s.tokens) {
            throw new Error(
                `Legacy analytics mismatch for ${s.token}: old(${s.liquidity},${s.bnb},${s.tokens}) ` +
                `vs V2(${l},${b},${t}) — STOP before rotating the Generator`,
            );
        }
    }
    console.log(`  ✓ legacy analytics preserved for ${snapshot.length} token(s)`);

    await send("setGenerator", "setGenerator", [candidate.generatorV2]);
    if (!same(await database.generator(), candidate.generatorV2)) {
        throw new Error("Read-back mismatch after setGenerator — STOP and inspect");
    }

    await send("setModuleMasterCopy(2)", "setModuleMasterCopy", [2, candidate.liquidityModuleMasterCopyV2]);
    if (!same(await database.moduleMasterCopies(2), candidate.liquidityModuleMasterCopyV2)) {
        throw new Error("Read-back mismatch after setModuleMasterCopy — STOP and inspect");
    }

    const cutoverBlock = vaultReceipt.blockNumber;
    const cutoverAt = new Date().toISOString();

    // Record: live pointers forward, legacy retained for the subgraph.
    base.previous = base.previous || {};
    base.previous.singleSidedV2Cutover = {
        cutoverAt,
        cutoverBlock,
        generator: candidate.legacyGenerator,
        liquidityVault: candidate.legacyLiquidityVault,
        tokenMasterCopy: candidate.tokenMasterCopy,
        liquidityModuleMasterCopy: candidate.legacyLiquidityModuleMasterCopy,
        txHashes,
    };
    base.core.generator = candidate.generatorV2;
    base.core.liquidityVault = candidate.vaultV2;
    base.masterCopies.liquidity = candidate.liquidityModuleMasterCopyV2;
    if (candidate.tokenMasterCopyV2) base.masterCopies.token = candidate.tokenMasterCopyV2;
    base.singleSidedV2 = {
        deploymentBlock: candidate.deploymentBlock,
        cutoverBlock,
        generator: candidate.generatorV2,
        liquidityVault: candidate.vaultV2,
        liquidityModuleMasterCopy: candidate.liquidityModuleMasterCopyV2,
        startTickBounds: candidate.singleSidedStartTickBounds,
    };
    fs.writeFileSync(baseFile, JSON.stringify(base, null, 2));

    candidate.databasePointersRotated = true;
    candidate.cutoverAt = cutoverAt;
    candidate.cutoverBlock = cutoverBlock;
    candidate.cutoverTxHashes = txHashes;
    fs.writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));

    console.log(`\n✓ Cutover complete at block ${cutoverBlock}. Wrote ${baseFile} and ${candidateFile}.`);
    console.log("Next: regenerate the subgraph networks/manifest, build, deploy a new version; then frontend `npm run abis`.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
