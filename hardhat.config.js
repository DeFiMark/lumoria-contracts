require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * The toolbox already wires hardhat-verify (BscScan uses the Etherscan-compatible API).
 * Export BSCSCAN_API_KEY to enable `npx hardhat verify`.
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
        // BscScan uses the Etherscan-compatible API; one key works for both networks.
        apiKey: {
            bsc: process.env.BSCSCAN_API_KEY || "",
            bscTestnet: process.env.BSCSCAN_API_KEY || "",
        },
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
