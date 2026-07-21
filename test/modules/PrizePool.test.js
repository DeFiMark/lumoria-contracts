// PrizePool (type 4) — epoch-bucketed tax, off-chain tickets, merkle settlement.
//
// The load-bearing properties under test:
//   - ORDER: the root is committed before randomness exists, and the
//     challenge window elapses before either a draw or a claim.
//   - PULL: every payout is a permissionless O(1) claim.
//   - ROLLOVER: every failure path moves the pot to the live epoch;
//     no BNB is ever stranded.
//   - receiveTax stays accrue-only under a real V4 swap.
//
// See docs/TOKENOMICS_V2.md §2 and MODULE_BUILD_HANDOFF.md §5 (B3).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    launchTokenWithPool,
    buildPrizePoolInitData,
    buildRewardInitData,
    MODULE_TYPE,
    PAYOUT_MODE,
} = require("../fixtures/deploy");
const {
    buildProRataSettlement,
    buildLotterySettlement,
} = require("../../scripts/lib/merkle");

const E = ethers.parseEther;
const coder = ethers.AbiCoder.defaultAbiCoder();

const DAY = 24 * 60 * 60;
const CHALLENGE_WINDOW = 6 * 60 * 60;
const RANDOMNESS_DEADLINE = 3 * DAY;
const CLAIM_WINDOW = 30 * DAY;

const epochKey = (epochId) => ethers.toBeHex(epochId, 32); // bytes32(epochId)

// Launch a token whose entire tax goes to a PrizePool. Extra init fields via cfg.
async function launchWithPrize(base, cfg = {}) {
    const launched = await launchTokenWithPool(base, {
        creator: base.signers.creator,
        modules: (shells) => [{
            moduleType: MODULE_TYPE.PRIZE,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildPrizePoolInitData({
                token: shells.tokenAddr,
                database: base.databaseAddr,
                rootPoster: base.signers.keeper.address,
                holdRequirementBps: 0n, // hold tests opt in explicitly
                ...cfg,
            }),
        }],
    });
    const mc = await launched.taxHandler.getModule(0);
    const prize = await ethers.getContractAt("PrizePool", mc.moduleAddress);
    return { ...launched, prize };
}

// ALL_HOLDERS variant, optionally paired with a RewardModule.
async function launchAllHolders(base, { withReward = true, ...cfg } = {}) {
    const prizeBps = withReward ? 5000 : 10000;
    const launched = await launchTokenWithPool(base, {
        creator: base.signers.creator,
        modules: (shells) => {
            const mods = [{
                moduleType: MODULE_TYPE.PRIZE,
                buyAllocation: prizeBps,
                sellAllocation: prizeBps,
                initPayload: buildPrizePoolInitData({
                    token: shells.tokenAddr,
                    database: base.databaseAddr,
                    payoutMode: PAYOUT_MODE.ALL_HOLDERS,
                    holdRequirementBps: 0n,
                    ...cfg,
                }),
            }];
            if (withReward) {
                mods.push({
                    moduleType: MODULE_TYPE.REWARD,
                    buyAllocation: 5000,
                    sellAllocation: 5000,
                    initPayload: buildRewardInitData({ token: shells.tokenAddr }),
                });
            }
            return mods;
        },
    });
    const prizeCfg = await launched.taxHandler.getModule(0);
    const prize = await ethers.getContractAt("PrizePool", prizeCfg.moduleAddress);
    let rewardMod = null;
    if (withReward) {
        const rc = await launched.taxHandler.getModule(1);
        rewardMod = await ethers.getContractAt("RewardModule", rc.moduleAddress);
    }
    return { ...launched, prize, rewardMod };
}

async function fund(launched, bnb) {
    await launched.taxHandler.receiveBuyTax({ value: bnb });
}

async function deployMock(base) {
    const MockRandomness = await ethers.getContractFactory("MockRandomness");
    const mock = await MockRandomness.deploy();
    await base.database.setRandomnessProvider(await mock.getAddress());
    return mock;
}

