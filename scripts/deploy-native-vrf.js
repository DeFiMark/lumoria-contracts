// Staged rollout: canary, fund-canary, status, deploy, move-reserve, activate.
// Subscription remains controlled by the Database owner, never the operator.
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const config = require('./lib/vrf-config');
const { sendRaw, waitForReceipt } = require('./lib/raw-tx');

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 56 || !['bsc', 'localhost'].includes(hre.network.name)) throw new Error('BSC or its local fork required');
  const stage = process.env.VRF_STAGE || 'status';
  const file = path.join(__dirname, '..', 'deployments', `${hre.network.name}-native-vrf.json`);
  const depFile = path.join(__dirname, '..', 'deployments', 'bsc.json');
  const dep = JSON.parse(fs.readFileSync(depFile));
  const journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { chainId, transactions: {}, createdAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(file, JSON.stringify(journal, null, 2));
  const [signer] = await ethers.getSigners();
  const db = await ethers.getContractAt('Database', dep.core.database);
  if ((await db.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error('Signer must be Database owner');
  const net = config[chainId];
  const coordinator = new ethers.Contract(net.coordinator, config.abi, signer);
  const fee = ethers.parseEther('0.001');
  const confirmations = 10;
  async function transact(label, tx) {
    let entry = journal.transactions[label];
    if (!entry) {
      console.log(`Sending ${label}`);
      await sendRaw(hre, tx, { onBroadcast: hash => { journal.transactions[label] = { hash }; save(); console.log(`${label}: ${hash}`); } });
      entry = journal.transactions[label];
    }
    const receipt = await waitForReceipt(hre, entry.hash);
    journal.transactions[label] = { ...entry, ...receipt }; save();
    return receipt;
  }
  async function call(label, contract, method, args = [], value = 0n) {
    return transact(label, { to: await contract.getAddress(), data: contract.interface.encodeFunctionData(method, args), value });
  }
  async function deploy(label, name, args = []) {
    const factory = await ethers.getContractFactory(name);
    const receipt = await transact(label, await factory.getDeployTransaction(...args));
    if (!receipt.contractAddress || await ethers.provider.getCode(receipt.contractAddress) === '0x') throw new Error(`Missing deployment ${label}`);
    return ethers.getContractAt(name, receipt.contractAddress);
  }
  async function subscription(label) {
    const receipt = await call(label, coordinator, 'createSubscription');
    const raw = await ethers.provider.getTransactionReceipt(receipt.hash);
    const event = raw.logs.map(l => { try { return coordinator.interface.parseLog(l); } catch { return null; } })
      .find(l => l?.name === 'SubscriptionCreated');
    if (!event) throw new Error('Missing subscription event');
    return event.args.subId.toString();
  }
  if (stage === 'canary') {
    const subId = await subscription('canarySubscription');
    const canary = await deploy('canary', 'VRFDeploymentCanary');
    const args = [await canary.getAddress(), net.coordinator, subId, net.keyHash, confirmations, fee.toString()];
    const adapter = await deploy('canaryAdapter', 'NativeVRFRandomness', args);
    journal.canary = { contract: await canary.getAddress(), adapter: await adapter.getAddress(), subId, args }; save();
    await call('canaryAddConsumer', coordinator, 'addConsumer', [subId, await adapter.getAddress()]);
    await call('canaryConfigure', canary, 'configure', [await adapter.getAddress()]);
    await call('canaryReserve', adapter, 'fundReserve', [], ethers.parseEther('0.005'));
    await call('canaryProject', adapter, 'fundProject', [await canary.getAddress()], fee);
    await call('canaryDraw', canary, 'draw');
    journal.canary.requestId = (await adapter.requestIds(await canary.getAddress(), ethers.ZeroHash)).toString(); save();
    console.log(`Canary requested ${journal.canary.requestId}`);
  } else if (stage === 'fund-canary') {
    if (!journal.canary?.requestId) throw new Error('Missing canary');
    const adapter = await ethers.getContractAt('NativeVRFRandomness', journal.canary.adapter);
    // 200 gwei * (200k verification + 100k callback) * 1.6 = 0.096 BNB.
    // A reserve, not the expected actual charge. Recovered after fulfillment.
    await call('canaryGasLaneReserve', adapter, 'fundReserve', [], ethers.parseEther('0.1'));
  } else if (stage === 'status') {
    if (!journal.canary?.requestId) { console.log('No canary request'); return; }
    const adapter = await ethers.getContractAt('NativeVRFRandomness', journal.canary.adapter);
    const r = await adapter.requests(journal.canary.requestId);
    console.log(`Canary oracle callback received: ${r.fulfilled}; delivered: ${r.delivered}`);
    if (r.fulfilled && !r.delivered) await call('canaryDeliver', adapter, 'deliver', [journal.canary.requestId]);
    const canary = await ethers.getContractAt('VRFDeploymentCanary', journal.canary.contract);
    if (await canary.fulfilled()) { journal.canary.passed = true; journal.canary.word = (await canary.word()).toString(); save(); }
    console.log(`Canary passed: ${journal.canary.passed === true}`);
  } else if (stage === 'deploy') {
    if (!journal.canary?.passed) throw new Error('Real oracle canary must pass first');
    const subId = await subscription('productionSubscription');
    const args = [dep.core.database, net.coordinator, subId, net.keyHash, confirmations, fee.toString()];
    const adapter = await deploy('adapter', 'NativeVRFRandomness', args);
    const prize = await deploy('prizeMaster', 'PrizePool');
    await call('productionAddConsumer', coordinator, 'addConsumer', [subId, await adapter.getAddress()]);
    journal.production ||= { adapter: await adapter.getAddress(), prizeMaster: await prize.getAddress(), subId, args,
      requestFeeBNB: '0.001', confirmations, coordinator: net.coordinator, previousProvider: dep.core.randomnessProvider,
      previousPrizeMaster: dep.masterCopies.prizePool };
    save(); console.log(JSON.stringify(journal.production, null, 2));
  } else if (stage === 'move-reserve') {
    if (!journal.canary?.passed || !journal.production) throw new Error('Canary/candidates missing');
    if (!journal.canary.recoveredReserveWei) {
      if (await coordinator.pendingRequestExists(journal.canary.subId)) throw new Error('Canary still pending');
      journal.canary.recoveredReserveWei = (await coordinator.getSubscription(journal.canary.subId)).nativeBalance.toString(); save();
    }
    await call('canaryCancelAfterSuccess', coordinator, 'cancelSubscription', [journal.canary.subId, signer.address]);
    const adapter = await ethers.getContractAt('NativeVRFRandomness', journal.production.adapter);
    await call('productionReserve', adapter, 'fundReserve', [], BigInt(journal.canary.recoveredReserveWei));
    console.log(`Moved unused canary reserve: ${ethers.formatEther(journal.canary.recoveredReserveWei)} BNB`);
  } else if (stage === 'activate') {
    const p = journal.production;
    if (!journal.canary?.passed || !p) throw new Error('Missing verified candidates');
    if (hre.network.name === 'bsc' && !journal.verifiedAt) throw new Error('Explorer verification required before activation');
    const old = await ethers.getContractAt('TrustedOperatorRandomness', p.previousProvider);
    if (await old.nextRequestId() !== 0n) throw new Error('Legacy requests require explicit inventory before activation');
    const handlers = [];
    for (let i = 0; i < Number(await db.allTokensLength()); i++) {
      const handler = await ethers.getContractAt('TaxHandler', await db.tokenTaxHandler(await db.allTokens(i)));
      handlers.push(await handler.getAddress());
      for (let j = 0; j < Number(await handler.getModuleCount()); j++) {
        const m = await handler.getModule(j);
        if (Number(m.moduleType) !== 4) continue;
        const pool = await ethers.getContractAt('PrizePool', m.moduleAddress);
        if (await pool.payoutMode() === 1n) throw new Error(`Lottery migration required: ${m.moduleAddress}`);
      }
    }
    if (handlers.length) {
      const iface = (await ethers.getContractFactory('TaxHandler')).interface;
      const logs = await ethers.provider.getLogs({ address: handlers, fromBlock: dep.startBlock, toBlock: 'latest',
        topics: [iface.getEvent('ModuleAdded').topicHash, ethers.zeroPadValue('0x04', 32)] });
      for (const log of logs) {
        const address = iface.parseLog(log).args.moduleAddress;
        if (await (await ethers.getContractAt('PrizePool', address)).payoutMode() === 1n) throw new Error(`Historical lottery migration required: ${address}`);
      }
    }
    const sub = await coordinator.getSubscription(p.subId);
    if (sub.nativeBalance < ethers.parseEther('0.1')) throw new Error('Fund at least 0.1 BNB operating reserve before activation');
    if (sub.owner.toLowerCase() !== signer.address.toLowerCase() || !sub.consumers.some(a => a.toLowerCase() === p.adapter.toLowerCase())) throw new Error('Subscription wiring mismatch');
    const provider = await db.randomnessProvider();
    if (![p.previousProvider, p.adapter].some(a => a.toLowerCase() === provider.toLowerCase())) throw new Error('Provider drift');
    await call('activatePrizeMaster', db, 'setModuleMasterCopy', [4, p.prizeMaster]);
    await call('activateProvider', db, 'setRandomnessProvider', [p.adapter]);
    if ((await db.randomnessProvider()).toLowerCase() !== p.adapter.toLowerCase() || (await db.moduleMasterCopies(4)).toLowerCase() !== p.prizeMaster.toLowerCase()) throw new Error('Activation readback failed');
    journal.activatedAt = new Date().toISOString(); save();
    if (hre.network.name === 'bsc') {
      dep.previous.nativeVRF = { provider: p.previousProvider, prizeMaster: p.previousPrizeMaster };
      dep.core.randomnessProvider = p.adapter; dep.masterCopies.prizePool = p.prizeMaster;
      dep.nativeVRF = { ...p, activatedAt: journal.activatedAt, canary: journal.canary, transactions: journal.transactions };
      fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
    }
    console.log('VRF provider and future PrizePool master activated');
  } else throw new Error('Unknown VRF_STAGE');
}
main().catch(e => { console.error(e.shortMessage || e.reason || e.message?.split('\n')[0] || e.code); process.exitCode = 1; });
