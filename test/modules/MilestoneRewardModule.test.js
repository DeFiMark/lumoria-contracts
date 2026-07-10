// MilestoneRewardModule (type 5) — accrue tax, creator releases to ALL holders.
//
// The load-bearing property under test: the contract has EXACTLY ONE
// value-moving call, and its target is the token's RewardModule — never a
// parameter. The creator's discretion is over timing and amount, never
// destination. After 18 months with no release, `publicRelease` opens the
// full balance to anyone — still only into the RewardModule.
//
// See docs/TOKENOMICS_V2.md §2B and MODULE_BUILD_HANDOFF.md §5 (B1).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    launchTokenWithPool,
    buildMilestoneInitData,
    buildRewardInitData,
    MODULE_TYPE,
} = require("../fixtures/deploy");

const E = ethers.parseEther;
const PUBLIC_RELEASE_DELAY = 540 * 24 * 60 * 60; // 18 months, mirrors the contract

// Launch a token whose tax is split between a RewardModule (BNB mode) and a
// MilestoneRewardModule. Returns both module handles.
async function launchWithMilestone(base, { milestoneBps = 5000 } = {}) {
    const rewardBps = 10000 - milestoneBps;
    const launched = await launchTokenWithPool(base, {
        creator: base.signers.creator,
        modules: (shells) => [
            {
                moduleType: MODULE_TYPE.REWARD,
                buyAllocation: rewardBps,
                sellAllocation: rewardBps,
                initPayload: buildRewardInitData({ token: shells.tokenAddr }),
            },
            {
                moduleType: MODULE_TYPE.MILESTONE,
                buyAllocation: milestoneBps,
                sellAllocation: milestoneBps,
                initPayload: buildMilestoneInitData({ token: shells.tokenAddr }),
            },
        ],
    });

    const rewardCfg = await launched.taxHandler.getModule(0);
    const milestoneCfg = await launched.taxHandler.getModule(1);
    const rewardMod = await ethers.getContractAt("RewardModule", rewardCfg.moduleAddress);
    const milestone = await ethers.getContractAt("MilestoneRewardModule", milestoneCfg.moduleAddress);
    return { ...launched, rewardMod, milestone };
}

// Milestone-only launch — the "no RewardModule" configuration the launch
// wizard must prevent but the contract must survive.
async function launchMilestoneOnly(base) {
    const launched = await launchTokenWithPool(base, {
        creator: base.signers.creator,
        modules: (shells) => [
            {
                moduleType: MODULE_TYPE.MILESTONE,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildMilestoneInitData({ token: shells.tokenAddr }),
            },
        ],
    });
    const cfg = await launched.taxHandler.getModule(0);
    const milestone = await ethers.getContractAt("MilestoneRewardModule", cfg.moduleAddress);
    return { ...launched, milestone };
}

// Fund the milestone module by pushing tax through the TaxHandler, exactly
// as the hook would.
async function fundViaTax(launched, bnb) {
    await launched.taxHandler.receiveBuyTax({ value: bnb });
}

