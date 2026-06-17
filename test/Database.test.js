const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBase, loadFixture } = require("./fixtures/deploy");

describe("Database", function () {

    describe("constructor", function () {
        it("rejects zero-address WBNB", async function () {
            const Database = await ethers.getContractFactory("Database");
            await expect(Database.deploy(ethers.ZeroAddress)).to.be.revertedWith("Zero WBNB");
        });

        it("defaults platformFeeBps to 100 (1%)", async function () {
            const { database } = await loadFixture(deployBase);
            expect(await database.platformFeeBps()).to.equal(100);
        });

        it("stores the WBNB address as immutable", async function () {
            const { database, wbnb } = await loadFixture(deployBase);
            expect(await database.wbnb()).to.equal(await wbnb.getAddress());
        });
    });

    describe("admin: system config", function () {
        it("only owner can set generator/router/poolManager/hook/vault/feeReceiver/rebate", async function () {
            const { database, signers } = await loadFixture(deployBase);
            const stranger = signers.user1;
            await expect(database.connect(stranger).setGenerator(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setRouter(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setPoolManager(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setHook(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setLiquidityVault(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setFeeReceiver(stranger.address)).to.be.reverted;
            await expect(database.connect(stranger).setRebateContract(stranger.address)).to.be.reverted;
        });

        it("emits events with old → new values on each setter", async function () {
            const { database, signers } = await loadFixture(deployBase);
            const owner = signers.owner;
            const oldGenerator = await database.generator();
            await expect(database.setGenerator(signers.user1.address))
                .to.emit(database, "GeneratorUpdated")
                .withArgs(oldGenerator, signers.user1.address);
        });
    });

    describe("admin: platform fee", function () {
        it("only owner can update platform fee", async function () {
            const { database, signers } = await loadFixture(deployBase);
            await expect(database.connect(signers.user1).setPlatformFeeBps(50)).to.be.reverted;
        });

        it("rejects fee above MAX_PLATFORM_FEE (500 bps = 5%)", async function () {
            const { database } = await loadFixture(deployBase);
            await expect(database.setPlatformFeeBps(501)).to.be.revertedWith("Exceeds max");
        });

        it("accepts fee at exactly the cap", async function () {
            const { database } = await loadFixture(deployBase);
            await expect(database.setPlatformFeeBps(500))
                .to.emit(database, "PlatformFeeUpdated")
                .withArgs(100, 500);
            expect(await database.platformFeeBps()).to.equal(500);
        });
    });

    describe("registerToken", function () {
        it("only generator can register", async function () {
            const { database, signers } = await loadFixture(deployBase);
            // fixture sets generator = owner, so user1 should be rejected
            await expect(
                database.connect(signers.user1).registerToken(
                    signers.user2.address,
                    signers.creator.address,
                    signers.user3.address,
                ),
            ).to.be.revertedWith("Only generator");
        });

        it("rejects zero token address", async function () {
            const { database, signers } = await loadFixture(deployBase);
            await expect(
                database.registerToken(
                    ethers.ZeroAddress,
                    signers.creator.address,
                    signers.user3.address,
                ),
            ).to.be.revertedWith("Zero token");
        });

        it("rejects double registration", async function () {
            const { database, signers } = await loadFixture(deployBase);
            const fakeToken = signers.user1.address;
            await database.registerToken(fakeToken, signers.creator.address, signers.user2.address);
            await expect(
                database.registerToken(fakeToken, signers.creator.address, signers.user2.address),
            ).to.be.revertedWith("Already registered");
        });

        it("populates registry + allTokens + emits TokenRegistered", async function () {
            const { database, signers } = await loadFixture(deployBase);
            const fakeToken = signers.user1.address;
            const fakeTax = signers.user2.address;

            await expect(database.registerToken(fakeToken, signers.creator.address, fakeTax))
                .to.emit(database, "TokenRegistered")
                .withArgs(fakeToken, signers.creator.address, fakeTax);

            expect(await database.isLumoriaToken(fakeToken)).to.equal(true);
            expect(await database.tokenCreator(fakeToken)).to.equal(signers.creator.address);
            expect(await database.tokenTaxHandler(fakeToken)).to.equal(fakeTax);
            expect(await database.allTokensLength()).to.equal(1);
            expect(await database.allTokens(0)).to.equal(fakeToken);
        });
    });

    describe("registerVolume", function () {
        it("only the hook can register volume", async function () {
            const { database, signers } = await loadFixture(deployBase);
            await expect(
                database.registerVolume(signers.user1.address, signers.user2.address, 100),
            ).to.be.revertedWith("Only hook");
        });

        it("accumulates user + token volume when called by the hook", async function () {
            const { database, signers } = await loadFixture(deployBase);
            // set hook to a test signer
            await database.setHook(signers.keeper.address);

            const fakeToken = signers.user1.address;
            await database
                .connect(signers.keeper)
                .registerVolume(fakeToken, signers.user2.address, 1000);
            await database
                .connect(signers.keeper)
                .registerVolume(fakeToken, signers.user2.address, 500);

            expect(await database.userVolume(fakeToken, signers.user2.address)).to.equal(1500);
            expect(await database.tokenVolume(fakeToken)).to.equal(1500);
        });

        it("skips per-user attribution for user == address(0) but still tracks token volume", async function () {
            const { database, signers } = await loadFixture(deployBase);
            await database.setHook(signers.keeper.address);

            const fakeToken = signers.user1.address;
            await database
                .connect(signers.keeper)
                .registerVolume(fakeToken, ethers.ZeroAddress, 777);

            expect(await database.userVolume(fakeToken, ethers.ZeroAddress)).to.equal(0);
            expect(await database.tokenVolume(fakeToken)).to.equal(777);
        });
    });

    describe("master copies", function () {
        it("fixture registers all four module master copies", async function () {
            const { database, masterCopies } = await loadFixture(deployBase);
            expect(await database.moduleMasterCopies(0)).to.equal(await masterCopies.reward.getAddress());
            expect(await database.moduleMasterCopies(1)).to.equal(await masterCopies.burn.getAddress());
            expect(await database.moduleMasterCopies(2)).to.equal(await masterCopies.liquidity.getAddress());
            expect(await database.moduleMasterCopies(3)).to.equal(await masterCopies.creatorFee.getAddress());
        });

        it("unregistered module types return zero", async function () {
            const { database } = await loadFixture(deployBase);
            expect(await database.moduleMasterCopies(99)).to.equal(ethers.ZeroAddress);
        });
    });
});
