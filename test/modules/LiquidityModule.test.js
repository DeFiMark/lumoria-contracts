const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    launchTokenWithPair,
    buildLiquidityInitData,
    MODULE_TYPE,
} = require("../fixtures/deploy");

const DEAD = "0x000000000000000000000000000000000000dEaD";

// Mirrors BurnModule tests — executeLiquidity needs Phase 3 Router + Pair.
// Guards + config setters are testable now.

describe("LiquidityModule", function () {

    async function launchWithLiquidity(base, { liquidityInterval = 5 * 60 } = {}) {
        const shells = await prepareTokenShells(base);
        const modules = [
            {
                moduleType: MODULE_TYPE.LIQUIDITY,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildLiquidityInitData({
                    token: shells.tokenAddr,
                    database: await base.database.getAddress(),
                    liquidityInterval,
                }),
            },
        ];
        await initializeToken(base, shells, {
            name: "Liq",
            symbol: "LIQ",
            pair: base.signers.user3.address,
            creator: base.signers.creator,
            buyFee: 500,
            sellFee: 500,
            modules,
        });
        const liqModAddr = (await shells.taxHandler.getModule(0)).moduleAddress;
        const liqMod = await ethers.getContractAt("LiquidityModule", liqModAddr);
        return { ...shells, liqMod };
    }

    it("rejects interval below MIN_INTERVAL at init", async function () {
        const base = await loadFixture(deployBase);
        const shells = await prepareTokenShells(base);
        const modules = [
            {
                moduleType: MODULE_TYPE.LIQUIDITY,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildLiquidityInitData({
                    token: shells.tokenAddr,
                    database: await base.database.getAddress(),
                    liquidityInterval: 60,
                }),
            },
        ];
        await expect(
            shells.taxHandler.__init__(
                shells.tokenAddr,
                await base.database.getAddress(),
                base.signers.creator.address,
                500,
                500,
                modules,
            ),
        ).to.be.reverted;
    });

    it("only taxHandler can send BNB in", async function () {
        const base = await loadFixture(deployBase);
        const { liqMod } = await launchWithLiquidity(base);
        await expect(
            liqMod.connect(base.signers.user1).receiveTax({ value: ethers.parseEther("1") }),
        ).to.be.revertedWith("Only taxHandler");
    });

    it("accumulates BNB in the module", async function () {
        const base = await loadFixture(deployBase);
        const { liqMod, taxHandler } = await launchWithLiquidity(base);
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
        expect(await ethers.provider.getBalance(await liqMod.getAddress())).to.equal(
            ethers.parseEther("1"),
        );
    });

    it("only creator can update interval", async function () {
        const base = await loadFixture(deployBase);
        const { liqMod } = await launchWithLiquidity(base);
        await expect(
            liqMod.connect(base.signers.user1).setInterval(60 * 60),
        ).to.be.revertedWith("Only creator");
        await expect(liqMod.connect(base.signers.creator).setInterval(60 * 60))
            .to.emit(liqMod, "IntervalUpdated");
    });

    describe("executeLiquidity", function () {
        async function launchWithLiqAndPair(base, opts = {}) {
            // buyFee = 0 avoids the Router-swap tax recursion during executeLiquidity's half-swap.
            return launchTokenWithPair(base, {
                buyFee: 0,
                sellFee: 0,
                modules: (shells) => [{
                    moduleType: MODULE_TYPE.LIQUIDITY,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildLiquidityInitData({
                        token: shells.tokenAddr,
                        database: opts.databaseAddr,
                        liquidityInterval: opts.liquidityInterval ?? 5 * 60,
                    }),
                }],
                initialLiquidity: { tokens: ethers.parseEther("100000"), bnb: ethers.parseEther("10") },
            });
        }

        it("reverts when interval hasn't elapsed", async function () {
            const base = await loadFixture(deployBase);
            const databaseAddr = await base.database.getAddress();
            const { taxHandler } = await launchWithLiqAndPair(base, { databaseAddr });
            const liqMod = await ethers.getContractAt(
                "LiquidityModule",
                (await taxHandler.getModule(0)).moduleAddress,
            );
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            await expect(liqMod.executeLiquidity()).to.be.revertedWith("Interval not elapsed");
        });

        it("swaps half BNB for tokens and locks the pair as V4 vault liquidity", async function () {
            const base = await loadFixture(deployBase);
            const databaseAddr = await base.database.getAddress();
            const { taxHandler, tokenAddr } = await launchWithLiqAndPair(base, { databaseAddr });
            const liqMod = await ethers.getContractAt(
                "LiquidityModule",
                (await taxHandler.getModule(0)).moduleAddress,
            );

            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            await time.increase(6 * 60);

            const lockedBefore = await base.vault.lockedLiquidity(tokenAddr);

            await expect(liqMod.connect(base.signers.keeper).executeLiquidity())
                .to.emit(liqMod, "LiquidityAdded");

            // Liquidity grew in the permanently-locked vault position
            // (the V4-era replacement for "LP tokens to dEaD").
            const lockedAfter = await base.vault.lockedLiquidity(tokenAddr);
            expect(lockedAfter).to.be.gt(lockedBefore);
            expect(await liqMod.totalLPLocked()).to.be.gt(0);
            // Module should have very little BNB left (minor dust is fine)
            expect(await ethers.provider.getBalance(await liqMod.getAddress())).to.be.lt(ethers.parseEther("0.01"));
        });
    });
});
