// Shared deploy fixture for Lumoria tests (Uniswap V4 era).
//
// `deployBase()` spins up the full system: Database, FeeReceiver, all
// master copies, a LOCAL Uniswap V4 PoolManager (on BSC mainnet the
// canonical deployment is used instead), the LumoriaHook (deployed via
// CREATE2 with a mined salt — V4 encodes hook permissions in the low 14
// bits of the hook's address), the LumoriaLiquidityVault, and the
// LumoriaSwapRouter. Tests use this via `loadFixture(deployBase)` for
// fast snapshot-based reuse.
//
// Launching a token is a three-step dance because modules encode their
// TaxHandler address in their init payload — we need the TaxHandler clone
// address *before* we can build module payloads:
//
//   1. prepareTokenShells(base) → { token, taxHandler, tokenAddr, taxHandlerAddr }
//        Deploys empty ERC-1167 clones, no init.
//   2. Build module init payloads using taxHandlerAddr (helpers below).
//   3. initializeToken(base, shells, { name, symbol, creator, pair, buyFee, sellFee, modules })
//        Calls __init__ on TaxHandler (which clones + inits each module)
//        and __init__ on the token, then registerToken on the Database.
//
// The Generator contract does this natively in one transaction; the JS
// flow mirrors it for unit-level control.
//
// V4 notes:
// - There is no pair contract. The token's `pair` reference is the
//   PoolManager (the address that custodies reserves and is excluded
//   from reward-share tracking). The pool itself is identified by a
//   deterministic PoolId = keccak256(abi.encode(poolKey)).
// - All liquidity is full-range, owned by the vault, permanently locked.
// - `launchTokenWithPool` (aliased as the legacy `launchTokenWithPair`)
//   seeds initial liquidity through router.addLiquidityETH, which lazily
//   initializes the pool at the implied price.

const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployHookViaCreate2 } = require("../../scripts/lib/hook-miner");

const ZERO = ethers.ZeroAddress;
const coder = ethers.AbiCoder.defaultAbiCoder();

