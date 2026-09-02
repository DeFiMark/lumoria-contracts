// Opt-in production-state rehearsal for Permanent Single-Sided V4.
//
// This test uses the checked-in BSC deployment manifest and live contract state
// from an explicitly configured archive RPC. It never invents replacements for
// canonical V4 or active Lumoria addresses; when necessary it also rehearses
// the separately documented metadata token-master prerequisite on the fork.
// Normal local runs skip it.
//
// Run (PowerShell):
//   $env:BSC_FORK="1"
//   $env:BSC_RPC="https://<archive-capable-bsc-rpc>"
//   node node_modules/hardhat/internal/cli/cli.js test test/SingleSidedV4Fork.test.js

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const deployment = require("../deployments/bsc.json");
const {
    buildCreatorFeeInitData,
    buildLiquidityInitData,
    encodeBYOLPayload,
    encodeFlatCurvePayload,
    encodeSingleSidedPayload,
    poolKeyFor,
    EMPTY_METADATA,
    MODULE_TYPE,
    LAUNCH_MODE,
} = require("./fixtures/deploy");

const FORK_ENABLED = process.env.BSC_FORK === "1" && Boolean(process.env.BSC_RPC);
const describeFork = FORK_ENABLED ? describe : describe.skip;
const START_TICK = 180000;

function randomSalt() {
    return ethers.hexlify(ethers.randomBytes(32));
}

async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

function parsedLog(receipt, contract, name) {
    return receipt.logs
        .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find((log) => log && log.name === name);
}

