const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    launchTokenWithPair,
    buildRewardInitData,
    buildCreatorFeeInitData,
    MODULE_TYPE,
} = require("../fixtures/deploy");

// RewardModule has two modes:
//  BNB mode (rewardToken = ZERO): testable right now, no external router.
//  Token mode: needs a working external router → Phase 3.

describe("RewardModule (BNB mode)", function () {

    async function launchWithRewardOnly(base, { minDistribution = 0n } = {}) {
        const shells = await prepareTokenShells(base);
        const modules = [
            {
                moduleType: MODULE_TYPE.REWARD,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildRewardInitData({
                    token: shells.tokenAddr,
                    minDistribution,
                }),
            },
        ];
        await initializeToken(base, shells, {
            name: "Reward",
            symbol: "RWD",
            pair: base.signers.user3.address,
            creator: base.signers.creator,
            buyFee: 500,
            sellFee: 500,
            modules,
        });
        const rewardModAddr = (await shells.taxHandler.getModule(0)).moduleAddress;
        const rewardMod = await ethers.getContractAt("RewardModule", rewardModAddr);
        return { ...shells, rewardMod };
    }

    it("initializes with BNB mode flags", async function () {
        const base = await loadFixture(deployBase);
        const { rewardMod } = await launchWithRewardOnly(base);
        expect(await rewardMod.rewardToken()).to.equal(ethers.ZeroAddress);
        expect(await rewardMod.getModuleType()).to.equal(0);
    });

    it("accumulates pendingBNB when no shares exist", async function () {
        const base = await loadFixture(deployBase);
        const { taxHandler, rewardMod } = await launchWithRewardOnly(base, {
            minDistribution: ethers.parseEther("0.01"),
        });
        // No holders have transferred yet → totalSharesTracked == 0
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
        // Module receives BNB but doesn't distribute because there are no shares
        expect(await rewardMod.pendingBNB()).to.equal(ethers.parseEther("1"));
        expect(await rewardMod.dividendsPerShare()).to.equal(0);
    });

    it("distributes dividends pro-rata once holders exist", async function () {
        const base = await loadFixture(deployBase);
        const { owner, user1, user2, creator } = base.signers;
        const { token, taxHandler, rewardMod } = await launchWithRewardOnly(base);

        // Seed holders
        await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
        await token.connect(owner).transfer(user2.address, ethers.parseEther("3000"));

        // Receive tax
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
        // After distribution, user1 and user2 have unpaid rewards in 1:3 ratio of total shares,
        // but owner still holds the bulk of supply so gets most.

        // Compute expected unpaid for user1: user1 shares / totalSharesTracked * 1 BNB
        const user1Unpaid = await rewardMod.getUnpaidRewards(user1.address);
        const user2Unpaid = await rewardMod.getUnpaidRewards(user2.address);
        expect(user2Unpaid).to.equal(user1Unpaid * 3n);
    });

    it("claimReward transfers BNB and resets unpaid", async function () {
        const base = await loadFixture(deployBase);
        const { owner, user1 } = base.signers;
        const { token, taxHandler, rewardMod } = await launchWithRewardOnly(base);

        // user1 gets 10% of supply
        const totalSupply = await token.totalSupply();
        const user1Share = totalSupply / 10n;
        await token.connect(owner).transfer(user1.address, user1Share);

        await taxHandler.receiveBuyTax({ value: ethers.parseEther("10") });

        const unpaid = await rewardMod.getUnpaidRewards(user1.address);
        expect(unpaid).to.be.gt(0);

        const before = await ethers.provider.getBalance(user1.address);
        const tx = await rewardMod.connect(user1).claimReward();
        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;
        const after = await ethers.provider.getBalance(user1.address);

        expect(after - before + gasCost).to.equal(unpaid);
        expect(await rewardMod.getUnpaidRewards(user1.address)).to.equal(0);
    });

    it("share changes crystallize prior dividends before updating", async function () {
        const base = await loadFixture(deployBase);
        const { owner, user1 } = base.signers;
        const { token, taxHandler, rewardMod } = await launchWithRewardOnly(base);

        // user1 gets some tokens, tax is received, user1 transfers away,
        // should still be entitled to the crystallized portion.
        await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });
        const unpaidBefore = await rewardMod.getUnpaidRewards(user1.address);

        await token.connect(user1).transfer(base.signers.user2.address, ethers.parseEther("1000"));
        const unpaidAfter = await rewardMod.getUnpaidRewards(user1.address);
        expect(unpaidAfter).to.equal(unpaidBefore);
    });
});

