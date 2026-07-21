// Phase A of docs/TOKENOMICS_V2.md — the pre-mainnet substrate changes.
//
// Everything here covers code that FREEZES per-token at launch, so a bug that
// ships is a bug that can never be fixed for the tokens already deployed:
//
//   §7.1  RewardModule must not swap inside the V4 swap callback.
//   §7.2  CreatorFeeModule must not push BNB inside the swap callback.
//   §7.3  System contracts that custody tokens must never accrue reflections.
//   §7.4  Database.randomnessProvider exists and is owner-gated.
//   §7.5  Integer dust must not land on a zero-allocation module.
//   §4.1  RewardModule.donate()  — lets a PrizePool pay every holder.
//   §4.2  RewardModule.sync()    — a reward module added post-launch starts blind.
//   §6.2  No module swap may run with a zero slippage floor; swaps are gated to
//         the platform operator registry (with a liveness fallback) so minOut is
//         computed off-chain.
//   §6.3  Only swaps are gated. Pure bookkeeping ("churn the gas") stays
//         permissionless forever, and the split is visible in the ABI.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    launchTokenWithPair,
    useRealGenerator,
    encodeFlatCurvePayload,
    buildCreatorFeeInitData,
    buildRewardInitData,
    buildBurnInitData,
    buildLiquidityInitData,
    farDeadline,
    MODULE_TYPE,
    LAUNCH_MODE,
} = require("./fixtures/deploy");

const ZERO = ethers.ZeroAddress;

/** Launch with one BNB-mode RewardModule at 100%. */
async function launchWithReward(base, cfg = {}) {
    const shells = await prepareTokenShells(base);
    await initializeToken(base, shells, {
        name: "Rewarded",
        symbol: "RWD",
        pair: cfg.pair || base.signers.keeper.address,
        creator: base.signers.creator,
        buyFee: 500,
        sellFee: 500,
        modules: [{
            moduleType: MODULE_TYPE.REWARD,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildRewardInitData({ token: shells.tokenAddr }),
        }],
    });
    const cfg0 = await shells.taxHandler.getModule(0);
    const rewardMod = await ethers.getContractAt("RewardModule", cfg0.moduleAddress);
    return { ...shells, rewardMod };
}

