const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    launchTokenWithPair,
    buildBurnInitData,
    MODULE_TYPE,
} = require("../fixtures/deploy");

const DEADLINE = () => Math.floor(Date.now() / 1000) + 3600;

// BurnModule's executeBurn needs a working Lumoria Router + pair to swap
// BNB → token. Those land in Phase 3. Until then we test:
//   - Initialization guards + interval floor
//   - receiveTax accepts only from taxHandler
//   - setInterval access control
// The end-to-end burn flow is stubbed below with TODO markers.

describe("BurnModule", function () {

    async function launchWithBurn(base, { burnInterval = 5 * 60 } = {}) {
        const shells = await prepareTokenShells(base);
        const modules = [
            {
                moduleType: MODULE_TYPE.BURN,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildBurnInitData({
                    token: shells.tokenAddr,
                    database: await base.database.getAddress(),
                    burnInterval,
                }),
            },
        ];
        await initializeToken(base, shells, {
            name: "Burn",
            symbol: "BRN",
            pair: base.signers.user3.address,
            creator: base.signers.creator,
            buyFee: 500,
            sellFee: 500,
            modules,
        });
        const burnModAddr = (await shells.taxHandler.getModule(0)).moduleAddress;
        const burnMod = await ethers.getContractAt("BurnModule", burnModAddr);
        return { ...shells, burnMod };
    }

    describe("initialization", function () {
        it("rejects interval below MIN_INTERVAL (5 min)", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            const modules = [
                {
                    moduleType: MODULE_TYPE.BURN,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildBurnInitData({
                        token: shells.tokenAddr,
                        database: await base.database.getAddress(),
                        burnInterval: 60, // 1 min — below floor
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
            ).to.be.reverted; // propagated from BurnModule.__init__
        });

        it("stores config correctly", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod, taxHandler, taxHandlerAddr } = await launchWithBurn(base);
            expect(await burnMod.taxHandler()).to.equal(taxHandlerAddr);
            expect(await burnMod.burnInterval()).to.equal(5 * 60);
            expect(await burnMod.getModuleType()).to.equal(1);
        });
    });

    describe("receiveTax", function () {
        it("only taxHandler can send BNB in", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await expect(
                burnMod.connect(base.signers.user1).receiveTax({ value: ethers.parseEther("1") }),
            ).to.be.revertedWith("Only taxHandler");
        });

        it("accumulates BNB in the module", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod, taxHandler } = await launchWithBurn(base);
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            const modBalance = await ethers.provider.getBalance(await burnMod.getAddress());
            expect(modBalance).to.equal(ethers.parseEther("1"));
        });
    });

    describe("setInterval", function () {
        it("only creator can change interval", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await expect(
                burnMod.connect(base.signers.user1).setInterval(60 * 60),
            ).to.be.revertedWith("Only creator");
        });

        it("rejects interval below MIN_INTERVAL", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await expect(
                burnMod.connect(base.signers.creator).setInterval(60),
            ).to.be.revertedWith("Interval too short");
        });

        it("creator can update interval", async function () {
            const base = await loadFixture(deployBase);
            const { burnMod } = await launchWithBurn(base);
            await expect(burnMod.connect(base.signers.creator).setInterval(60 * 60))
                .to.emit(burnMod, "IntervalUpdated")
                .withArgs(5 * 60, 60 * 60);
        });
    });

    describe("executeBurn", function () {
        async function launchWithBurnAndPair(base, opts = {}) {
            // buyFee = 0 isolates this test from the tax-recursion flywheel:
            // if the module pays a buy tax on its own buyback, that tax loops
            // back through TaxHandler → module. We test the core burn mechanic
            // here; the flywheel is a Router integration concern.
            return launchTokenWithPair(base, {
                buyFee: 0,
                sellFee: 0,
                modules: (shells) => [{
                    moduleType: MODULE_TYPE.BURN,
                    buyAllocation: 10000,
                    sellAllocation: 10000,
                    initPayload: buildBurnInitData({
                        token: shells.tokenAddr,
                        database: opts.databaseAddr,
                        burnInterval: opts.burnInterval ?? 5 * 60,
                    }),
                }],
                initialLiquidity: { tokens: ethers.parseEther("100000"), bnb: ethers.parseEther("10") },
            });
        }

        it("reverts when interval hasn't elapsed", async function () {
            const base = await loadFixture(deployBase);
            const databaseAddr = await base.database.getAddress();
            const { taxHandler } = await launchWithBurnAndPair(base, { databaseAddr });
            const burnMod = await ethers.getContractAt(
                "BurnModule",
                (await taxHandler.getModule(0)).moduleAddress,
            );
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            // burnInterval is 5 min; lastBurnTime = deploy timestamp. Not elapsed yet.
            await expect(burnMod.executeBurn()).to.be.revertedWith("Interval not elapsed");
        });

        it("swaps BNB for tokens and burns them, reducing totalSupply", async function () {
            const base = await loadFixture(deployBase);
            const databaseAddr = await base.database.getAddress();
            const { taxHandler, token, tokenAddr } = await launchWithBurnAndPair(base, { databaseAddr });
            const burnMod = await ethers.getContractAt(
                "BurnModule",
                (await taxHandler.getModule(0)).moduleAddress,
            );

            // Send tax BNB to the module
            await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            const modBnb = await ethers.provider.getBalance(await burnMod.getAddress());
            expect(modBnb).to.equal(ethers.parseEther("1"));

            // Advance past interval
            await time.increase(6 * 60);

            const supplyBefore = await token.totalSupply();

            // Anyone can trigger
            await expect(burnMod.connect(base.signers.keeper).executeBurn())
                .to.emit(burnMod, "BurnExecuted");

            const supplyAfter = await token.totalSupply();
            expect(supplyAfter).to.be.lt(supplyBefore);
            expect(await burnMod.totalBurned()).to.be.gt(0);
            expect(await burnMod.totalBNBSpent()).to.equal(ethers.parseEther("1"));
            // Burn module should have ~0 BNB after the swap (possibly dust)
            expect(await ethers.provider.getBalance(await burnMod.getAddress())).to.be.lt(ethers.parseEther("0.001"));
        });
    });
});
