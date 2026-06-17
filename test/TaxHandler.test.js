const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    buildCreatorFeeInitData,
    MODULE_TYPE,
    CHANGE_TYPE,
} = require("./fixtures/deploy");

const ONE_DAY = 24 * 60 * 60;

// Launch a simple single-module token with CreatorFee @ 100% (sums to 10000).
async function launchWithSingleCreatorFee(base, cfg = {}) {
    const shells = await prepareTokenShells(base);
    const creator = cfg.creator || base.signers.creator;
    const feeRecipient = cfg.creatorFeeRecipient || creator;

    const modules = [
        {
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(feeRecipient.address),
        },
    ];

    await initializeToken(base, shells, {
        name: cfg.name || "Test Token",
        symbol: cfg.symbol || "TEST",
        pair: cfg.pair || base.signers.user3.address, // stand-in pair address
        creator,
        buyFee: cfg.buyFee ?? 500,   // 5% default
        sellFee: cfg.sellFee ?? 500,
        modules,
    });

    return shells;
}

// Launch a three-module token: Reward (BNB-mode) + CreatorFee × 2 (treasuries)
async function launchWithThreeModules(base) {
    const shells = await prepareTokenShells(base);
    const creator = base.signers.creator;
    const treasuryA = base.signers.user2;
    const treasuryB = base.signers.user3;

    // Reward module in BNB mode — no external router needed
    const { buildRewardInitData } = require("./fixtures/deploy");
    const modules = [
        {
            moduleType: MODULE_TYPE.REWARD,
            buyAllocation: 6000,
            sellAllocation: 6000,
            initPayload: buildRewardInitData({
                token: shells.tokenAddr,
            }),
        },
        {
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 3000,
            sellAllocation: 3000,
            initPayload: buildCreatorFeeInitData(treasuryA.address),
        },
        {
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 1000,
            sellAllocation: 1000,
            initPayload: buildCreatorFeeInitData(treasuryB.address),
        },
    ];

    await initializeToken(base, shells, {
        name: "Three Mod",
        symbol: "TM",
        pair: base.signers.keeper.address,
        creator,
        buyFee: 500,
        sellFee: 500,
        modules,
    });

    return { shells, creator, treasuryA, treasuryB };
}

