const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBase, loadFixture, buildCreatorFeeInitData } = require("../fixtures/deploy");

// CreatorFeeModule reads taxHandler from msg.sender on __init__. For unit
// tests we clone the master copy and call __init__ from whichever signer we
// want to act as the "taxHandler" — that signer becomes the module's
// authorized caller for receiveTax.

async function cloneAndInitCreatorFee(base, { taxHandlerSigner, recipient }) {
    const implAddr = await base.masterCopies.creatorFee.getAddress();
    const impl = implAddr.toLowerCase().replace("0x", "");
    const bytecode =
        "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + impl + "5af43d82803e903d91602b57fd5bf3";
    const tx = await base.signers.owner.sendTransaction({ data: bytecode });
    const receipt = await tx.wait();
    const mod = await ethers.getContractAt("CreatorFeeModule", receipt.contractAddress);

    const payload = buildCreatorFeeInitData(recipient.address);
    // Call __init__ from the "taxHandler" signer — msg.sender there becomes
    // the module's stored taxHandler.
    await mod.connect(taxHandlerSigner).__init__(payload);
    return mod;
}

describe("CreatorFeeModule", function () {

    describe("initialization", function () {
        it("stores taxHandler (= caller) + recipient", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            expect(await mod.taxHandler()).to.equal(user1.address);
            expect(await mod.recipient()).to.equal(user2.address);
            expect(await mod.totalPaid()).to.equal(0);
        });

        it("rejects zero-address recipient", async function () {
            const base = await loadFixture(deployBase);
            const implAddr = await base.masterCopies.creatorFee.getAddress();
            const impl = implAddr.toLowerCase().replace("0x", "");
            const tx = await base.signers.owner.sendTransaction({
                data: "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + impl + "5af43d82803e903d91602b57fd5bf3",
            });
            const receipt = await tx.wait();
            const mod = await ethers.getContractAt("CreatorFeeModule", receipt.contractAddress);

            const payload = buildCreatorFeeInitData(ethers.ZeroAddress);
            await expect(mod.__init__(payload)).to.be.revertedWith("Zero recipient");
        });

        it("blocks double initialization", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            const payload = buildCreatorFeeInitData(user2.address);
            await expect(mod.__init__(payload)).to.be.revertedWith("Already initialized");
        });
    });

    describe("receiveTax", function () {
        it("only taxHandler can send", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2, user3 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await expect(
                mod.connect(user3).receiveTax({ value: ethers.parseEther("1") }),
            ).to.be.revertedWith("Only taxHandler");
        });

        it("accrues BNB to the recipient and emits TaxAccrued — it does not push", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            const before = await ethers.provider.getBalance(user2.address);
            await expect(mod.connect(user1).receiveTax({ value: ethers.parseEther("0.7") }))
                .to.emit(mod, "TaxAccrued")
                .withArgs(user2.address, ethers.parseEther("0.7"), ethers.parseEther("0.7"));
            const after = await ethers.provider.getBalance(user2.address);

            // Nothing was pushed — the BNB sits in the module until pulled.
            expect(after - before).to.equal(0);
            expect(await mod.owed(user2.address)).to.equal(ethers.parseEther("0.7"));
            expect(await mod.totalAccrued()).to.equal(ethers.parseEther("0.7"));
            expect(await mod.totalPaid()).to.equal(0);
        });

        it("zero-value calls are a no-op", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await mod.connect(user1).receiveTax({ value: 0 });
            expect(await mod.totalAccrued()).to.equal(0);
            expect(await mod.owed(user2.address)).to.equal(0);
        });

        // Regression: docs/TOKENOMICS_V2.md §7.2. Under the old push-based
        // receiveTax(), a recipient that could not accept BNB reverted the call,
        // which reverted the swap, which bricked every trade of the token.
        it("does NOT revert when the recipient is a contract that cannot receive BNB", async function () {
            const base = await loadFixture(deployBase);
            const { user1 } = base.signers;

            const Rejecting = await ethers.getContractFactory("RejectingRecipient");
            const rejecting = await Rejecting.deploy();
            await rejecting.waitForDeployment();
            const rejectingAddr = await rejecting.getAddress();

            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: { address: rejectingAddr },
            });

            // The tax path must survive a recipient that rejects BNB.
            await expect(mod.connect(user1).receiveTax({ value: ethers.parseEther("1") })).to.not.be
                .reverted;
            expect(await mod.owed(rejectingAddr)).to.equal(ethers.parseEther("1"));

            // Only the recipient's own withdrawal fails.
            await expect(rejecting.tryWithdraw(await mod.getAddress())).to.be.revertedWith(
                "withdraw failed",
            );

            // And it can recover by handing the stream to an address that can receive.
            await rejecting.setRecipient(await mod.getAddress(), base.signers.user2.address);
            expect(await mod.recipient()).to.equal(base.signers.user2.address);
        });
    });

    describe("withdraw", function () {
        it("pays the accrued balance and tracks totalPaid", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await mod.connect(user1).receiveTax({ value: ethers.parseEther("2") });

            const before = await ethers.provider.getBalance(user2.address);
            const tx = await mod.connect(user2).withdraw();
            const receipt = await tx.wait();
            const gas = receipt.gasUsed * receipt.gasPrice;
            const after = await ethers.provider.getBalance(user2.address);

            expect(after - before + gas).to.equal(ethers.parseEther("2"));
            expect(await mod.owed(user2.address)).to.equal(0);
            expect(await mod.totalPaid()).to.equal(ethers.parseEther("2"));
        });

        it("reverts when nothing is owed, and on double withdraw", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2, user3 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await expect(mod.connect(user3).withdraw()).to.be.revertedWith("Nothing owed");

            await mod.connect(user1).receiveTax({ value: ethers.parseEther("1") });
            await mod.connect(user2).withdraw();
            await expect(mod.connect(user2).withdraw()).to.be.revertedWith("Nothing owed");
        });

        it("a recipient change leaves the old recipient's accrual claimable", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2, user3 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await mod.connect(user1).receiveTax({ value: ethers.parseEther("1") });
            await mod.connect(user2).setRecipient(user3.address);
            await mod.connect(user1).receiveTax({ value: ethers.parseEther("3") });

            expect(await mod.owed(user2.address)).to.equal(ethers.parseEther("1"));
            expect(await mod.owed(user3.address)).to.equal(ethers.parseEther("3"));

            // The old recipient can still pull what it earned before the handover.
            await expect(mod.connect(user2).withdraw()).to.not.be.reverted;
            await expect(mod.connect(user3).withdraw()).to.not.be.reverted;
        });
    });

    describe("setRecipient", function () {
        it("only current recipient can change recipient", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2, user3 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await expect(mod.connect(user1).setRecipient(user3.address)).to.be.revertedWith("Only recipient");
            await mod.connect(user2).setRecipient(user3.address);
            expect(await mod.recipient()).to.equal(user3.address);
        });

        it("rejects zero address", async function () {
            const base = await loadFixture(deployBase);
            const { user1, user2 } = base.signers;
            const mod = await cloneAndInitCreatorFee(base, {
                taxHandlerSigner: user1,
                recipient: user2,
            });
            await expect(mod.connect(user2).setRecipient(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
        });
    });
});
