const hre = require('hardhat');
const fs = require('fs');
async function main() {
  const { ethers } = hre;
  const dep = require('../deployments/bsc.json');
  const [signer] = await ethers.getSigners();
  const db = await ethers.getContractAt('Database', dep.core.database);
  const report = { chainId: String((await ethers.provider.getNetwork()).chainId), block: await ethers.provider.getBlockNumber(), deployer: signer.address,
    balanceBNB: ethers.formatEther(await ethers.provider.getBalance(signer.address)), owner: await db.owner(),
    provider: await db.randomnessProvider(), prizeMaster: await db.moduleMasterCopies(4), tokens: [] };
  for (let i = 0; i < Number(await db.allTokensLength()); i++) {
    const token = await db.allTokens(i);
    const handler = await ethers.getContractAt('TaxHandler', await db.tokenTaxHandler(token));
    const row = { token, creator: await db.tokenCreator(token), handler: await handler.getAddress(), renounced: await handler.managementRenounced(), modules: [] };
    for (let j = 0; j < Number(await handler.getModuleCount()); j++) {
      const m = await handler.getModule(j);
      const entry = { address: m.moduleAddress, type: Number(m.moduleType) };
      if (entry.type === 4) {
        const pool = await ethers.getContractAt('PrizePool', entry.address);
        entry.mode = Number(await pool.payoutMode());
        entry.liveEpoch = String(await pool.liveEpochId());
        entry.balance = String(await ethers.provider.getBalance(entry.address));
        try { entry.nonCancellable = await pool.supportsNonCancellableRandomness(); } catch { entry.nonCancellable = false; }
      }
      row.modules.push(entry);
    }
    report.tokens.push(row);
  }
  const old = await ethers.getContractAt('TrustedOperatorRandomness', dep.previous?.nativeVRF?.provider || report.provider);
  report.legacyRequestCount = String(await old.nextRequestId());
  if (dep.nativeVRF) {
    const config = require('./lib/vrf-config');
    const adapter = await ethers.getContractAt('NativeVRFRandomness', report.provider);
    const coordinator = new ethers.Contract(await adapter.coordinator(), config.abi, ethers.provider);
    const subscriptionId = await adapter.subscriptionId();
    const subscription = await coordinator.getSubscription(subscriptionId);
    report.vrf = { adapter: report.provider, database: await adapter.database(), coordinator: await adapter.coordinator(),
      subscriptionId: subscriptionId.toString(), subscriptionOwner: subscription.owner, consumers: Array.from(subscription.consumers),
      reserveBNB: ethers.formatEther(subscription.nativeBalance), requestFeeBNB: ethers.formatEther(await adapter.requestFee()),
      confirmations: String(await adapter.confirmations()), prizeNonCancellable: await (await ethers.getContractAt('PrizePool', report.prizeMaster)).supportsNonCancellableRandomness() };
  }
  const moduleInterface = (await ethers.getContractFactory('TaxHandler')).interface;
  const logs = await ethers.provider.getLogs({ address: report.tokens.map(t => t.handler), fromBlock: dep.startBlock,
    toBlock: report.block, topics: [moduleInterface.getEvent('ModuleAdded').topicHash, ethers.zeroPadValue('0x04', 32)] });
  report.historicalPrizePools = [];
  for (const log of logs) {
    const address = moduleInterface.parseLog(log).args.moduleAddress;
    const pool = await ethers.getContractAt('PrizePool', address);
    report.historicalPrizePools.push({ address, mode: Number(await pool.payoutMode()), balance: String(await ethers.provider.getBalance(address)) });
  }
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync('deployments/vrf-inventory.json', JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.shortMessage || e.reason || e.code || 'Inspection failed'); process.exitCode = 1; });