describe("MilestoneRewardModule", function () {

    describe("initialization", function () {
        it("stores taxHandler from msg.sender and the token from the payload", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            expect(await l.milestone.taxHandler()).to.equal(l.taxHandlerAddr);
            expect(await l.milestone.token()).to.equal(l.tokenAddr);
        });

        it("reports module type 5", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            expect(await l.milestone.getModuleType()).to.equal(5);
        });

        it("cannot be initialized twice", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await expect(
                l.milestone.__init__(buildMilestoneInitData({ token: l.tokenAddr })),
            ).to.be.revertedWith("Already initialized");
        });

        it("rejects a zero token", async function () {
            const MilestoneRewardModule =
                await ethers.getContractFactory("MilestoneRewardModule");
            const fresh = await MilestoneRewardModule.deploy();
            await expect(
                fresh.__init__(buildMilestoneInitData({ token: ethers.ZeroAddress })),
            ).to.be.revertedWith("Zero token");
        });

        it("starts the 18-month clock at init", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            const now = (await ethers.provider.getBlock("latest")).timestamp;
            const releaseAt = await l.milestone.publicReleaseAt();
            expect(releaseAt).to.be.closeTo(BigInt(now + PUBLIC_RELEASE_DELAY), 30n);
        });
    });

    describe("receiveTax", function () {
        it("accrues from the TaxHandler and emits TaxReceived", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await expect(l.taxHandler.receiveBuyTax({ value: E("2") }))
                .to.emit(l.milestone, "TaxReceived")
                .withArgs(E("1"), E("1")); // 5000 bps of 2 BNB
            expect(await ethers.provider.getBalance(l.milestone)).to.equal(E("1"));
            expect(await l.milestone.totalAccrued()).to.equal(E("1"));
        });

        it("rejects direct callers", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await expect(
                l.milestone.connect(base.signers.user1).receiveTax({ value: E("1") }),
            ).to.be.revertedWith("Only taxHandler");
        });

        it("survives a real V4 buy AND sell — the swap-path invariant", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            const { user1 } = base.signers;

            // Seed a real pool so the hook drives receiveTax inside the swap callback.
            await l.token.connect(base.signers.owner).approve(base.router, E("100000000"));
            await base.router.connect(base.signers.owner).addLiquidityETH(
                l.tokenAddr, E("100000000"), 0, 0, base.signers.owner.address,
                (await ethers.provider.getBlock("latest")).timestamp + 3600,
                { value: E("50") },
            );

            const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
            await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0, [ethers.ZeroAddress, l.tokenAddr], user1.address, deadline,
                { value: E("1") },
            );
            expect(await ethers.provider.getBalance(l.milestone)).to.be.gt(0n);

            const tokens = await l.token.balanceOf(user1.address);
            await l.token.connect(user1).approve(base.router, tokens);
            await base.router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
                tokens, 0, [l.tokenAddr, ethers.ZeroAddress], user1.address, deadline,
            );
        });
    });

    describe("releaseRewards", function () {
        it("reverts for anyone but the creator", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("2"));
            await expect(
                l.milestone.connect(base.signers.user1).releaseRewards(E("1"), "gm"),
            ).to.be.revertedWith("Only creator");
        });

        it("reverts on amount == 0 and amount > balance", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("2")); // module holds 1 BNB
            const creator = base.signers.creator;
            await expect(
                l.milestone.connect(creator).releaseRewards(0, "zero"),
            ).to.be.revertedWith("Bad amount");
            await expect(
                l.milestone.connect(creator).releaseRewards(E("1") + 1n, "too much"),
            ).to.be.revertedWith("Bad amount");
        });

        it("reverts with 'No reward module' when the token has none", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchMilestoneOnly(base);
            await fundViaTax(l, E("1"));
            await expect(
                l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "1k holders"),
            ).to.be.revertedWith("No reward module");
        });

        it("donates to the RewardModule and records the reason on-chain", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4")); // milestone holds 2

            // Give user1 the entire supply so shares exist to distribute against.
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            const rmAddr = await l.rewardMod.getAddress();
            await expect(
                l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "1,000 holders"),
            )
                .to.emit(l.milestone, "RewardsReleased")
                .withArgs(base.signers.creator.address, rmAddr, E("1"), E("1"), "1,000 holders")
                .and.to.emit(l.rewardMod, "Donated")
                .withArgs(await l.milestone.getAddress(), E("1"));

            expect(await l.milestone.totalReleased()).to.equal(E("1"));
            expect(await ethers.provider.getBalance(l.milestone)).to.equal(E("1"));
        });

        it("a full-supply holder can claim essentially the whole release; excluded system contracts get nothing", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));

            const { owner, user1 } = base.signers;
            const supply = await l.token.balanceOf(owner.address);
            await l.token.connect(owner).transfer(user1.address, supply);

            await l.milestone.connect(base.signers.creator).releaseRewards(E("2"), "TGE");

            // user1 holds ~the full tracked share set → gets ~everything.
            // (The tax that flowed to the RewardModule directly is included too.)
            const unpaid = await l.rewardMod.getUnpaidRewards(user1.address);
            expect(unpaid).to.be.closeTo(E("4"), E("0.000001")); // 2 tax + 2 released

            // Excluded system contracts accrue nothing.
            expect(await l.rewardMod.getUnpaidRewards(await base.rebate.getAddress())).to.equal(0n);
            expect(await l.rewardMod.getUnpaidRewards(await base.vestingVault.getAddress())).to.equal(0n);
            expect(await l.rewardMod.getUnpaidRewards(await l.milestone.getAddress())).to.equal(0n);

            const before = await ethers.provider.getBalance(user1.address);
            const tx = await l.rewardMod.connect(user1).claimReward();
            const receipt = await tx.wait();
            const gas = receipt.gasUsed * receipt.gasPrice;
            const after = await ethers.provider.getBalance(user1.address);
            expect(after - before + gas).to.equal(unpaid);
        });

        it("partial releases are the norm — the balance keeps accruing after one", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            await l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "20% at 1k holders");
            await fundViaTax(l, E("2"));
            expect(await ethers.provider.getBalance(l.milestone)).to.equal(E("2"));
            expect(await l.milestone.totalAccrued()).to.equal(E("3"));
            expect(await l.milestone.totalReleased()).to.equal(E("1"));
        });

        it("still works after renounceManagement — creator is fixed at launch", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("2"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            await l.taxHandler.connect(base.signers.creator).renounceManagement();
            await expect(
                l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "post-renounce"),
            ).to.emit(l.milestone, "RewardsReleased");
        });
    });

    describe("the destination lock — no extraction route exists", function () {
        it("the ABI exposes no withdraw, sweep, recipient, or owner surface", async function () {
            // The auditor's grep, as a test. Every externally-callable function is
            // on this allowlist; anything new must be reviewed against §2B.2
            // before it lands here.
            const allowed = new Set([
                "__init__",
                "receiveTax",
                "releaseRewards",
                "publicRelease",
                // views
                "taxHandler", "token", "totalAccrued", "totalReleased",
                "lastReleaseTime", "publicReleaseAt", "PUBLIC_RELEASE_DELAY",
                "getModuleType", "getStats",
            ]);
            const iface = (await ethers.getContractFactory("MilestoneRewardModule")).interface;
            iface.forEachFunction((fn) => {
                expect(allowed.has(fn.name), `unexpected external function: ${fn.name}`).to.be.true;
            });
        });

        it("the creator's balance only ever goes DOWN when releasing", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            const creator = base.signers.creator;
            const before = await ethers.provider.getBalance(creator.address);
            const tx = await l.milestone.connect(creator).releaseRewards(E("2"), "drain attempt");
            const receipt = await tx.wait();
            const after = await ethers.provider.getBalance(creator.address);
            expect(after).to.equal(before - receipt.gasUsed * receipt.gasPrice);
        });

        it("a malicious reason string is inert data", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("2"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            const evil = " ".repeat(64) + '"><script>alert(1)</script>' + "0x" + "ff".repeat(64);
            await expect(
                l.milestone.connect(base.signers.creator).releaseRewards(E("1"), evil),
            ).to.emit(l.milestone, "RewardsReleased");
            expect(await ethers.provider.getBalance(l.milestone)).to.equal(0n);
        });
    });

    describe("the 18-month public valve", function () {
        it("publicRelease reverts inside the creator window", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("2"));
            await expect(
                l.milestone.connect(base.signers.user3).publicRelease(),
            ).to.be.revertedWith("Creator window");

            await time.increase(PUBLIC_RELEASE_DELAY - 3600);
            await expect(
                l.milestone.connect(base.signers.user3).publicRelease(),
            ).to.be.revertedWith("Creator window");
        });

        it("after 18 months of inactivity anyone can release — the FULL balance, still only into the RewardModule", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            await time.increase(PUBLIC_RELEASE_DELAY + 1);

            const rmAddr = await l.rewardMod.getAddress();
            const stranger = base.signers.user3;
            const before = await ethers.provider.getBalance(stranger.address);
            const tx = await l.milestone.connect(stranger).publicRelease();
            const receipt = await tx.wait();

            await expect(tx)
                .to.emit(l.milestone, "RewardsReleased")
                .withArgs(stranger.address, rmAddr, E("2"), 0n, "18-month public release");
            expect(await ethers.provider.getBalance(l.milestone)).to.equal(0n);

            // The caller gained nothing but the gas bill.
            const after = await ethers.provider.getBalance(stranger.address);
            expect(after).to.equal(before - receipt.gasUsed * receipt.gasPrice);
        });

        it("a creator release resets the clock", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            await time.increase(PUBLIC_RELEASE_DELAY - 3600);
            await l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "still here");

            // Past the ORIGINAL deadline, but the clock restarted an hour ago.
            await time.increase(7200);
            await expect(
                l.milestone.connect(base.signers.user3).publicRelease(),
            ).to.be.revertedWith("Creator window");

            // A full new window later it opens again.
            await time.increase(PUBLIC_RELEASE_DELAY);
            await expect(l.milestone.connect(base.signers.user3).publicRelease())
                .to.emit(l.milestone, "RewardsReleased");
        });

        it("a public release restarts the clock too", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);

            await time.increase(PUBLIC_RELEASE_DELAY + 1);
            await l.milestone.connect(base.signers.user3).publicRelease();

            await fundViaTax(l, E("2"));
            await expect(
                l.milestone.connect(base.signers.user3).publicRelease(),
            ).to.be.revertedWith("Creator window");
        });

        it("publicRelease with nothing accrued reverts rather than resetting the clock", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await time.increase(PUBLIC_RELEASE_DELAY + 1);
            await expect(
                l.milestone.connect(base.signers.user3).publicRelease(),
            ).to.be.revertedWith("Bad amount");
        });
    });

    describe("getStats", function () {
        it("encodes (totalAccrued, totalReleased, balance, lastReleaseTime)", async function () {
            const base = await loadFixture(deployBase);
            const l = await launchWithMilestone(base);
            await fundViaTax(l, E("4"));
            const supply = await l.token.balanceOf(base.signers.owner.address);
            await l.token.connect(base.signers.owner).transfer(base.signers.user1.address, supply);
            await l.milestone.connect(base.signers.creator).releaseRewards(E("1"), "x");

            const [accrued, released, balance, lastRelease] =
                ethers.AbiCoder.defaultAbiCoder().decode(
                    ["uint256", "uint256", "uint256", "uint256"],
                    await l.milestone.getStats(),
                );
            expect(accrued).to.equal(E("2"));
            expect(released).to.equal(E("1"));
            expect(balance).to.equal(E("1"));
            expect(lastRelease).to.equal(await l.milestone.lastReleaseTime());
        });
    });
});
