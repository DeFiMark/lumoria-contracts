const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    deployBase,
    loadFixture,
    prepareTokenShells,
    initializeToken,
    buildCreatorFeeInitData,
    EMPTY_METADATA,
    sampleMetadata,
    MODULE_TYPE,
} = require("./fixtures/deploy");

// LumoriaToken's transfer path calls ITaxHandler.setShare on sender + recipient,
// so tests need a real (initialized) TaxHandler. Using a CreatorFee-only
// handler keeps the fixture simple.

async function launchBasicToken(base, cfg = {}) {
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
        metadata: cfg.metadata,
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
                token.__init__(
                    "X",
                    "Y",
                    base.signers.user1.address,
                    base.signers.user2.address,
                    base.signers.user3.address,
                    EMPTY_METADATA,
                ),
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
                    EMPTY_METADATA,
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

    // Display metadata — the pointers that make a launched token legible to an
    // indexer that has never heard of Lumoria. Storage holds URIs only; the
    // bytes live on permanent content-addressed storage.
    describe("display metadata", function () {
        it("stores the launch metadata and serves it under both conventions", async function () {
            const base = await loadFixture(deployBase);
            const meta = sampleMetadata();
            const { token } = await launchBasicToken(base, { metadata: meta });

            expect(await token.image()).to.equal(meta.image);
            expect(await token.socials()).to.equal(meta.socials);
            expect(await token.contractURI()).to.equal(meta.contractURI);
            // `logo()` is the same slot under the other common name — a scanner
            // that probes only one of the two must still find the artwork.
            expect(await token.logo()).to.equal(meta.image);
        });

        it("announces the contractURI at launch so ERC-7572 indexers see it", async function () {
            const base = await loadFixture(deployBase);
            const shells = await prepareTokenShells(base);
            const modules = [{
                moduleType: MODULE_TYPE.CREATOR,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildCreatorFeeInitData(base.signers.creator.address),
            }];

            // `initializeToken` hands back the token's own `__init__` tx —
            // the launch-time announcement is otherwise unobservable.
            const initTx = await initializeToken(base, shells, {
                name: "Meta",
                symbol: "MTA",
                pair: base.signers.user3.address,
                creator: base.signers.creator,
                buyFee: 500,
                sellFee: 500,
                modules,
                metadata: sampleMetadata(),
            });
            await expect(initTx).to.emit(shells.token, "ContractURIUpdated");
        });

        it("stays silent at launch when there is no contractURI to announce", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base); // EMPTY_METADATA

            expect(await token.image()).to.equal("");
            expect(await token.socials()).to.equal("");
            expect(await token.contractURI()).to.equal("");
            // A launch with no artwork must not emit an empty ERC-7572 signal —
            // an indexer that saw one would fetch "" and cache a broken record.
            const logs = await token.queryFilter(token.filters.ContractURIUpdated());
            expect(logs.length).to.equal(0);
        });

        it("lets the creator update each field, and nobody else", async function () {
            const base = await loadFixture(deployBase);
            const { token } = await launchBasicToken(base, { metadata: sampleMetadata() });
            const { creator, user1 } = base.signers;

            await expect(token.connect(creator).setImage("https://arweave.net/new-art"))
                .to.emit(token, "ImageUpdated")
                .withArgs("https://arweave.net/new-art");
            expect(await token.image()).to.equal("https://arweave.net/new-art");
            expect(await token.logo()).to.equal("https://arweave.net/new-art");

            await expect(token.connect(creator).setSocials('{"website":"https://new.example"}'))
                .to.emit(token, "SocialsUpdated")
                .withArgs('{"website":"https://new.example"}');
            expect(await token.socials()).to.equal('{"website":"https://new.example"}');

            // ERC-7572: the event carries no arguments — indexers re-read.
            await expect(token.connect(creator).setContractURI("https://arweave.net/new-meta"))
                .to.emit(token, "ContractURIUpdated");
            expect(await token.contractURI()).to.equal("https://arweave.net/new-meta");

            for (const call of [
                token.connect(user1).setImage("x"),
                token.connect(user1).setSocials("x"),
                token.connect(user1).setContractURI("x"),
            ]) {
                await expect(call).to.be.revertedWith("Only creator");
            }
        });

        it("freezes metadata when the creator renounces management", async function () {
            const base = await loadFixture(deployBase);
            const { token, taxHandler } = await launchBasicToken(base, {
                metadata: sampleMetadata(),
            });
            const { creator } = base.signers;
            const frozen = await token.image();

            await taxHandler.connect(creator).renounceManagement();

            // "Renounced" is sold as a total, verifiable freeze. If the artwork
            // and the socials stayed editable, a renounced token's public
            // identity would still be rug-pullable and the promise would be a
            // half-truth — so metadata freezes with the tokenomics.
            await expect(token.connect(creator).setImage("https://arweave.net/rug"))
                .to.be.revertedWith("Renounced");
            await expect(token.connect(creator).setSocials("{}"))
                .to.be.revertedWith("Renounced");
            await expect(token.connect(creator).setContractURI("https://arweave.net/rug"))
                .to.be.revertedWith("Renounced");

            expect(await token.image()).to.equal(frozen);
        });
    });
});
