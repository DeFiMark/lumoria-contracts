const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    deployBase,
    loadFixture,
    useRealGenerator,
    buildCreatorFeeInitData,
    encodeBYOLPayload,
    encodeFlatCurvePayload,
    MODULE_TYPE,
    LAUNCH_MODE,
} = require("./fixtures/deploy");

const TOTAL_SUPPLY = ethers.parseEther("1000000000");
const DEAD = "0x000000000000000000000000000000000000dEaD";

// Build a single-CreatorFee module config (doesn't need taxHandler in the payload
// any more — module infers from msg.sender at init time).
function singleCreatorFeeModule(creatorAddr) {
    return [{
        moduleType: MODULE_TYPE.CREATOR,
        buyAllocation: 10000,
        sellAllocation: 10000,
        initPayload: buildCreatorFeeInitData(creatorAddr),
    }];
}

function randomSalt() {
    return ethers.hexlify(ethers.randomBytes(32));
}

describe("Generator", function () {

    describe("constructor + wiring", function () {
        it("rejects zero database", async function () {
            const G = await ethers.getContractFactory("Generator");
            await expect(G.deploy(ethers.ZeroAddress)).to.be.revertedWith("Gen: zero database");
        });

        it("exposes getDatabase()", async function () {
            const base = await loadFixture(deployBase);
            expect(await base.generator.getDatabase()).to.equal(await base.database.getAddress());
        });
    });

    describe("predictTokenAddress", function () {
        it("predicts the CREATE2 token clone address for a given salt", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const salt = randomSalt();
            const predicted = await base.generator.predictTokenAddress(salt);

            const { creator } = base.signers;
            const tx = await base.generator.connect(creator).generateProject(
                "Predicted", "PRD",
                0, 0,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.BYOL,
                encodeBYOLPayload(TOTAL_SUPPLY),
                [],
                salt,
                { value: ethers.parseEther("1") },
            );
            const receipt = await tx.wait();

            // Find the ProjectGenerated event to extract the real token address.
            const log = receipt.logs.find(l => {
                try {
                    const parsed = base.generator.interface.parseLog(l);
                    return parsed && parsed.name === "ProjectGenerated";
                } catch { return false; }
            });
            const parsed = base.generator.interface.parseLog(log);
            expect(parsed.args.token).to.equal(predicted);
        });
    });

    describe("BYOL launch", function () {
        it("1% platform fee → FeeReceiver, creator gets remaining tokens, LP to dEaD", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator } = base.signers;

            const feeBefore = await base.feeReceiver.totalReceived();

            const tokensForLP = ethers.parseEther("600000000"); // 60% of supply → LP
            const salt = randomSalt();
            await base.generator.connect(creator).generateProject(
                "BYOL", "BYO",
                500, 500,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.BYOL,
                encodeBYOLPayload(tokensForLP),
                [],
                salt,
                { value: ethers.parseEther("5") },
            );

            // Platform fee: 1% of 5 BNB = 0.05 BNB
            const feeAfter = await base.feeReceiver.totalReceived();
            expect(feeAfter - feeBefore).to.equal(ethers.parseEther("0.05"));

            // Creator received (TOTAL_SUPPLY - tokensForLP)
            const predicted = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", predicted);
            const expectedCreatorTokens = TOTAL_SUPPLY - tokensForLP;
            expect(await token.balanceOf(creator.address)).to.equal(expectedCreatorTokens);

            // Token is registered as Lumoria
            expect(await base.database.isLumoriaToken(predicted)).to.equal(true);

            // V4 pool seeded: liquidity permanently locked in the vault,
            // reserves custodied by the PoolManager.
            expect(await base.vault.lockedLiquidity(predicted)).to.be.gt(0);
            expect(await token.balanceOf(await base.poolManager.getAddress())).to.be.gt(0);
            expect(
                await ethers.provider.getBalance(await base.poolManager.getAddress()),
            ).to.be.gt(0);
        });

        it("rejects zero BNB", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            await expect(
                base.generator.connect(base.signers.creator).generateProject(
                    "X", "X", 0, 0,
                    singleCreatorFeeModule(base.signers.creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(TOTAL_SUPPLY),
                    [],
                    randomSalt(),
                    { value: 0 },
                ),
            ).to.be.revertedWith("Gen: zero BNB");
        });

        it("rejects tokensForLP = 0", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            await expect(
                base.generator.connect(base.signers.creator).generateProject(
                    "X", "X", 0, 0,
                    singleCreatorFeeModule(base.signers.creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(0n),
                    [],
                    randomSalt(),
                    { value: ethers.parseEther("1") },
                ),
            ).to.be.revertedWith("Gen: bad tokensForLP");
        });

        it("post-launch: buys go through Router correctly", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;
            const salt = randomSalt();

            await base.generator.connect(creator).generateProject(
                "Tradable", "TRD", 500, 500,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.BYOL,
                encodeBYOLPayload(ethers.parseEther("500000000")),
                [],
                salt,
                { value: ethers.parseEther("10") },
            );
            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
            const wbnbAddr = await base.wbnb.getAddress();

            // Buy through the router
            await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0, [wbnbAddr, tokenAddr], user1.address,
                Math.floor(Date.now() / 1000) + 3600,
                { value: ethers.parseEther("1") },
            );
            expect(await token.balanceOf(user1.address)).to.be.gt(0);
        });
    });

    describe("FLAT_CURVE launch", function () {
        async function launchWithFlatCurve(base, overrides = {}) {
            const { creator } = base.signers;
            const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);

            const payload = encodeFlatCurvePayload({
                hardCap: ethers.parseEther("10"),
                minContribution: ethers.parseEther("0.1"),
                maxContribution: ethers.parseEther("5"),
                tokensForPresale: ethers.parseEther("400000000"),
                tokensForLP: ethers.parseEther("500000000"),
                liquidityBps: 8000,  // 80% of raised BNB → LP
                creatorBps: 2000,    // 20% → creator
                startTime: now + 1,
                endTime: now + 3600,
                ...overrides,
            });

            const salt = randomSalt();
            const tx = await base.generator.connect(creator).generateProject(
                "FlatLaunch", "FL", 0, 0,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.FLAT_CURVE,
                payload,
                [],
                salt,
            );
            const receipt = await tx.wait();

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);

            // Find FlatCurveLaunched event to get the flatCurve address
            const log = receipt.logs.find(l => {
                try {
                    const p = base.generator.interface.parseLog(l);
                    return p && p.name === "FlatCurveLaunched";
                } catch { return false; }
            });
            const parsed = base.generator.interface.parseLog(log);
            const flatCurve = await ethers.getContractAt("FlatCurve", parsed.args.flatCurve);

            return { token, tokenAddr, flatCurve };
        }

        it("clones a FlatCurve, transfers tokens, creator gets remainder", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator } = base.signers;

            const { token, flatCurve } = await launchWithFlatCurve(base);

            // FlatCurve holds presale + LP allocations = 900M
            const totalForCurve = ethers.parseEther("900000000");
            expect(await token.balanceOf(await flatCurve.getAddress())).to.equal(totalForCurve);
            // Creator holds the rest (100M)
            expect(await token.balanceOf(creator.address)).to.equal(TOTAL_SUPPLY - totalForCurve);
        });

        it("rejects msg.value on FLAT_CURVE path", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator } = base.signers;
            const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);

            const payload = encodeFlatCurvePayload({
                hardCap: ethers.parseEther("10"),
                minContribution: ethers.parseEther("0.1"),
                maxContribution: ethers.parseEther("5"),
                tokensForPresale: ethers.parseEther("400000000"),
                tokensForLP: ethers.parseEther("500000000"),
                liquidityBps: 8000,
                creatorBps: 2000,
                startTime: now + 1,
                endTime: now + 3600,
            });

            await expect(
                base.generator.connect(creator).generateProject(
                    "X", "X", 0, 0,
                    singleCreatorFeeModule(creator.address),
                    LAUNCH_MODE.FLAT_CURVE,
                    payload,
                    [],
                    randomSalt(),
                    { value: ethers.parseEther("1") },
                ),
            ).to.be.revertedWith("Gen: no BNB on FLAT_CURVE");
        });
    });

    describe("allocations (B1 + B2)", function () {
        const ONE_YEAR = 365 * 24 * 3600;
        const alloc = (beneficiary, amount, cliff = 0, duration = 0) =>
            ({ beneficiary, amount, cliff, duration });

        it("immediate allocation (duration=0) goes straight to the beneficiary and shrinks the creator remainder", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            const tokensForLP = ethers.parseEther("600000000"); // remainder = 400M
            const amount = ethers.parseEther("50000000");
            const salt = randomSalt();

            await expect(
                base.generator.connect(creator).generateProject(
                    "Alloc", "ALC", 500, 500,
                    singleCreatorFeeModule(creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(tokensForLP),
                    [alloc(user1.address, amount)],
                    salt,
                    { value: ethers.parseEther("5") },
                ),
            ).to.emit(base.generator, "AllocationMinted");

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);

            expect(await token.balanceOf(user1.address)).to.equal(amount);
            const remainder = TOTAL_SUPPLY - tokensForLP;
            expect(await token.balanceOf(creator.address)).to.equal(remainder - amount);
        });

        it("vested allocation (duration>0) parks tokens in the vault and records a schedule", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            const tokensForLP = ethers.parseEther("600000000");
            const amount = ethers.parseEther("50000000");
            const salt = randomSalt();

            await expect(
                base.generator.connect(creator).generateProject(
                    "Vest", "VST", 500, 500,
                    singleCreatorFeeModule(creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(tokensForLP),
                    [alloc(user1.address, amount, 0, ONE_YEAR)],
                    salt,
                    { value: ethers.parseEther("5") },
                ),
            ).to.emit(base.generator, "AllocationVested");

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
            const vaultAddr = await base.vestingVault.getAddress();

            // Vault custodies the locked tokens; the beneficiary has nothing yet.
            expect(await token.balanceOf(vaultAddr)).to.equal(amount);
            expect(await token.balanceOf(user1.address)).to.equal(0);

            // Schedule recorded with the right shape.
            expect(await base.vestingVault.scheduleCount()).to.equal(1);
            const sched = await base.vestingVault.getSchedule(0);
            expect(sched.token).to.equal(tokenAddr);
            expect(sched.beneficiary).to.equal(user1.address);
            expect(sched.total).to.equal(amount);
            expect(sched.duration).to.equal(ONE_YEAR);

            const remainder = TOTAL_SUPPLY - tokensForLP;
            expect(await token.balanceOf(creator.address)).to.equal(remainder - amount);
        });

        it("excludes the vesting vault from reward-share tracking", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            const tokensForLP = ethers.parseEther("600000000");
            const amount = ethers.parseEther("50000000");
            const salt = randomSalt();

            await base.generator.connect(creator).generateProject(
                "VestShare", "VSH", 500, 500,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.BYOL,
                encodeBYOLPayload(tokensForLP),
                [alloc(user1.address, amount, 0, ONE_YEAR)],
                salt,
                { value: ethers.parseEther("5") },
            );

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
            const taxHandlerAddr = await base.database.tokenTaxHandler(tokenAddr);
            const taxHandler = await ethers.getContractAt("TaxHandler", taxHandlerAddr);
            const vaultAddr = await base.vestingVault.getAddress();

            // The vault holds tokens but accrues zero shares; totalShares
            // reflects only the creator's tracked balance (pool is excluded too).
            // Tolerance absorbs tiny LP-provisioning dust held by the router/vault;
            // the point is the vault's 50M allocation is NOT in the share total.
            expect(await taxHandler.shares(vaultAddr)).to.equal(0);
            expect(await taxHandler.totalShares()).to.be.closeTo(
                await token.balanceOf(creator.address),
                ethers.parseEther("0.001"),
            );
        });

        it("reverts when allocations exceed the creator remainder", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            const tokensForLP = ethers.parseEther("600000000"); // remainder = 400M
            const tooMuch = ethers.parseEther("400000001");

            await expect(
                base.generator.connect(creator).generateProject(
                    "Over", "OVR", 0, 0,
                    singleCreatorFeeModule(creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(tokensForLP),
                    [alloc(user1.address, tooMuch)],
                    randomSalt(),
                    { value: ethers.parseEther("1") },
                ),
            ).to.be.revertedWith("Gen: alloc exceeds remainder");
        });

        it("reverts on a zero-amount allocation", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;

            await expect(
                base.generator.connect(creator).generateProject(
                    "Zero", "ZRO", 0, 0,
                    singleCreatorFeeModule(creator.address),
                    LAUNCH_MODE.BYOL,
                    encodeBYOLPayload(ethers.parseEther("600000000")),
                    [alloc(user1.address, 0n)],
                    randomSalt(),
                    { value: ethers.parseEther("1") },
                ),
            ).to.be.revertedWith("Gen: zero alloc amount");
        });

        it("supports multiple allocations and carves them all from the remainder", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1, user2 } = base.signers;

            const tokensForLP = ethers.parseEther("600000000"); // remainder = 400M
            const a1 = ethers.parseEther("30000000");
            const a2 = ethers.parseEther("20000000");
            const salt = randomSalt();

            await base.generator.connect(creator).generateProject(
                "Multi", "MLT", 500, 500,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.BYOL,
                encodeBYOLPayload(tokensForLP),
                [alloc(user1.address, a1), alloc(user2.address, a2, 0, ONE_YEAR)],
                salt,
                { value: ethers.parseEther("5") },
            );

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);
            const vaultAddr = await base.vestingVault.getAddress();

            expect(await token.balanceOf(user1.address)).to.equal(a1);       // immediate
            expect(await token.balanceOf(vaultAddr)).to.equal(a2);           // vested
            const remainder = TOTAL_SUPPLY - tokensForLP;
            expect(await token.balanceOf(creator.address)).to.equal(remainder - a1 - a2);
        });

        it("supports allocations on the FLAT_CURVE path", async function () {
            const base = await loadFixture(deployBase);
            await useRealGenerator(base);
            const { creator, user1 } = base.signers;
            const now = Math.floor((await ethers.provider.getBlock("latest")).timestamp);

            const payload = encodeFlatCurvePayload({
                hardCap: ethers.parseEther("10"),
                minContribution: ethers.parseEther("0.1"),
                maxContribution: ethers.parseEther("5"),
                tokensForPresale: ethers.parseEther("400000000"),
                tokensForLP: ethers.parseEther("500000000"), // curve = 900M, remainder = 100M
                liquidityBps: 8000,
                creatorBps: 2000,
                startTime: now + 1,
                endTime: now + 3600,
            });

            const amount = ethers.parseEther("40000000");
            const salt = randomSalt();
            await base.generator.connect(creator).generateProject(
                "FCAlloc", "FCA", 0, 0,
                singleCreatorFeeModule(creator.address),
                LAUNCH_MODE.FLAT_CURVE,
                payload,
                [alloc(user1.address, amount)],
                salt,
            );

            const tokenAddr = await base.generator.predictTokenAddress(salt);
            const token = await ethers.getContractAt("LumoriaToken", tokenAddr);

            expect(await token.balanceOf(user1.address)).to.equal(amount);
            const remainder = TOTAL_SUPPLY - ethers.parseEther("900000000"); // 100M
            expect(await token.balanceOf(creator.address)).to.equal(remainder - amount);
        });
    });
});
