// Permanent Single-Sided V4 launch integration and regression coverage.
//
// The launch starts exactly at the position's upper boundary with 100% of the
// final token supply and no BNB. These tests intentionally trade through the
// unchanged Lumoria router and through a raw PoolManager caller: mode 2 must be
// an additive liquidity shape, not a special trading system.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
    deployBase,
    loadFixture,
    useRealGenerator,
    prepareTokenShells,
    initializeToken,
    launchTokenWithPool,
    poolKeyFor,
    poolIdFor,
    buildCreatorFeeInitData,
    buildLiquidityInitData,
    encodeSingleSidedPayload,
    EMPTY_METADATA,
    MODULE_TYPE,
    LAUNCH_MODE,
} = require("./fixtures/deploy");

const TOTAL_SUPPLY = ethers.parseEther("1000000000");
const LAUNCH_FEE = ethers.parseEther("0.005");
const START_TICK = 180000;
const MIN_USABLE_TICK = -887220;
const MIN_SQRT_PRICE_LIMIT = 4295128739n + 1n;
const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const BPS = 10000n;

function randomSalt() {
    return ethers.hexlify(ethers.randomBytes(32));
}

function creatorFeeModule(recipient) {
    return [{
        moduleType: MODULE_TYPE.CREATOR,
        buyAllocation: 10000,
        sellAllocation: 10000,
        initPayload: buildCreatorFeeInitData(recipient),
    }];
}

async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

function parsedLog(receipt, contract, name) {
    return receipt.logs
        .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find((log) => log && log.name === name);
}

async function taxOwed(base, tokenAddr, recipient) {
    const taxHandlerAddr = await base.database.tokenTaxHandler(tokenAddr);
    const taxHandler = await ethers.getContractAt("TaxHandler", taxHandlerAddr);
    const moduleConfig = await taxHandler.getModule(0);
    const module = await ethers.getContractAt("CreatorFeeModule", moduleConfig.moduleAddress);
    return module.owed(recipient);
}

async function launchSingleSided(base, overrides = {}) {
    await useRealGenerator(base);
    const creator = overrides.creator ?? base.signers.creator;
    const recipient = overrides.recipient ?? base.signers.rest[0].address;
    const salt = overrides.salt ?? randomSalt();
    const tokenAddr = await base.generator.predictTokenAddress(salt);
    const modules = overrides.modules ?? creatorFeeModule(recipient);
    const value = overrides.value ?? LAUNCH_FEE;

    const tx = await base.generator.connect(creator).generateProject(
        overrides.name ?? "Single Sided",
        overrides.symbol ?? "SSV4",
        overrides.buyFee ?? 500,
        overrides.sellFee ?? 1000,
        modules,
        LAUNCH_MODE.SINGLE_SIDED,
        overrides.payload ?? encodeSingleSidedPayload(overrides.startTick ?? START_TICK),
        overrides.allocations ?? [],
        salt,
        EMPTY_METADATA,
        { value },
    );
    const receipt = await tx.wait();
    const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
    const taxHandler = await ethers.getContractAt(
        "TaxHandler", await base.database.tokenTaxHandler(tokenAddr),
    );
    return { token, tokenAddr, taxHandler, receipt, recipient, creator };
}

async function prepareDirectVaultToken(base) {
    const shells = await prepareTokenShells(base);
    await initializeToken(base, shells, {
        name: "Direct Vault Token",
        symbol: "DVT",
        creator: base.signers.owner,
        buyFee: 0,
        sellFee: 0,
        modules: creatorFeeModule(base.signers.rest[1].address),
    });
    await shells.token.transfer(await base.vault.getAddress(), TOTAL_SUPPLY);
    return shells;
}

