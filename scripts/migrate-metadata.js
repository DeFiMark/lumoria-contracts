/**
 * Phase 8 migration — swap in the metadata-aware Generator + token master copy.
 *
 * `Generator.generateProject` gained a `metadata` parameter and
 * `LumoriaToken.__init__` gained the matching storage, so both contracts have
 * to be replaced together: the Generator calls `__init__` with the new arity,
 * and a mismatched pair reverts every launch. Neither is upgradeable, but
 * neither needs to be — the Database points at both through owner-only
 * setters:
 *
 *   Database.setTokenMasterCopy(address)   (Database.sol)
 *   Database.setGenerator(address)         (Database.sol)
 *
 * WHAT THIS AFFECTS: future launches only.
 *
 *   - Tokens ALREADY LAUNCHED are untouched. They are ERC-1167 clones frozen
 *     against the old master copy's code, so they keep behaving exactly as
 *     they did — with no metadata getters. Nothing about them breaks; a client
 *     reading `image()` on one gets a revert, which is why every subgraph and
 *     UI read of these fields is a `try_`/optional read.
 *   - `Database.generator` is a single address, so setting it REVOKES the old
 *     Generator: `registerToken` gates on `msg.sender == generator`, and
 *     `VestingVault.createSchedule` resolves the Generator through the Database
 *     on every call. The old Generator becomes inert the moment this lands.
 *   - `predictTokenAddress` answers differ afterwards. The ERC-1167 init code
 *     embeds the master copy address, so the same salt now derives a different
 *     token address. Any UI holding a prediction across this migration must
 *     re-read it — which the launch path already does at build time, precisely
 *     because a master-copy rotation is possible (see the frontend's
 *     `resolveDeployTarget`).
 *
 * ORDERING: the master copy is set BEFORE the Generator. Between the two
 * transactions the OLD Generator is live against the NEW master copy, and its
 * 5-argument `__init__` call would revert against the 6-argument
 * implementation — so launches fail closed for that window rather than
 * producing a half-initialised token. Run both in one sitting.
 *
 * Run:
 *   npx hardhat run scripts/migrate-metadata.js --network bsc
 *
 * Then verify the two new contracts:
 *   npx hardhat verify --network bsc <tokenMasterCopy>
 *   npx hardhat verify --network bsc <generator> <database>
 *
 * ...and redeploy the subgraph (the Generator address is a data-source address
 * in subgraph.yaml, and `TokenMetadataInitialized` is a new event).
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
    const networkName = hre.network.name;
    const [deployer] = await hre.ethers.getSigners();

    const outFile = path.join(__dirname, "..", "deployments", `${networkName}.json`);
    if (!fs.existsSync(outFile)) {
        throw new Error(`No deployment record at ${outFile} — run deploy-base.js first.`);
    }
    const deployments = JSON.parse(fs.readFileSync(outFile, "utf8"));

    const databaseAddr = deployments.core?.database;
    if (!databaseAddr) throw new Error("deployment record has no core.database");

    console.log(`\nPhase 8 metadata migration on ${networkName}`);
    console.log(`  deployer  ${deployer.address}`);
    console.log(`  database  ${databaseAddr}\n`);

    const database = await hre.ethers.getContractAt("Database", databaseAddr);

    // Fail before spending gas if this key cannot complete the migration —
    // deploying the pair and then being unable to wire it in leaves the system
    // exactly as it was, but wastes the deployment.
    const owner = await database.owner();
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
        throw new Error(
            `Database owner is ${owner}, not the signer ${deployer.address}. ` +
            `Both setters are onlyOwner — run this from the owner key.`,
        );
    }

    console.log("Current wiring:");
    console.log(`  generator        ${await database.generator()}`);
    console.log(`  tokenMasterCopy  ${await database.tokenMasterCopy()}\n`);

    console.log("Deploying...");
    const TokenMC = await hre.ethers.getContractFactory("LumoriaToken");
    const tokenMC = await TokenMC.deploy();
    await tokenMC.waitForDeployment();
    const tokenMCAddr = await tokenMC.getAddress();
    console.log(`  LumoriaToken (master copy) → ${tokenMCAddr}`);

    const Generator = await hre.ethers.getContractFactory("Generator");
    const generator = await Generator.deploy(databaseAddr);
    await generator.waitForDeployment();
    const generatorAddr = await generator.getAddress();
    console.log(`  Generator                  → ${generatorAddr}\n`);

    const tx = async (label, promise) => {
        const t = await promise;
        await t.wait();
        console.log(`  ✓ ${label}`);
    };

    console.log("Wiring (master copy first — see the header note on ordering):");
    await tx("setTokenMasterCopy", database.setTokenMasterCopy(tokenMCAddr));
    await tx("setGenerator", database.setGenerator(generatorAddr));

    // Read back rather than trust the receipts.
    const liveGenerator = await database.generator();
    const liveTokenMC = await database.tokenMasterCopy();
    if (
        liveGenerator.toLowerCase() !== generatorAddr.toLowerCase() ||
        liveTokenMC.toLowerCase() !== tokenMCAddr.toLowerCase()
    ) {
        throw new Error("Post-migration read-back does not match — DO NOT announce this migration.");
    }

    // Keep the previous addresses: they are what a block explorer will show for
    // every token launched before today, and the only way to decode their
    // launch logs.
    deployments.previous = deployments.previous || {};
    deployments.previous.metadataMigration = {
        migratedAt: new Date().toISOString(),
        generator: deployments.core.generator,
        tokenMasterCopy: deployments.masterCopies.token,
    };
    deployments.core.generator = generatorAddr;
    deployments.masterCopies.token = tokenMCAddr;
    fs.writeFileSync(outFile, JSON.stringify(deployments, null, 2));
    console.log(`\n✓ Wrote ${outFile}`);

    console.log(`
Next:
  1. npx hardhat verify --network ${networkName} ${tokenMCAddr}
  2. npx hardhat verify --network ${networkName} ${generatorAddr} ${databaseAddr}
  3. subgraph: update the Generator address + startBlock, then codegen/build/deploy
  4. frontend: npm run abis (regenerates lib/abis + lib/addresses from this file)
  5. smoke-launch on a fork or with a small BYOL launch, and confirm
     TokenMetadataInitialized fires with the URIs you passed
`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
