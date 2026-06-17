// LumoriaHook + LumoriaSwapRouter + LumoriaLiquidityVault — V4 integration suite.
//
// Covers the properties that define the V4 migration:
//   1. Fee math identical to the legacy Router, enforced at the POOL level.
//   2. Taxes are unbypasseable: raw PoolManager swaps (no hookData, no
//      Lumoria router) still pay platform fee + token tax.
//   3. exactOutput swaps revert.
//   4. Liquidity is permanently locked: only the vault can add, nobody can
//      remove, donations are disabled, pool creation is vault-gated.
//   5. Rebate + volume attribution flows through hookData.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
    deployBase,
    loadFixture,
    launchTokenWithPool,
    poolKeyFor,
    buildCreatorFeeInitData,
    MODULE_TYPE,
} = require("./fixtures/deploy");

const MIN_SQRT_PRICE_LIMIT = 4295128739n + 1n;
const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const BPS = 10000n;

/** Launch a token whose entire tax goes to one CreatorFeeModule recipient —
 *  makes the tax leg trivially assertable as a balance delta. */
async function launchTaxedToken(base, { buyFee, sellFee, recipient, liquidity }) {
    return launchTokenWithPool(base, {
        buyFee,
        sellFee,
        modules: [{
            moduleType: MODULE_TYPE.CREATOR,
            buyAllocation: 10000,
            sellAllocation: 10000,
            initPayload: buildCreatorFeeInitData(recipient),
        }],
        initialLiquidity: liquidity ?? {
            tokens: ethers.parseEther("500000000"), // 500M tokens
            bnb: ethers.parseEther("100"),
        },
    });
}

async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

