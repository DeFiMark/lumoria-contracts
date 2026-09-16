const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const config = require('../scripts/lib/vrf-config');

(process.env.BSC_FORK ? describe : describe.skip)('Native VRF real BSC coordinator rehearsal', function () {
  it('creates a subscription, funds and requests in BNB, stores callback within gas limit, and delivers', async function () {
    const [owner] = await ethers.getSigners();
    const coordinator = new ethers.Contract(config[56].coordinator, config.abi, owner);
    const receipt = await (await coordinator.createSubscription()).wait();
    const event = receipt.logs.map(l => { try { return coordinator.interface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === 'SubscriptionCreated');
    const id = event.args.subId;
    const canary = await (await ethers.getContractFactory('VRFDeploymentCanary')).deploy();
    const adapter = await (await ethers.getContractFactory('NativeVRFRandomness')).deploy(
      await canary.getAddress(), config[56].coordinator, id, config[56].keyHash, 10, ethers.parseEther('0.001'));
    await coordinator.addConsumer(id, await adapter.getAddress());
    await canary.configure(await adapter.getAddress());
    await adapter.fundReserve({ value: ethers.parseEther('0.005') });
    await adapter.fundProject(await canary.getAddress(), { value: ethers.parseEther('0.001') });
    await canary.draw();
    expect(await coordinator.pendingRequestExists(id)).to.equal(true);
    expect((await coordinator.getSubscription(id)).nativeBalance).to.equal(ethers.parseEther('0.006'));
    const requestId = await adapter.requestIds(await canary.getAddress(), ethers.ZeroHash);
    // Local fork only: prove callback gas/storage compatibility, not oracle liveness.
    await network.provider.send('hardhat_impersonateAccount', [config[56].coordinator]);
    await network.provider.send('hardhat_setBalance', [config[56].coordinator, '0xDE0B6B3A7640000']);
    const sender = await ethers.getSigner(config[56].coordinator);
    const callback = await (await adapter.connect(sender).rawFulfillRandomWords(requestId, [123], { gasLimit: 100000 })).wait();
    expect(callback.gasUsed).to.be.lessThan(100000n);
    await adapter.deliver(requestId);
    expect(await canary.word()).to.equal(123);
    expect(await canary.fulfilled()).to.equal(true);
    await network.provider.send('hardhat_stopImpersonatingAccount', [config[56].coordinator]);
  });
});
