// TrustedOperatorRandomness — commit–reveal + blockhash mixing, platform-wide.
//
// The ordering is the security property: the seed hash is committed BEFORE
// participants are known, and revealed after. Get it backwards and the
// operator can grind the winner. See docs/TOKENOMICS_V2.md §3.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBase, loadFixture } = require("./fixtures/deploy");

const KEY = ethers.id("epoch-1");
const SEED = ethers.id("secret seed");
const SEED_HASH = ethers.keccak256(SEED); // keccak256(abi.encodePacked(bytes32))

async function deployRandomness(base) {
    const TrustedOperatorRandomness =
        await ethers.getContractFactory("TrustedOperatorRandomness");
    const provider = await TrustedOperatorRandomness.deploy(await base.database.getAddress());

    const MockRandomnessConsumer =
        await ethers.getContractFactory("MockRandomnessConsumer");
    const consumer = await MockRandomnessConsumer.deploy(await provider.getAddress());

    const scopedKey = await provider.scopedKeyFor(await consumer.getAddress(), KEY);
    return { provider, consumer, scopedKey };
}

describe("TrustedOperatorRandomness", function () {

    it("registers at Database.randomnessProvider (owner-gated, V2 §7.4)", async function () {
        const base = await loadFixture(deployBase);
        const { provider } = await deployRandomness(base);
        await base.database.setRandomnessProvider(await provider.getAddress());
        expect(await base.database.randomnessProvider()).to.equal(await provider.getAddress());
    });

    describe("commit", function () {
        it("stores the seed hash and emits", async function () {
            const base = await loadFixture(deployBase);
            const { provider, scopedKey } = await deployRandomness(base);
            await expect(provider.commit(scopedKey, SEED_HASH))
                .to.emit(provider, "SeedCommitted")
                .withArgs(scopedKey, SEED_HASH, base.signers.owner.address);
            expect(await provider.seedHashes(scopedKey)).to.equal(SEED_HASH);
        });

        it("rejects a zero hash and a re-commit", async function () {
            const base = await loadFixture(deployBase);
            const { provider, scopedKey } = await deployRandomness(base);
            await expect(provider.commit(scopedKey, ethers.ZeroHash))
                .to.be.revertedWith("Zero hash");
            await provider.commit(scopedKey, SEED_HASH);
            // Re-committing after seeing the tickets is the grind this prevents.
            await expect(provider.commit(scopedKey, ethers.id("other")))
                .to.be.revertedWith("Already committed");
        });

        it("is permissionless with no operators, operator-only once one is registered", async function () {
            const base = await loadFixture(deployBase);
            const { provider, scopedKey } = await deployRandomness(base);
            const { user1, keeper } = base.signers;

            // operatorCount == 0 → permissionless (platform default)
            await provider.connect(user1).commit(scopedKey, SEED_HASH);

            await base.database.setOperator(keeper.address, true);
            const key2 = ethers.id("epoch-2");
            await expect(provider.connect(user1).commit(key2, SEED_HASH))
                .to.be.revertedWith("Only operator");
            await provider.connect(keeper).commit(key2, SEED_HASH);
        });
    });

    describe("requestRandomness", function () {
        it("reverts with no prior commit — no commit, no draw", async function () {
            const base = await loadFixture(deployBase);
            const { consumer } = await deployRandomness(base);
            await expect(consumer.request(KEY)).to.be.revertedWith("No commit");
        });

        it("records the request under the consumer-scoped key", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);
            await expect(consumer.request(KEY))
                .to.emit(provider, "RandomnessRequested")
                .withArgs(scopedKey, KEY, await consumer.getAddress(), 1n);
            const req = await provider.requests(scopedKey);
            expect(req.consumer).to.equal(await consumer.getAddress());
            expect(req.fulfilled).to.equal(false);
        });

        it("cannot be requested twice", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);
            await consumer.request(KEY);
            await expect(consumer.request(KEY)).to.be.revertedWith("Already requested");
        });

        it("a stranger using the same raw key cannot squat the consumer's slot", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);

            // The attacker's request lands under THEIR scoped key (and reverts
            // for lack of a commit there); the consumer's slot is untouched.
            await expect(
                provider.connect(base.signers.user1).requestRandomness(KEY),
            ).to.be.revertedWith("No commit");
            await consumer.request(KEY); // still fine
        });
    });

    describe("reveal", function () {
        it("reverts before any request", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);
            await expect(
                provider.reveal(await consumer.getAddress(), KEY, SEED),
            ).to.be.revertedWith("Not requested");
        });

        it("reverts when the seed does not hash to the commit", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);
            await consumer.request(KEY);
            await expect(
                provider.reveal(await consumer.getAddress(), KEY, ethers.id("wrong seed")),
            ).to.be.revertedWith("Bad seed");
        });

        it("delivers keccak(seed, prev blockhash) to the consumer, exactly once", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await provider.commit(scopedKey, SEED_HASH);
            await consumer.request(KEY);

            const tx = await provider.reveal(await consumer.getAddress(), KEY, SEED);
            const receipt = await tx.wait();

            // Recompute the word from the reveal block's parent hash.
            const revealBlock = await ethers.provider.getBlock(receipt.blockNumber);
            const expected = BigInt(ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "bytes32"],
                    [SEED, revealBlock.parentHash],
                ),
            ));

            expect(await consumer.received(KEY)).to.equal(true);
            expect(await consumer.words(KEY)).to.equal(expected);
            await expect(tx).to.emit(provider, "RandomnessFulfilled");

            // Cannot be fulfilled twice.
            await expect(
                provider.reveal(await consumer.getAddress(), KEY, SEED),
            ).to.be.revertedWith("Already fulfilled");
        });

        it("is permissionless — knowing the preimage is the credential", async function () {
            const base = await loadFixture(deployBase);
            const { provider, consumer, scopedKey } = await deployRandomness(base);
            await base.database.setOperator(base.signers.keeper.address, true);
            await provider.connect(base.signers.keeper).commit(scopedKey, SEED_HASH);
            await consumer.request(KEY);
            // Any account holding the published seed can finish the job.
            await provider.connect(base.signers.user3)
                .reveal(await consumer.getAddress(), KEY, SEED);
            expect(await consumer.received(KEY)).to.equal(true);
        });
    });

    describe("MockRandomness (test double)", function () {
        it("auto-fulfills synchronously with the preset word", async function () {
            const MockRandomness = await ethers.getContractFactory("MockRandomness");
            const mock = await MockRandomness.deploy();
            const MockRandomnessConsumer = await ethers.getContractFactory("MockRandomnessConsumer");
            const consumer = await MockRandomnessConsumer.deploy(await mock.getAddress());

            await mock.setWord(1234n);
            await consumer.request(KEY);
            expect(await consumer.words(KEY)).to.equal(1234n);
        });

        it("manual mode defers fulfillment until fulfill() is called", async function () {
            const MockRandomness = await ethers.getContractFactory("MockRandomness");
            const mock = await MockRandomness.deploy();
            const MockRandomnessConsumer = await ethers.getContractFactory("MockRandomnessConsumer");
            const consumer = await MockRandomnessConsumer.deploy(await mock.getAddress());

            await mock.setAutoFulfill(false);
            await mock.setWord(777n);
            await consumer.request(KEY);
            expect(await consumer.received(KEY)).to.equal(false);

            await mock.fulfill(await consumer.getAddress(), KEY);
            expect(await consumer.words(KEY)).to.equal(777n);
            await expect(mock.fulfill(await consumer.getAddress(), KEY))
                .to.be.revertedWith("Already fulfilled");
        });
    });
});