async function deployBase() {
    const [owner, feeRecipient, creator, user1, user2, user3, keeper, ...rest] =
        await ethers.getSigners();

    // WBNB mock — retained ONLY as the legacy "BNB marker" address that
    // modules put in swap paths. Pools are native-BNB; nothing wraps.
    const MockWBNB = await ethers.getContractFactory("MockWBNB");
    const wbnb = await MockWBNB.deploy();

    const Database = await ethers.getContractFactory("Database");
    const database = await Database.deploy(await wbnb.getAddress());
    const databaseAddr = await database.getAddress();

    const FeeReceiver = await ethers.getContractFactory("FeeReceiver");
    const feeReceiver = await FeeReceiver.deploy(feeRecipient.address);
    await database.setFeeReceiver(await feeReceiver.getAddress());

    // ── Master copies ────────────────────────────────────────────────
    const LumoriaToken = await ethers.getContractFactory("LumoriaToken");
    const tokenMC = await LumoriaToken.deploy();
    await database.setTokenMasterCopy(await tokenMC.getAddress());

    const TaxHandler = await ethers.getContractFactory("TaxHandler");
    const taxHandlerMC = await TaxHandler.deploy();
    await database.setTaxHandlerMasterCopy(await taxHandlerMC.getAddress());

    const CreatorFeeModule = await ethers.getContractFactory("CreatorFeeModule");
    const creatorFeeMC = await CreatorFeeModule.deploy();
    await database.setModuleMasterCopy(3, await creatorFeeMC.getAddress());

    const RewardModule = await ethers.getContractFactory("RewardModule");
    const rewardMC = await RewardModule.deploy();
    await database.setModuleMasterCopy(0, await rewardMC.getAddress());

    const BurnModule = await ethers.getContractFactory("BurnModule");
    const burnMC = await BurnModule.deploy();
    await database.setModuleMasterCopy(1, await burnMC.getAddress());

    const LiquidityModule = await ethers.getContractFactory("LiquidityModule");
    const liqMC = await LiquidityModule.deploy();
    await database.setModuleMasterCopy(2, await liqMC.getAddress());

    const PrizePool = await ethers.getContractFactory("PrizePool");
    const prizeMC = await PrizePool.deploy();
    await database.setModuleMasterCopy(4, await prizeMC.getAddress());

    const MilestoneRewardModule = await ethers.getContractFactory("MilestoneRewardModule");
    const milestoneMC = await MilestoneRewardModule.deploy();
    await database.setModuleMasterCopy(5, await milestoneMC.getAddress());

    // ── Uniswap V4 core (local deployment for tests) ─────────────────
    const PoolManager = await ethers.getContractFactory("PoolManager");
    const poolManager = await PoolManager.deploy(owner.address);
    const poolManagerAddr = await poolManager.getAddress();
    await database.setPoolManager(poolManagerAddr);

    // ── LumoriaHook (CREATE2, mined address) ─────────────────────────
    const Create2Deployer = await ethers.getContractFactory("Create2Deployer");
    const create2Deployer = await Create2Deployer.deploy();
    const { hook } = await deployHookViaCreate2(create2Deployer, poolManagerAddr, databaseAddr);
    await database.setHook(await hook.getAddress());

    // ── Vault + Router ───────────────────────────────────────────────
    const LumoriaLiquidityVault = await ethers.getContractFactory("LumoriaLiquidityVault");
    const vault = await LumoriaLiquidityVault.deploy(poolManagerAddr, databaseAddr);
    await database.setLiquidityVault(await vault.getAddress());

    const LumoriaSwapRouter = await ethers.getContractFactory("LumoriaSwapRouter");
    const router = await LumoriaSwapRouter.deploy(poolManagerAddr, databaseAddr);
    await database.setRouter(await router.getAddress());

    // ── VestingVault (shared singleton; custodies vested allocations) ─
    // Must be wired before any launch — TaxHandler caches it at init to
    // exclude it from reward-share tracking.
    const VestingVault = await ethers.getContractFactory("VestingVault");
    const vestingVault = await VestingVault.deploy(databaseAddr);
    await database.setVestingVault(await vestingVault.getAddress());

    // ── Rebate ───────────────────────────────────────────────────────
    const RebateContract = await ethers.getContractFactory("RebateContract");
    const rebate = await RebateContract.deploy(databaseAddr);
    await database.setRebateContract(await rebate.getAddress());
    // The HOOK credits rebates now (it sees every buy, router-agnostic).
    await rebate.setAuthorizedCreditor(await hook.getAddress(), true);

    // ── FlatCurve master copy + Generator ────────────────────────────
    const FlatCurve = await ethers.getContractFactory("FlatCurve");
    const flatCurveMC = await FlatCurve.deploy();
    await database.setFlatCurveMasterCopy(await flatCurveMC.getAddress());

    const Generator = await ethers.getContractFactory("Generator");
    const generator = await Generator.deploy(databaseAddr);

    // By default the fixture sets `owner` as the Generator stand-in so
    // unit-level helpers (prepareTokenShells / initializeToken) can call
    // registerToken. Tests exercising the real Generator call
    // `useRealGenerator(base)` to swap.
    await database.setGenerator(owner.address);

    return {
        signers: { owner, feeRecipient, creator, user1, user2, user3, keeper, rest },
        wbnb,
        database,
        feeReceiver,
        poolManager,
        hook,
        vault,
        vestingVault,
        router,
        rebate,
        generator,
        create2Deployer,
        masterCopies: {
            token: tokenMC,
            taxHandler: taxHandlerMC,
            creatorFee: creatorFeeMC,
            reward: rewardMC,
            burn: burnMC,
            liquidity: liqMC,
            prize: prizeMC,
            milestone: milestoneMC,
            flatCurve: flatCurveMC,
        },
    };
}

/**
 * Swap Database.generator from the `owner` stand-in to the real Generator
 * contract. Call once before invoking `generator.generateProject`.
 */
async function useRealGenerator(base) {
    await base.database.connect(base.signers.owner).setGenerator(
        await base.generator.getAddress(),
    );
}

/**
 * abi.encode BYOL launch payload: (uint256 tokensForLP)
 */
function encodeBYOLPayload(tokensForLP) {
    return coder.encode(["uint256"], [tokensForLP]);
}

/**
 * abi.encode FlatCurve launch payload: (hardCap, min, max, tkPre, tkLP, lqBps, crBps, start, end)
 */
function encodeFlatCurvePayload({
    hardCap,
    minContribution,
    maxContribution,
    tokensForPresale,
    tokensForLP,
    liquidityBps,
    creatorBps,
    startTime,
    endTime,
}) {
    return coder.encode(
        ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
        [
            hardCap,
            minContribution,
            maxContribution,
            tokensForPresale,
            tokensForLP,
            liquidityBps,
            creatorBps,
            startTime,
            endTime,
        ],
    );
}