// Standard three-buyer lottery ticket set (weights sum to 1000 BNB-wei units).
function lotteryTickets(base) {
    const { user1, user2, user3 } = base.signers;
    return [
        { account: user1.address, weight: E("1"), tokensBought: 0n },
        { account: user2.address, weight: E("2"), tokensBought: 0n },
        { account: user3.address, weight: E("7"), tokensBought: 0n },
    ];
}

// Find a random word for which every requested slot lands on the wanted
// ticket index (deterministic search, mirrors the contract's r derivation).
function findWord(settlement, wants /* {slot: index} */) {
    for (let w = 0n; w < 50000n; w++) {
        let ok = true;
        for (const [slot, idx] of Object.entries(wants)) {
            if (settlement.winningIndex(w, BigInt(slot)) !== idx) { ok = false; break; }
        }
        if (ok) return w;
    }
    throw new Error("no word found");
}

before(async function () {
    // launchWithPrize needs the database address synchronously in a builder.
    // Stash it on the base inside each fixture load instead of re-awaiting.
});

describe("PrizePool", function () {

    async function fixture() {
        const base = await loadFixture(deployBase);
        base.databaseAddr = await base.database.getAddress();
        return base;
    }

    describe("initialization", function () {
        it("stores config, reports type 4, rejects re-init", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            expect(await l.prize.getModuleType()).to.equal(4);
            expect(await l.prize.taxHandler()).to.equal(l.taxHandlerAddr);
            expect(await l.prize.token()).to.equal(l.tokenAddr);
            expect(await l.prize.payoutMode()).to.equal(PAYOUT_MODE.PRO_RATA);
            expect(await l.prize.epochLength()).to.equal(DAY);
            expect(await l.prize.rootPoster()).to.equal(base.signers.keeper.address);
            await expect(l.prize.__init__("0x" + "00".repeat(352)))
                .to.be.revertedWith("Already initialized");
        });

        it("validates the payload bounds", async function () {
            const base = await fixture();
            const PrizePool = await ethers.getContractFactory("PrizePool");
            const raw = await PrizePool.deploy();
            const good = {
                token: base.signers.user1.address,
                database: base.databaseAddr,
                rootPoster: base.signers.keeper.address,
            };
            const cases = [
                [{ ...good, payoutMode: 3 }, "Bad mode"],
                [{ ...good, epochLength: 60 }, "Bad epoch length"],
                [{ ...good, epochLength: 31 * DAY }, "Bad epoch length"],
                [{ ...good, holdRequirementBps: 10001n }, "Bad hold bps"],
                [{ ...good, maxWeightBps: 10001n }, "Bad weight cap"],
                [{ ...good, settleBountyBps: 501n }, "Bad bounty"],
                [{ ...good, payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 0 }, "Bad winner count"],
                [{ ...good, payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 11 }, "Bad winner count"],
            ];
            for (const [cfg, msg] of cases) {
                await expect(raw.__init__(buildPrizePoolInitData(cfg)))
                    .to.be.revertedWith(msg);
            }
        });
    });

    describe("epoch math (§2.3)", function () {
        it("buckets tax into the live epoch and jumps cleanly over dead epochs", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await fund(l, E("1"));
            expect(await l.prize.epochPot(0)).to.equal(E("1"));

            // Five epochs of silence — the jump loses nothing because the
            // skipped epochs were necessarily empty.
            await time.increase(5 * DAY + 1);
            await fund(l, E("2"));
            expect(await l.prize.currentEpochId()).to.equal(5n);
            expect(await l.prize.epochPot(5)).to.equal(E("2"));
            expect(await l.prize.epochPot(0)).to.equal(E("1")); // untouched
        });

        it("a queued epoch-length change applies at the NEXT boundary, never mid-flight", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            const creator = base.signers.creator;

            await expect(l.prize.connect(base.signers.user1).setEpochLength(2 * DAY))
                .to.be.revertedWith("Only creator");
            await expect(l.prize.connect(creator).setEpochLength(60))
                .to.be.revertedWith("Bad epoch length");

            await expect(l.prize.connect(creator).setEpochLength(2 * DAY))
                .to.emit(l.prize, "EpochLengthQueued").withArgs(2 * DAY);

            // Still inside epoch 0 — the in-flight epoch keeps its length.
            expect(await l.prize.epochLength()).to.equal(DAY);
            await time.increase(DAY - 3600);
            await fund(l, E("1"));
            expect(await l.prize.currentEpochId()).to.equal(0n);

            // Cross the boundary: the new length applies from epoch 1 on.
            await time.increase(3600 + 1);
            await expect(l.taxHandler.receiveBuyTax({ value: E("1") }))
                .to.emit(l.prize, "EpochLengthApplied");
            expect(await l.prize.epochLength()).to.equal(2 * DAY);
            expect(await l.prize.currentEpochId()).to.equal(1n);

            // One old-length day later we are STILL in epoch 1 (it is 2 days now).
            await time.increase(DAY + 1);
            await fund(l, E("1"));
            expect(await l.prize.currentEpochId()).to.equal(1n);
        });
    });

    describe("receiveTax — the swap-path invariant", function () {
        it("rejects direct callers", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await expect(l.prize.receiveTax({ value: E("1") }))
                .to.be.revertedWith("Only taxHandler");
        });

        it("a full V4 buy/sell cycle with the PrizePool installed cannot revert", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            const { user1, owner } = base.signers;

            await l.token.connect(owner).approve(base.router, E("100000000"));
            await base.router.connect(owner).addLiquidityETH(
                l.tokenAddr, E("100000000"), 0, 0, owner.address,
                (await ethers.provider.getBlock("latest")).timestamp + 3600,
                { value: E("50") },
            );

            const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
            await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0, [ethers.ZeroAddress, l.tokenAddr], user1.address, deadline, { value: E("1") },
            );
            expect(await l.prize.epochPot(0)).to.be.gt(0n);

            const tokens = await l.token.balanceOf(user1.address);
            await l.token.connect(user1).approve(base.router, tokens);
            await base.router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
                tokens, 0, [l.tokenAddr, ethers.ZeroAddress], user1.address, deadline,
            );
        });
    });

    describe("postRoot (§2.6 phase 1)", function () {
        it("only the rootPoster, only after the epoch ends, only once", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await fund(l, E("10"));
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);

            await expect(
                l.prize.connect(base.signers.user1).postRoot(0, s.root, s.totalWeight, 1),
            ).to.be.revertedWith("Only rootPoster");

            await expect(
                l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1),
            ).to.be.revertedWith("Epoch not ended");

            await time.increase(DAY + 1);
            await expect(
                l.prize.connect(base.signers.keeper).postRoot(0, ethers.ZeroHash, s.totalWeight, 1),
            ).to.be.revertedWith("Zero root");

            await expect(l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1))
                .to.emit(l.prize, "RootPosted").withArgs(0, s.root, s.totalWeight, 1);

            await expect(
                l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1),
            ).to.be.revertedWith("Already settled");
        });

        it("rootPoster == 0 delegates to the platform operator registry (no permissionless fallback)", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, { rootPoster: ethers.ZeroAddress });
            await fund(l, E("10"));
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);
            await time.increase(DAY + 1);

            // No operators registered → nobody may post; the epoch just waits.
            await expect(
                l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1),
            ).to.be.revertedWith("Only operator");

            // Register an operator → that address may post.
            await base.database.connect(base.signers.owner).setOperator(base.signers.keeper.address, true);
            await expect(l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1))
                .to.emit(l.prize, "RootPosted").withArgs(0, s.root, s.totalWeight, 1);
        });

        it("an explicit rootPoster overrides the registry — operators may NOT post", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base); // rootPoster = keeper (explicit)
            await fund(l, E("10"));
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);
            await time.increase(DAY + 1);

            await base.database.connect(base.signers.owner).setOperator(base.signers.user2.address, true);
            await expect(
                l.prize.connect(base.signers.user2).postRoot(0, s.root, s.totalWeight, 1),
            ).to.be.revertedWith("Only rootPoster");
        });

        it("pays the settle bounty out of the pot", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, { settleBountyBps: 500n }); // 5%
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);
            await expect(l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1))
                .to.emit(l.prize, "SettleBountyPaid")
                .withArgs(0, base.signers.keeper.address, E("0.5"));
            expect((await l.prize.settlements(0)).pot).to.equal(E("9.5"));
        });

        it("rolls over: no tickets / below min pot / below min participants — nothing strands", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, { minPot: E("5"), minParticipants: 3n });
            const keeper = base.signers.keeper;
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);

            // Epoch 0: nobody bought.
            await fund(l, E("1"));
            await time.increase(DAY + 1);
            await expect(l.prize.connect(keeper).postRoot(0, ethers.ZeroHash, 0, 0))
                .to.emit(l.prize, "PotRolledOver").withArgs(0, 1, E("1"), "no tickets");
            expect(await l.prize.epochPot(1)).to.equal(E("1"));
            await expect(l.prize.connect(keeper).postRoot(0, s.root, s.totalWeight, 1))
                .to.be.revertedWith("Already settled");

            // Epoch 1: pot (1 + 2) below minPot 5.
            await fund(l, E("2"));
            await time.increase(DAY + 1);
            await expect(l.prize.connect(keeper).postRoot(1, s.root, s.totalWeight, 5))
                .to.emit(l.prize, "PotRolledOver").withArgs(1, 2, E("3"), "below min pot");

            // Epoch 2: pot fine (3 + 4 = 7), but only 1 participant < 3.
            await fund(l, E("4"));
            await time.increase(DAY + 1);
            await expect(l.prize.connect(keeper).postRoot(2, s.root, s.totalWeight, 1))
                .to.emit(l.prize, "PotRolledOver").withArgs(2, 3, E("7"), "below min participants");

            // Everything is in epoch 3's pot; nothing stranded.
            expect(await l.prize.epochPot(3)).to.equal(E("7"));
            expect(await ethers.provider.getBalance(l.prize)).to.equal(E("7"));
        });
    });

    describe("ordering — root before randomness (§2.6)", function () {
        it("drawRandomness before postRoot reverts", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 3,
            });
            await deployMock(base);
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            await expect(l.prize.drawRandomness(0)).to.be.revertedWith("No root");
        });

        it("drawRandomness waits out the challenge window, needs a provider, runs once", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 3,
            });
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const s = buildLotterySettlement(lotteryTickets(base));
            await l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 3);

            await expect(l.prize.drawRandomness(0)).to.be.revertedWith("Challenge window");
            await time.increase(CHALLENGE_WINDOW + 1);
            await expect(l.prize.drawRandomness(0)).to.be.revertedWith("No provider");

            const mock = await deployMock(base);
            await mock.setWord(42n);
            await expect(l.prize.drawRandomness(0))
                .to.emit(l.prize, "RandomnessFulfilled").withArgs(0, 42n);
            await expect(l.prize.drawRandomness(0)).to.be.revertedWith("Already requested");
        });

        it("fulfillRandomness is provider-only and single-shot", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 3,
            });
            const mock = await deployMock(base);
            await mock.setAutoFulfill(false);
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const s = buildLotterySettlement(lotteryTickets(base));
            await l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 3);
            await time.increase(CHALLENGE_WINDOW + 1);
            await l.prize.drawRandomness(0);

            await expect(l.prize.fulfillRandomness(epochKey(0), 1n))
                .to.be.revertedWith("Only provider");

            await mock.setWord(7n);
            await mock.fulfill(await l.prize.getAddress(), epochKey(0));
            expect((await l.prize.settlements(0)).randomWord).to.equal(7n);
            // The mock guards double-fulfill; the pool guards its own state too.
            await expect(mock.fulfill(await l.prize.getAddress(), epochKey(0)))
                .to.be.revertedWith("Already fulfilled");
        });

        it("drawRandomness reverts on a PRO_RATA pool", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await expect(l.prize.drawRandomness(0)).to.be.revertedWith("Wrong mode");
        });
    });

    describe("pro-rata claims (§2.7)", function () {
        async function settledProRata(base, cfg = {}) {
            const l = await launchWithPrize(base, cfg);
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const { user1, user2 } = base.signers;
            const s = buildProRataSettlement([
                { account: user1.address, weight: E("1"), tokensBought: 0n },
                { account: user2.address, weight: E("3"), tokensBought: 0n },
            ]);
            await l.prize.connect(base.signers.keeper)
                .postRoot(0, s.root, s.totalWeight, 2);
            return { l, s };
        }

        it("claims are blocked during the challenge window, then pay pot*weight/totalWeight once", async function () {
            const base = await fixture();
            const { l, s } = await settledProRata(base);
            const { user1, user2 } = base.signers;

            const p1 = s.proofFor(user1.address);
            await expect(
                l.prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof),
            ).to.be.revertedWith("Challenge window");

            await time.increase(CHALLENGE_WINDOW + 1);
            const before = await ethers.provider.getBalance(user1.address);
            const tx = await l.prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof);
            const receipt = await tx.wait();
            const after = await ethers.provider.getBalance(user1.address);
            expect(after - before + receipt.gasUsed * receipt.gasPrice).to.equal(E("2.5")); // 10 * 1/4

            await expect(
                l.prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof),
            ).to.be.revertedWith("Already claimed");

            const p2 = s.proofFor(user2.address);
            await expect(l.prize.connect(user2).claim(0, p2.weight, p2.tokensBought, p2.proof))
                .to.emit(l.prize, "PrizeClaimed").withArgs(0, user2.address, E("7.5"));
        });

        it("a forged leaf fails, and someone else's proof fails", async function () {
            const base = await fixture();
            const { l, s } = await settledProRata(base);
            const { user1, user3 } = base.signers;
            await time.increase(CHALLENGE_WINDOW + 1);

            const p1 = s.proofFor(user1.address);
            // Inflated weight.
            await expect(
                l.prize.connect(user1).claim(0, p1.weight * 2n, p1.tokensBought, p1.proof),
            ).to.be.revertedWith("Bad proof");
            // user3 is not in the tree, even with a valid-shaped proof.
            await expect(
                l.prize.connect(user3).claim(0, p1.weight, p1.tokensBought, p1.proof),
            ).to.be.revertedWith("Bad proof");
        });

        it("a leaf from epoch e cannot be replayed at e+1", async function () {
            const base = await fixture();
            const { l, s } = await settledProRata(base);
            const { user1, user2, keeper } = base.signers;

            // Settle epoch 1 with a DIFFERENT ticket set (user2 only).
            await fund(l, E("4"));
            await time.increase(DAY + 1);
            const s2 = buildProRataSettlement([
                { account: user2.address, weight: E("5"), tokensBought: 0n },
            ]);
            await l.prize.connect(keeper).postRoot(1, s2.root, s2.totalWeight, 1);
            await time.increase(CHALLENGE_WINDOW + 1);

            // user1's perfectly valid epoch-0 entitlement fails against epoch 1.
            const p1 = s.proofFor(user1.address);
            await expect(
                l.prize.connect(user1).claim(1, p1.weight, p1.tokensBought, p1.proof),
            ).to.be.revertedWith("Bad proof");
        });

        it("hold requirement: buy, dump, claim reverts; buy, hold, claim succeeds", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, { holdRequirementBps: 10000n });
            await fund(l, E("10"));
            const { owner, user1, user2, keeper } = base.signers;

            // user1 "bought" 1000 tokens and still holds them; user2 dumped.
            await l.token.connect(owner).transfer(user1.address, E("1000"));

            await time.increase(DAY + 1);
            const s = buildProRataSettlement([
                { account: user1.address, weight: E("1"), tokensBought: E("1000") },
                { account: user2.address, weight: E("1"), tokensBought: E("1000") },
            ]);
            await l.prize.connect(keeper).postRoot(0, s.root, s.totalWeight, 2);
            await time.increase(CHALLENGE_WINDOW + 1);

            const p2 = s.proofFor(user2.address);
            await expect(
                l.prize.connect(user2).claim(0, p2.weight, p2.tokensBought, p2.proof),
            ).to.be.revertedWith("Sold before claim");

            const p1 = s.proofFor(user1.address);
            await expect(l.prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof))
                .to.emit(l.prize, "PrizeClaimed");
        });

        it("after the claim window, claims close and the remainder sweeps to the live epoch", async function () {
            const base = await fixture();
            const { l, s } = await settledProRata(base);
            const { user1, user2 } = base.signers;

            await time.increase(CHALLENGE_WINDOW + 1);
            const p1 = s.proofFor(user1.address);
            await l.prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof); // takes 2.5

            await expect(l.prize.sweepUnclaimed(0)).to.be.revertedWith("Claim window open");
            await time.increase(CLAIM_WINDOW + 1);

            const p2 = s.proofFor(user2.address);
            await expect(
                l.prize.connect(user2).claim(0, p2.weight, p2.tokensBought, p2.proof),
            ).to.be.revertedWith("Claim window closed");

            const liveEpoch = await l.prize.liveEpochId();
            await expect(l.prize.sweepUnclaimed(0))
                .to.emit(l.prize, "PotRolledOver").withArgs(0, liveEpoch, E("7.5"), "unclaimed");
            await expect(l.prize.sweepUnclaimed(0)).to.be.revertedWith("Nothing to sweep");
            expect(await l.prize.epochPot(liveEpoch)).to.equal(E("7.5"));
        });
    });

    describe("lottery claims (§2.7)", function () {
        async function settledLottery(base, { word, winnerCount = 3, tickets } = {}) {
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount,
            });
            const mock = await deployMock(base);
            await mock.setWord(word);
            await fund(l, E("9"));
            await time.increase(DAY + 1);
            const s = buildLotterySettlement(tickets ?? lotteryTickets(base));
            await l.prize.connect(base.signers.keeper)
                .postRoot(0, s.root, s.totalWeight, s.ticketCount);
            await time.increase(CHALLENGE_WINDOW + 1);
            await l.prize.drawRandomness(0);
            return { l, s, mock };
        }

        function signerFor(base, address) {
            const { user1, user2, user3 } = base.signers;
            return [user1, user2, user3].find((x) => x.address === address);
        }

        it("only the ticket whose [cumBefore, cumBefore+weight) contains r wins the slot", async function () {
            const base = await fixture();
            const probe = buildLotterySettlement(lotteryTickets(base));
            const word = findWord(probe, { 0: 2 }); // slot 0 → ticket 2 (user3)
            const { l, s } = await settledLottery(base, { word });

            // An adjacent (losing) ticket with a perfectly valid proof is rejected.
            const loser = s.proofFor(1);
            await expect(
                l.prize.connect(signerFor(base, loser.account)).claimLottery(
                    0, 0, loser.index, loser.weight, loser.cumBefore, loser.tokensBought, loser.proof,
                ),
            ).to.be.revertedWith("Not the winner");

            // The winning ticket claims pot/winnerCount.
            const winner = s.proofFor(2);
            await expect(
                l.prize.connect(signerFor(base, winner.account)).claimLottery(
                    0, 0, winner.index, winner.weight, winner.cumBefore, winner.tokensBought, winner.proof,
                ),
            ).to.emit(l.prize, "LotteryClaimed").withArgs(0, 0, winner.account, E("3"));

            // Duplicate slot claim rejected.
            await expect(
                l.prize.connect(signerFor(base, winner.account)).claimLottery(
                    0, 0, winner.index, winner.weight, winner.cumBefore, winner.tokensBought, winner.proof,
                ),
            ).to.be.revertedWith("Slot claimed");

            // Slot out of range rejected.
            await expect(
                l.prize.connect(signerFor(base, winner.account)).claimLottery(
                    0, 3, winner.index, winner.weight, winner.cumBefore, winner.tokensBought, winner.proof,
                ),
            ).to.be.revertedWith("Bad slot");
        });

        it("the same account winning two slots is accepted — weighted sampling WITH replacement", async function () {
            const base = await fixture();
            const probe = buildLotterySettlement(lotteryTickets(base));
            const word = findWord(probe, { 0: 2, 1: 2 }); // both slots → user3's ticket
            const { l, s } = await settledLottery(base, { word });

            const w = s.proofFor(2);
            const signer = signerFor(base, w.account);
            await l.prize.connect(signer).claimLottery(
                0, 0, w.index, w.weight, w.cumBefore, w.tokensBought, w.proof,
            );
            await expect(
                l.prize.connect(signer).claimLottery(
                    0, 1, w.index, w.weight, w.cumBefore, w.tokensBought, w.proof,
                ),
            ).to.emit(l.prize, "LotteryClaimed").withArgs(0, 1, w.account, E("3"));
        });

        it("a forged lottery leaf fails; claims need randomness first", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 3,
            });
            await deployMock(base);
            await fund(l, E("9"));
            await time.increase(DAY + 1);
            const s = buildLotterySettlement(lotteryTickets(base));
            await l.prize.connect(base.signers.keeper)
                .postRoot(0, s.root, s.totalWeight, s.ticketCount);
            await time.increase(CHALLENGE_WINDOW + 1);

            const p = s.proofFor(0);
            await expect(
                l.prize.connect(base.signers.user1).claimLottery(
                    0, 0, p.index, p.weight, p.cumBefore, p.tokensBought, p.proof,
                ),
            ).to.be.revertedWith("No randomness");

            await l.prize.drawRandomness(0);
            // Tampered cumBefore to move the range under r: proof fails first.
            await expect(
                l.prize.connect(base.signers.user1).claimLottery(
                    0, 0, p.index, p.weight, p.cumBefore + 1n, p.tokensBought, p.proof,
                ),
            ).to.be.revertedWith("Bad proof");
        });

        it("withheld randomness past the deadline rolls the epoch over instead of freezing it", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 3,
            });
            const mock = await deployMock(base);
            await mock.setAutoFulfill(false); // operator withholds the reveal
            await fund(l, E("9"));
            await time.increase(DAY + 1);
            const s = buildLotterySettlement(lotteryTickets(base));
            await l.prize.connect(base.signers.keeper)
                .postRoot(0, s.root, s.totalWeight, s.ticketCount);
            await time.increase(CHALLENGE_WINDOW + 1);
            await l.prize.drawRandomness(0);

            await expect(l.prize.rolloverStaleRandomness(0))
                .to.be.revertedWith("Deadline not reached");
            await time.increase(RANDOMNESS_DEADLINE);

            const liveEpoch = await l.prize.liveEpochId();
            await expect(l.prize.rolloverStaleRandomness(0))
                .to.emit(l.prize, "PotRolledOver")
                .withArgs(0, liveEpoch, E("9"), "randomness timeout");

            // A late reveal can no longer resurrect the epoch.
            await expect(mock.fulfill(await l.prize.getAddress(), epochKey(0)))
                .to.be.revertedWith("Rolled over");
            expect(await l.prize.epochPot(liveEpoch)).to.equal(E("9"));
        });
    });

    describe("challenge window — invalidateRoot (§5)", function () {
        it("platform owner may void a root inside the window; the pot rolls over", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const { user1, keeper, owner } = base.signers;
            const s = buildProRataSettlement([
                { account: user1.address, weight: E("1"), tokensBought: 0n },
            ]);
            await l.prize.connect(keeper).postRoot(0, s.root, s.totalWeight, 1);

            await expect(l.prize.connect(user1).invalidateRoot(0))
                .to.be.revertedWith("Only platform owner");

            const liveEpoch = await l.prize.liveEpochId();
            await expect(l.prize.connect(owner).invalidateRoot(0))
                .to.emit(l.prize, "RootInvalidated").withArgs(0)
                .and.to.emit(l.prize, "PotRolledOver")
                .withArgs(0, liveEpoch, E("10"), "root invalidated");

            // Claims against the voided root are dead.
            await time.increase(CHALLENGE_WINDOW + 1);
            const p = s.proofFor(user1.address);
            await expect(
                l.prize.connect(user1).claim(0, p.weight, p.tokensBought, p.proof),
            ).to.be.revertedWith("Not settled");
        });

        it("after the window closes the root is final even for the owner", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base);
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            const s = buildProRataSettlement([
                { account: base.signers.user1.address, weight: E("1"), tokensBought: 0n },
            ]);
            await l.prize.connect(base.signers.keeper).postRoot(0, s.root, s.totalWeight, 1);
            await time.increase(CHALLENGE_WINDOW + 1);
            await expect(l.prize.connect(base.signers.owner).invalidateRoot(0))
                .to.be.revertedWith("Window closed");
        });
    });

    describe("ALL_HOLDERS mode (§2.2)", function () {
        it("delegates the pot to the RewardModule's donate() — no second accumulator", async function () {
            const base = await fixture();
            const l = await launchAllHolders(base);
            const { owner, user1 } = base.signers;

            // Give user1 the supply so shares exist.
            const supply = await l.token.balanceOf(owner.address);
            await l.token.connect(owner).transfer(user1.address, supply);

            await fund(l, E("10")); // 5 to prize, 5 straight to reward
            await time.increase(DAY + 1);

            const rmAddr = await l.rewardMod.getAddress();
            await expect(l.prize.settleAllHolders(0))
                .to.emit(l.prize, "DonatedToRewards").withArgs(0, rmAddr, E("5"))
                .and.to.emit(l.rewardMod, "Donated")
                .withArgs(await l.prize.getAddress(), E("5"));

            expect(await l.rewardMod.getUnpaidRewards(user1.address))
                .to.be.closeTo(E("10"), E("0.000001"));
            await expect(l.prize.settleAllHolders(0)).to.be.revertedWith("Already settled");
        });

        it("rolls over instead of reverting when the token has no RewardModule", async function () {
            const base = await fixture();
            const l = await launchAllHolders(base, { withReward: false });
            await fund(l, E("10"));
            await time.increase(DAY + 1);
            await expect(l.prize.settleAllHolders(0))
                .to.emit(l.prize, "PotRolledOver").withArgs(0, 1, E("10"), "no reward module");
            expect(await l.prize.epochPot(1)).to.equal(E("10"));
        });

        it("respects minPot, pays the settle bounty, and rejects other modes", async function () {
            const base = await fixture();
            const l = await launchAllHolders(base, { minPot: E("100"), settleBountyBps: 100n });
            await fund(l, E("10")); // 5 to prize < minPot
            await time.increase(DAY + 1);
            await expect(l.prize.settleAllHolders(0))
                .to.emit(l.prize, "PotRolledOver").withArgs(0, 1, E("5"), "below min pot");

            const proRata = await launchWithPrize(base);
            await expect(proRata.prize.settleAllHolders(0)).to.be.revertedWith("Wrong mode");
        });
    });

    describe("end-to-end with TrustedOperatorRandomness", function () {
        it("commit → postRoot → challenge window → draw → reveal → winning claim", async function () {
            const base = await fixture();
            const l = await launchWithPrize(base, {
                payoutMode: PAYOUT_MODE.LOTTERY, winnerCount: 1,
            });

            const TrustedOperatorRandomness =
                await ethers.getContractFactory("TrustedOperatorRandomness");
            const provider = await TrustedOperatorRandomness.deploy(base.databaseAddr);
            await base.database.setRandomnessProvider(await provider.getAddress());

            // 1. Operator commits the seed BEFORE the epoch's buyers are known.
            const seed = ethers.id("operator seed for epoch 0");
            const scopedKey = await provider.scopedKeyFor(await l.prize.getAddress(), epochKey(0));
            await provider.commit(scopedKey, ethers.keccak256(seed));

            // 2. The epoch happens.
            await fund(l, E("9"));
            await time.increase(DAY + 1);

            // 3. Root, window, draw, reveal.
            const s = buildLotterySettlement(lotteryTickets(base));
            await l.prize.connect(base.signers.keeper)
                .postRoot(0, s.root, s.totalWeight, s.ticketCount);
            await time.increase(CHALLENGE_WINDOW + 1);
            await l.prize.drawRandomness(0);
            await provider.reveal(await l.prize.getAddress(), epochKey(0), seed);

            const word = (await l.prize.settlements(0)).randomWord;
            expect(word).to.not.equal(0n);

            // 4. The winner (computed exactly as the contract does) claims.
            const idx = s.winningIndex(word, 0n);
            const w = s.proofFor(idx);
            const { user1, user2, user3 } = base.signers;
            const signer = [user1, user2, user3].find((x) => x.address === w.account);
            await expect(
                l.prize.connect(signer).claimLottery(
                    0, 0, w.index, w.weight, w.cumBefore, w.tokensBought, w.proof,
                ),
            ).to.emit(l.prize, "LotteryClaimed").withArgs(0, 0, w.account, E("9"));
        });
    });
});
