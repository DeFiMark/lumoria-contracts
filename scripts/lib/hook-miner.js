// Hook address miner for Uniswap V4.
//
// V4 encodes a hook's permissions in the LOW 14 BITS of its contract
// address (see @uniswap/v4-core/src/libraries/Hooks.sol). The PoolManager
// validates them on pool initialization, and BaseHook's constructor
// reverts (HookAddressNotValid) if the deployed address doesn't match
// getHookPermissions(). So the hook must be deployed via CREATE2 with a
// salt mined so that `address & 0x3FFF == FLAGS`.
//
// Used by both test fixtures (test/fixtures/deploy.js) and the deploy
// scripts (scripts/deploy-base.js).

const { ethers } = require("hardhat");

// Flag bit positions — mirror Hooks.sol exactly.
const HOOK_FLAGS = Object.freeze({
    BEFORE_INITIALIZE: 1n << 13n,
    AFTER_INITIALIZE: 1n << 12n,
    BEFORE_ADD_LIQUIDITY: 1n << 11n,
    AFTER_ADD_LIQUIDITY: 1n << 10n,
    BEFORE_REMOVE_LIQUIDITY: 1n << 9n,
    AFTER_REMOVE_LIQUIDITY: 1n << 8n,
    BEFORE_SWAP: 1n << 7n,
    AFTER_SWAP: 1n << 6n,
    BEFORE_DONATE: 1n << 5n,
    AFTER_DONATE: 1n << 4n,
    BEFORE_SWAP_RETURNS_DELTA: 1n << 3n,
    AFTER_SWAP_RETURNS_DELTA: 1n << 2n,
    AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1n << 1n,
    AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1n << 0n,
});

const ALL_HOOK_MASK = (1n << 14n) - 1n;

// LumoriaHook's permission set — must match LumoriaHook.getHookPermissions().
const LUMORIA_HOOK_FLAGS =
    HOOK_FLAGS.BEFORE_INITIALIZE |
    HOOK_FLAGS.BEFORE_ADD_LIQUIDITY |
    HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY |
    HOOK_FLAGS.BEFORE_SWAP |
    HOOK_FLAGS.AFTER_SWAP |
    HOOK_FLAGS.BEFORE_DONATE |
    HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA |
    HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;

/**
 * Mine a CREATE2 salt such that the resulting address carries exactly
 * `flags` in its low 14 bits.
 *
 * @param {string} deployerAddress  CREATE2 deployer contract address
 * @param {string} creationCodeHash keccak256 of (creationCode ++ constructorArgs)
 * @param {bigint} flags            required low-14-bit pattern
 * @param {bigint} startSalt        optional starting salt (for resumable mining)
 * @returns {{ salt: string, address: string, iterations: number }}
 */
function mineHookSalt(deployerAddress, creationCodeHash, flags = LUMORIA_HOOK_FLAGS, startSalt = 0n) {
    const prefix = ethers.concat(["0xff", deployerAddress]);
    // ~16k expected iterations for a 14-bit constraint; cap generously.
    const MAX_ITERATIONS = 10_000_000;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const salt = ethers.toBeHex(startSalt + BigInt(i), 32);
        const digest = ethers.keccak256(ethers.concat([prefix, salt, creationCodeHash]));
        const address = ethers.getAddress("0x" + digest.slice(26));
        if ((BigInt(address) & ALL_HOOK_MASK) === flags) {
            return { salt, address, iterations: i + 1 };
        }
    }
    throw new Error("hook-miner: no salt found (should be statistically impossible)");
}

/**
 * Deploy LumoriaHook at a mined address via the given Create2Deployer.
 *
 * @returns {{ hook: import("ethers").Contract, address: string, salt: string }}
 */
async function deployHookViaCreate2(deployer, poolManagerAddress, databaseAddress) {
    const HookFactory = await ethers.getContractFactory("LumoriaHook");
    const creationCode = ethers.concat([
        HookFactory.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address"],
            [poolManagerAddress, databaseAddress],
        ),
    ]);
    const creationCodeHash = ethers.keccak256(creationCode);

    const deployerAddress = await deployer.getAddress();
    const { salt, address } = mineHookSalt(deployerAddress, creationCodeHash);

    await (await deployer.deploy(salt, creationCode)).wait();
    const hook = await ethers.getContractAt("LumoriaHook", address);
    return { hook, address, salt };
}

module.exports = {
    HOOK_FLAGS,
    ALL_HOOK_MASK,
    LUMORIA_HOOK_FLAGS,
    mineHookSalt,
    deployHookViaCreate2,
};
