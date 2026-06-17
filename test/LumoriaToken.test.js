const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    buildCreatorFeeInitData,
    MODULE_TYPE,
} = require("./fixtures/deploy");

// LumoriaToken's transfer path calls ITaxHandler.setShare on sender + recipient,
// so tests need a real (initialized) TaxHandler. Using a CreatorFee-only
// handler keeps the fixture simple.

async function launchBasicToken(base) {
    const shells = await prepareTokenShells(base);
    const modules = [
        {
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(base.signers.creator.address),
        },
    ];
    await initializeToken(base, shells, {
        name: "Lumoria Test",
        symbol: "LUM",
        pair: base.signers.user3.address,
        creator: base.signers.creator,
        buyFee: 500,
        sellFee: 500,
        modules,
    });
    return shells;
}

describe("LumoriaToken", function () {

    describe("initialization", function () {
        it("mints the full 1B supply to the initializer", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            const supply = await token.totalSupply();
            expect(supply).to.equal(ethers.parseEther("1000000000"));
            // owner in fixture is the initializer
            expect(await token.balanceOf(base.signers.owner.address)).to.equal(supply);
        });

        it("blocks double initialization", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            await expect(
                token.__init__("X", "Y", base.signers.user1.address, base.signers.user2.address, base.signers.user3.address),
            ).to.be.revertedWith("Already initialized");
        });

        it("rejects zero addresses at init", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            await expect(
                shells.token.__init__(
                    "N",
                    "S",
                    ethers.ZeroAddress,
                    shells.taxHandlerAddr,
                    base.signers.creator.address,
                ),
            ).to.be.revertedWith("Zero pair");
        });
    });

    describe("transfer + holder tracking", function () {
        it("forwards setShare to TaxHandler for both sender and recipient", async function () {
            const base = await loadFixture(deployBase);
            const { token, taxHandler } = await launchBasicToken(base);
            const { owner, user1 } = base.signers;

            await token.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            expect(await taxHandler.shares(user1.address)).to.equal(ethers.parseEther("1000"));
            // owner share = totalSupply - 1000
            expect(await taxHandler.shares(owner.address)).to.equal(
                ethers.parseEther("1000000000") - ethers.parseEther("1000"),
            );
        });

        it("rejects zero recipient and zero amount", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            await expect(
                token.transfer(ethers.ZeroAddress, 100),
            ).to.be.revertedWith("Zero recipient");
            await expect(
                token.transfer(base.signers.user1.address, 0),
            ).to.be.revertedWith("Zero amount");
        });

        it("rejects insufficient balance", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            await expect(
                token.connect(base.signers.user1).transfer(base.signers.user2.address, 1),
            ).to.be.revertedWith("Insufficient balance");
        });
    });

    describe("approve + transferFrom", function () {
        it("requires sufficient allowance", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            const { owner, user1, user2 } = base.signers;
            await token.connect(owner).transfer(user1.address, ethers.parseEther("100"));
            // user2 tries to pull without approval
            await expect(
                token.connect(user2).transferFrom(user1.address, user2.address, ethers.parseEther("10")),
            ).to.be.revertedWith("Insufficient allowance");
        });

        it("decrements allowance on transferFrom", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            const { owner, user1, user2 } = base.signers;
            await token.connect(owner).transfer(user1.address, ethers.parseEther("100"));
            await token.connect(user1).approve(user2.address, ethers.parseEther("50"));
            await token.connect(user2).transferFrom(user1.address, user2.address, ethers.parseEther("30"));
            expect(await token.allowance(user1.address, user2.address)).to.equal(ethers.parseEther("20"));
        });
    });

    describe("burn", function () {
        it("reduces totalSupply and sender balance", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            const { owner } = base.signers;
            const supplyBefore = await token.totalSupply();
            await token.connect(owner).burn(ethers.parseEther("1000"));
            expect(await token.totalSupply()).to.equal(supplyBefore - ethers.parseEther("1000"));
        });

        it("rejects zero amount", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base);
            await expect(token.burn(0)).to.be.revertedWith("Zero amount");
        });

        it("updates share in TaxHandler", async function () {
            const base = await loadFixture(deployBase);
            const { token, taxHandler } = await launchBasicToken(base);
            const { owner } = base.signers;
            await token.connect(owner).burn(ethers.parseEther("500"));
            expect(await taxHandler.shares(owner.address)).to.equal(
                ethers.parseEther("1000000000") - ethers.parseEther("500"),
            );
        });
    });
});
