const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBase, loadFixture } = require("./fixtures/deploy");

describe("FeeReceiver", function () {

    describe("constructor", function () {
        it("rejects zero recipient", async function () {
            const FeeReceiver = await ethers.getContractFactory("FeeReceiver");
            await expect(FeeReceiver.deploy(ethers.ZeroAddress)).to.be.revertedWith("Zero recipient");
        });
    });

    describe("receiveFee (tagged)", function () {
        it("rejects zero-value calls", async function () {
            const { feeReceiver } = await loadFixture(deployBase);
            await expect(feeReceiver.receiveFee(ethers.ZeroAddress, { value: 0 }))
                .to.be.revertedWith("Zero fee");
        });

        it("increments totalReceived and per-token tracking", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            const fakeToken = signers.user1.address;
            await feeReceiver.receiveFee(fakeToken, { value: ethers.parseEther("0.1") });
            await feeReceiver.receiveFee(fakeToken, { value: ethers.parseEther("0.05") });

            expect(await feeReceiver.totalReceived()).to.equal(ethers.parseEther("0.15"));
            expect(await feeReceiver.feesByToken(fakeToken)).to.equal(ethers.parseEther("0.15"));
        });

        it("emits both FeeReceived and TokenFeeReceived", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            const fakeToken = signers.user1.address;
            await expect(feeReceiver.receiveFee(fakeToken, { value: 100 }))
                .to.emit(feeReceiver, "FeeReceived")
                .and.to.emit(feeReceiver, "TokenFeeReceived")
                .withArgs(fakeToken, 100);
        });
    });

    describe("receive (untagged fallback)", function () {
        it("accepts raw BNB sends and updates totalReceived", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            await signers.user1.sendTransaction({
                to: await feeReceiver.getAddress(),
                value: ethers.parseEther("1"),
            });
            expect(await feeReceiver.totalReceived()).to.equal(ethers.parseEther("1"));
        });
    });

    describe("withdraw", function () {
        it("only owner can withdraw", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            await signers.user1.sendTransaction({
                to: await feeReceiver.getAddress(),
                value: ethers.parseEther("0.5"),
            });
            await expect(feeReceiver.connect(signers.user1).withdraw()).to.be.reverted;
        });

        it("reverts with No balance when empty", async function () {
            const { feeReceiver } = await loadFixture(deployBase);
            await expect(feeReceiver.withdraw()).to.be.revertedWith("No balance");
        });

        it("transfers the full balance to the recipient and emits event", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            await signers.user1.sendTransaction({
                to: await feeReceiver.getAddress(),
                value: ethers.parseEther("2"),
            });
            const before = await ethers.provider.getBalance(signers.feeRecipient.address);
            await expect(feeReceiver.withdraw())
                .to.emit(feeReceiver, "FeesWithdrawn")
                .withArgs(signers.feeRecipient.address, ethers.parseEther("2"));
            const after = await ethers.provider.getBalance(signers.feeRecipient.address);
            expect(after - before).to.equal(ethers.parseEther("2"));
        });
    });

    describe("setRecipient", function () {
        it("only owner can change recipient", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            await expect(feeReceiver.connect(signers.user1).setRecipient(signers.user2.address))
                .to.be.reverted;
        });

        it("rejects zero-address recipient", async function () {
            const { feeReceiver } = await loadFixture(deployBase);
            await expect(feeReceiver.setRecipient(ethers.ZeroAddress)).to.be.revertedWith("Zero recipient");
        });

        it("updates recipient and emits event", async function () {
            const { feeReceiver, signers } = await loadFixture(deployBase);
            const oldRecipient = await feeReceiver.recipient();
            await expect(feeReceiver.setRecipient(signers.user3.address))
                .to.emit(feeReceiver, "RecipientUpdated")
                .withArgs(oldRecipient, signers.user3.address);
            expect(await feeReceiver.recipient()).to.equal(signers.user3.address);
        });
    });
});