describe("Permanent Single-Sided V4 launch", function () {
    describe("Generator mode 2", function () {
        it("keeps mode IDs stable and emits common plus mode-specific launch events", async function () {
            expect(LAUNCH_MODE).to.deep.equal({ BYOL: 0, FLAT_CURVE: 1, SINGLE_SIDED: 2 });

            const base = await loadFixture(deployBase);
            const { creator } = base.signers;
            const salt = randomSalt();
            const predicted = await base.generator.predictTokenAddress(salt);
            await useRealGenerator(base);

            const tx = base.generator.connect(creator).generateProject(
                "Single Sided", "SSV4", 500, 1000,
                creatorFeeModule(base.signers.rest[0].address),
                LAUNCH_MODE.SINGLE_SIDED,
                encodeSingleSidedPayload(START_TICK),
                [], salt, EMPTY_METADATA, { value: LAUNCH_FEE },
            );

            await expect(tx).to.emit(base.generator, "SingleSidedLaunched")
                .withArgs(predicted, START_TICK, anyValue, anyValue, anyValue)
                .and.to.emit(base.generator, "ProjectGenerated")
                .withArgs(predicted, anyValue, creator.address, "Single Sided", "SSV4", 500, 1000, 2)
                .and.to.emit(base.feeReceiver, "LaunchFeeReceived")
                .withArgs(predicted, creator.address, LAUNCH_FEE);
        });

        it("requires exactly the launch fee and rejects malformed payloads", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const args = (payload, salt) => [
                "Bad", "BAD", 0, 0, creatorFeeModule(base.signers.rest[0].address),
                LAUNCH_MODE.SINGLE_SIDED, payload, [], salt, EMPTY_METADATA,
            ];

            await expect(base.generator.connect(base.signers.creator).generateProject(
                ...args(encodeSingleSidedPayload(START_TICK), randomSalt()), { value: 0 },
            )).to.be.revertedWith("Gen: insufficient launch fee");

            await expect(base.generator.connect(base.signers.creator).generateProject(
                ...args(encodeSingleSidedPayload(START_TICK), randomSalt()),
                { value: LAUNCH_FEE + 1n },
            )).to.be.revertedWith("Gen: no BNB on SINGLE_SIDED");

            await expect(base.generator.connect(base.signers.creator).generateProject(
                ...args("0x1234", randomSalt()), { value: LAUNCH_FEE },
            )).to.be.revertedWith("Gen: bad single-sided payload");
        });

        it("rejects allocations and an initial LiquidityModule atomically", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            await expect(base.generator.connect(creator).generateProject(
                "Allocated", "ALLOC", 0, 0,
                creatorFeeModule(base.signers.rest[0].address),
                LAUNCH_MODE.SINGLE_SIDED,
                encodeSingleSidedPayload(START_TICK),
                [{ beneficiary: user1.address, amount: 1n, cliff: 0, duration: 0 }],
                randomSalt(), EMPTY_METADATA, { value: LAUNCH_FEE },
            )).to.be.revertedWith("Gen: allocations disabled");

            const salt = randomSalt();
            const predicted = await base.generator.predictTokenAddress(salt);
            const liquidityModule = [{
                moduleType: MODULE_TYPE.LIQUIDITY,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildLiquidityInitData({
                    token: predicted,
                    database: await base.database.getAddress(),
                    liquidityInterval: 3600,
                }),
            }];
            await expect(base.generator.connect(creator).generateProject(
                "Liquidity", "LIQ", 500, 500, liquidityModule,
                LAUNCH_MODE.SINGLE_SIDED,
                encodeSingleSidedPayload(START_TICK),
                [], salt, EMPTY_METADATA, { value: LAUNCH_FEE },
            )).to.be.revertedWith("Gen: liquidity module disabled");

            expect(await base.database.isLumoriaToken(predicted)).to.equal(false);
            expect(await ethers.provider.getCode(predicted)).to.equal("0x");
        });

        it("rejects a post-launch LiquidityModule on-chain while BYOL tokens still accept one", async function () {
            const base = await loadFixture(deployBase);
            const { creator } = base.signers;
            const databaseAddr = await base.database.getAddress();

            async function addLiquidityModule(taxHandler, tokenAddr) {
                await taxHandler.connect(creator).proposeModuleAdd(
                    MODULE_TYPE.LIQUIDITY,
                    5000, 5000,
                    buildLiquidityInitData({ token: tokenAddr, database: databaseAddr, liquidityInterval: 3600 }),
                    [{ moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 }],
                );
                await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
                await ethers.provider.send("evm_mine", []);
                return taxHandler.connect(creator).executeModuleChange();
            }

            // Control: a full-range (BYOL) token can still add the module.
            const byol = await launchTokenWithPool(base, {
                modules: creatorFeeModule(base.signers.rest[3].address),
                initialLiquidity: { tokens: ethers.parseEther("500000000"), bnb: ethers.parseEther("10") },
            });
            await addLiquidityModule(byol.taxHandler, byol.tokenAddr);
            expect((await byol.taxHandler.getModule(1)).moduleType).to.equal(MODULE_TYPE.LIQUIDITY);

            // Mode 2: the proposal is accepted (it is only a proposal) but the
            // module master refuses to initialize for a single-sided token.
            const single = await launchSingleSided(base);
            await expect(addLiquidityModule(single.taxHandler, single.tokenAddr))
                .to.be.revertedWith("Single-sided token");
            expect(await single.taxHandler.getModuleCount()).to.equal(1);
        });

        it("enforces the owner-tunable product start-tick window and its default FDV range", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { owner, creator, user1 } = base.signers;
            const Q192 = 1n << 192n;
            const ONE_BNB = ethers.parseEther("1");

            const [minStartTick, maxStartTick] = await base.generator.singleSidedStartTickBounds();
            expect(minStartTick).to.equal(148200n);
            expect(maxStartTick).to.equal(196260n);
            expect(await base.generator.singleSidedMinStartTick()).to.equal(minStartTick);
            expect(await base.generator.singleSidedMaxStartTick()).to.equal(maxStartTick);

            // A fresh Generator announces its defaults.
            const Generator = await ethers.getContractFactory("Generator");
            const fresh = await Generator.deploy(await base.database.getAddress());
            await expect(fresh.deploymentTransaction())
                .to.emit(fresh, "SingleSidedStartTickBoundsUpdated").withArgs(148200, 196260);

            // Both bounds are launchable and map to the documented FDV window
            // (fdv = supply * Q192 / sqrtPrice^2; pool price is token/BNB so a
            // LOWER tick is a HIGHER FDV).
            async function fdvBnbAt(tick) {
                const { tokenAddr } = await launchSingleSided(base, { startTick: Number(tick) });
                const position = await base.vault.singleSidedPosition(tokenAddr);
                return (TOTAL_SUPPLY * Q192) / (position.sqrtPriceX96 * position.sqrtPriceX96);
            }
            const maxFdv = await fdvBnbAt(minStartTick);
            const minFdv = await fdvBnbAt(maxStartTick);
            expect(maxFdv).to.be.within(360n * ONE_BNB, 372n * ONE_BNB);   // ≈ 366 BNB
            expect(minFdv).to.be.within(29n * ONE_BNB / 10n, 31n * ONE_BNB / 10n); // ≈ 3 BNB

            // One tick outside either bound reverts at the Generator, before the vault.
            for (const tick of [Number(minStartTick) - 60, Number(maxStartTick) + 60]) {
                await expect(launchSingleSided(base, { startTick: tick }))
                    .to.be.revertedWith("Gen: start tick out of bounds");
            }

            // Setter is owner-only, alignment- and order-checked.
            await expect(base.generator.connect(creator).setSingleSidedStartTickBounds(START_TICK, START_TICK))
                .to.be.revertedWith("Gen: only owner");
            await expect(base.generator.connect(user1).setSingleSidedStartTickBounds(START_TICK, START_TICK))
                .to.be.revertedWith("Gen: only owner");
            await expect(base.generator.connect(owner).setSingleSidedStartTickBounds(START_TICK + 1, START_TICK + 60))
                .to.be.revertedWith("Gen: unaligned bounds");
            await expect(base.generator.connect(owner).setSingleSidedStartTickBounds(START_TICK + 60, START_TICK))
                .to.be.revertedWith("Gen: inverted bounds");

            // Owner narrows the window to a single tick; launches follow it immediately.
            await expect(base.generator.connect(owner).setSingleSidedStartTickBounds(START_TICK, START_TICK))
                .to.emit(base.generator, "SingleSidedStartTickBoundsUpdated").withArgs(START_TICK, START_TICK);
            expect(await base.generator.singleSidedStartTickBounds()).to.deep.equal([BigInt(START_TICK), BigInt(START_TICK)]);
            await expect(launchSingleSided(base, { startTick: START_TICK + 60 }))
                .to.be.revertedWith("Gen: start tick out of bounds");
            await expect(launchSingleSided(base, { startTick: Number(minStartTick) }))
                .to.be.revertedWith("Gen: start tick out of bounds");
            const { tokenAddr } = await launchSingleSided(base, { startTick: START_TICK });
            expect(await base.vault.isSingleSided(tokenAddr)).to.equal(true);
        });

        it("commits the full final supply, seeds zero BNB, and leaves no creator or vault dust", async function () {
            const base = await loadFixture(deployBase);
            const pmBnbBefore = await ethers.provider.getBalance(await base.poolManager.getAddress());
            const { token, tokenAddr, receipt, creator } = await launchSingleSided(base);
            const position = await base.vault.singleSidedPosition(tokenAddr);
            const vaultEvent = parsedLog(receipt, base.vault, "SingleSidedPositionLocked");
            const generatorEvent = parsedLog(receipt, base.generator, "SingleSidedLaunched");
            const poolInitialize = parsedLog(receipt, base.poolManager, "Initialize");

            expect(await base.vault.isSingleSided(tokenAddr)).to.equal(true);
            expect(position.tickLower).to.equal(MIN_USABLE_TICK);
            expect(position.tickUpper).to.equal(START_TICK);
            expect(position.sqrtPriceX96).to.equal(generatorEvent.args.sqrtPriceX96);
            expect(position.sqrtPriceX96).to.equal(vaultEvent.args.sqrtPriceX96);
            expect(position.sqrtPriceX96).to.equal(poolInitialize.args.sqrtPriceX96);
            expect(poolInitialize.args.tick).to.equal(START_TICK);
            expect(poolInitialize.args.id).to.equal(await poolIdFor(base, tokenAddr));
            expect(position.liquidity).to.equal(generatorEvent.args.liquidity);
            expect(position.tokenAmount).to.equal(generatorEvent.args.tokenAmountCommitted);
            expect(position.tokenAmount + position.dustBurned).to.equal(TOTAL_SUPPLY);
            expect(await token.totalSupply()).to.equal(position.tokenAmount);
            expect(await token.balanceOf(await base.poolManager.getAddress())).to.equal(position.tokenAmount);
            expect(await token.balanceOf(await base.vault.getAddress())).to.equal(0);
            expect(await token.balanceOf(creator.address)).to.equal(0);
            expect(await base.vault.totalTokensLocked(tokenAddr)).to.equal(position.tokenAmount);
            expect(await base.vault.totalBnbLocked(tokenAddr)).to.equal(0);
            expect(await ethers.provider.getBalance(await base.poolManager.getAddress())).to.equal(pmBnbBefore);
        });
    });

    describe("Vault initialization and permanent-lock invariants", function () {
        it("allows only the current Generator and rejects a nonzero-BNB seed", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await prepareDirectVaultToken(base);

            await expect(base.vault.connect(base.signers.user1).initializeSingleSided(
                tokenAddr, START_TICK,
            )).to.be.revertedWithCustomError(base.vault, "OnlyGenerator");

            await expect(base.vault.initializeSingleSided(
                tokenAddr, START_TICK, { value: 1n },
            )).to.be.revertedWithCustomError(base.vault, "NonZeroBnbSeed");
        });

        it("requires a registered token, an aligned bounded tick, and a fresh pool", async function () {
            const base = await loadFixture(deployBase);

            await expect(base.vault.initializeSingleSided(
                base.signers.user1.address, START_TICK,
            )).to.be.revertedWithCustomError(base.vault, "NotLumoriaToken");

            const direct = await prepareDirectVaultToken(base);
            for (const tick of [START_TICK + 1, MIN_USABLE_TICK, 887280]) {
                await expect(base.vault.initializeSingleSided(direct.tokenAddr, tick))
                    .to.be.revertedWithCustomError(base.vault, "InvalidStartTick");
            }

            const initialized = await launchTokenWithPool(base, {
                modules: creatorFeeModule(base.signers.rest[2].address),
                initialLiquidity: {
                    tokens: ethers.parseEther("500000000"),
                    bnb: ethers.parseEther("10"),
                },
            });
            await expect(base.vault.initializeSingleSided(initialized.tokenAddr, START_TICK))
                .to.be.revertedWithCustomError(base.vault, "PoolAlreadyInitialized");
        });

        it("rejects a second initialization and all later configured-vault liquidity", async function () {
            const base = await loadFixture(deployBase);
            const direct = await prepareDirectVaultToken(base);
            await base.vault.initializeSingleSided(direct.tokenAddr, START_TICK);
            await expect(base.vault.initializeSingleSided(direct.tokenAddr, START_TICK))
                .to.be.revertedWithCustomError(base.vault, "AlreadySingleSided");

            // Acquire tokens from a normal Generator launch, then attempt the
            // unchanged router's add-liquidity path. The vault's mode flag is
            // the final gate and the whole transfer rolls back.
            const traded = await launchSingleSided(base, { recipient: base.signers.rest[3].address });
            await base.router.connect(base.signers.user1)
                .swapExactETHForTokensSupportingFeeOnTransferTokens(
                    0, [ethers.ZeroAddress, traded.tokenAddr], base.signers.user1.address,
                    await deadline(), { value: ethers.parseEther("1") },
                );
            const balance = await traded.token.balanceOf(base.signers.user1.address);
            await traded.token.connect(base.signers.user1).approve(await base.router.getAddress(), balance);
            await expect(base.router.connect(base.signers.user1).addLiquidityETH(
                traded.tokenAddr, balance, 0, 0, base.signers.user1.address, await deadline(),
                { value: ethers.parseEther("1") },
            )).to.be.revertedWithCustomError(base.vault, "AdditionalLiquidityDisabled");
            expect(await traded.token.balanceOf(base.signers.user1.address)).to.equal(balance);
        });

        it("still rejects direct additions, removals, and donations through the PoolManager", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await launchSingleSided(base);
            const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
            const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
            const key = await poolKeyFor(base, tokenAddr);

            await expect(raw.rawAddLiquidity(key, 1n, { value: 1n })).to.be.reverted;
            await expect(raw.rawAddLiquidity(key, -1n)).to.be.reverted;
            await expect(raw.rawDonate(key, 1n, 0, { value: 1n })).to.be.reverted;
        });
    });

    describe("unchanged hook and router trading", function () {
        it("first buy crosses the exact upper boundary, pays exact taxes, and moves price correctly", async function () {
            const base = await loadFixture(deployBase);
            const recipient = base.signers.rest[4].address;
            const { token, tokenAddr, taxHandler } = await launchSingleSided(base, {
                buyFee: 500, sellFee: 1000, recipient,
            });
            const start = (await base.vault.singleSidedPosition(tokenAddr)).sqrtPriceX96;
            const bnbIn = ethers.parseEther("1");
            const platformFee = (bnbIn * 100n) / BPS;
            const buyTax = ((bnbIn - platformFee) * 500n) / BPS;
            const feeBefore = await base.feeReceiver.totalReceived();

            const buyReceipt = await (await base.router.connect(base.signers.user1)
                .swapExactETHForTokensSupportingFeeOnTransferTokens(
                    0, [ethers.ZeroAddress, tokenAddr], base.signers.user1.address,
                    await deadline(), { value: bnbIn },
                )).wait();
            const bought = parsedLog(buyReceipt, base.hook, "TokenPurchased");

            expect(bought.args.bnbIn).to.equal(bnbIn);
            expect(bought.args.platformFee).to.equal(platformFee);
            expect(bought.args.taxTaken).to.equal(buyTax);
            expect(bought.args.tokensOut).to.be.gt(0);
            expect(bought.args.sqrtPriceX96).to.be.lt(start);
            expect(bought.args.tick).to.be.lt(START_TICK);
            expect(await token.balanceOf(base.signers.user1.address)).to.equal(bought.args.tokensOut);
            expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(platformFee);
            expect(await taxOwed(base, tokenAddr, recipient)).to.equal(buyTax);
            expect(await taxHandler.totalBuyTaxReceived()).to.equal(buyTax);

            // Lower token/BNB sqrt-price means higher user-facing BNB/token.
            const Q192 = 2n ** 192n;
            const startBnbPerToken = (Q192 * 10n ** 18n) / (start * start);
            const postBuyBnbPerToken =
                (Q192 * 10n ** 18n) / (bought.args.sqrtPriceX96 * bought.args.sqrtPriceX96);
            expect(postBuyBnbPerToken).to.be.gt(startBnbPerToken);
        });

        it("sell tax math is unchanged and selling moves price back toward the start", async function () {
            const base = await loadFixture(deployBase);
            const recipient = base.signers.rest[5].address;
            const { token, tokenAddr, taxHandler } = await launchSingleSided(base, {
                buyFee: 0, sellFee: 1000, recipient,
            });
            const start = (await base.vault.singleSidedPosition(tokenAddr)).sqrtPriceX96;
            const buyReceipt = await (await base.router.connect(base.signers.user1)
                .swapExactETHForTokensSupportingFeeOnTransferTokens(
                    0, [ethers.ZeroAddress, tokenAddr], base.signers.user1.address,
                    await deadline(), { value: ethers.parseEther("2") },
                )).wait();
            const afterBuy = parsedLog(buyReceipt, base.hook, "TokenPurchased").args.sqrtPriceX96;
            const amount = await token.balanceOf(base.signers.user1.address);
            await token.connect(base.signers.user1).approve(await base.router.getAddress(), amount);
            const feeBefore = await base.feeReceiver.totalReceived();

            const sellReceipt = await (await base.router.connect(base.signers.user1)
                .swapExactTokensForETHSupportingFeeOnTransferTokens(
                    amount, 0, [tokenAddr, ethers.ZeroAddress], base.signers.user1.address,
                    await deadline(),
                )).wait();
            const sold = parsedLog(sellReceipt, base.hook, "TokenSold");
            const grossBnb = sold.args.bnbOut + sold.args.platformFee + sold.args.taxTaken;

            expect(sold.args.platformFee).to.equal((grossBnb * 100n) / BPS);
            expect(sold.args.taxTaken).to.equal(((grossBnb - sold.args.platformFee) * 1000n) / BPS);
            expect(sold.args.sqrtPriceX96).to.be.gt(afterBuy);
            expect(sold.args.sqrtPriceX96).to.be.lte(start);
            expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(sold.args.platformFee);
            expect(await taxOwed(base, tokenAddr, recipient)).to.equal(sold.args.taxTaken);
            expect(await taxHandler.totalSellTaxReceived()).to.equal(sold.args.taxTaken);
        });

        it("raw third-party buy and sell remain taxed without user attribution", async function () {
            const base = await loadFixture(deployBase);
            const recipient = base.signers.rest[6].address;
            const { token, tokenAddr } = await launchSingleSided(base, {
                buyFee: 500, sellFee: 1000, recipient,
            });
            const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
            const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
            const key = await poolKeyFor(base, tokenAddr);
            const bnbIn = ethers.parseEther("1");
            const expectedPlatform = bnbIn / 100n;
            const expectedTax = ((bnbIn - expectedPlatform) * 500n) / BPS;

            await expect(raw.connect(base.signers.user1).rawSwap(
                key,
                { zeroForOne: true, amountSpecified: -bnbIn, sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
                { value: bnbIn },
            )).to.emit(base.feeReceiver, "TradeFeeReceived")
                .withArgs(tokenAddr, ethers.ZeroAddress, expectedPlatform, bnbIn, true);
            expect(await taxOwed(base, tokenAddr, recipient)).to.equal(expectedTax);
            expect(await base.database.userVolume(tokenAddr, base.signers.user1.address)).to.equal(0);

            const bought = await token.balanceOf(base.signers.user1.address);
            await token.connect(base.signers.user1).approve(await raw.getAddress(), bought);
            const feeBefore = await base.feeReceiver.totalReceived();
            const taxBefore = await taxOwed(base, tokenAddr, recipient);
            await raw.connect(base.signers.user1).rawSwap(
                key,
                { zeroForOne: false, amountSpecified: -bought, sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT },
            );
            expect(await base.feeReceiver.totalReceived()).to.be.gt(feeBefore);
            expect(await taxOwed(base, tokenAddr, recipient)).to.be.gt(taxBefore);
        });

        it("a very large exact-input buy settles completely without stranded vault/router balances", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launchSingleSided(base, { buyFee: 0, sellFee: 0 });
            const value = ethers.parseEther("5000");

            await expect(base.router.connect(base.signers.user1)
                .swapExactETHForTokensSupportingFeeOnTransferTokens(
                    0, [ethers.ZeroAddress, tokenAddr], base.signers.user1.address,
                    await deadline(), { value },
                )).to.emit(base.hook, "TokenPurchased");

            expect(await token.balanceOf(base.signers.user1.address)).to.be.gt(0);
            expect(await token.balanceOf(await base.router.getAddress())).to.equal(0);
            expect(await token.balanceOf(await base.vault.getAddress())).to.equal(0);
            expect(await ethers.provider.getBalance(await base.router.getAddress())).to.equal(0);
            expect(await ethers.provider.getBalance(await base.vault.getAddress())).to.equal(0);
        });
    });

    describe("Vault V2 legacy analytics rotation", function () {
        it("preserves old totals and aggregates post-rotation additions", async function () {
            const base = await loadFixture(deployBase);
            const legacy = await launchTokenWithPool(base, {
                modules: creatorFeeModule(base.signers.rest[7].address),
                initialLiquidity: {
                    tokens: ethers.parseEther("500000000"),
                    bnb: ethers.parseEther("100"),
                },
            });
            const oldLiquidity = await base.vault.lockedLiquidity(legacy.tokenAddr);
            const oldBnb = await base.vault.totalBnbLocked(legacy.tokenAddr);
            const oldTokens = await base.vault.totalTokensLocked(legacy.tokenAddr);

            const Vault = await ethers.getContractFactory("LumoriaLiquidityVault");
            const vaultV2 = await Vault.deploy(
                await base.poolManager.getAddress(),
                await base.database.getAddress(),
                await base.vault.getAddress(),
            );
            await base.database.setLiquidityVault(await vaultV2.getAddress());

            expect(await vaultV2.lockedLiquidity(legacy.tokenAddr)).to.equal(oldLiquidity);
            expect(await vaultV2.totalBnbLocked(legacy.tokenAddr)).to.equal(oldBnb);
            expect(await vaultV2.totalTokensLocked(legacy.tokenAddr)).to.equal(oldTokens);

            const addition = ethers.parseEther("1000000");
            await legacy.token.approve(await base.router.getAddress(), addition);
            await base.router.addLiquidityETH(
                legacy.tokenAddr, addition, 0, 0, base.signers.owner.address, await deadline(),
                { value: ethers.parseEther("0.2") },
            );
            expect(await vaultV2.lockedLiquidity(legacy.tokenAddr)).to.be.gt(oldLiquidity);
            expect(await vaultV2.totalBnbLocked(legacy.tokenAddr)).to.be.gt(oldBnb);
            expect(await vaultV2.totalTokensLocked(legacy.tokenAddr)).to.be.gt(oldTokens);
        });
    });
});
