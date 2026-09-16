const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployBase, loadFixture, launchTokenWithPool, buildPrizePoolInitData } = require("./fixtures/deploy");
const E = ethers.parseEther;
async function fixture() {
    const base = await deployBase();
    base.databaseAddr = await base.database.getAddress();
    const coordinator = await (await ethers.getContractFactory("MockNativeVRF")).deploy();
    const vrf = await (await ethers.getContractFactory("NativeVRFRandomness")).deploy(
        base.databaseAddr, await coordinator.getAddress(), 1, ethers.id("lane"), 3, E("0.001"));
    await base.database.setRandomnessProvider(await vrf.getAddress());
    const launched = await launchTokenWithPool(base, { modules: shells => [{ moduleType: 4, buyAllocation: 10000,
        sellAllocation: 10000, initPayload: buildPrizePoolInitData({ token: shells.tokenAddr, database: base.databaseAddr,
            payoutMode: 1, winnerCount: 1, rootPoster: base.signers.keeper.address }) }] });
    const pool = await ethers.getContractAt("PrizePool", (await launched.taxHandler.getModule(0)).moduleAddress);
    await launched.taxHandler.receiveBuyTax({ value: E("1") });
    await time.increase(86401);
    const root = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256", "uint256", "uint256"], [0, base.signers.user1.address, 100, 0, 0]));
    await pool.connect(base.signers.keeper).postRoot(0, root, 100, 1);
    await time.increase(21601);
    return { ...base, ...launched, pool, vrf, coordinator };
}
describe("Project prepaid native VRF", function () {
    it("pays the committed winning ticket after VRF delivery and rejects a second claim", async function () {
        const b = await loadFixture(fixture);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.001") });
        await b.pool.drawRandomness(0);
        await b.coordinator.fulfill(await b.vrf.getAddress(), 1, 123);
        await b.vrf.deliver(1);
        await expect(b.pool.connect(b.signers.user1).claimLottery(0, 0, 0, 100, 0, 0, []))
            .to.changeEtherBalance(b.signers.user1, E("1"));
        await expect(b.pool.connect(b.signers.user1).claimLottery(0, 0, 0, 100, 0, 0, []))
            .to.be.revertedWith("Slot claimed");
    });
    it("forwards direct and explicit reserve funding without spending project escrow", async function () {
        const b = await loadFixture(fixture);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.003") });
        await expect(b.vrf.fundReserve({ value: E("0.01") }))
            .to.emit(b.vrf, "ReserveFunded").withArgs(b.signers.owner.address, E("0.01"));
        await b.signers.user1.sendTransaction({ to: await b.vrf.getAddress(), value: E("0.02") });
        expect(await b.coordinator.funded()).to.equal(E("0.03"));
        expect(await b.vrf.projectBalance(b.tokenAddr)).to.equal(E("0.003"));
        expect(await ethers.provider.getBalance(await b.vrf.getAddress())).to.equal(E("0.003"));
        await expect(b.vrf.fundReserve()).to.be.revertedWith("VRF: zero funding");
    });
    it("matches out-of-order callbacks to their original epoch", async function () {
        const b = await loadFixture(fixture);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.002") });
        await b.pool.drawRandomness(0);
        await b.taxHandler.receiveBuyTax({ value: E("1") });
        const nextEpoch = await b.pool.currentEpochId();
        await time.increase(86401);
        await b.pool.connect(b.signers.keeper).postRoot(nextEpoch, ethers.id("second root"), 100, 2);
        await time.increase(21601);
        await b.pool.drawRandomness(nextEpoch);
        await b.coordinator.fulfill(await b.vrf.getAddress(), 2, 222);
        await b.vrf.deliver(2);
        expect((await b.pool.settlements(nextEpoch)).randomWord).to.equal(222);
        expect((await b.pool.settlements(0)).randomnessFulfilled).to.equal(false);
        await b.coordinator.fulfill(await b.vrf.getAddress(), 1, 111);
        await b.vrf.deliver(1);
        expect((await b.pool.settlements(0)).randomWord).to.equal(111);
    });
    it("requires project credit, pays in native, pins the word and delivers permissionlessly", async function () {
        const b = await loadFixture(fixture);
        await expect(b.pool.drawRandomness(0)).to.be.revertedWith("VRF: fund project");
        expect((await b.pool.settlements(0)).randomnessRequested).to.equal(false);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.002") });
        await b.pool.drawRandomness(0);
        expect(await b.vrf.projectBalance(b.tokenAddr)).to.equal(E("0.001"));
        expect(await b.coordinator.funded()).to.equal(E("0.001"));
        expect(await b.coordinator.lastExtraArgs()).to.equal(ethers.concat([
            ethers.id("VRF ExtraArgsV1").slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]) ]));
        await expect(b.vrf.rawFulfillRandomWords(1, [123])).to.be.revertedWith("VRF: only coordinator");
        await time.increase(3 * 86400);
        await expect(b.pool.rolloverStaleRandomness(0)).to.be.revertedWith("Randomness is committed");
        await b.coordinator.fulfill(await b.vrf.getAddress(), 1, 123);
        await b.coordinator.fulfill(await b.vrf.getAddress(), 1, 456);
        expect((await b.vrf.requests(1)).word).to.equal(123);
        await b.vrf.connect(b.signers.user1).deliver(1);
        expect((await b.pool.settlements(0)).randomWord).to.equal(123);
        await expect(b.vrf.deliver(1)).to.be.revertedWith("VRF: not deliverable");
        await expect(b.pool.drawRandomness(0)).to.be.revertedWith("Already requested");
    });
    it("refunds only unspent project credit to its creator", async function () {
        const b = await loadFixture(fixture);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.003") });
        await b.pool.drawRandomness(0);
        await expect(b.vrf.withdrawProject(b.tokenAddr, 1)).to.be.revertedWith("VRF: only creator");
        await expect(b.vrf.connect(b.signers.creator).withdrawProject(b.tokenAddr, E("0.003"))).to.be.revertedWith("VRF: invalid amount");
        await b.vrf.connect(b.signers.creator).withdrawProject(b.tokenAddr, E("0.002"));
        expect(await b.vrf.projectBalance(b.tokenAddr)).to.equal(0);
        expect(await b.coordinator.funded()).to.equal(E("0.001"));
    });
    it("atomically rolls back charges and request state if coordinator rejects", async function () {
        const b = await loadFixture(fixture);
        await b.vrf.fundProject(b.tokenAddr, { value: E("0.001") });
        await b.coordinator.setFailRequest(true);
        await expect(b.pool.drawRandomness(0)).to.be.revertedWith("Coordinator unavailable");
        expect(await b.vrf.projectBalance(b.tokenAddr)).to.equal(E("0.001"));
        expect(await b.coordinator.funded()).to.equal(0);
        expect(await b.vrf.requested(await b.pool.getAddress(), ethers.ZeroHash)).to.equal(false);
    });
    it("rejects unknown projects and cannot request through an arbitrary wallet", async function () {
        const b = await loadFixture(fixture);
        await expect(b.vrf.fundProject(b.signers.user1.address, { value: 1 })).to.be.revertedWith("VRF: unknown token");
        await expect(b.vrf.requestRandomness(ethers.ZeroHash)).to.be.reverted;
    });
});
