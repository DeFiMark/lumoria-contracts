const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    useRealGenerator,
    buildCreatorFeeInitData,
    encodeFlatCurvePayload,
    MODULE_TYPE,
    LAUNCH_MODE,
} = require("./fixtures/deploy");

const TOTAL_SUPPLY = ethers.parseEther("1000000000");
const DEAD = "0x000000000000000000000000000000000000dEaD";

function randomSalt() {
    return ethers.hexlify(ethers.randomBytes(32));
}

function singleCreatorFeeModule(creatorAddr) {
    return [{
        moduleType: MODULE_TYPE.CREATOR,
        buyAllocation: 10000,
        sellAllocation: 10000,
        initPayload: buildCreatorFeeInitData(creatorAddr),
    }];
}

async function launchFlatCurve(base, overrides = {}) {
    const { creator } = base.signers;
    const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);

    const cfg = {
        hardCap: ethers.parseEther("10"),
        minContribution: ethers.parseEther("0.1"),
        maxContribution: ethers.parseEther("5"),
        tokensForPresale: ethers.parseEther("400000000"),
        tokensForLP: ethers.parseEther("500000000"),
        liquidityBps: 8000,
        creatorBps: 2000,
        startTime: now + 1,
        endTime: now + 3600,
        ...overrides,
    };
    const payload = encodeFlatCurvePayload(cfg);

    const salt = randomSalt();
    const tx = await base.generator.connect(creator).generateProject(
        "FCLaunch", "FCL", 0, 0,
        singleCreatorFeeModule(creator.address),
        LAUNCH_MODE.FLAT_CURVE,
        payload,
        [],
        salt,
    );
    const receipt = await tx.wait();

    const tokenAddr = await base.generator.predictTokenAddress(salt);
    const token = await ethers.getContractAt("LumoriaToken", tokenAddr);

    const log = receipt.logs.find(l => {
        try {
            const p = base.generator.interface.parseLog(l);
            return p && p.name === "FlatCurveLaunched";
        } catch { return false; }
    });
    const parsed = base.generator.interface.parseLog(log);
    const flatCurve = await ethers.getContractAt("FlatCurve", parsed.args.flatCurve);

    return { token, tokenAddr, flatCurve, flatCurveAddr: parsed.args.flatCurve, cfg };
}