// Module type IDs (mirror TaxHandler constants)
const MODULE_TYPE = Object.freeze({
    REWARD: 0,
    BURN: 1,
    LIQUIDITY: 2,
    CREATOR: 3,
    PRIZE: 4,
    MILESTONE: 5,
});

// Change type IDs (mirror TaxHandler constants)
const CHANGE_TYPE = Object.freeze({
    ADD: 0,
    REMOVE: 1,
    UPDATE: 2,
});

// Launch modes (mirror IGenerator)
const LAUNCH_MODE = Object.freeze({
    BYOL: 0,
    FLAT_CURVE: 1,
});

/**
 * Deploy a raw ERC-1167 minimal proxy pointing at `implementation`.
 * Returns the new contract address. The proxy is not initialized.
 */
async function cloneERC1167(implementationAddress, signer) {
    const impl = implementationAddress.toLowerCase().replace("0x", "");
    const bytecode =
        "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
        impl +
        "5af43d82803e903d91602b57fd5bf3";
    const tx = await signer.sendTransaction({ data: bytecode });
    const receipt = await tx.wait();
    return receipt.contractAddress;
}

/**
 * Step 1 of the launch dance. Deploy uninitialized Token + TaxHandler clones.
 */
async function prepareTokenShells(base) {
    const { owner } = base.signers;
    const taxHandlerAddr = await cloneERC1167(
        await base.masterCopies.taxHandler.getAddress(),
        owner,
    );
    const tokenAddr = await cloneERC1167(
        await base.masterCopies.token.getAddress(),
        owner,
    );
    const taxHandler = await ethers.getContractAt("TaxHandler", taxHandlerAddr);
    const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
    return { token, tokenAddr, taxHandler, taxHandlerAddr };
}

/**
 * The canonical V4 PoolKey for a Lumoria token (JS mirror of
 * LumoriaHook.poolKeyFor). currency0 = native BNB (address(0)).
 */
async function poolKeyFor(base, tokenAddr) {
    return {
        currency0: ZERO,
        currency1: tokenAddr,
        fee: 0,
        tickSpacing: 60,
        hooks: await base.hook.getAddress(),
    };
}

/**
 * Deterministic PoolId = keccak256(abi.encode(poolKey)).
 */
async function poolIdFor(base, tokenAddr) {
    const key = await poolKeyFor(base, tokenAddr);
    return ethers.keccak256(
        coder.encode(
            ["tuple(address,address,uint24,int24,address)"],
            [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]],
        ),
    );
}

/**
 * Step 3 of the launch dance. Initializes both contracts and registers
 * the token in the Database.
 *
 * cfg: {
 *   name, symbol,
 *   pair,                            // defaults to the PoolManager address
 *   creator: Signer | address,
 *   buyFee, sellFee,                 // bps
 *   modules: ModuleInitData[]
 * }
 */
async function initializeToken(base, shells, cfg) {
    const { owner } = base.signers;
    const creatorAddr = cfg.creator.address || cfg.creator;
    const pair = cfg.pair || (await base.poolManager.getAddress());

    await shells.taxHandler.__init__(
        shells.tokenAddr,
        await base.database.getAddress(),
        creatorAddr,
        cfg.buyFee,
        cfg.sellFee,
        cfg.modules,
    );

    await shells.token.connect(owner).__init__(
        cfg.name,
        cfg.symbol,
        pair,
        shells.taxHandlerAddr,
        creatorAddr,
    );

    await base.database.connect(owner).registerToken(
        shells.tokenAddr,
        creatorAddr,
        shells.taxHandlerAddr,
    );
}

/**
 * Full-stack launch on a V4 pool: clones Token + TaxHandler, inits with
 * pair = PoolManager, registers in the Database, and optionally seeds
 * initial (permanently locked) liquidity via router.addLiquidityETH —
 * which lazily initializes the pool at the implied price.
 *
 * cfg: {
 *   name, symbol,
 *   creator: Signer,
 *   buyFee, sellFee,
 *   modules: ModuleInitData[] | (shells) => ModuleInitData[]
 *   initialLiquidity?: { tokens: bigint, bnb: bigint }
 * }
 *
 * Returns { token, tokenAddr, taxHandler, taxHandlerAddr, poolId, pairAddr }.
 * (`pairAddr` is the PoolManager address — the V4-era stand-in kept for
 * legacy test compatibility.)
 */