describe("TokenomicsV2 Phase A", function () {

    // ─── §7.4 ───────────────────────────────────────────────────────
    describe("Database.randomnessProvider (§7.4)", function () {
        it("defaults to zero, is owner-gated, and emits on update", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1 } = base.signers;

            expect(await base.database.randomnessProvider()).to.equal(ZERO);

            await expect(
                base.database.connect(user1).setRandomnessProvider(user1.address),
            ).to.be.reverted;

            await expect(base.database.connect(owner).setRandomnessProvider(user1.address))
                .to.emit(base.database, "RandomnessProviderUpdated")
                .withArgs(ZERO, user1.address);

            expect(await base.database.randomnessProvider()).to.equal(user1.address);
        });
    });

    // ─── §7.1 ───────────────────────────────────────────────────────
    describe("RewardModule does not swap in the swap path (§7.1)", function () {
        it("token-mode receiveTax survives a reverting external router", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1, keeper } = base.signers;

            const RevertingRouter = await ethers.getContractFactory("RevertingRouter");
            const badRouter = await RevertingRouter.deploy();
            const badRouterAddr = await badRouter.getAddress();
            const wbnbAddr = await base.wbnb.getAddress();

            const shells = await prepareTokenShells(base);
            await initializeToken(base, shells, {
                name: "TokenMode",
                symbol: "TM",
                pair: keeper.address,
                creator: base.signers.creator,
                buyFee: 500,
                sellFee: 500,
                modules: [{
                    moduleType: MODULE_TYPE.REWARD,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildRewardInitData({
                        token: shells.tokenAddr,
                        rewardToken: wbnbAddr,       // token mode
                        externalRouter: badRouterAddr,
                        externalWBNB: wbnbAddr,
                        minDistribution: 0n,         // would always try to swap
                    }),
                }],
            });
            const cfg0 = await shells.taxHandler.getModule(0);
            const rewardMod = await ethers.getContractAt("RewardModule", cfg0.moduleAddress);

            // Give a holder shares so _tryDistribute would otherwise proceed.
            await shells.token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            expect(await rewardMod.totalSharesTracked()).to.be.gt(0);

            // THE REGRESSION: the tax leg must not touch the external router.
            // Before the fix this reverted, which reverted the trade.
            await expect(shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") })).to.not.be
                .reverted;

            // BNB accrued, nothing distributed.
            expect(await ethers.provider.getBalance(cfg0.moduleAddress)).to.equal(
                ethers.parseEther("1"),
            );
            expect(await rewardMod.totalDividendsDistributed()).to.equal(0);

            // The failure is isolated to the keeper's out-of-band trigger.
            await expect(rewardMod.convertAndDistribute(1n, await farDeadline())).to.be.reverted;
        });

        it("BNB-mode receiveTax still distributes inline (no external call involved)", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1 } = base.signers;
            const { token, taxHandler, rewardMod } = await launchWithReward(base);

            await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

            expect(await rewardMod.totalDividendsDistributed()).to.equal(ethers.parseEther("1"));
            expect(await rewardMod.getUnpaidRewards(user1.address)).to.be.gt(0);
        });
    });

    // ─── §4.1 ───────────────────────────────────────────────────────
    describe("RewardModule.donate (§4.1)", function () {
        it("lets anyone fund rewards and distributes pro-rata", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1, user2, user3 } = base.signers;
            const { token, rewardMod } = await launchWithReward(base);

            // Two holders, 3:1
            await token.connect(owner).transfer(user1.address, ethers.parseEther("3000"));
            await token.connect(owner).transfer(user2.address, ethers.parseEther("1000"));

            // user3 is neither the TaxHandler nor a holder — donation must still work.
            await expect(rewardMod.connect(user3).donate({ value: ethers.parseEther("4") }))
                .to.emit(rewardMod, "Donated")
                .withArgs(user3.address, ethers.parseEther("4"));

            const r1 = await rewardMod.getUnpaidRewards(user1.address);
            const r2 = await rewardMod.getUnpaidRewards(user2.address);
            expect(r1).to.be.gt(r2);
            expect(r1 / r2).to.equal(3n);
        });

        it("rejects zero-value donations", async function () {
            const base = await loadFixture(deployBase);
            const { rewardMod } = await launchWithReward(base);
            await expect(rewardMod.donate({ value: 0 })).to.be.revertedWith("Zero donation");
        });
    });

    // ─── §4.2 ───────────────────────────────────────────────────────
    describe("RewardModule.sync (§4.2)", function () {
        it("backfills holders that predate the module, without trusting the caller", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1, user2, user3, creator } = base.signers;

            // Launch with a CreatorFeeModule only — no reward module yet.
            const shells = await prepareTokenShells(base);
            await initializeToken(base, shells, {
                name: "Late", symbol: "LATE",
                pair: base.signers.keeper.address,
                creator,
                buyFee: 500, sellFee: 500,
                modules: [{
                    moduleType: MODULE_TYPE.CREATOR,
                    buyAllocation: 10000, sellAllocation: 10000,
                    initPayload: buildCreatorFeeInitData(creator.address),
                }],
            });

            // Holders acquire tokens BEFORE any reward module exists.
            await shells.token.connect(owner).transfer(user1.address, ethers.parseEther("3000"));
            await shells.token.connect(owner).transfer(user2.address, ethers.parseEther("1000"));

            // Creator adds a reward module later, rebalancing creator fee to 0.
            await shells.taxHandler.connect(creator).proposeModuleAdd(
                MODULE_TYPE.REWARD,
                10000, 10000,
                buildRewardInitData({ token: shells.tokenAddr }),
                [{ moduleIndex: 0, buyAllocation: 0, sellAllocation: 0 }],
            );
            await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
            await ethers.provider.send("evm_mine", []);
            await shells.taxHandler.connect(creator).executeModuleChange();

            const cfg1 = await shells.taxHandler.getModule(1);
            const rewardMod = await ethers.getContractAt("RewardModule", cfg1.moduleAddress);

            // It starts blind — setShare only fires on transfer.
            expect(await rewardMod.totalSharesTracked()).to.equal(0);

            // Anyone can backfill. user3 supplies the list; balances are read
            // on-chain, so a bogus entry cannot inflate anyone's share.
            await expect(rewardMod.connect(user3).sync([user1.address, user2.address, user3.address]))
                .to.emit(rewardMod, "SharesSynced");

            expect(await rewardMod.shares(user1.address)).to.equal(ethers.parseEther("3000"));
            expect(await rewardMod.shares(user2.address)).to.equal(ethers.parseEther("1000"));
            expect(await rewardMod.shares(user3.address)).to.equal(0); // holds nothing

            // Now a distribution reaches the pre-existing holders.
            await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("4") });
            expect(await rewardMod.getUnpaidRewards(user1.address)).to.be.gt(0);
            expect(await rewardMod.getUnpaidRewards(user2.address)).to.be.gt(0);
        });

        it("forces excluded addresses to zero rather than reading their balance", async function () {
            const base = await loadFixture(deployBase);
            const { owner } = base.signers;
            const { token, taxHandler, rewardMod } = await launchWithReward(base);

            const rebateAddr = await base.rebate.getAddress();
            await token.connect(owner).transfer(rebateAddr, ethers.parseEther("5000"));

            await rewardMod.sync([rebateAddr]);
            expect(await rewardMod.shares(rebateAddr)).to.equal(0);
            expect(await taxHandler.shares(rebateAddr)).to.equal(0);
        });
    });

    // ─── §7.3 ───────────────────────────────────────────────────────
    describe("Share exclusions (§7.3)", function () {
        it("excludes the vesting vault, rebate contract, liquidity vault and module clones", async function () {
            const base = await loadFixture(deployBase);
            const { taxHandler } = await launchWithReward(base);

            expect(await taxHandler.isExcludedFromShares(await base.vestingVault.getAddress())).to.equal(true);
            expect(await taxHandler.isExcludedFromShares(await base.rebate.getAddress())).to.equal(true);
            expect(await taxHandler.isExcludedFromShares(await base.vault.getAddress())).to.equal(true);

            const cfg0 = await taxHandler.getModule(0);
            expect(await taxHandler.isExcludedFromShares(cfg0.moduleAddress)).to.equal(true);

            // Ordinary holders are not excluded.
            expect(await taxHandler.isExcludedFromShares(base.signers.user1.address)).to.equal(false);
        });

        it("reports the pool as excluded even though it has no mapping entry", async function () {
            const base = await loadFixture(deployBase);
            const { taxHandler } = await launchWithReward(base, {
                pair: base.signers.keeper.address,
            });
            // `pair` is the token's stand-in pool address in this fixture.
            expect(await taxHandler.isExcludedFromShares(base.signers.keeper.address)).to.equal(true);
        });

        it("an excluded contract holding tokens accrues no shares and dilutes nobody", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1 } = base.signers;
            const { token, taxHandler, rewardMod } = await launchWithReward(base);

            const rebateAddr = await base.rebate.getAddress();
            const moved = ethers.parseEther("9000");

            await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            const sharesBefore = await taxHandler.totalShares();

            // The RebateContract receives a large balance — it must not register.
            // Total shares fall by exactly what left the (tracked) owner, so the
            // rebate balance contributes nothing and dilutes nobody.
            await token.connect(owner).transfer(rebateAddr, moved);

            expect(await taxHandler.shares(rebateAddr)).to.equal(0);
            expect(await taxHandler.totalShares()).to.equal(sharesBefore - moved);
            expect(await rewardMod.shares(rebateAddr)).to.equal(0);
            expect(await rewardMod.totalSharesTracked()).to.equal(await taxHandler.totalShares());

            // A distribution therefore credits it nothing.
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            expect(await rewardMod.getUnpaidRewards(rebateAddr)).to.equal(0);
            expect(await rewardMod.getUnpaidRewards(user1.address)).to.be.gt(0);
        });

        it("excludeFromShares is generator-only", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const { taxHandler } = await launchWithReward(base);

            // The fixture sets `owner` as the Generator stand-in.
            await expect(
                taxHandler.connect(user1).excludeFromShares(user2.address),
            ).to.be.revertedWith("Only generator");

            await expect(taxHandler.connect(base.signers.owner).excludeFromShares(user2.address))
                .to.emit(taxHandler, "ExcludedFromShares")
                .withArgs(user2.address);
        });

        it("excluding an address that already holds shares zeroes them out", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1, user2 } = base.signers;
            const { token, taxHandler, rewardMod } = await launchWithReward(base);

            await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await token.connect(owner).transfer(user2.address, ethers.parseEther("1000"));

            const totalBefore = await taxHandler.totalShares();
            expect(await taxHandler.shares(user2.address)).to.equal(ethers.parseEther("1000"));

            await taxHandler.connect(owner).excludeFromShares(user2.address);

            // The excluded holder's share is zeroed and removed from the total,
            // and the zeroing is propagated to the reward module.
            expect(await taxHandler.shares(user2.address)).to.equal(0);
            expect(await taxHandler.totalShares()).to.equal(totalBefore - ethers.parseEther("1000"));
            expect(await rewardMod.shares(user2.address)).to.equal(0);
            expect(await rewardMod.totalSharesTracked()).to.equal(await taxHandler.totalShares());
        });

        it("the Generator excludes a FlatCurve before it receives presale tokens", async function () {
            const base = await loadFixture(deployBase);
            const { creator } = base.signers;
            await useRealGenerator(base);

            // The RewardModule needs the real token address in its init payload,
            // which the Generator lets us compute before the launch lands.
            const salt = ethers.zeroPadValue("0x01", 32);
            const predictedToken = await base.generator.predictTokenAddress(salt);

            const now = (await ethers.provider.getBlock("latest")).timestamp;
            const payload = encodeFlatCurvePayload({
                hardCap: ethers.parseEther("100"),
                minContribution: ethers.parseEther("0.01"),
                maxContribution: ethers.parseEther("10"),
                tokensForPresale: ethers.parseEther("300000000"),
                tokensForLP: ethers.parseEther("200000000"),
                liquidityBps: 7000,
                creatorBps: 3000,
                startTime: now + 60,
                endTime: now + 3600,
            });

            const tx = await base.generator.connect(creator).generateProject(
                "Curve", "CRV", 500, 500,
                [{
                    moduleType: MODULE_TYPE.REWARD,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildRewardInitData({ token: predictedToken }),
                }],
                LAUNCH_MODE.FLAT_CURVE,
                payload,
                [],
                salt,
                { value: ethers.parseEther("0.005") }, // flat launch fee
            );
            const receipt = await tx.wait();

            const launched = receipt.logs
                .map((l) => { try { return base.generator.interface.parseLog(l); } catch { return null; } })
                .find((p) => p && p.name === "FlatCurveLaunched");
            expect(launched, "FlatCurveLaunched event").to.not.equal(undefined);

            const [tokenAddr, flatCurveAddr] = launched.args;
            const taxHandlerAddr = await base.database.tokenTaxHandler(tokenAddr);
            const taxHandler = await ethers.getContractAt("TaxHandler", taxHandlerAddr);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);

            // The FlatCurve holds a huge presale balance...
            expect(await token.balanceOf(flatCurveAddr)).to.equal(ethers.parseEther("500000000"));
            // ...and accrues exactly zero reward shares against it.
            expect(await taxHandler.isExcludedFromShares(flatCurveAddr)).to.equal(true);
            expect(await taxHandler.shares(flatCurveAddr)).to.equal(0);
        });
    });

    // ─── §7.5 ───────────────────────────────────────────────────────
    describe("Dust sweep skips zero-allocation modules (§7.5)", function () {
        it("dust lands on the last NON-ZERO module, not the last module", async function () {
            const base = await loadFixture(deployBase);
            const { creator, user1, user2 } = base.signers;

            const shells = await prepareTokenShells(base);
            // Two creator-fee modules: the first takes everything, the second is
            // a 0-bps module sitting LAST — the natural shape of a default
            // reward module funded only by donations.
            await initializeToken(base, shells, {
                name: "Dust", symbol: "DUST",
                pair: base.signers.keeper.address,
                creator,
                buyFee: 500, sellFee: 500,
                modules: [
                    {
                        moduleType: MODULE_TYPE.CREATOR,
                        buyAllocation: 10000, sellAllocation: 10000,
                        initPayload: buildCreatorFeeInitData(user1.address),
                    },
                    {
                        moduleType: MODULE_TYPE.CREATOR,
                        buyAllocation: 0, sellAllocation: 0,
                        initPayload: buildCreatorFeeInitData(user2.address),
                    },
                ],
            });

            const cfgA = await shells.taxHandler.getModule(0);
            const cfgB = await shells.taxHandler.getModule(1);
            const modA = await ethers.getContractAt("CreatorFeeModule", cfgA.moduleAddress);
            const modB = await ethers.getContractAt("CreatorFeeModule", cfgB.moduleAddress);

            // An amount that does not divide evenly, to force dust.
            const amount = 1_000_000_000_000_000_001n;
            await shells.taxHandler.receiveBuyTax({ value: amount });

            // Everything, including the dust wei, goes to the 10000-bps module.
            expect(await modA.owed(user1.address)).to.equal(amount);
            expect(await modB.owed(user2.address)).to.equal(0);
            expect(await ethers.provider.getBalance(cfgB.moduleAddress)).to.equal(0);

            // And nothing is stranded in the TaxHandler.
            expect(await ethers.provider.getBalance(shells.taxHandlerAddr)).to.equal(0);
        });

        it("splits with dust across three modules still conserve the full amount", async function () {
            const base = await loadFixture(deployBase);
            const { creator, user1, user2, user3 } = base.signers;

            const shells = await prepareTokenShells(base);
            await initializeToken(base, shells, {
                name: "Split", symbol: "SPL",
                pair: base.signers.keeper.address,
                creator,
                buyFee: 500, sellFee: 500,
                modules: [3333, 3333, 3334].map((bps, i) => ({
                    moduleType: MODULE_TYPE.CREATOR,
                    buyAllocation: bps, sellAllocation: bps,
                    initPayload: buildCreatorFeeInitData([user1, user2, user3][i].address),
                })),
            });

            const amount = 1_000_000_000_000_000_007n;
            await shells.taxHandler.receiveBuyTax({ value: amount });

            let total = 0n;
            for (let i = 0; i < 3; i++) {
                const cfg = await shells.taxHandler.getModule(i);
                total += await ethers.provider.getBalance(cfg.moduleAddress);
            }
            expect(total).to.equal(amount);
            expect(await ethers.provider.getBalance(shells.taxHandlerAddr)).to.equal(0);
        });
    });

    // ─── §6.2 ───────────────────────────────────────────────────────
    describe("Module swaps: slippage floors + operator gating (§6.2)", function () {

        const HOUR = 3600;
        const INTERVAL = 5 * 60;

        async function launchWithBurn(base, opts = {}) {
            const databaseAddr = await base.database.getAddress();
            const launch = await launchTokenWithPair(base, {
                buyFee: opts.buyFee ?? 0,
                sellFee: 0,
                modules: (shells) => [{
                    moduleType: MODULE_TYPE.BURN,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildBurnInitData({
                        token: shells.tokenAddr,
                        database: databaseAddr,
                        burnInterval: INTERVAL,
                    }),
                }],
                initialLiquidity: {
                    tokens: ethers.parseEther("100000"),
                    bnb: ethers.parseEther("10"),
                },
            });
            const cfg0 = await launch.taxHandler.getModule(0);
            const burnMod = await ethers.getContractAt("BurnModule", cfg0.moduleAddress);
            await launch.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

            // Operators are platform-wide, registered by the Database owner.
            if (opts.operator) {
                await base.database.connect(base.signers.owner).setOperator(opts.operator, true);
            }
            return { ...launch, burnMod };
        }

        it("rejects a zero slippage floor — a free sandwich otherwise", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await time.increase(INTERVAL + 1);
            await expect(burnMod.executeBurn(0, await farDeadline())).to.be.revertedWith(
                "Zero minTokensOut",
            );
        });

        it("rejects an expired deadline", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await time.increase(INTERVAL + 1);
            const past = (await ethers.provider.getBlock("latest")).timestamp - 1;
            await expect(burnMod.executeBurn(1n, past)).to.be.revertedWith("Expired");
        });

        it("enforces the slippage floor against the real swap output", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await time.increase(INTERVAL + 1);
            // Far more tokens than 1 BNB can buy from this pool.
            await expect(
                burnMod.executeBurn(ethers.parseEther("100000000"), await farDeadline()),
            ).to.be.reverted;
        });

        it("the buyback's own tax re-enters receiveTax and terminates one level deep", async function () {
            const base = await loadFixture(deployBase);
            // buyFee > 0 → the module's own buyback is taxed, and 100% of that
            // tax routes straight back into this module. It must not loop.
            const { burnMod } = await launchWithBurn(base, { buyFee: 500 });
            await time.increase(INTERVAL + 1);

            await expect(burnMod.executeBurn(1n, await farDeadline()))
                .to.emit(burnMod, "TaxReceived")   // re-entered once...
                .and.to.emit(burnMod, "BurnExecuted"); // ...and still completed
        });

        describe("platform operator registry", function () {
            it("with zero operators registered, execution is permissionless immediately", async function () {
                const base = await loadFixture(deployBase);
                const { user1 } = base.signers;
                const { burnMod } = await launchWithBurn(base); // no operators

                expect(await base.database.operatorCount()).to.equal(0);
                await time.increase(INTERVAL + 1);
                await expect(burnMod.connect(user1).executeBurn(1n, await farDeadline())).to.emit(
                    burnMod,
                    "BurnExecuted",
                );
            });

            it("registering the first operator gates every module, system-wide", async function () {
                const base = await loadFixture(deployBase);
                const { keeper, user1 } = base.signers;
                const { burnMod } = await launchWithBurn(base, { operator: keeper.address });

                expect(await base.database.operatorCount()).to.equal(1);
                await time.increase(INTERVAL + 1);
                await expect(
                    burnMod.connect(user1).executeBurn(1n, await farDeadline()),
                ).to.be.revertedWith("Operator window");
            });

            it("a registered operator executes as soon as the interval elapses", async function () {
                const base = await loadFixture(deployBase);
                const { keeper } = base.signers;
                const { burnMod } = await launchWithBurn(base, { operator: keeper.address });

                await time.increase(INTERVAL + 1);
                await expect(burnMod.connect(keeper).executeBurn(1n, await farDeadline())).to.emit(
                    burnMod,
                    "BurnExecuted",
                );
            });

            it("anyone may execute once the fallback delay lapses — an absent backend cannot strand funds", async function () {
                const base = await loadFixture(deployBase);
                const { keeper, user1 } = base.signers;
                const { burnMod } = await launchWithBurn(base, { operator: keeper.address });

                await time.increase(INTERVAL + HOUR + 1);
                await expect(burnMod.connect(user1).executeBurn(1n, await farDeadline())).to.emit(
                    burnMod,
                    "BurnExecuted",
                );
            });

            it("revoking the last operator restores permissionless execution", async function () {
                const base = await loadFixture(deployBase);
                const { owner, keeper, user1 } = base.signers;
                const { burnMod } = await launchWithBurn(base, { operator: keeper.address });

                await base.database.connect(owner).setOperator(keeper.address, false);
                expect(await base.database.operatorCount()).to.equal(0);

                await time.increase(INTERVAL + 1);
                await expect(burnMod.connect(user1).executeBurn(1n, await farDeadline())).to.emit(
                    burnMod,
                    "BurnExecuted",
                );
            });

            it("the token creator cannot appoint an operator — only the Database owner", async function () {
                const base = await loadFixture(deployBase);
                const { owner, creator, keeper } = base.signers;
                const { burnMod } = await launchWithBurn(base);

                // No per-module setOperator exists at all.
                expect(burnMod.interface.hasFunction?.("setOperator") ?? false).to.equal(false);

                await expect(base.database.connect(creator).setOperator(keeper.address, true)).to.be
                    .reverted;

                await expect(base.database.connect(owner).setOperator(keeper.address, true))
                    .to.emit(base.database, "OperatorUpdated")
                    .withArgs(keeper.address, true);
                expect(await base.database.isOperator(keeper.address)).to.equal(true);
            });

            it("operatorCount stays honest across redundant grants and revokes", async function () {
                const base = await loadFixture(deployBase);
                const { owner, keeper, user1 } = base.signers;

                await base.database.connect(owner).setOperator(keeper.address, true);
                await base.database.connect(owner).setOperator(keeper.address, true); // no-op
                expect(await base.database.operatorCount()).to.equal(1);

                await base.database.connect(owner).setOperator(user1.address, true);
                expect(await base.database.operatorCount()).to.equal(2);

                await base.database.connect(owner).setOperator(keeper.address, false);
                await base.database.connect(owner).setOperator(keeper.address, false); // no-op
                expect(await base.database.operatorCount()).to.equal(1);

                await expect(
                    base.database.connect(owner).setOperator(ethers.ZeroAddress, true),
                ).to.be.revertedWith("Zero operator");
            });

            it("token-mode reward distribution honours the same registry", async function () {
                const base = await loadFixture(deployBase);
                const { owner, keeper, user1 } = base.signers;

                const RevertingRouter = await ethers.getContractFactory("RevertingRouter");
                const badRouter = await RevertingRouter.deploy();
                const wbnbAddr = await base.wbnb.getAddress();

                const shells = await prepareTokenShells(base);
                await initializeToken(base, shells, {
                    name: "TokenMode", symbol: "TM",
                    pair: base.signers.user3.address,
                    creator: base.signers.creator,
                    buyFee: 500, sellFee: 500,
                    modules: [{
                        moduleType: MODULE_TYPE.REWARD,
                        buyAllocation: 10000, sellAllocation: 10000,
                        initPayload: buildRewardInitData({
                            token: shells.tokenAddr,
                            rewardToken: wbnbAddr,
                            externalRouter: await badRouter.getAddress(),
                            externalWBNB: wbnbAddr,
                        }),
                    }],
                });
                const cfg0 = await shells.taxHandler.getModule(0);
                const rewardMod = await ethers.getContractAt("RewardModule", cfg0.moduleAddress);

                // Shares + accrued BNB, so the distribution actually reaches the swap.
                await shells.token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
                await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

                await base.database.connect(owner).setOperator(keeper.address, true);

                // Non-operator is inside the operator's window → gated.
                await expect(
                    rewardMod.connect(user1).convertAndDistribute(1n, await farDeadline()),
                ).to.be.revertedWith("Operator window");

                // The operator gets through the gate and fails on the bad router instead.
                await expect(
                    rewardMod.connect(keeper).convertAndDistribute(1n, await farDeadline()),
                ).to.be.revertedWithCustomError(badRouter, "RouterDown");
            });
        });

        it("LiquidityModule rejects a zero slippage floor too", async function () {
            const base = await loadFixture(deployBase);
            const databaseAddr = await base.database.getAddress();
            const launch = await launchTokenWithPair(base, {
                buyFee: 0,
                sellFee: 0,
                modules: (shells) => [{
                    moduleType: MODULE_TYPE.LIQUIDITY,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildLiquidityInitData({
                        token: shells.tokenAddr,
                        database: databaseAddr,
                        liquidityInterval: INTERVAL,
                    }),
                }],
                initialLiquidity: {
                    tokens: ethers.parseEther("100000"),
                    bnb: ethers.parseEther("10"),
                },
            });
            const cfg0 = await launch.taxHandler.getModule(0);
            const liqMod = await ethers.getContractAt("LiquidityModule", cfg0.moduleAddress);
            await launch.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            await time.increase(INTERVAL + 1);

            await expect(
                liqMod.executeLiquidity(0, 0, 0, await farDeadline()),
            ).to.be.revertedWith("Zero minTokensOut");
        });

        it("BNB-mode reward distribution needs no swap, so it stays permissionless", async function () {
            const base = await loadFixture(deployBase);
            const { owner, keeper, user1, user2 } = base.signers;

            const shells = await prepareTokenShells(base);
            await initializeToken(base, shells, {
                name: "BnbMode", symbol: "BM",
                pair: base.signers.user3.address,
                creator: base.signers.creator,
                buyFee: 500, sellFee: 500,
                modules: [{
                    moduleType: MODULE_TYPE.REWARD,
                    buyAllocation: 10000, sellAllocation: 10000,
                    initPayload: buildRewardInitData({ token: shells.tokenAddr }),
                }],
            });
            const cfg0 = await shells.taxHandler.getModule(0);
            const rewardMod = await ethers.getContractAt("RewardModule", cfg0.moduleAddress);

            await shells.token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

            // An operator IS registered — but processRewards() performs no swap,
            // so the gate never applies to it.
            await base.database.connect(owner).setOperator(keeper.address, true);

            await expect(rewardMod.connect(user2).processRewards()).to.not.be.reverted;
        });

        it("the permissionless and gated entry points are separate functions, not a branch", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1 } = base.signers;

            // BNB-mode module: convertAndDistribute is unreachable.
            const { rewardMod: bnbMod } = await launchWithReward(base);
            await expect(
                bnbMod.convertAndDistribute(1n, await farDeadline()),
            ).to.be.revertedWith("BNB mode: use processRewards");

            // Token-mode module: processRewards is unreachable.
            const RevertingRouter = await ethers.getContractFactory("RevertingRouter");
            const badRouter = await RevertingRouter.deploy();
            const wbnbAddr = await base.wbnb.getAddress();
            const shells = await prepareTokenShells(base);
            await initializeToken(base, shells, {
                name: "TokenMode2", symbol: "TM2",
                pair: base.signers.user3.address,
                creator: base.signers.creator,
                buyFee: 500, sellFee: 500,
                modules: [{
                    moduleType: MODULE_TYPE.REWARD,
                    buyAllocation: 10000, sellAllocation: 10000,
                    initPayload: buildRewardInitData({
                        token: shells.tokenAddr,
                        rewardToken: wbnbAddr,
                        externalRouter: await badRouter.getAddress(),
                        externalWBNB: wbnbAddr,
                    }),
                }],
            });
            const cfg0 = await shells.taxHandler.getModule(0);
            const tokenMod = await ethers.getContractAt("RewardModule", cfg0.moduleAddress);

            await expect(tokenMod.connect(user1).processRewards()).to.be.revertedWith(
                "Token mode: use convertAndDistribute",
            );
        });

        it("claims, donations and share-sync are never gated, even with operators registered", async function () {
            const base = await loadFixture(deployBase);
            const { owner, keeper, user1, user2, user3 } = base.signers;
            const { token, taxHandler, rewardMod } = await launchWithReward(base);

            await base.database.connect(owner).setOperator(keeper.address, true);

            await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

            // Anyone donates, anyone syncs, the holder claims, anyone churns.
            await expect(rewardMod.connect(user3).donate({ value: ethers.parseEther("1") })).to.not.be
                .reverted;
            await expect(rewardMod.connect(user2).sync([user1.address])).to.not.be.reverted;
            await expect(rewardMod.connect(user2).processRewards()).to.not.be.reverted;
            await expect(rewardMod.connect(user1).claimReward()).to.not.be.reverted;
        });

        it("a token cannot reward itself — the swap would re-enter its own tax path", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            const routerAddr = await base.router.getAddress();
            const wbnbAddr = await base.wbnb.getAddress();

            await expect(
                initializeToken(base, shells, {
                    name: "Self", symbol: "SELF",
                    pair: base.signers.keeper.address,
                    creator: base.signers.creator,
                    buyFee: 500, sellFee: 500,
                    modules: [{
                        moduleType: MODULE_TYPE.REWARD,
                        buyAllocation: 10000, sellAllocation: 10000,
                        initPayload: buildRewardInitData({
                            token: shells.tokenAddr,
                            rewardToken: shells.tokenAddr, // self-reward
                            externalRouter: routerAddr,
                            externalWBNB: wbnbAddr,
                        }),
                    }],
                }),
            ).to.be.revertedWith("Reward token = token");
        });
    });
});
