// Operator tooling end-to-end: REAL router buys → TokenPurchased logs →
// scripts/operator/lib/tickets.js derivation → scripts/lib/merkle.js root →
// postRoot → on-chain claim with the derived proof.
//
// This is the closed loop the PrizePool's trust model rests on: anyone can
// recompute the root from public events (TOKENOMICS_V2 §5). If this test
// passes, the operator script, the merkle lib, and the contract agree.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
    deployBase,
    loadFixture,
    launchTokenWithPool,
    buildPrizePoolInitData,
    buildBurnInitData,
    farDeadline,
    MODULE_TYPE,
    PAYOUT_MODE,
} = require("../fixtures/deploy");
const { deriveTickets } = require("../../scripts/operator/lib/tickets");
const { buildProRataSettlement } = require("../../scripts/lib/merkle");

const E = ethers.parseEther;
const DAY = 24 * 60 * 60;
const CHALLENGE_WINDOW = 6 * 60 * 60;

describe("operator settlement loop (tickets.js + merkle.js)", function () {
    it("derives tickets from real hook logs and settles a claimable root", async function () {
        const base = await loadFixture(deployBase);
        base.databaseAddr = await base.database.getAddress();
        const { owner, user1, user2, keeper } = base.signers;

        const l = await launchTokenWithPool(base, {
            creator: base.signers.creator,
            modules: (shells) => [{
                moduleType: MODULE_TYPE.PRIZE,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildPrizePoolInitData({
                    token: shells.tokenAddr,
                    database: base.databaseAddr,
                    payoutMode: PAYOUT_MODE.PRO_RATA,
                    rootPoster: keeper.address,
                    holdRequirementBps: 10000n, // buyers must still hold
                }),
            }],
            initialLiquidity: { tokens: E("100000000"), bnb: E("50") },
        });
        const mc = await l.taxHandler.getModule(0);
        const prize = await ethers.getContractAt("PrizePool", mc.moduleAddress);

        // Two attributed buys through the Lumoria router in epoch 0.
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        for (const [signer, bnb] of [[user1, E("1")], [user2, E("3")]]) {
            await base.router.connect(signer).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0, [ethers.ZeroAddress, l.tokenAddr], signer.address, deadline, { value: bnb },
            );
        }

        // Close the epoch.
        await time.increase(DAY + 1);

        // Operator side: derive tickets from the logs alone.
        const { tickets, config } = await deriveTickets(await prize.getAddress(), 0);
        expect(tickets.length).to.equal(2);
        expect(tickets[0].account).to.equal(user1.address);
        expect(tickets[0].weight).to.equal(E("1"));   // gross bnbIn, pre-fee
        expect(tickets[1].account).to.equal(user2.address);
        expect(tickets[1].weight).to.equal(E("3"));
        expect(config.rootPoster).to.equal(keeper.address);

        // Build + post the root the script would post.
        const s = buildProRataSettlement(tickets);
        await prize.connect(keeper).postRoot(0, s.root, s.totalWeight, s.ticketCount);
        await time.increase(CHALLENGE_WINDOW + 1);

        // Both buyers claim with derived proofs; weights are BNB spent, so
        // user2 gets 3x user1. They still hold their tokensBought, so the
        // 10000-bps hold requirement passes with real balances.
        const pot = (await prize.settlements(0)).pot;
        const p1 = s.proofFor(user1.address);
        await expect(prize.connect(user1).claim(0, p1.weight, p1.tokensBought, p1.proof))
            .to.emit(prize, "PrizeClaimed").withArgs(0, user1.address, pot / 4n);
        const p2 = s.proofFor(user2.address);
        await expect(prize.connect(user2).claim(0, p2.weight, p2.tokensBought, p2.proof))
            .to.emit(prize, "PrizeClaimed").withArgs(0, user2.address, (pot * 3n) / 4n);
    });

    it("excludes unattributed and module-flow buys from tickets", async function () {
        const base = await loadFixture(deployBase);
        base.databaseAddr = await base.database.getAddress();
        const { user1, keeper } = base.signers;

        const l = await launchTokenWithPool(base, {
            creator: base.signers.creator,
            modules: (shells) => [
                {
                    moduleType: MODULE_TYPE.PRIZE,
                    buyAllocation: 5000,
                    sellAllocation: 5000,
                    initPayload: buildPrizePoolInitData({
                        token: shells.tokenAddr,
                        database: base.databaseAddr,
                        rootPoster: keeper.address,
                    }),
                },
                {
                    moduleType: MODULE_TYPE.BURN,
                    buyAllocation: 5000,
                    sellAllocation: 5000,
                    initPayload: buildBurnInitData({
                        token: shells.tokenAddr,
                        database: base.databaseAddr,
                        burnInterval: 300,
                    }),
                },
            ],
            initialLiquidity: { tokens: E("100000000"), bnb: E("50") },
        });
        const mc = await l.taxHandler.getModule(0);
        const prize = await ethers.getContractAt("PrizePool", mc.moduleAddress);
        const burnCfg = await l.taxHandler.getModule(1);
        const burn = await ethers.getContractAt("BurnModule", burnCfg.moduleAddress);

        // A raw PoolManager swap (third-party router) carries no hookData —
        // buyer is address(0) and must earn no ticket.
        const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
        const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
        const key = {
            currency0: ethers.ZeroAddress,
            currency1: l.tokenAddr,
            fee: 0,
            tickSpacing: 60,
            hooks: await base.hook.getAddress(),
        };
        const MIN_SQRT_PRICE_LIMIT = 4295128740n;
        await raw.connect(user1).rawSwap(key, {
            zeroForOne: true,
            amountSpecified: -E("1"),
            sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT + 1n,
        }, { value: E("1") });

        // One attributed buy for contrast.
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, l.tokenAddr], user1.address, deadline, { value: E("2") },
        );

        // A module buyback — the BurnModule buys through the router, so the
        // hook attributes the module clone as the buyer. Tax recursion is not
        // participation: the burn module must earn no ticket.
        await time.increase(301);
        await burn.executeBurn(1n, await farDeadline());

        await time.increase(DAY + 1);
        const { tickets } = await deriveTickets(await prize.getAddress(), 0);
        expect(tickets.length).to.equal(1);
        expect(tickets[0].account).to.equal(user1.address);
        expect(tickets[0].weight).to.equal(E("2"));
    });
});