describe("V4: LumoriaHook fee collection", function () {
    it("buy: exact platform fee → FeeReceiver, exact tax → TaxHandler→module, remainder swaps", async function () {
        const base = await loadFixture(deployBase);
        const { user1, rest } = base.signers;
        const taxRecipient = rest[0];

        const { token, tokenAddr, taxHandler } = await launchTaxedToken(base, {
            buyFee: 500, sellFee: 500, recipient: taxRecipient.address,
        });

        const bnbIn = ethers.parseEther("1");
        const expectedPlatform = (bnbIn * 100n) / BPS;                  // 1%
        const expectedTax = ((bnbIn - expectedPlatform) * 500n) / BPS;  // 5% of remainder

        const feeBefore = await base.feeReceiver.totalReceived();
        const taxRecipientBefore = await ethers.provider.getBalance(taxRecipient.address);

        await expect(
            base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0,
                [ethers.ZeroAddress, tokenAddr],
                user1.address,
                await deadline(),
                { value: bnbIn },
            ),
        ).to.emit(base.hook, "TokenPurchased")
            .withArgs(tokenAddr, user1.address, bnbIn, expectedPlatform, expectedTax, anyValue);

        expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(expectedPlatform);
        expect(
            (await ethers.provider.getBalance(taxRecipient.address)) - taxRecipientBefore,
        ).to.equal(expectedTax);
        expect(await taxHandler.totalBuyTaxReceived()).to.equal(expectedTax);
        expect(await token.balanceOf(user1.address)).to.be.gt(0);
    });

    it("sell: platform fee + tax taken from the BNB output; receiver gets the net", async function () {
        const base = await loadFixture(deployBase);
        const { user1, user2, rest } = base.signers;
        const taxRecipient = rest[1];

        const { token, tokenAddr, taxHandler } = await launchTaxedToken(base, {
            buyFee: 0, sellFee: 1000, recipient: taxRecipient.address,
        });

        // user1 buys (0% buy tax) to acquire tokens, then sells.
        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(),
            { value: ethers.parseEther("1") },
        );
        const tokensToSell = await token.balanceOf(user1.address);
        await token.connect(user1).approve(await base.router.getAddress(), tokensToSell);

        const feeBefore = await base.feeReceiver.totalReceived();
        const taxBefore = await ethers.provider.getBalance(taxRecipient.address);
        const receiverBefore = await ethers.provider.getBalance(user2.address);

        const tx = await base.router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensToSell, 0, [tokenAddr, ethers.ZeroAddress], user2.address, await deadline(),
        );
        const receipt = await tx.wait();

        // Recover the emitted TokenSold for exact figures.
        const soldLog = receipt.logs
            .map((log) => { try { return base.hook.interface.parseLog(log); } catch { return null; } })
            .find((parsed) => parsed && parsed.name === "TokenSold");
        expect(soldLog, "TokenSold event").to.not.equal(undefined);
        const [evToken, evSeller, evTokensIn, evPlatform, evTax, evBnbOut] = soldLog.args;

        expect(evToken).to.equal(tokenAddr);
        expect(evSeller).to.equal(user1.address);
        expect(evTokensIn).to.equal(tokensToSell);

        // Reconstruct: gross = net + fees; platform = gross/100; tax = 10% of (gross - platform).
        const gross = evBnbOut + evPlatform + evTax;
        expect(evPlatform).to.equal((gross * 100n) / BPS);
        expect(evTax).to.equal(((gross - evPlatform) * 1000n) / BPS);

        expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(evPlatform);
        expect((await ethers.provider.getBalance(taxRecipient.address)) - taxBefore).to.equal(evTax);
        expect((await ethers.provider.getBalance(user2.address)) - receiverBefore).to.equal(evBnbOut);
        expect(await taxHandler.totalSellTaxReceived()).to.equal(evTax);
    });

    it("98% taxes work end-to-end in both directions", async function () {
        const base = await loadFixture(deployBase);
        const { user1, rest } = base.signers;
        const taxRecipient = rest[2];

        const { token, tokenAddr } = await launchTaxedToken(base, {
            buyFee: 9800, sellFee: 9800, recipient: taxRecipient.address,
        });

        const bnbIn = ethers.parseEther("1");
        const expectedPlatform = (bnbIn * 100n) / BPS;
        const expectedTax = ((bnbIn - expectedPlatform) * 9800n) / BPS; // 0.9702 BNB

        const taxBefore = await ethers.provider.getBalance(taxRecipient.address);
        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(), { value: bnbIn },
        );
        expect(
            (await ethers.provider.getBalance(taxRecipient.address)) - taxBefore,
        ).to.equal(expectedTax);

        const bought = await token.balanceOf(user1.address);
        expect(bought).to.be.gt(0); // only ~1.98% of the BNB swapped, but it swapped

        // and sell the lot back through a 98% sell tax
        await token.connect(user1).approve(await base.router.getAddress(), bought);
        await expect(
            base.router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
                bought, 0, [tokenAddr, ethers.ZeroAddress], user1.address, await deadline(),
            ),
        ).to.emit(base.hook, "TokenSold");
    });

    it("0% token tax: only the platform fee is taken; TaxHandler untouched", async function () {
        const base = await loadFixture(deployBase);
        const { user1, rest } = base.signers;

        const { tokenAddr, taxHandler } = await launchTaxedToken(base, {
            buyFee: 0, sellFee: 0, recipient: rest[3].address,
        });

        const bnbIn = ethers.parseEther("1");
        const feeBefore = await base.feeReceiver.totalReceived();
        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(), { value: bnbIn },
        );
        expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(bnbIn / 100n);
        expect(await taxHandler.totalBuyTaxReceived()).to.equal(0);
    });

    it("two pools, one hook: fees stay per-token", async function () {
        const base = await loadFixture(deployBase);
        const { user1, rest } = base.signers;

        const a = await launchTaxedToken(base, { buyFee: 500, sellFee: 500, recipient: rest[4].address });
        const b = await launchTaxedToken(base, { buyFee: 2000, sellFee: 2000, recipient: rest[5].address });

        const bnbIn = ethers.parseEther("1");
        const afterPlatform = bnbIn - bnbIn / 100n;

        const aBefore = await ethers.provider.getBalance(rest[4].address);
        const bBefore = await ethers.provider.getBalance(rest[5].address);

        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, a.tokenAddr], user1.address, await deadline(), { value: bnbIn },
        );
        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, b.tokenAddr], user1.address, await deadline(), { value: bnbIn },
        );

        expect((await ethers.provider.getBalance(rest[4].address)) - aBefore)
            .to.equal((afterPlatform * 500n) / BPS);
        expect((await ethers.provider.getBalance(rest[5].address)) - bBefore)
            .to.equal((afterPlatform * 2000n) / BPS);
    });

    it("router enforces amountOutMin and deadline", async function () {
        const base = await loadFixture(deployBase);
        const { user1, rest } = base.signers;
        const { tokenAddr } = await launchTaxedToken(base, {
            buyFee: 500, sellFee: 500, recipient: rest[6].address,
        });

        await expect(
            base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                ethers.MaxUint256, // impossible min
                [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(),
                { value: ethers.parseEther("1") },
            ),
        ).to.be.revertedWithCustomError(base.router, "InsufficientOutput");

        await expect(
            base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
                0, [ethers.ZeroAddress, tokenAddr], user1.address,
                (await ethers.provider.getBlock("latest")).timestamp - 1, // expired
                { value: ethers.parseEther("1") },
            ),
        ).to.be.revertedWithCustomError(base.router, "Expired");
    });
});

