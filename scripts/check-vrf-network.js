require('dotenv').config();
const { ethers } = require('ethers');
const config = require('./lib/vrf-config');
async function main() {
  for (const [id, env, fallback] of [[56, 'BSC_RPC', 'https://bsc-dataseed.binance.org'], [97, 'BSC_TESTNET_RPC', 'https://data-seed-prebsc-1-s1.binance.org:8545']]) {
    const request = new ethers.FetchRequest(process.env[env] || fallback); request.timeout = 15000;
    const provider = new ethers.JsonRpcProvider(request, id, { staticNetwork: true });
    try {
      const wallet = new ethers.Wallet(process.env.DEPLOYER_PK);
      const coordinator = new ethers.Contract(config[id].coordinator, config.abi, provider);
      console.log(JSON.stringify({ chainId: id, balance: ethers.formatEther(await provider.getBalance(wallet.address)),
        coordinatorCode: (await provider.getCode(config[id].coordinator)).length, config: Array.from(await coordinator.s_config(), String) }));
    } catch (e) { console.log(JSON.stringify({ chainId: id, error: e.shortMessage || e.code || 'network unavailable' })); }
    finally { provider.destroy(); }
  }
}
main().catch(() => { process.exitCode = 1; });
