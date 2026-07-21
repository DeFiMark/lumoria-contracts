require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * The toolbox already wires hardhat-verify. Etherscan V2 unified API keys:
 * one ETHERSCAN_API_KEY now covers all chains (BscScan included) via
 * https://api.etherscan.io/v2/api?chainid=56. Export ETHERSCAN_API_KEY to
 * enable `npx hardhat verify` (BSCSCAN_API_KEY still accepted as a fallback
 * name for older .env files).
 */

/**
 * Lumoria Hardhat config
 *
 * Pinned to Solidity 0.8.28 to match every contract in the repo.
 * Optimizer at 200 runs is a reasonable default for deployment-size vs. runtime-gas balance.
 * Add extra networks under `networks` when ready to deploy to BSC testnet / mainnet.
 */

const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org";
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const DEPLOYER_PK = process.env.DEPLOYER_PK;

const networks = {
    hardhat: {
        // in-memory, fresh per test run.
        // Unlimited size: the locally-deployed Uniswap V4 PoolManager (test
        // fixture only) exceeds 24KB under the debug-profile build. On BSC
        // mainnet we use the canonical PoolManager, so size never matters.
        allowUnlimitedContractSize: true,
        // Optional BSC mainnet fork — pre-deploy rehearsal against the REAL
        // canonical Uniswap V4 PoolManager. Enabled ONLY when BSC_FORK is set,
        // so `npm test` never forks. chainId is pinned to 56 so deploy-base.js
        // treats the fork as mainnet (uses the canonical PoolManager + periphery
        // instead of deploying a local PoolManager). Usage:
        //   BSC_FORK=1 npx hardhat node          # start a persistent forked node
        //   npm run deploy:local                 # deploy onto the fork
        //   npm run smoke:local                  # launch + buy on the fork
        // Set BSC_RPC to an archive-capable endpoint; optionally pin a block
        // with BSC_FORK_BLOCK for reproducibility.
        ...(process.env.BSC_FORK
            ? {
                  chainId: 56,
                  forking: {
                      url: BSC_RPC,
                      ...(process.env.BSC_FORK_BLOCK
                          ? { blockNumber: Number(process.env.BSC_FORK_BLOCK) }
                          : {}),
                  },
              }
            : {}),
    },
    localhost: {
        // Persistent in-process node started via `npm run node`.
        // Override with LOCALHOST_URL if running on a custom port (e.g. 8546).
        url: process.env.LOCALHOST_URL || "http://127.0.0.1:8545",
    },
};
if (DEPLOYER_PK) {
    networks.bsc = { url: BSC_RPC, accounts: [DEPLOYER_PK], chainId: 56 };
    networks.bscTestnet = { url: BSC_TESTNET_RPC, accounts: [DEPLOYER_PK], chainId: 97 };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        compilers: [
            {
                version: "0.8.28",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                    // viaIR: needed for stack-too-deep in V4 periphery-style code paths.
                    viaIR: true,
                    // Uniswap V4 core uses transient storage (EIP-1153). BSC supports
                    // Cancun opcodes since the Haber hardfork (June 2024).
                    evmVersion: "cancun",
                },
            },
            {
                // Solely for @uniswap/v4-core's PoolManager.sol, which pins 0.8.26
                // exactly. Mirrors v4-core's foundry "debug" profile (legacy
                // pipeline; via-IR trips a Yul stack error under Hardhat's
                // default optimizer step sequence). Only compiled for local
                // tests — mainnet uses the canonical BSC PoolManager.
                version: "0.8.26",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                    viaIR: false,
                    evmVersion: "cancun",
                },
            },
        ],
    },
    networks,
    etherscan: {
        // Etherscan V2: a single unified key covers every chain (the API routes
        // by ?chainid=). The single-string form is what selects the V2 endpoint
        // in hardhat-verify ≥2.1 — don't switch back to the per-network object,
        // that's the deprecated V1 path and BscScan's V1 API has been sunset.
        apiKey: process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },
    mocha: {
        timeout: 120000, // 2 minutes — some fixtures deploy many contracts
    },
};
