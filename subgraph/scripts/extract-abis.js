// Copies the ABI arrays out of the parent repo's Hardhat artifacts into
// subgraph/abis/, so the subgraph is self-contained for `graph codegen`.
// Run after `npx hardhat compile` in the parent repo:  npm run extract-abis

const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "..", "..", "artifacts", "contracts");
const OUT = path.join(__dirname, "..", "abis");

const CONTRACTS = {
  Database: "Database.sol/Database.json",
  Generator: "Generator.sol/Generator.json",
  FeeReceiver: "FeeReceiver.sol/FeeReceiver.json",
  RebateContract: "RebateContract.sol/RebateContract.json",
  VestingVault: "VestingVault.sol/VestingVault.json",
  LumoriaToken: "LumoriaToken.sol/LumoriaToken.json",
  TaxHandler: "TaxHandler.sol/TaxHandler.json",
  FlatCurve: "FlatCurve.sol/FlatCurve.json",
  LumoriaHook: "v4/LumoriaHook.sol/LumoriaHook.json",
  LumoriaLiquidityVault: "v4/LumoriaLiquidityVault.sol/LumoriaLiquidityVault.json",
  CreatorFeeModule: "modules/CreatorFeeModule.sol/CreatorFeeModule.json",
  RewardModule: "modules/RewardModule.sol/RewardModule.json",
  BurnModule: "modules/BurnModule.sol/BurnModule.json",
  LiquidityModule: "modules/LiquidityModule.sol/LiquidityModule.json",
  MilestoneRewardModule: "modules/MilestoneRewardModule.sol/MilestoneRewardModule.json",
};

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const missing = [];
for (const name of Object.keys(CONTRACTS)) {
  const src = path.join(ARTIFACTS, CONTRACTS[name]);
  if (!fs.existsSync(src)) {
    missing.push(`${name}  (${src})`);
    continue;
  }
  const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  console.log(`  ✓ ${name}.json`);
}

if (missing.length) {
  console.error("\nMissing artifacts — run `npx hardhat compile` in the parent repo first:");
  missing.forEach((m) => console.error("  ✗ " + m));
  process.exit(1);
}
console.log("\nABIs extracted to subgraph/abis/");