describe("V4: taxes cannot be bypassed (raw PoolManager access)", function () {
    async function rawSetup(base) {
        const { rest } = base.signers;
        const launched = await launchTaxedToken(base, {
            buyFee: 1000, sellFee: 1000, recipient: rest[7].address,
        });
        const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
        const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
        const key = await poolKeyFor(base, launched.tokenAddr);
        return { ...launched, raw, key, taxRecipient: rest[7] };
    }

    it("raw buy with no hookData still pays platform fee + tax; token volume tracked, user volume skipped", async function () {
        const base = await loadFixture(deployBase);
        const { user1 } = base.signers;
        const { token, tokenAddr, raw, key, taxRecipient } = await rawSetup(base);

        const bnbIn = ethers.parseEther("1");
        const expectedPlatform = bnbIn / 100n;
        const expectedTax = ((bnbIn - expectedPlatform) * 1000n) / BPS;

        const feeBefore = await base.feeReceiver.totalReceived();
        const taxBefore = await ethers.provider.getBalance(taxRecipient.address);
        const tokenVolBefore = await base.database.tokenVolume(tokenAddr);

        await raw.connect(user1).rawSwap(
            key,
            { zeroForOne: true, amountSpecified: -bnbIn, sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
            { value: bnbIn },
        );

        expect((await base.feeReceiver.totalReceived()) - feeBefore).to.equal(expectedPlatform);
        expect((await ethers.provider.getBalance(taxRecipient.address)) - taxBefore).to.equal(expectedTax);
        expect(await token.balanceOf(user1.address)).to.be.gt(0);

        // token volume always tracked; per-user attribution impossible without hookData
        expect((await base.database.tokenVolume(tokenAddr)) - tokenVolBefore).to.equal(bnbIn);
        expect(await base.database.userVolume(tokenAddr, user1.address)).to.equal(0);
    });

    it("raw sell with no hookData still pays platform fee + sell tax", async function () {
        const base = await loadFixture(deployBase);
        const { user1 } = base.signers;
        const { token, tokenAddr, raw, key, taxRecipient } = await rawSetup(base);

        // acquire tokens first (raw buy)
        await raw.connect(user1).rawSwap(
            key,
            { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
            { value: ethers.parseEther("1") },
        );
        const bal = await token.balanceOf(user1.address);
        await token.connect(user1).approve(await raw.getAddress(), bal);

        const feeBefore = await base.feeReceiver.totalReceived();
        const taxBefore = await ethers.provider.getBalance(taxRecipient.address);

        await raw.connect(user1).rawSwap(
            key,
            { zeroForOne: false, amountSpecified: -bal, sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT },
        );

        expect(await base.feeReceiver.totalReceived()).to.be.gt(feeBefore);
        expect(await ethers.provider.getBalance(taxRecipient.address)).to.be.gt(taxBefore);
    });

    it("exactOutput swaps revert in both directions", async function () {
        const base = await loadFixture(deployBase);
        const { user1 } = base.signers;
        const { raw, key } = await rawSetup(base);

        // exactOut buy (positive amountSpecified = desired token output)
        await expect(
            raw.connect(user1).rawSwap(
                key,
                { zeroForOne: true, amountSpecified: ethers.parseEther("1000"), sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
                { value: ethers.parseEther("10") },
            ),
        ).to.be.reverted; // LumoriaHook.ExactOutputNotSupported (ERC-7751 wrapped)

        // exactOut sell (positive amountSpecified = desired BNB output)
        await expect(
            raw.connect(user1).rawSwap(
                key,
                { zeroForOne: false, amountSpecified: ethers.parseEther("1"), sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT },
            ),
        ).to.be.reverted;
    });
});

describe("V4: liquidity is permanently locked", function () {
    async function lockSetup(base) {
        const launched = await launchTaxedToken(base, {
            buyFee: 500, sellFee: 500, recipient: base.signers.rest[8].address,
        });
        const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
        const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
        const key = await poolKeyFor(base, launched.tokenAddr);
        return { ...launched, raw, key };
    }

    it("third parties cannot add liquidity (hook gates to vault)", async function () {
        const base = await loadFixture(deployBase);
        const { raw, key } = await lockSetup(base);
        await expect(
            raw.rawAddLiquidity(key, 1000n, { value: ethers.parseEther("1") }),
        ).to.be.reverted; // LumoriaHook.OnlyVault (wrapped)
    });

    it("liquidity removal always reverts — even hypothetically for the vault position", async function () {
        const base = await loadFixture(deployBase);
        const { raw, key } = await lockSetup(base);
        await expect(
            raw.rawAddLiquidity(key, -1000n),
        ).to.be.reverted; // LumoriaHook.LiquidityPermanentlyLocked (wrapped)
    });

    it("donations are disabled", async function () {
        const base = await loadFixture(deployBase);
        const { raw, key } = await lockSetup(base);
        await expect(
            raw.rawDonate(key, ethers.parseEther("1"), 0, { value: ethers.parseEther("1") }),
        ).to.be.reverted; // LumoriaHook.DonationsDisabled (wrapped)
    });

    it("pools cannot be initialized by anyone but the vault", async function () {
        const base = await loadFixture(deployBase);
        // a registered token that does NOT have a pool yet
        const { tokenAddr } = await launchTokenWithPool(base, {
            buyFee: 0, sellFee: 0,
            modules: [{
                moduleType: MODULE_TYPE.CREATOR,
                buyAllocation: 10000,
                sellAllocation: 10000,
                initPayload: buildCreatorFeeInitData(base.signers.rest[9].address),
            }],
            // no initialLiquidity → no pool
        });
        const RawV4Caller = await ethers.getContractFactory("RawV4Caller");
        const raw = await RawV4Caller.deploy(await base.poolManager.getAddress());
        const key = await poolKeyFor(base, tokenAddr);

        await expect(
            raw.rawInitialize(key, 2n ** 96n), // price 1:1
        ).to.be.reverted; // LumoriaHook.OnlyVault (wrapped)
    });

    it("router rejects addLiquidityETH for non-Lumoria tokens; vault rejects non-router callers", async function () {
        const base = await loadFixture(deployBase);
        const { user1 } = base.signers;

        await expect(
            base.router.connect(user1).addLiquidityETH(
                user1.address, // not a Lumoria token
                1000, 0, 0, user1.address, await deadline(),
                { value: ethers.parseEther("1") },
            ),
        ).to.be.revertedWithCustomError(base.router, "NotLumoriaToken");

        await expect(
            base.vault.connect(user1).addLiquidityLocked(user1.address, 1000, user1.address, {
                value: ethers.parseEther("1"),
            }),
        ).to.be.revertedWithCustomError(base.vault, "OnlyRouter");
    });

    it("post-launch adds keep growing the same locked position", async function () {
        const base = await loadFixture(deployBase);
        const { owner } = base.signers;
        const { token, tokenAddr } = await launchTaxedToken(base, {
            buyFee: 500, sellFee: 500, recipient: base.signers.rest[10].address,
        });

        const lockedBefore = await base.vault.lockedLiquidity(tokenAddr);
        await token.connect(owner).approve(await base.router.getAddress(), ethers.parseEther("1000000"));
        await base.router.connect(owner).addLiquidityETH(
            tokenAddr, ethers.parseEther("1000000"), 0, 0, owner.address, await deadline(),
            { value: ethers.parseEther("0.2") },
        );
        expect(await base.vault.lockedLiquidity(tokenAddr)).to.be.gt(lockedBefore);
    });
});

describe("V4: rebates + volume attribution via LumoriaSwapRouter", function () {
    it("buy through the router credits the rebate and registers per-user volume", async function () {
        const base = await loadFixture(deployBase);
        const { creator, user1 } = base.signers;

        const { token, tokenAddr } = await launchTaxedToken(base, {
            buyFee: 500, sellFee: 500, recipient: base.signers.rest[11].address,
        });

        // Creator funds a 50% rebate pool from their token allocation.
        const fund = ethers.parseEther("10000000"); // 10M tokens
        await token.connect(base.signers.owner).transfer(creator.address, fund);
        await token.connect(creator).approve(await base.rebate.getAddress(), fund);
        await base.rebate.connect(creator).fundRebate(tokenAddr, fund, 5000);

        const bnbIn = ethers.parseEther("1");
        const tx = await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(), { value: bnbIn },
        );
        const receipt = await tx.wait();

        const purchased = receipt.logs
            .map((log) => { try { return base.hook.interface.parseLog(log); } catch { return null; } })
            .find((parsed) => parsed && parsed.name === "TokenPurchased");
        const tokensOut = purchased.args[5];

        // balance = swap output + 50% rebate bonus
        expect(await token.balanceOf(user1.address)).to.equal(tokensOut + tokensOut / 2n);
        // per-user volume registered at the gross BNB amount
        expect(await base.database.userVolume(tokenAddr, user1.address)).to.equal(bnbIn);
        expect(await base.database.tokenVolume(tokenAddr)).to.be.gte(bnbIn);
    });

    it("sell through the router registers seller volume", async function () {
        const base = await loadFixture(deployBase);
        const { user1 } = base.signers;
        const { token, tokenAddr } = await launchTaxedToken(base, {
            buyFee: 0, sellFee: 500, recipient: base.signers.rest[12].address,
        });

        await base.router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [ethers.ZeroAddress, tokenAddr], user1.address, await deadline(),
            { value: ethers.parseEther("1") },
        );
        const bal = await token.balanceOf(user1.address);
        await token.connect(user1).approve(await base.router.getAddress(), bal);

        const volBefore = await base.database.userVolume(tokenAddr, user1.address);
        await base.router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
            bal, 0, [tokenAddr, ethers.ZeroAddress], user1.address, await deadline(),
        );
        expect(await base.database.userVolume(tokenAddr, user1.address)).to.be.gt(volBefore);
    });
});
