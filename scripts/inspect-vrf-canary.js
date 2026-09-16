const hre = require('hardhat');
const config = require('./lib/vrf-config');
async function main() {
  const { ethers } = hre;
  const journal = require('../deployments/bsc-native-vrf.json');
  const c = new ethers.Contract(config[56].coordinator, config.abi, ethers.provider);
  const s = await c.getSubscription(journal.canary.subId);
  const receipt = await ethers.provider.getTransactionReceipt(journal.transactions.canaryDraw.hash);
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  const head = await ethers.provider.getBlock('latest');
  const topics = new Map();
  const logs = await ethers.provider.getLogs({ address: config[56].coordinator, fromBlock: head.number - 5000, toBlock: head.number });
  for (const l of logs) topics.set(l.topics[0], (topics.get(l.topics[0]) || 0) + 1);
  console.log(JSON.stringify({ ageSeconds: head.timestamp - block.timestamp, subscription: Array.from(s, x => typeof x === 'bigint' ? x.toString() : x), pending: await c.pendingRequestExists(journal.canary.subId), recentCoordinatorEvents: Object.fromEntries(topics) }, null, 2));
}
main().catch(e => { console.error(e.shortMessage || e.code); process.exitCode = 1; });
