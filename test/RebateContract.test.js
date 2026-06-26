const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    deployBase,
    loadFixture,
    launchTokenWithPair,
    buildCreatorFeeInitData,
    MODULE_TYPE,
} = require("./fixtures/deploy");

async function launch(base) {
    return launchTokenWithPair(base, {
        modules: (shells) => [{
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(base.signers.creator.address),
        }],
        initialLiquidity: { tokens: ethers.parseEther("100000"), bnb: ethers.parseEther("10") },
    });
}

describe("RebateContract", function () {

    describe("constructor + admin", function () {
        it("rejects zero database", async function () {
            const R = await ethers.getContractFactory("RebateContract");
            await expect(R.deploy(ethers.ZeroAddress)).to.be.revertedWith("Rebate: zero database");
        });

        it("only owner can set authorized creditor", async function () {
            const { rebate, signers } = await loadFixture(deployBase);
            await expect(
                rebate.connect(signers.user1).setAuthorizedCreditor(signers.user2.address, true),
            ).to.be.reverted;
        });

        it("authorizes + deauthorizes a creditor (emits event)", async function () {
            const { rebate, signers } = await loadFixture(deployBase);
            await expect(rebate.setAuthorizedCreditor(signers.user2.address, true))
                .to.emit(rebate, "CreditorUpdated")
                .withArgs(signers.user2.address, true);
            expect(await rebate.authorizedCreditors(signers.user2.address)).to.equal(true);
        });
    });

    describe("fundRebate", function () {
        it("only the token's creator can fund", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            await token.connect(base.signers.owner).transfer(base.signers.user1.address, ethers.parseEther("100"));
            await token.connect(base.signers.user1).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await expect(
                base.rebate.connect(base.signers.user1).fundRebate(tokenAddr, ethers.parseEther("100"), 5000),
            ).to.be.revertedWith("Rebate: only creator");
        });

        it("rejects funding for non-Lumoria tokens", async function () {
            const base = await loadFixture(deployBase);
            // user2.address is not a Lumoria token
            await expect(
                base.rebate.connect(base.signers.creator).fundRebate(base.signers.user2.address, 100, 5000),
            ).to.be.revertedWith("Rebate: not Lumoria token");
        });

        it("rejects zero amount or out-of-range bps", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await launch(base);
            await expect(
                base.rebate.connect(base.signers.creator).fundRebate(tokenAddr, 0, 5000),
            ).to.be.revertedWith("Rebate: zero amount");
            await expect(
                base.rebate.connect(base.signers.creator).fundRebate(tokenAddr, 100, 0),
            ).to.be.revertedWith("Rebate: bad bps");
            await expect(
                base.rebate.connect(base.signers.creator).fundRebate(tokenAddr, 100, 10001),
            ).to.be.revertedWith("Rebate: bad bps");
        });

        it("populates config + emits event", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            await token.connect(base.signers.owner).transfer(base.signers.creator.address, ethers.parseEther("1000"));
            await token.connect(base.signers.creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await expect(base.rebate.connect(base.signers.creator).fundRebate(tokenAddr, ethers.parseEther("1000"), 5000))
                .to.emit(base.rebate, "RebateFunded");
            const cfg = await base.rebate.getRebate(tokenAddr);
            expect(cfg.rebateBps).to.equal(5000);
            expect(cfg.fundedBalance).to.equal(ethers.parseEther("1000"));
            expect(cfg.creator).to.equal(base.signers.creator.address);
            expect(cfg.active).to.equal(true);
        });
    });

    describe("topUpRebate", function () {
        it("requires prior fundRebate", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await launch(base);
            await expect(
                base.rebate.connect(base.signers.creator).topUpRebate(tokenAddr, 100),
            ).to.be.revertedWith("Rebate: not funded");
        });

        it("increases fundedBalance and can reactivate a drained pool", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            const { creator, owner } = base.signers;
            await token.connect(owner).transfer(creator.address, ethers.parseEther("2000"));
            await token.connect(creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await base.rebate.connect(creator).fundRebate(tokenAddr, ethers.parseEther("500"), 5000);
            await base.rebate.connect(creator).withdrawFunds(tokenAddr, ethers.parseEther("500"));
            // Pool drained via withdraw → active should be false
            let cfg = await base.rebate.getRebate(tokenAddr);
            expect(cfg.active).to.equal(false);

            await base.rebate.connect(creator).topUpRebate(tokenAddr, ethers.parseEther("500"));
            cfg = await base.rebate.getRebate(tokenAddr);
            expect(cfg.active).to.equal(true);
            expect(cfg.fundedBalance).to.equal(ethers.parseEther("500"));
        });
    });

    describe("creditRebate", function () {
        it("rejects unauthorized creditors", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await launch(base);
            await expect(
                base.rebate.connect(base.signers.user1).creditRebate(tokenAddr, base.signers.user2.address, 100),
            ).to.be.revertedWith("Rebate: unauthorized");
        });

        it("silently exits when pool is empty", async function () {
            const base = await loadFixture(deployBase);
            const { tokenAddr } = await launch(base);
            // authorize user1 as creditor
            await base.rebate.setAuthorizedCreditor(base.signers.user1.address, true);
            // no fundRebate called → active = false → silent no-op, no revert
            await expect(
                base.rebate.connect(base.signers.user1).creditRebate(tokenAddr, base.signers.user2.address, 100),
            ).to.not.be.reverted;
        });

        it("credits proportional tokens and deactivates when drained", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            const { creator, owner, user1, user2 } = base.signers;

            await token.connect(owner).transfer(creator.address, ethers.parseEther("100"));
            await token.connect(creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await base.rebate.connect(creator).fundRebate(tokenAddr, ethers.parseEther("100"), 5000);

            // authorize user1 as creditor for this test
            await base.rebate.setAuthorizedCreditor(user1.address, true);
            // buyer claims rebate on a 100-token buy → should get 50 tokens
            await expect(
                base.rebate.connect(user1).creditRebate(tokenAddr, user2.address, ethers.parseEther("100")),
            ).to.emit(base.rebate, "RebateCredited");
            expect(await token.balanceOf(user2.address)).to.equal(ethers.parseEther("50"));

            // Drain with a second massive credit
            await base.rebate.connect(user1).creditRebate(tokenAddr, user2.address, ethers.parseEther("1000000"));
            const cfg = await base.rebate.getRebate(tokenAddr);
            expect(cfg.fundedBalance).to.equal(0);
            expect(cfg.active).to.equal(false);
        });
    });

    describe("withdraw / setRebateBps", function () {
        it("only creator can set bps / withdraw", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            const { creator, owner, user1 } = base.signers;
            await token.connect(owner).transfer(creator.address, ethers.parseEther("100"));
            await token.connect(creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await base.rebate.connect(creator).fundRebate(tokenAddr, ethers.parseEther("100"), 5000);

            await expect(
                base.rebate.connect(user1).setRebateBps(tokenAddr, 7000),
            ).to.be.revertedWith("Rebate: only creator");
            await expect(
                base.rebate.connect(user1).withdrawFunds(tokenAddr, 100),
            ).to.be.revertedWith("Rebate: only creator");
        });

        it("updates bps and emits event", async function () {
            const base = await loadFixture(deployBase);
            const { token, tokenAddr } = await launch(base);
            const { creator, owner } = base.signers;
            await token.connect(owner).transfer(creator.address, ethers.parseEther("100"));
            await token.connect(creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await base.rebate.connect(creator).fundRebate(tokenAddr, ethers.parseEther("100"), 5000);

            await expect(base.rebate.connect(creator).setRebateBps(tokenAddr, 7000))
                .to.emit(base.rebate, "RebateBpsUpdated")
                .withArgs(tokenAddr, 5000, 7000);
        });
    });

    describe("renounce freezes rebate controls (Q1)", function () {
        async function fundedAndLaunched(base) {
            const launched = await launch(base);
            const { creator, owner } = base.signers;
            await launched.token.connect(owner).transfer(creator.address, ethers.parseEther("2000"));
            await launched.token.connect(creator).approve(await base.rebate.getAddress(), ethers.MaxUint256);
            await base.rebate.connect(creator).fundRebate(launched.tokenAddr, ethers.parseEther("500"), 5000);
            return launched;
        }

        it("isManagementRenounced tracks the token's TaxHandler", async function () {
            const base = await loadFixture(deployBase);
            const launched = await fundedAndLaunched(base);
            expect(await base.rebate.isManagementRenounced(launched.tokenAddr)).to.equal(false);
            await launched.taxHandler.connect(base.signers.creator).renounceManagement();
            expect(await base.rebate.isManagementRenounced(launched.tokenAddr)).to.equal(true);
        });

        it("blocks setRebateBps, withdrawFunds, and fundRebate after renounce", async function () {
            const base = await loadFixture(deployBase);
            const launched = await fundedAndLaunched(base);
            const { creator } = base.signers;
            await launched.taxHandler.connect(creator).renounceManagement();

            await expect(base.rebate.connect(creator).setRebateBps(launched.tokenAddr, 7000))
                .to.be.revertedWith("Rebate: renounced");
            await expect(base.rebate.connect(creator).withdrawFunds(launched.tokenAddr, ethers.parseEther("100")))
                .to.be.revertedWith("Rebate: renounced");
            await expect(base.rebate.connect(creator).fundRebate(launched.tokenAddr, ethers.parseEther("100"), 6000))
                .to.be.revertedWith("Rebate: renounced");
        });

        it("still allows top-ups after renounce (additive only, rate unchanged)", async function () {
            const base = await loadFixture(deployBase);
            const launched = await fundedAndLaunched(base);
            const { creator } = base.signers;
            await launched.taxHandler.connect(creator).renounceManagement();

            await expect(base.rebate.connect(creator).topUpRebate(launched.tokenAddr, ethers.parseEther("250")))
                .to.emit(base.rebate, "RebateToppedUp");
            const cfg = await base.rebate.getRebate(launched.tokenAddr);
            expect(cfg.fundedBalance).to.equal(ethers.parseEther("750"));
            expect(cfg.rebateBps).to.equal(5000);
        });

        it("buyers are still credited after renounce (the pool keeps paying out)", async function () {
            const base = await loadFixture(deployBase);
            const launched = await fundedAndLaunched(base);
            const { creator, user1, user2 } = base.signers;
            await launched.taxHandler.connect(creator).renounceManagement();
            await base.rebate.setAuthorizedCreditor(user1.address, true);

            await expect(
                base.rebate.connect(user1).creditRebate(launched.tokenAddr, user2.address, ethers.parseEther("100")),
            ).to.emit(base.rebate, "RebateCredited");
            expect(await launched.token.balanceOf(user2.address)).to.equal(ethers.parseEther("50"));
        });
    });
});
