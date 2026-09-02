// Generates networks.json from the parent repo's deployments/<network>.json,
// so `graph build --network bsc` injects the real addresses + startBlock into
// subgraph.yaml. It also materializes the additive Generator/Vault V2 data
// sources when an explicit candidate deployment file is available. Historical
// sources are deliberately retained for full replay.
//
// Network defaults to bsc; override with SUBGRAPH_NETWORK=bscTestnet.

const fs = require("fs");
const path = require("path");

const NET = process.env.SUBGRAPH_NETWORK || "bsc";
const depFile = path.join(__dirname, "..", "..", "deployments", `${NET}.json`);
const candidateFile = process.env.SINGLE_SIDED_V2_DEPLOYMENT_FILE ||
  path.join(__dirname, "..", "..", "deployments", `${NET}-single-sided-v2-candidate.json`);
const manifestFile = path.join(__dirname, "..", "subgraph.yaml");

if (!fs.existsSync(depFile)) {
  console.error(`No deployments file at ${depFile}.`);
  console.error("Deploy the contracts first (npm run deploy:bsc in the parent repo).");
  process.exit(1);
}

const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
const sb = dep.startBlock || 0;
const c = dep.core;

// After the V2 cutover `core.generator` / `core.liquidityVault` point at V2
// (the frontend needs the live pointers). The ORIGINAL contracts stay indexed
// as the historical `Generator` / `LumoriaLiquidityVault` sources from
// `previous.singleSidedV2Cutover`; V2 is added below from the candidate file.
const legacy = dep.previous && dep.previous.singleSidedV2Cutover
  ? dep.previous.singleSidedV2Cutover
  : null;
const legacyGenerator = legacy ? legacy.generator : c.generator;
const legacyLiquidityVault = legacy ? legacy.liquidityVault : c.liquidityVault;

const graphNetwork = NET === "bscTestnet" ? "chapel" : "bsc";

const networks = {};
networks[graphNetwork] = {
  Database: { address: c.database, startBlock: sb },
  Generator: { address: legacyGenerator, startBlock: sb },
  LumoriaHook: { address: c.hook, startBlock: sb },
  LumoriaLiquidityVault: { address: legacyLiquidityVault, startBlock: sb },
  FeeReceiver: { address: c.feeReceiver, startBlock: sb },
  RebateContract: { address: c.rebateContract, startBlock: sb },
  VestingVault: { address: c.vestingVault, startBlock: sb },
};

const candidate = fs.existsSync(candidateFile)
  ? JSON.parse(fs.readFileSync(candidateFile, "utf8"))
  : {};
const generatorV2 = process.env.GENERATOR_V2_ADDRESS || candidate.generatorV2;
const vaultV2 = process.env.LIQUIDITY_VAULT_V2_ADDRESS || candidate.vaultV2;
const deploymentBlockRaw = process.env.SINGLE_SIDED_START_BLOCK || candidate.deploymentBlock;
const hasAnyV2Coordinate = generatorV2 || vaultV2 || deploymentBlockRaw !== undefined;

let v2Manifest = "";

if (hasAnyV2Coordinate) {
  if (!generatorV2 || !vaultV2 || deploymentBlockRaw === undefined) {
    console.error(`Incomplete V2 coordinates in ${candidateFile}.`);
    console.error("Provide generatorV2, vaultV2, and deploymentBlock together (file or env)." );
    process.exit(1);
  }

  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const deploymentBlock = Number(deploymentBlockRaw);
  if (!addressPattern.test(generatorV2) || !addressPattern.test(vaultV2)) {
    console.error("Generator/Vault V2 coordinates must be valid non-placeholder addresses.");
    process.exit(1);
  }
  if (/^0x0{40}$/i.test(generatorV2) || /^0x0{40}$/i.test(vaultV2)) {
    console.error("Refusing to activate a zero-address V2 data source.");
    process.exit(1);
  }
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0) {
    console.error("deploymentBlock must be a positive safe integer.");
    process.exit(1);
  }
  if (generatorV2.toLowerCase() === legacyGenerator.toLowerCase() ||
      vaultV2.toLowerCase() === legacyLiquidityVault.toLowerCase()) {
    console.error("V2 addresses must differ from the retained legacy data sources.");
    process.exit(1);
  }

  networks[graphNetwork].GeneratorV2 = { address: generatorV2, startBlock: deploymentBlock };
  networks[graphNetwork].LumoriaLiquidityVaultV2 = { address: vaultV2, startBlock: deploymentBlock };

  v2Manifest = `  # Generated from ${path.basename(candidateFile)}; do not hand-edit.\n` +
