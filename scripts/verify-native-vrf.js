const hre = require('hardhat');
const fs = require('fs');
async function main() {
  const file = `deployments/${hre.network.name}-native-vrf.json`;
  const j = JSON.parse(fs.readFileSync(file));
  for (const [address, args, contract] of [
    [j.canary.contract, [], 'contracts/test-mocks/VRFDeploymentCanary.sol:VRFDeploymentCanary'],
    [j.canary.adapter, j.canary.args, 'contracts/NativeVRFRandomness.sol:NativeVRFRandomness'],
    [j.production.adapter, j.production.args, 'contracts/NativeVRFRandomness.sol:NativeVRFRandomness'],
    [j.production.prizeMaster, [], 'contracts/modules/PrizePool.sol:PrizePool'],
  ]) {
    try {
      await hre.run('verify:verify', { address, constructorArguments: args, contract });
    } catch (e) {
      if (!/already verified/i.test(e.message)) throw e;
    }
  }
  j.verifiedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
}
main().catch(e => { console.error(e.message?.split('\n').slice(0, 3).join('\n') || e.code); process.exitCode = 1; });