describe("RewardModule (token mode)", function () {
    // Use a second Lumoria token as the reward asset. Our Router implements the
    // same V2-like swap signature the RewardModule expects, so we can use it as
    // the "external" router in tests. The reward token's buy fee is set to 0 so
    // only the 1% platform fee applies to each swap.

    async function launchRewardedToken(base) {
        // 1. Launch the REWARD token (what holders of the main token will receive).
        const rewardLaunch = await launchTokenWithPair(base, {
            name: "Reward",
            symbol: "RWD",
            buyFee: 0,
            sellFee: 0,
            modules: (s) => [{
                moduleType: MODULE_TYPE.CREATOR,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildCreatorFeeInitData(base.signers.creator.address),
            }],
            initialLiquidity: { tokens: ethers.parseEther("100000"), bnb: ethers.parseEther("10") },
        });
        const rewardTokenAddr = rewardLaunch.tokenAddr;

        // 2. Launch the MAIN token with a RewardModule that swaps BNB → rewardToken.
        const shells = await prepareTokenShells(base);
        const routerAddr = await base.router.getAddress();
        const wbnbAddr = await base.wbnb.getAddress();

        const modules = [{
            moduleType: MODULE_TYPE.REWARD,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildRewardInitData({
                token: shells.tokenAddr,
                rewardToken: rewardTokenAddr,
                externalRouter: routerAddr,
                externalWBNB: wbnbAddr,
                minDistribution: ethers.parseEther("0.01"),
            }),
        }];

        await initializeToken(base, shells, {
            name: "Main",
            symbol: "MAIN",
            pair: base.signers.keeper.address, // dummy (main token's pair isn't used in this test)
            creator: base.signers.creator,
            buyFee: 0,
            sellFee: 0,
            modules,
        });

        const rewardModAddr = (await shells.taxHandler.getModule(0)).moduleAddress;
        const rewardMod = await ethers.getContractAt("RewardModule", rewardModAddr);
        const rewardToken = await ethers.getContractAt("LumoriaToken", rewardTokenAddr);

        return { ...shells, rewardMod, rewardToken, rewardTokenAddr };
    }

    it("swaps received BNB tax into reward token and distributes", async function () {
        const base = await loadFixture(deployBase);
        const { token, taxHandler, rewardMod, rewardToken } = await launchRewardedToken(base);
        const { owner, user1 } = base.signers;

        // Seed user1 with main-token shares
        await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));

        // Send tax BNB → TaxHandler → RewardModule → swap → reward token distributed pro-rata
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("1") });

        // User should have a positive unpaid reward balance in rewardToken units
        const unpaid = await rewardMod.getUnpaidRewards(user1.address);
        expect(unpaid).to.be.gt(0);

        // Distribute counter reflects the swapped reward amount (not the BNB spent)
        expect(await rewardMod.totalDividendsDistributed()).to.be.gt(0);

        // User can claim and ends up with reward token
        const rewardBefore = await rewardToken.balanceOf(user1.address);
        await rewardMod.connect(user1).claimReward();
        const rewardAfter = await rewardToken.balanceOf(user1.address);
        expect(rewardAfter - rewardBefore).to.equal(unpaid);
    });

    it("accumulates BNB below minDistribution and distributes when threshold met", async function () {
        const base = await loadFixture(deployBase);
        const { token, taxHandler, rewardMod } = await launchRewardedToken(base);
        const { owner, user1 } = base.signers;

        await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));

        // Small BNB transfers below minDistribution (0.01) → should just accumulate
        // NOTE: min is on BNB balance, not pendingBNB (that's BNB-mode only). So
        // we send tax below threshold and verify no distribution happens.
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("0.005") });
        expect(await rewardMod.totalDividendsDistributed()).to.equal(0);

        // Top up to cross the threshold
        await taxHandler.receiveBuyTax({ value: ethers.parseEther("0.01") });
        expect(await rewardMod.totalDividendsDistributed()).to.be.gt(0);
    });
});