describe("TaxHandler", function () {

    describe("initialization", function () {
        it("rejects fees above MAX_FEE (9800 bps)", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            await expect(
                shells.taxHandler.__init__(
                    shells.tokenAddr,
                    await base.database.getAddress(),
                    base.signers.creator.address,
                    9801,
                    0,
                    [],
                ),
            ).to.be.revertedWith("Fee exceeds max");
        });

        it("rejects empty module set", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            await expect(
                shells.taxHandler.__init__(
                    shells.tokenAddr,
                    await base.database.getAddress(),
                    base.signers.creator.address,
                    500,
                    500,
                    [],
                ),
            ).to.be.revertedWith("Bad module count");
        });

        it("rejects module allocations that don't sum to 10000", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            const modules = [
                {
                    moduleType: MODULE_TYPE.CREATOR,
                    buyAllocation: 9000, // missing 1000
                    sellAllocation: 10000,
                    initPayload: buildCreatorFeeInitData(base.signers.creator.address),
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
            ).to.be.revertedWith("Buy alloc != 10000");
        });

        it("successfully initializes with a single CreatorFee module at 10000/10000", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            expect(await shells.taxHandler.buyFee()).to.equal(500);
            expect(await shells.taxHandler.sellFee()).to.equal(500);
            expect(await shells.taxHandler.getModuleCount()).to.equal(1);
            const mod = await shells.taxHandler.getModule(0);
            expect(mod.moduleType).to.equal(MODULE_TYPE.CREATOR);
            expect(mod.buyAllocation).to.equal(10000);
            expect(mod.sellAllocation).to.equal(10000);
        });

        it("blocks double initialization", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(
                shells.taxHandler.__init__(
                    shells.tokenAddr,
                    await base.database.getAddress(),
                    base.signers.creator.address,
                    500,
                    500,
                    [],
                ),
            ).to.be.revertedWith("Already initialized");
        });
    });

    describe("receiveBuyTax / receiveSellTax distribution", function () {
        it("forwards 100% to a single module", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            // CreatorFeeModule recipient = creator; balance delta checks the forward
            const before = await ethers.provider.getBalance(base.signers.creator.address);
            await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            const after = await ethers.provider.getBalance(base.signers.creator.address);
            expect(after - before).to.equal(ethers.parseEther("1"));
        });

        it("splits correctly across three modules (6000 / 3000 / 1000)", async function () {
            const base = await loadFixture(deployBase);
            const { shells, treasuryA, treasuryB } = await launchWithThreeModules(base);

            // RewardModule is in BNB mode but has no shares set → pendingBNB accumulates.
            // Treasuries should each receive their allocation (3000 and 1000 bps).
            const beforeA = await ethers.provider.getBalance(treasuryA.address);
            const beforeB = await ethers.provider.getBalance(treasuryB.address);

            await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

            const afterA = await ethers.provider.getBalance(treasuryA.address);
            const afterB = await ethers.provider.getBalance(treasuryB.address);

            expect(afterA - beforeA).to.equal(ethers.parseEther("0.3"));
            // Last module receives the remainder to avoid dust; 1 ETH * 1000/10000 = 0.1
            // Here treasuryB is the last module, so it gets the leftover = 1 - 0.6 - 0.3 = 0.1
            expect(afterB - beforeB).to.equal(ethers.parseEther("0.1"));
        });

        it("rejects zero-value tax", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(shells.taxHandler.receiveBuyTax({ value: 0 })).to.be.revertedWith("Zero tax");
            await expect(shells.taxHandler.receiveSellTax({ value: 0 })).to.be.revertedWith("Zero tax");
        });

        it("tracks totals separately for buy vs sell", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await shells.taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
            await shells.taxHandler.receiveSellTax({ value: ethers.parseEther("0.5") });
            expect(await shells.taxHandler.totalBuyTaxReceived()).to.equal(ethers.parseEther("1"));
            expect(await shells.taxHandler.totalSellTaxReceived()).to.equal(ethers.parseEther("0.5"));
        });
    });

    describe("fee change timelock", function () {
        it("applies fee decrease instantly", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(shells.taxHandler.connect(base.signers.creator).proposeFeeChange(200, 300))
                .to.emit(shells.taxHandler, "FeesUpdated")
                .withArgs(500, 200, 500, 300);
            expect(await shells.taxHandler.buyFee()).to.equal(200);
            expect(await shells.taxHandler.sellFee()).to.equal(300);
        });

        it("timelocks fee increases for 24h", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await shells.taxHandler.connect(base.signers.creator).proposeFeeChange(1000, 1000);

            // Not yet elapsed
            await expect(
                shells.taxHandler.connect(base.signers.creator).executeFeeChange(),
            ).to.be.revertedWith("Timelock active");

            // Advance 24h
            await time.increase(ONE_DAY);
            await shells.taxHandler.connect(base.signers.creator).executeFeeChange();
            expect(await shells.taxHandler.buyFee()).to.equal(1000);
            expect(await shells.taxHandler.sellFee()).to.equal(1000);
        });

        it("rejects fee change beyond MAX_FEE", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(
                shells.taxHandler.connect(base.signers.creator).proposeFeeChange(9801, 0),
            ).to.be.revertedWith("Fee exceeds max");
        });

        it("only creator can propose / execute / cancel", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(
                shells.taxHandler.connect(base.signers.user1).proposeFeeChange(200, 200),
            ).to.be.revertedWith("Only creator");
        });

        it("cancel clears the pending change", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await shells.taxHandler.connect(base.signers.creator).proposeFeeChange(1000, 1000);
            await shells.taxHandler.connect(base.signers.creator).cancelFeeChange();
            await expect(
                shells.taxHandler.connect(base.signers.creator).executeFeeChange(),
            ).to.be.revertedWith("No pending change");
        });
    });

    describe("module change timelock — batch proposals", function () {
        it("rejects propose that would leave sum != 10000", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            // Propose update that breaks the sum (0 rebalance)
            await expect(
                shells.taxHandler.connect(creator).proposeModuleUpdate([
                    { moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 },
                ]),
            ).to.be.revertedWith("Buy alloc != 10000");
        });

        it("accepts batch update that balances to 10000", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            // Shift Reward: 6000→5000, compensate by moving 1000 to Treasury A (3000→4000)
            await shells.taxHandler.connect(creator).proposeModuleUpdate([
                { moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 },
                { moduleIndex: 1, buyAllocation: 4000, sellAllocation: 4000 },
            ]);
            await time.increase(ONE_DAY);
            await shells.taxHandler.connect(creator).executeModuleChange();

            const reward = await shells.taxHandler.getModule(0);
            const treasA = await shells.taxHandler.getModule(1);
            expect(reward.buyAllocation).to.equal(5000);
            expect(treasA.buyAllocation).to.equal(4000);
        });

        it("REMOVE with rebalance atomically drops module and redistributes bps", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            // Remove Treasury B (idx 2), move its 1000 bps to Reward
            await shells.taxHandler.connect(creator).proposeModuleRemove(2, [
                { moduleIndex: 0, buyAllocation: 7000, sellAllocation: 7000 },
            ]);
            await time.increase(ONE_DAY);
            await shells.taxHandler.connect(creator).executeModuleChange();

            expect(await shells.taxHandler.getModuleCount()).to.equal(2);
            const reward = await shells.taxHandler.getModule(0);
            expect(reward.buyAllocation).to.equal(7000);
        });

        it("blocks REMOVE of the last remaining module", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(
                shells.taxHandler.connect(base.signers.creator).proposeModuleRemove(0, []),
            ).to.be.revertedWith("Cannot remove last");
        });

        it("blocks rebalance entries targeting the module being removed", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            await expect(
                shells.taxHandler.connect(creator).proposeModuleRemove(2, [
                    { moduleIndex: 2, buyAllocation: 0, sellAllocation: 0 },
                ]),
            ).to.be.revertedWith("Cannot rebalance removed");
        });

        it("ADD with rebalance deploys a new module and frees bps from an existing one", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            // Currently: [CreatorFee = 10000]. Add a second CreatorFee at 3000, reduce first to 7000.
            const newRecipient = base.signers.user1.address;
            const addPayload = buildCreatorFeeInitData(newRecipient);

            await shells.taxHandler.connect(base.signers.creator).proposeModuleAdd(
                MODULE_TYPE.CREATOR,
                3000,
                3000,
                addPayload,
                [{ moduleIndex: 0, buyAllocation: 7000, sellAllocation: 7000 }],
            );
            await time.increase(ONE_DAY);
            await shells.taxHandler.connect(base.signers.creator).executeModuleChange();

            expect(await shells.taxHandler.getModuleCount()).to.equal(2);
            const first = await shells.taxHandler.getModule(0);
            const second = await shells.taxHandler.getModule(1);
            expect(first.buyAllocation).to.equal(7000);
            expect(second.buyAllocation).to.equal(3000);
            expect(second.moduleType).to.equal(MODULE_TYPE.CREATOR);
        });

        it("only one pending module change at a time", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            await shells.taxHandler.connect(creator).proposeModuleUpdate([
                { moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 },
                { moduleIndex: 1, buyAllocation: 4000, sellAllocation: 4000 },
            ]);
            await expect(
                shells.taxHandler.connect(creator).proposeModuleUpdate([
                    { moduleIndex: 0, buyAllocation: 4000, sellAllocation: 4000 },
                    { moduleIndex: 1, buyAllocation: 5000, sellAllocation: 5000 },
                ]),
            ).to.be.revertedWith("Pending exists");
        });

        it("timelock must elapse before execute", async function () {
            const base = await loadFixture(deployBase);
            const { shells, creator } = await launchWithThreeModules(base);
            await shells.taxHandler.connect(creator).proposeModuleUpdate([
                { moduleIndex: 0, buyAllocation: 5000, sellAllocation: 5000 },
                { moduleIndex: 1, buyAllocation: 4000, sellAllocation: 4000 },
            ]);
            await expect(
                shells.taxHandler.connect(creator).executeModuleChange(),
            ).to.be.revertedWith("Timelock active");
        });
    });

    describe("setShare (called by token)", function () {
        it("rejects callers other than the token", async function () {
            const base = await loadFixture(deployBase);
            const shells = await launchWithSingleCreatorFee(base);
            await expect(
                shells.taxHandler.connect(base.signers.user1).setShare(base.signers.user2.address, 100),
            ).to.be.revertedWith("Only token");
        });

        it("is called by LumoriaToken transfers, updating shares on both sides", async function () {
            const base = await loadFixture(deployBase);
            const { shells } = await launchWithThreeModules(base);
            const { owner, user1, user2 } = base.signers;

            // Owner received the full supply on token init; transfer some to user1
            await shells.token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            expect(await shells.taxHandler.shares(user1.address)).to.equal(ethers.parseEther("1000"));

            await shells.token.connect(user1).transfer(user2.address, ethers.parseEther("400"));
            expect(await shells.taxHandler.shares(user1.address)).to.equal(ethers.parseEther("600"));
            expect(await shells.taxHandler.shares(user2.address)).to.equal(ethers.parseEther("400"));
        });
    });
});