async function launchTokenWithPool(base, cfg) {
    const shells = await prepareTokenShells(base);
    const tokenAddr = shells.tokenAddr;

    const modules = typeof cfg.modules === "function"
        ? cfg.modules(shells)
        : cfg.modules;

    const creator = cfg.creator || base.signers.creator;

    await initializeToken(base, shells, {
        name: cfg.name || "Test",
        symbol: cfg.symbol || "TST",
        creator,
        buyFee: cfg.buyFee ?? 500,
        sellFee: cfg.sellFee ?? 500,
        modules,
    });

    if (cfg.initialLiquidity) {
        const { tokens, bnb } = cfg.initialLiquidity;
        // owner holds the full supply from token init
        await shells.token.connect(base.signers.owner).approve(
            await base.router.getAddress(),
            tokens,
        );
        await base.router.connect(base.signers.owner).addLiquidityETH(
            tokenAddr,
            tokens,
            0,
            0,
            base.signers.owner.address, // ignored — liquidity is vault-locked
            (await ethers.provider.getBlock("latest")).timestamp + 3600,
            { value: bnb },
        );
    }

    return {
        ...shells,
        poolId: await poolIdFor(base, tokenAddr),
        pairAddr: await base.poolManager.getAddress(),
    };
}

// Legacy alias — V2-era tests imported this name.
const launchTokenWithPair = launchTokenWithPool;

// ─── Module Init Payload Builders ──────────────────────────────────

// Module init payloads no longer encode `taxHandler` — the module infers it
// from `msg.sender` at init time (the TaxHandler clone is the caller).

/** CreatorFeeModule: abi.encode(recipient) */
function buildCreatorFeeInitData(recipientAddr) {
    return coder.encode(["address"], [recipientAddr]);
}

/** RewardModule: abi.encode(token, rewardToken, externalRouter, externalWBNB, minDistribution).
 *  Pass rewardToken=ZERO for BNB mode (no external router needed).
 *  Operators are platform-wide (Database.setOperator), never per-module. */
function buildRewardInitData({
    token,
    rewardToken = ZERO,
    externalRouter = ZERO,
    externalWBNB = ZERO,
    minDistribution = 0n,
}) {
    return coder.encode(
        ["address", "address", "address", "address", "uint256"],
        [token, rewardToken, externalRouter, externalWBNB, minDistribution],
    );
}

/** BurnModule: abi.encode(token, database, burnInterval) */
function buildBurnInitData({ token, database, burnInterval }) {
    return coder.encode(
        ["address", "address", "uint256"],
        [token, database, burnInterval],
    );
}

/** LiquidityModule: abi.encode(token, database, liquidityInterval) */
function buildLiquidityInitData({ token, database, liquidityInterval }) {
    return coder.encode(
        ["address", "address", "uint256"],
        [token, database, liquidityInterval],
    );
}

/** MilestoneRewardModule: abi.encode(token) */
function buildMilestoneInitData({ token }) {
    return coder.encode(["address"], [token]);
}

/** PrizePool: the full §2.10 tuple. Defaults follow the recommended settings
 *  (hold everything you bought; uncapped weights; no minimums; no bounty). */
const PAYOUT_MODE = Object.freeze({ PRO_RATA: 0, LOTTERY: 1, ALL_HOLDERS: 2 });

function buildPrizePoolInitData({
    token,
    database,
    payoutMode = PAYOUT_MODE.PRO_RATA,
    epochLength = 24 * 60 * 60,
    winnerCount = 0,
    holdRequirementBps = 10000n,
    maxWeightBps = 0n,
    minPot = 0n,
    minParticipants = 0n,
    settleBountyBps = 0n,
    rootPoster,
}) {
    return coder.encode(
        [
            "address", "address", "uint8", "uint256", "uint8",
            "uint256", "uint256", "uint256", "uint256", "uint256", "address",
        ],
        [
            token, database, payoutMode, epochLength, winnerCount,
            holdRequirementBps, maxWeightBps, minPot, minParticipants,
            settleBountyBps, rootPoster ?? ZERO,
        ],
    );
}

/** Far-future deadline for module execute* calls. */
async function farDeadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

module.exports = {
    deployBase,
    loadFixture,
    cloneERC1167,
    prepareTokenShells,
    initializeToken,
    poolKeyFor,
    poolIdFor,
    launchTokenWithPool,
    launchTokenWithPair,
    useRealGenerator,
    encodeBYOLPayload,
    encodeFlatCurvePayload,
    buildCreatorFeeInitData,
    buildRewardInitData,
    buildBurnInitData,
    buildLiquidityInitData,
    buildMilestoneInitData,
    buildPrizePoolInitData,
    farDeadline,
    MODULE_TYPE,
    CHANGE_TYPE,
    LAUNCH_MODE,
    PAYOUT_MODE,
};