describeFork("BSC fork: Permanent Single-Sided V4 cutover rehearsal", function () {
    this.timeout(300000);

    it("rotates candidates on a fork, preserves legacy analytics, quotes, buys, sells, and raw-routes", async function () {
        expect((await ethers.provider.getNetwork()).chainId).to.equal(56n);

        // Mine one local block before contract calls. Hardhat/EDR does not ship
        // BSC's remote hardfork history, so calls in the exact remote fork block
        // fail before execution; the first local block uses the configured
        // local hardfork while retaining the complete production state.
        const [bootstrapSigner] = await ethers.getSigners();
        await (await bootstrapSigner.sendTransaction({
            to: bootstrapSigner.address,
            value: 0,
        })).wait();

        const requiredLiveAddresses = [
            deployment.core.database,
            deployment.core.hook,
            deployment.core.liquidityVault,
            deployment.core.router,
            deployment.v4.poolManager,
            deployment.v4.v4Quoter,
        ];
        for (const address of requiredLiveAddresses) {
            expect(await ethers.provider.getCode(address), `missing live code at ${address}`)
                .not.to.equal("0x");
        }

        const database = await ethers.getContractAt("Database", deployment.core.database);
        expect((await database.poolManager()).toLowerCase())
            .to.equal(deployment.v4.poolManager.toLowerCase());
        expect((await database.hook()).toLowerCase()).to.equal(deployment.core.hook.toLowerCase());
        expect((await database.liquidityVault()).toLowerCase())
            .to.equal(deployment.core.liquidityVault.toLowerCase());

        const ownerAddress = await database.owner();
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddress],
        });
        await network.provider.send("hardhat_setBalance", [
            ownerAddress,
            ethers.toBeHex(ethers.parseEther("100")),
        ]);
        const owner = await ethers.getSigner(ownerAddress);
        const [deployer, creator, trader] = await ethers.getSigners();

        // The current Generator source already includes the separate metadata
        // launch ABI. Production documents that token-master migration as a
        // prerequisite, so rehearse it on the fork when live state has not yet
        // completed it. Candidate/cutover scripts hard-fail on this mismatch.
        const tokenArtifact = await hre.artifacts.readArtifact("LumoriaToken");
        const expectedTokenMasterHash = ethers.keccak256(tokenArtifact.deployedBytecode);
        let tokenMaster = await database.tokenMasterCopy();
        if (ethers.keccak256(await ethers.provider.getCode(tokenMaster)) !== expectedTokenMasterHash) {
            const TokenMaster = await ethers.getContractFactory("LumoriaToken", deployer);
            const metadataAwareTokenMaster = await TokenMaster.deploy();
            await database.connect(owner).setTokenMasterCopy(
                await metadataAwareTokenMaster.getAddress(),
            );
            tokenMaster = await database.tokenMasterCopy();
        }
        expect(ethers.keccak256(await ethers.provider.getCode(tokenMaster)))
            .to.equal(expectedTokenMasterHash);

        const oldVaultAddress = await database.liquidityVault();
        const oldVault = await ethers.getContractAt("LumoriaLiquidityVault", oldVaultAddress);
        let historical;
        const tokenCount = await database.allTokensLength();
        if (tokenCount > 0n) {
            const token = await database.allTokens(0);
            historical = {
                token,
                liquidity: await oldVault.lockedLiquidity(token),
                bnb: await oldVault.totalBnbLocked(token),
                tokens: await oldVault.totalTokensLocked(token),
            };
        }

        const Vault = await ethers.getContractFactory("LumoriaLiquidityVault", deployer);
        const vaultV2 = await Vault.deploy(
            deployment.v4.poolManager,
            deployment.core.database,
            oldVaultAddress,
        );
        const Generator = await ethers.getContractFactory("Generator", deployer);
        const generatorV2 = await Generator.deploy(deployment.core.database);

        await database.connect(owner).setLiquidityVault(await vaultV2.getAddress());
        if (historical) {
            expect(await vaultV2.lockedLiquidity(historical.token)).to.equal(historical.liquidity);
            expect(await vaultV2.totalBnbLocked(historical.token)).to.equal(historical.bnb);
            expect(await vaultV2.totalTokensLocked(historical.token)).to.equal(historical.tokens);
        }
        await database.connect(owner).setGenerator(await generatorV2.getAddress());
        const launchFee = await database.launchFeeBnb();

        // Legacy mode 0 must seed through Vault V2 unchanged. Install a
        // LiquidityModule so the same pool can also rehearse a later legacy
        // full-range addition after the cutover.
        const byolSalt = randomSalt();
        const byolTokenAddr = await generatorV2.predictTokenAddress(byolSalt);
        const liquidityModules = [{
            moduleType: MODULE_TYPE.LIQUIDITY,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildLiquidityInitData({
                token: byolTokenAddr,
                database: deployment.core.database,
                liquidityInterval: 5 * 60,
            }),
        }];
        await expect(generatorV2.connect(creator).generateProject(
            "Fork BYOL", "FBY", 0, 0, liquidityModules,
            LAUNCH_MODE.BYOL,
            encodeBYOLPayload(ethers.parseEther("500000000")),
            [], byolSalt, EMPTY_METADATA,
            { value: launchFee + ethers.parseEther("1") },
        )).to.emit(generatorV2, "BYOLLaunched");
        const byolLiquidityBefore = await vaultV2.lockedLiquidity(byolTokenAddr);
        expect(byolLiquidityBefore).to.be.gt(0);

        const byolTaxHandler = await ethers.getContractAt(
            "TaxHandler", await database.tokenTaxHandler(byolTokenAddr),
        );
        const liquidityConfig = await byolTaxHandler.getModule(0);
        const liquidityModule = await ethers.getContractAt(
            "LiquidityModule", liquidityConfig.moduleAddress,
        );
        // Deterministically accrue module BNB without depending on market size,
        // then wait through the live operator window before permissionless
        // execution. The module still performs its real swap + Vault V2 add.
        await byolTaxHandler.receiveBuyTax({ value: ethers.parseEther("0.1") });
        await network.provider.send("evm_increaseTime", [5 * 60 + 60 * 60 + 1]);
        await network.provider.send("evm_mine");
        await expect(liquidityModule.connect(trader).executeLiquidity(
            1n, 0, 0, await deadline(),
        )).to.emit(liquidityModule, "LiquidityAdded");
        expect(await vaultV2.lockedLiquidity(byolTokenAddr)).to.be.gt(byolLiquidityBefore);

        // Legacy mode 1 must still create and successfully finalize its raise
        // through Vault V2. Derive the net cap from the live platform fee
        // rather than assuming the deployment still uses its original 1%.
        const flatSalt = randomSalt();
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        const flatGross = ethers.parseEther("0.1");
        const flatNet = flatGross - (flatGross * await database.platformFeeBps()) / 10000n;
        const flatPayload = encodeFlatCurvePayload({
            hardCap: flatNet,
            minContribution: flatNet,
            maxContribution: flatNet,
            tokensForPresale: ethers.parseEther("400000000"),
            tokensForLP: ethers.parseEther("500000000"),
            liquidityBps: 8000,
            creatorBps: 2000,
            startTime: now + 1,
            endTime: now + 3600,
        });
        const flatTx = await generatorV2.connect(creator).generateProject(
            "Fork Flat", "FFT", 0, 0,
            [{
                moduleType: MODULE_TYPE.CREATOR,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildCreatorFeeInitData(creator.address),
            }],
            LAUNCH_MODE.FLAT_CURVE, flatPayload,
            [], flatSalt, EMPTY_METADATA, { value: launchFee },
        );
        const flatReceipt = await flatTx.wait();
        const flatEvent = parsedLog(flatReceipt, generatorV2, "FlatCurveLaunched");
        const flatCurve = await ethers.getContractAt("FlatCurve", flatEvent.args.flatCurve);
        const flatTokenAddr = await generatorV2.predictTokenAddress(flatSalt);
        await network.provider.send("evm_increaseTime", [2]);
        await network.provider.send("evm_mine");
        await flatCurve.connect(trader).contribute({ value: flatGross });
        await expect(flatCurve.connect(trader).launch()).to.emit(flatCurve, "RaiseLaunched");
        expect(await vaultV2.lockedLiquidity(flatTokenAddr)).to.be.gt(0);

        const salt = randomSalt();
        const tokenAddr = await generatorV2.predictTokenAddress(salt);
        const modules = [{
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(creator.address),
        }];
        await expect(generatorV2.connect(creator).generateProject(
            "Fork Single Sided", "FSS", 500, 500, modules,
            LAUNCH_MODE.SINGLE_SIDED,
            encodeSingleSidedPayload(START_TICK),
            [], salt, EMPTY_METADATA, { value: launchFee },
        )).to.emit(generatorV2, "SingleSidedLaunched");

        const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
        expect(await vaultV2.isSingleSided(tokenAddr)).to.equal(true);
        expect(await vaultV2.totalBnbLocked(tokenAddr)).to.equal(0);
        expect(await token.balanceOf(await vaultV2.getAddress())).to.equal(0);

        const key = await poolKeyFor({ hook: await ethers.getContractAt("LumoriaHook", deployment.core.hook) }, tokenAddr);
        const quoter = new ethers.Contract(
            deployment.v4.v4Quoter,
            [
                "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
            ],
            trader,
        );
        const quote = await quoter.quoteExactInputSingle.staticCall({
            poolKey: key,
            zeroForOne: true,
            exactAmount: ethers.parseEther("0.01"),
            hookData: "0x",
        });
        expect(quote.amountOut).to.be.gt(0);

        const router = await ethers.getContractAt("LumoriaSwapRouter", deployment.core.router);
        await expect(router.connect(trader).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], trader.address, await deadline(),
            { value: ethers.parseEther("0.01") },
        )).to.emit(await ethers.getContractAt("LumoriaHook", deployment.core.hook), "TokenPurchased");
        const bought = await token.balanceOf(trader.address);
        await token.connect(trader).approve(await router.getAddress(), bought / 2n);
        await expect(router.connect(trader).swapExactTokensForETHSupportingFeeOnTransferTokens(
            bought / 2n, 0, [tokenAddr, ethers.ZeroAddress], trader.address, await deadline(),
        )).to.emit(await ethers.getContractAt("LumoriaHook", deployment.core.hook), "TokenSold");

        const RawV4Caller = await ethers.getContractFactory("RawV4Caller", deployer);
        const raw = await RawV4Caller.deploy(deployment.v4.poolManager);
        await expect(raw.connect(trader).rawSwap(
            key,
            {
                zeroForOne: true,
                amountSpecified: -ethers.parseEther("0.01"),
                sqrtPriceLimitX96: 4295128740n,
            },
            { value: ethers.parseEther("0.01") },
        )).to.emit(await ethers.getContractAt("FeeReceiver", deployment.core.feeReceiver), "TradeFeeReceived");

        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [ownerAddress],
        });
    });
});
