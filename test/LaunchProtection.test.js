const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployBase, loadFixture, useRealGenerator, buildCreatorFeeInitData, EMPTY_METADATA } = require("./fixtures/deploy");
const E = ethers.parseEther;

async function launch(base, fee = 500) {
    await useRealGenerator(base);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const address = await base.generator.predictTokenAddress(salt);
    await base.generator.connect(base.signers.creator).generateProject("Guard", "GRD", fee, 500,
        [{ moduleType: 3, buyAllocation: 10000, sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(base.signers.creator.address) }],
        2, ethers.AbiCoder.defaultAbiCoder().encode(["int24", "bool"], [180000, true]), [], salt, EMPTY_METADATA,
        { value: await base.database.launchFeeBnb() });
    const handler = await ethers.getContractAt("TaxHandler", await base.database.tokenTaxHandler(address));
    const token = await ethers.getContractAt("LumoriaToken", address);
    return { address, handler, token };
}

describe("Launch protection", function () {
    it("steps on exact boundaries, clamps a non-round base, and cannot restart", async function () {
        const base = await loadFixture(deployBase);
        const { handler } = await launch(base, 725);
        const start = await handler.sniperGuardStart();
        expect(await handler.buyFee()).to.equal(9000);
        await time.increaseTo(start + 29n);
        expect(await handler.buyFee()).to.equal(9000);
        await time.increaseTo(start + 30n);
        expect(await handler.buyFee()).to.equal(8500);
        await time.increaseTo(start + 480n);
        expect(await handler.buyFee()).to.equal(1000);
        await time.increaseTo(start + 510n);
        expect(await handler.buyFee()).to.equal(725);
        await handler.connect(base.signers.creator).proposeFeeChange(0, 500);
        expect(await handler.sniperGuardActive()).to.equal(false);
        expect(await handler.buyFee()).to.equal(0);
        await expect(handler.startSniperGuard()).to.be.revertedWith("Only generator");
    });
    it("freezes base buy fees, allows sell decreases and survives renounce", async function () {
        const base = await loadFixture(deployBase);
        const { handler } = await launch(base);
        await expect(handler.connect(base.signers.creator).proposeFeeChange(0, 500)).to.be.revertedWith("Guard freezes buy fee");
        await handler.connect(base.signers.creator).proposeFeeChange(500, 0);
        await handler.connect(base.signers.creator).renounceManagement();
        await time.increaseTo(await handler.sniperGuardEnd());
        expect(await handler.buyFee()).to.equal(500);
    });
    it("routes a real buy's overage 25/75 without changing the platform fee", async function () {
        const base = await loadFixture(deployBase);
        const { address, handler } = await launch(base);
        const before = await base.feeReceiver.totalReceived();
        const amount = E("1"), platform = amount / 100n, tax = (amount - platform) * 9000n / 10000n;
        const overageShare = tax * 8500n / 36000n;
        await expect(base.router.connect(base.signers.user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, address], base.signers.user1.address, (await time.latest()) + 1000, { value: amount }))
            .to.emit(handler, "SniperOverageDistributed").withArgs(tax, overageShare, tax - overageShare);
        expect(await base.feeReceiver.totalReceived() - before).to.equal(platform + overageShare);
        const module = await ethers.getContractAt("CreatorFeeModule", (await handler.getModule(0)).moduleAddress);
        expect(await module.owed(base.signers.creator.address)).to.equal(tax - overageShare);
    });
    it("rejects guard base fees at or above 90%", async function () {
        const base = await loadFixture(deployBase);
        await expect(launch(base, 9000)).to.be.revertedWith("Guard base must be below 90%");
    });
    it("disables funded rebates throughout the guard and caps them after a fee decrease", async function () {
        const base = await loadFixture(deployBase);
        const { address, handler, token } = await launch(base, 2000);
        const creator = base.signers.creator;
        await base.router.connect(creator).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, address], creator.address, (await time.latest()) + 1000, { value: E("1") });
        await token.connect(creator).approve(await base.rebate.getAddress(), E("1000"));
        await expect(base.rebate.connect(creator).fundRebate(address, E("1000"), 2001)).to.be.revertedWith("Rebate: exceeds buy fee");
        await base.rebate.connect(creator).fundRebate(address, E("1000"), 1500);
        expect(await base.rebate.previewRebate(address, E("80"))).to.equal(0);
        await time.increaseTo(await handler.sniperGuardEnd());
        expect(await base.rebate.previewRebate(address, E("80"))).to.equal(E("15"));
        await handler.connect(creator).proposeFeeChange(1000, 500);
        expect(await base.rebate.previewRebate(address, E("90"))).to.equal(E("10"));
        await handler.connect(creator).proposeFeeChange(0, 500);
        expect(await base.rebate.previewRebate(address, E("100"))).to.equal(0);
    });
});
