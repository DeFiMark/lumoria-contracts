const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    launchTokenWithPool,
    buildCreatorFeeInitData,
    MODULE_TYPE,
} = require("./fixtures/deploy");

function singleCreatorFeeModule(creatorAddr) {
    return [{
        moduleType: MODULE_TYPE.CREATOR,
        buyAllocation: 10000,
        sellAllocation: 10000,
        initPayload: buildCreatorFeeInitData(creatorAddr),
    }];
}

describe("VestingVault", function () {
    const DAY = 24 * 3600;
    const YEAR = 365 * DAY;

    // Launch a token (owner holds the full supply via the manual-dance fixture),
    // move `amount` into the vault, and create a schedule. The default fixture
    // sets `owner` as the Generator stand-in, so `owner` is authorized to call
    // createSchedule directly.
    async function setupSchedule(base, { beneficiary, amount, cliff, duration }) {
        const { owner, creator } = base.signers;
        const launched = await launchTokenWithPool(base, {
            name: "Vest", symbol: "VST", creator,
            modules: singleCreatorFeeModule(creator.address),
        });
        await launched.token.connect(owner).transfer(
            await base.vestingVault.getAddress(), amount,
        );
        const tx = await base.vestingVault.connect(owner).createSchedule(
            launched.tokenAddr, beneficiary, amount, cliff, duration,
        );
        return { token: launched.token, tokenAddr: launched.tokenAddr, tx };
    }

    describe("constructor", function () {
        it("rejects zero database", async function () {
            const V = await ethers.getContractFactory("VestingVault");
            await expect(V.deploy(ethers.ZeroAddress)).to.be.revertedWith("Vault: zero database");
        });
    });

    describe("createSchedule", function () {
        it("only the Generator (resolved from the Database) may create schedules", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            await expect(
                base.vestingVault.connect(user1).createSchedule(
                    user2.address, user2.address, ethers.parseEther("1"), 0, YEAR,
                ),
            ).to.be.revertedWith("Vault: only generator");
        });

        it("records the schedule and emits ScheduleCreated", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            const amount = ethers.parseEther("1000");

            const { tokenAddr } = await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 0, duration: YEAR,
            });

            expect(await base.vestingVault.scheduleCount()).to.equal(1);
            const s = await base.vestingVault.getSchedule(0);
            expect(s.token).to.equal(tokenAddr);
            expect(s.beneficiary).to.equal(user1.address);
            expect(s.total).to.equal(amount);
            expect(s.released).to.equal(0);
            expect(s.duration).to.equal(YEAR);

            const ids = await base.vestingVault.getBeneficiarySchedules(user1.address);
            expect(ids.map(Number)).to.deep.equal([0]);
        });

        it("rejects zero duration, cliff > duration, zero beneficiary, zero amount", async function () {
            const base = await loadFixture(deployBase);
            const { owner, user1 } = base.signers;
            const vault = base.vestingVault.connect(owner);
            const t = user1.address;

            await expect(vault.createSchedule(t, t, 1n, 0, 0)).to.be.revertedWith("Vault: zero duration");
            await expect(vault.createSchedule(t, t, 1n, YEAR + 1, YEAR)).to.be.revertedWith("Vault: cliff > duration");
            await expect(vault.createSchedule(t, ethers.ZeroAddress, 1n, 0, YEAR)).to.be.revertedWith("Vault: zero beneficiary");
            await expect(vault.createSchedule(t, t, 0n, 0, YEAR)).to.be.revertedWith("Vault: zero amount");
            await expect(vault.createSchedule(ethers.ZeroAddress, t, 1n, 0, YEAR)).to.be.revertedWith("Vault: zero token");
        });
    });

    describe("vesting math", function () {
        it("nothing is releasable before the cliff", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            await setupSchedule(base, {
                beneficiary: user1.address, amount: ethers.parseEther("1000"),
                cliff: 90 * DAY, duration: 360 * DAY,
            });
            expect(await base.vestingVault.releasable(0)).to.equal(0);
        });

        it("unlocks the elapsed-since-start portion at the cliff, then linearly", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            const amount = ethers.parseEther("1000");
            await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 90 * DAY, duration: 360 * DAY,
            });
            const start = (await base.vestingVault.getSchedule(0)).start;

            // Just past the cliff: ~1/4 unlocked (90/360).
            await time.increaseTo(Number(start) + 90 * DAY + 5);
            const atCliff = await base.vestingVault.releasable(0);
            expect(atCliff).to.be.closeTo(amount / 4n, ethers.parseEther("0.01"));

            // Halfway: ~1/2 unlocked.
            await time.increaseTo(Number(start) + 180 * DAY);
            const atHalf = await base.vestingVault.releasable(0);
            expect(atHalf).to.be.closeTo(amount / 2n, ethers.parseEther("0.01"));
        });

        it("is fully vested at and after duration", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            const amount = ethers.parseEther("1000");
            await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 0, duration: 180 * DAY,
            });
            const start = (await base.vestingVault.getSchedule(0)).start;
            await time.increaseTo(Number(start) + 180 * DAY + 1);
            expect(await base.vestingVault.vestedAmount(0)).to.equal(amount);
            expect(await base.vestingVault.releasable(0)).to.equal(amount);
        });
    });

    describe("release", function () {
        it("transfers vested tokens to the beneficiary and tracks released", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const amount = ethers.parseEther("1000");
            const { token } = await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 0, duration: 180 * DAY,
            });
            const start = (await base.vestingVault.getSchedule(0)).start;

            // Fully vest, then release (anyone can poke — use user2).
            await time.increaseTo(Number(start) + 180 * DAY + 1);
            await expect(base.vestingVault.connect(user2).release(0))
                .to.emit(base.vestingVault, "TokensReleased")
                .withArgs(0, user1.address, amount);

            expect(await token.balanceOf(user1.address)).to.equal(amount);
            expect(await token.balanceOf(await base.vestingVault.getAddress())).to.equal(0);
            expect((await base.vestingVault.getSchedule(0)).released).to.equal(amount);
        });

        it("reverts when nothing is releasable, and on double release", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            const amount = ethers.parseEther("1000");
            await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 30 * DAY, duration: 180 * DAY,
            });

            // Before the cliff: nothing to release.
            await expect(base.vestingVault.release(0)).to.be.revertedWith("Vault: nothing to release");

            // Fully vest and drain, then a second release reverts.
            const start = (await base.vestingVault.getSchedule(0)).start;
            await time.increaseTo(Number(start) + 180 * DAY + 1);
            await base.vestingVault.release(0);
            await expect(base.vestingVault.release(0)).to.be.revertedWith("Vault: nothing to release");
        });

        it("supports incremental releases as tokens vest", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;
            const amount = ethers.parseEther("1000");
            const { token } = await setupSchedule(base, {
                beneficiary: user1.address, amount, cliff: 0, duration: 200 * DAY,
            });
            const start = Number((await base.vestingVault.getSchedule(0)).start);

            await time.increaseTo(start + 100 * DAY);
            await base.vestingVault.release(0); // ~half
            const half = await token.balanceOf(user1.address);
            expect(half).to.be.closeTo(amount / 2n, ethers.parseEther("1"));

            await time.increaseTo(start + 200 * DAY + 1);
            await base.vestingVault.release(0); // the rest
            expect(await token.balanceOf(user1.address)).to.equal(amount);
        });

        it("reverts releasing an unknown schedule", async function () {
            const base = await loadFixture(deployBase);
            await expect(base.vestingVault.release(99)).to.be.revertedWith("Vault: no schedule");
        });
    });
});