`  - kind: ethereum
    name: GeneratorV2
    network: ${graphNetwork}
    source:
      abi: Generator
      address: "${generatorV2}"
      startBlock: ${deploymentBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/generator.ts
      entities:
        - Token
        - Raise
        - SingleSidedLaunch
        - TokenAllocation
        - VestingSchedule
      abis:
        - name: Generator
          file: ./abis/Generator.json
        - name: FlatCurve
          file: ./abis/FlatCurve.json
      eventHandlers:
        - event: ProjectGenerated(indexed address,indexed address,indexed address,string,string,uint256,uint256,uint8)
          handler: handleProjectGenerated
        - event: TokenMetadataInitialized(indexed address,string,string,string)
          handler: handleTokenMetadataInitialized
        - event: FlatCurveLaunched(indexed address,indexed address,uint256)
          handler: handleFlatCurveLaunched
        - event: SingleSidedLaunched(indexed address,int24,uint160,uint256,uint128)
          handler: handleSingleSidedLaunched
        - event: AllocationMinted(indexed address,indexed address,uint256)
          handler: handleAllocationMinted
        - event: AllocationVested(indexed address,indexed address,indexed uint256,uint256,uint64,uint64)
          handler: handleAllocationVested
  - kind: ethereum
    name: LumoriaLiquidityVaultV2
    network: ${graphNetwork}
    source:
      abi: LumoriaLiquidityVault
      address: "${vaultV2}"
      startBlock: ${deploymentBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/vault.ts
      entities:
        - Token
        - SingleSidedLaunch
      abis:
        - name: LumoriaLiquidityVault
          file: ./abis/LumoriaLiquidityVault.json
      eventHandlers:
        - event: PoolInitialized(indexed address,indexed bytes32,uint160)
          handler: handlePoolInitialized
        - event: LiquidityLocked(indexed address,uint256,uint256,uint128,uint128)
          handler: handleLiquidityLocked
        - event: SingleSidedPositionLocked(indexed address,indexed bytes32,int24,int24,uint160,uint256,uint128,uint256)
          handler: handleSingleSidedPositionLocked
`;
  console.log(`Enabled V2 data sources from ${candidateFile} at block ${deploymentBlock}.`);
} else {
  console.warn(`No V2 candidate at ${candidateFile}; keeping the active manifest legacy-only.`);
  console.warn("Set the three V2 environment overrides only after deployment if needed.");
}

let manifest = fs.readFileSync(manifestFile, "utf8");
const hasGeneratorV2Source = /\n\s+name:\s+GeneratorV2\s*\n/.test(manifest);
const hasVaultV2Source = /\n\s+name:\s+LumoriaLiquidityVaultV2\s*\n/.test(manifest);
if (hasGeneratorV2Source !== hasVaultV2Source) {
  console.error("subgraph.yaml contains only one of the two required V2 data sources.");
  process.exit(1);
}
if (hasAnyV2Coordinate && !hasGeneratorV2Source) {
  const anchor = "dataSources:\n";
  const insertion = manifest.indexOf(anchor);
  if (insertion < 0) {
    console.error(`Missing dataSources section in ${manifestFile}.`);
    process.exit(1);
  }
  manifest = manifest.slice(0, insertion + anchor.length) +
    v2Manifest + manifest.slice(insertion + anchor.length);
  fs.writeFileSync(manifestFile, manifest);
} else if (!hasAnyV2Coordinate && hasGeneratorV2Source) {
  console.warn("V2 sources already exist in subgraph.yaml; retaining them for historical replay.");
}

fs.writeFileSync(
  path.join(__dirname, "..", "networks.json"),
  JSON.stringify(networks, null, 2)
);
console.log(`Wrote networks.json for "${graphNetwork}" (startBlock ${sb}).`);
console.log("Note: subgraph.yaml uses `network: bsc`. For testnet, also switch the");
console.log("network fields to `chapel` (or run codegen with a testnet manifest).");
