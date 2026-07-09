// Generates networks.json from the parent repo's deployments/<network>.json,
// so `graph build --network bsc` injects the real addresses + startBlock into
// subgraph.yaml. Run after the contracts are deployed:  npm run gen-networks
//
// Network defaults to bsc; override with SUBGRAPH_NETWORK=bscTestnet.

const fs = require("fs");
const path = require("path");

const NET = process.env.SUBGRAPH_NETWORK || "bsc";
const depFile = path.join(__dirname, "..", "..", "deployments", `${NET}.json`);

if (!fs.existsSync(depFile)) {
  console.error(`No deployments file at ${depFile}.`);
  console.error("Deploy the contracts first (npm run deploy:bsc in the parent repo).");
  process.exit(1);
}

const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
const sb = dep.startBlock || 0;
const c = dep.core;

const graphNetwork = NET === "bscTestnet" ? "chapel" : "bsc";

const networks = {};
networks[graphNetwork] = {
  Database: { address: c.database, startBlock: sb },
  Generator: { address: c.generator, startBlock: sb },
  LumoriaHook: { address: c.hook, startBlock: sb },
  LumoriaLiquidityVault: { address: c.liquidityVault, startBlock: sb },
  FeeReceiver: { address: c.feeReceiver, startBlock: sb },
  RebateContract: { address: c.rebateContract, startBlock: sb },
  VestingVault: { address: c.vestingVault, startBlock: sb },
};

fs.writeFileSync(
  path.join(__dirname, "..", "networks.json"),
  JSON.stringify(networks, null, 2)
);
console.log(`Wrote networks.json for "${graphNetwork}" (startBlock ${sb}).`);
console.log("Note: subgraph.yaml uses `network: bsc`. For testnet, also switch the");
console.log("network fields to `chapel` (or run codegen with a testnet manifest).");