describe("FlatCurve", function () {

    describe("initialization validation", function () {
        it("rejects endTime <= startTime", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);
            await expect(launchFlatCurve(base, { startTime: now + 1000, endTime: now + 100 }))
                .to.be.revertedWith("FlatCurve: bad window");
        });

        it("rejects bps that don't sum to 10000", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            await expect(launchFlatCurve(base, { liquidityBps: 7000, creatorBps: 2000 }))
                .to.be.revertedWith("FlatCurve: bps sum != 10000");
        });

        it("rejects maxContribution > hardCap", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            await expect(
                launchFlatCurve(base, { maxContribution: ethers.parseEther("50") }),
            ).to.be.revertedWith("FlatCurve: max > hardCap");
        });
    });

    describe("contribute", function () {
        it("reverts before startTime", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);
            const { flatCurve } = await launchFlatCurve(base, {
                startTime: now + 3600, endTime: now + 7200,
            });
            await expect(
                flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("1") }),
            ).to.be.revertedWith("FlatCurve: not started");
        });

        it("reverts after endTime", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve, cfg } = await launchFlatCurve(base);
            await time.increaseTo(cfg.endTime + 1);
            await expect(
                flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("1") }),
            ).to.be.revertedWith("FlatCurve: ended");
        });

        it("takes 1% platform fee, credits net contribution", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve, tokenAddr } = await launchFlatCurve(base);
            await time.increase(2);
            const feeBefore = await base.feeReceiver.totalReceived();

            await flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("1") });

            // 1% fee = 0.01 BNB
            const feeAfter = await base.feeReceiver.totalReceived();
            expect(feeAfter - feeBefore).to.equal(ethers.parseEther("0.01"));
            expect(await base.feeReceiver.feesByToken(tokenAddr)).to.equal(ethers.parseEther("0.01"));

            // User's net contribution = 0.99 BNB
            expect(await flatCurve.contributions(base.signers.user1.address)).to.equal(ethers.parseEther("0.99"));
            expect(await flatCurve.totalRaised()).to.equal(ethers.parseEther("0.99"));
        });

        it("rejects below minContribution", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base);
            await time.increase(2);
            // Net of 0.09 BNB would be below 0.1 BNB min
            await expect(
                flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("0.1") }),
            ).to.be.revertedWith("FlatCurve: below min");
        });

        it("rejects exceeding maxContribution (cumulative)", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base);
            await time.increase(2);
            // 5 BNB gross → 4.95 net, under the 5 BNB max
            await flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("5") });
            // Another 1 BNB → would push them over 5 BNB net
            await expect(
                flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("1") }),
            ).to.be.revertedWith("FlatCurve: exceeds max");
        });
    });

    describe("refund (pre-launch)", function () {
        it("returns net contribution and decrements totalRaised", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base);
            await time.increase(2);
            const { user1 } = base.signers;

            await flatCurve.connect(user1).contribute({ value: ethers.parseEther("1") });
            const beforeBal = await ethers.provider.getBalance(user1.address);

            const tx = await flatCurve.connect(user1).refund();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const afterBal = await ethers.provider.getBalance(user1.address);

            // Refund is NET (0.99), original 1% fee was non-refundable
            expect(afterBal - beforeBal + gasCost).to.equal(ethers.parseEther("0.99"));
            expect(await flatCurve.totalRaised()).to.equal(0);
            expect(await flatCurve.contributions(user1.address)).to.equal(0);
        });
    });

    describe("launch (success path)", function () {
        // Pick a hardCap that's exactly hit by clean-math contributions:
        // two users at 1 BNB gross each → 0.99 net each → 1.98 totalRaised.
        const CLEAN_CFG = {
            hardCap: ethers.parseEther("1.98"),
            maxContribution: ethers.parseEther("1"),  // net 0.99 per user
        };

        it("anyone can launch once hardCap is met; adds LP, sends creator share, makes tokens claimable", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve, tokenAddr, token, cfg } = await launchFlatCurve(base, CLEAN_CFG);
            const { user1, user2, creator, keeper } = base.signers;

            await time.increase(2);
            await flatCurve.connect(user1).contribute({ value: ethers.parseEther("1") });
            await flatCurve.connect(user2).contribute({ value: ethers.parseEther("1") });
            const totalRaised = await flatCurve.totalRaised();
            expect(totalRaised).to.equal(cfg.hardCap);

            const creatorBnbBefore = await ethers.provider.getBalance(creator.address);

            await expect(flatCurve.connect(keeper).launch())
                .to.emit(flatCurve, "RaiseLaunched");

            expect(await flatCurve.launched()).to.equal(true);
            expect(await flatCurve.failed()).to.equal(false);

            // V4 pool seeded with permanently-locked liquidity in the vault,
            // and the PoolManager custodies the reserves.
            expect(await base.vault.lockedLiquidity(tokenAddr)).to.be.gt(0);
            expect(await base.vault.totalBnbLocked(tokenAddr)).to.be.gt(0);
            expect(await token.balanceOf(await base.poolManager.getAddress())).to.be.gt(0);

            // Creator got BNB (20% of raised)
            const creatorBnbAfter = await ethers.provider.getBalance(creator.address);
            expect(creatorBnbAfter).to.be.gt(creatorBnbBefore);

            // Pro-rata claim: each user's share == 50% of tokensForPresale
            const u1Contribution = await flatCurve.contributions(user1.address);
            const expectedU1Tokens = (u1Contribution * cfg.tokensForPresale) / totalRaised;
            await flatCurve.connect(user1).claim();
            expect(await token.balanceOf(user1.address)).to.equal(expectedU1Tokens);
        });

        it("blocks launch before hardCap met if still within raise window", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base);
            await time.increase(2);
            await flatCurve.connect(base.signers.user1).contribute({ value: ethers.parseEther("1") });
            await expect(flatCurve.launch()).to.be.revertedWith("FlatCurve: still active");
        });

        it("blocks contribute/refund after launch", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base, CLEAN_CFG);
            const { user1, user2 } = base.signers;
            await time.increase(2);
            await flatCurve.connect(user1).contribute({ value: ethers.parseEther("1") });
            await flatCurve.connect(user2).contribute({ value: ethers.parseEther("1") });
            await flatCurve.launch();

            await expect(
                flatCurve.connect(user1).contribute({ value: ethers.parseEther("0.1") }),
            ).to.be.revertedWith("FlatCurve: finalized");
            await expect(flatCurve.connect(user1).refund()).to.be.revertedWith("FlatCurve: finalized");
        });

        it("prevents double-claim", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve } = await launchFlatCurve(base, CLEAN_CFG);
            const { user1, user2 } = base.signers;
            await time.increase(2);
            await flatCurve.connect(user1).contribute({ value: ethers.parseEther("1") });
            await flatCurve.connect(user2).contribute({ value: ethers.parseEther("1") });
            await flatCurve.launch();

            await flatCurve.connect(user1).claim();
            await expect(flatCurve.connect(user1).claim()).to.be.revertedWith("FlatCurve: already claimed");
        });
    });

    describe("launch (failure path)", function () {
        it("marks failed after endTime with hardCap unmet, enables withdrawOnFailure", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { flatCurve, cfg } = await launchFlatCurve(base);
            const { user1, user2 } = base.signers;

            await time.increase(2);
            await flatCurve.connect(user1).contribute({ value: ethers.parseEther("1") });
            await flatCurve.connect(user2).contribute({ value: ethers.parseEther("2") });

            // Skip to after endTime
            await time.increaseTo(cfg.endTime + 1);

            // Anyone can call launch → triggers failure branch
            await expect(flatCurve.connect(base.signers.keeper).launch())
                .to.emit(flatCurve, "RaiseFailed");
            expect(await flatCurve.failed()).to.equal(true);
            expect(await flatCurve.launched()).to.equal(false);

            // User1 can withdrawOnFailure
            const beforeBal = await ethers.provider.getBalance(user1.address);
            const tx = await flatCurve.connect(user1).withdrawOnFailure();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const afterBal = await ethers.provider.getBalance(user1.address);
            expect(afterBal - beforeBal + gasCost).to.equal(ethers.parseEther("0.99"));

            // Can't withdraw twice
            await expect(
                flatCurve.connect(user1).withdrawOnFailure(),
            ).to.be.revertedWith("FlatCurve: nothing to withdraw");

            // Claim is disabled on failure path
            await expect(flatCurve.connect(user2).claim()).to.be.revertedWith("FlatCurve: not launched");
        });
    });
});
