// Resumable rollout. LP_STAGE: deploy, verify, activate, smoke-start, smoke-finish.
// LP_STAGE=rehearse runs the same rollout on an in-memory BSC fork only.
const hre = require('hardhat');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { sendRaw, waitForReceipt } = require('./lib/raw-tx');
const { ethers } = hre;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const names = ['LumoriaToken', 'TaxHandler', 'RebateContract', 'Generator'];
const retired = [
  '0xd22E404B57EA8Df3Fa14DaeD18ED26aeA8D65D37', '0x6C9f1746BBF1cf91db72341D615dA75e1900041a',
  '0xE109A630cef96AF7aC6a2D68B066c9A95ed69c49', '0x2418fd099953af530beC228693C2057A97780156',
  '0x54e384a2c3A24d92f5422F3BF0B00e13c95C39cF', '0x9A40ed9708CB1616Fe9DDE1D4849f7476576811A',
];

async function main() {
  const stage = process.env.LP_STAGE;
  assert(['deploy', 'verify', 'activate', 'smoke-start', 'smoke-finish', 'rehearse'].includes(stage), 'Choose LP_STAGE');
  const fork = stage === 'rehearse';
  assert(fork ? hre.network.name === 'hardhat' && process.env.BSC_FORK === '1' : hre.network.name === 'bsc', 'Wrong network');
  assert.equal((await ethers.provider.getNetwork()).chainId, 56n);
  if (fork) await hre.network.provider.send('evm_mine');
  const baseFile = path.join(__dirname, '../deployments/bsc.json');
  const base = JSON.parse(fs.readFileSync(baseFile));
  const journalFile = path.join(__dirname, `../deployments/${fork ? 'fork' : 'bsc'}-launch-protection.json`);
  const j = !fork && fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile)) : {
    createdAt: new Date().toISOString(), database: base.core.database, previous: {
      generator: base.core.generator, rebateContract: base.core.rebateContract,
      token: base.masterCopies.token, taxHandler: base.masterCopies.taxHandler,
    }, contracts: {}, transactions: {}, retiredTestTokens: retired,
  };
  const save = () => fs.writeFileSync(journalFile, JSON.stringify(j, null, 2));
  const dbRead = await ethers.getContractAt('Database', base.core.database);
  const owner = await dbRead.owner();
  if (fork) {
    await hre.network.provider.send('hardhat_impersonateAccount', [owner]);
    await hre.network.provider.send('hardhat_setBalance', [owner, ethers.toQuantity(ethers.parseEther('100'))]);
  }
  const signer = fork ? await ethers.getSigner(owner) : (await ethers.getSigners())[0];
  assert(same(signer.address, owner), 'Signer is not Database owner');
  const db = dbRead.connect(signer);
  const artifacts = Object.fromEntries(await Promise.all(names.map(async name => [name, await hre.artifacts.readArtifact(name)])));
  const sourceHashes = Object.fromEntries(names.map(name => [name, ethers.keccak256(artifacts[name].bytecode)]));
  if (j.sourceHashes) assert.deepEqual(sourceHashes, j.sourceHashes, 'Compiled candidates changed since deployment');
  j.sourceHashes = sourceHashes;
  for (const field of ['hook', 'router', 'liquidityVault', 'randomnessProvider']) {
    assert(same(await db[field](), base.core[field]), `${field} drift`);
  }
  async function transact(label, tx) {
    let entry = j.transactions[label];
    if (!entry) {
      console.log(`Sending ${label}`);
      if (fork) {
        const sent = await signer.sendTransaction(tx);
        j.transactions[label] = { hash: sent.hash }; save();
        await sent.wait();
      } else {
        await sendRaw(hre, tx, { onSigned: hash => { j.transactions[label] = { hash }; save(); },
          onBroadcast: hash => console.log(`${label}: ${hash}`) });
      }
      entry = j.transactions[label];
    }
    const receipt = await waitForReceipt(hre, entry.hash);
    j.transactions[label] = receipt; save();
    return ethers.provider.getTransactionReceipt(receipt.hash);
  }
  const call = (label, contract, method, args = [], value = 0n) => transact(label, {
    to: contract.target, data: contract.interface.encodeFunctionData(method, args), value,
  });
  async function deploy() {
    assert(same(await db.generator(), j.previous.generator), 'Unexpected current Generator');
    assert.equal(Number(await db.allTokensLength()), retired.length, 'New projects need review before retiring test state');
    for (let i = 0; i < retired.length; i++) assert(same(await db.allTokens(i), retired[i]), 'Registry changed');
    j.inventoryBlock = await ethers.provider.getBlockNumber(); save();
    for (const name of names) {
      const args = ['Generator', 'RebateContract'].includes(name) ? [base.core.database] : [];
      const factory = await ethers.getContractFactory(name, signer);
      const receipt = await transact(`deploy${name}`, await factory.getDeployTransaction(...args));
      const address = receipt.contractAddress;
      assert(address && await ethers.provider.getCode(address) !== '0x', 'Missing candidate code');
      j.contracts[name] = { address, args, block: receipt.blockNumber, codeHash: ethers.keccak256(await ethers.provider.getCode(address)) }; save();
    }
    const generator = await ethers.getContractAt('Generator', j.contracts.Generator.address, signer);
    const old = await ethers.getContractAt('Generator', j.previous.generator);
    const bounds = Array.from(await old.singleSidedStartTickBounds());
    await call('preserveTickBounds', generator, 'setSingleSidedStartTickBounds', bounds);
    j.tickBounds = bounds.map(String);
    const rebate = await ethers.getContractAt('RebateContract', j.contracts.RebateContract.address, signer);
    await call('authorizeHook', rebate, 'setAuthorizedCreditor', [base.core.hook, true]);
    assert(await rebate.authorizedCreditors(base.core.hook));
    assert(await generator.supportsSniperGuard());
    save();
  }
  async function verify() {
    for (const name of names) {
      const { address, args } = j.contracts[name];
      try { await hre.run('verify:verify', { address, constructorArguments: args, contract: `contracts/${name}.sol:${name}` }); }
      catch (e) { if (!/already verified/i.test(e.message)) throw e; }
    }
    j.verifiedAt = new Date().toISOString(); save();
  }
  // Defined below to keep activation and smoke checks close to their journal entries.
  async function cutover() {
    if (!fork) {
      assert(j.verifiedAt, 'Explorer verification required');
      const rehearsal = JSON.parse(fs.readFileSync(path.join(__dirname, '../deployments/fork-launch-protection.json')));
      assert(rehearsal.smokePassed, 'Fork rehearsal required');
      assert.deepEqual(rehearsal.sourceHashes, sourceHashes, 'Rehearsal artifact mismatch');
    }
    assert.equal(Number(await db.allTokensLength()), retired.length, 'Registry changed before cutover');
    for (const name of names) {
      const c = j.contracts[name];
      assert.equal(ethers.keccak256(await ethers.provider.getCode(c.address)), c.codeHash, `${name} bytecode mismatch`);
    }
    const generatorNow = await db.generator();
    assert([j.previous.generator, ethers.ZeroAddress, j.contracts.Generator.address].some(a => same(a, generatorNow)), 'Generator drift');
    const operations = [
      ['tokenMasterCopy', 'setTokenMasterCopy', j.previous.token, j.contracts.LumoriaToken.address],
      ['taxHandlerMasterCopy', 'setTaxHandlerMasterCopy', j.previous.taxHandler, j.contracts.TaxHandler.address],
      ['rebateContract', 'setRebateContract', j.previous.rebateContract, j.contracts.RebateContract.address],
    ];
    for (const [read, , before, after] of operations) {
      const current = await db[read]();
      assert([before, after].some(a => same(a, current)), `${read} drift`);
    }
    const rebate = await ethers.getContractAt('RebateContract', j.contracts.RebateContract.address);
    assert(await rebate.authorizedCreditors(base.core.hook), 'Hook not authorized');
    await call('pauseLaunches', db, 'setGenerator', [ethers.ZeroAddress]);
    for (const [read, method, , address] of operations) {
      await call(method, db, method, [address]);
      assert(same(await db[read](), address), `${read} readback failed`);
    }
    await call('activateGenerator', db, 'setGenerator', [j.contracts.Generator.address]);
    assert(same(await db.generator(), j.contracts.Generator.address));
    j.activatedAt = new Date().toISOString(); save();
    if (!fork) {
      base.previous.launchProtection = j.previous;
      base.core.generator = j.contracts.Generator.address;
      base.core.rebateContract = j.contracts.RebateContract.address;
      base.masterCopies.token = j.contracts.LumoriaToken.address;
      base.masterCopies.taxHandler = j.contracts.TaxHandler.address;
      base.launchProtection = { activatedAt: j.activatedAt, contracts: j.contracts, retiredTestTokens: retired,
        activationBlock: j.transactions.activateGenerator.blockNumber, journal: 'bsc-launch-protection.json' };
      fs.writeFileSync(baseFile, JSON.stringify(base, null, 2));
    }
  }
  async function smoke(finish) {
    if (j.smokePassed) { console.log(`Smoke already passed for ${j.smoke.token}`); return; }
    if (!finish && j.smoke?.end) { console.log(`Smoke started; guard ends at ${j.smoke.end}`); return; }
    assert(same(await db.generator(), j.contracts.Generator.address), 'Candidates not active');
    const generator = await ethers.getContractAt('Generator', j.contracts.Generator.address, signer);
    const rebate = await ethers.getContractAt('RebateContract', j.contracts.RebateContract.address, signer);
    const router = await ethers.getContractAt('LumoriaSwapRouter', base.core.router, signer);
    const hook = await ethers.getContractAt('LumoriaHook', base.core.hook);
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const event = (receipt, contract, name) => receipt.logs.filter(l => same(l.address, contract.target))
      .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === name);
    if (!j.smoke) { j.smoke = { salt: ethers.hexlify(ethers.randomBytes(32)) }; save(); }
    const tokenAddress = await generator.predictTokenAddress(j.smoke.salt);
    j.smoke.token = tokenAddress; save();
    if (!finish) await call('smokeLaunch', generator, 'generateProject', [
      'Lumoria Guard Test - Not Investment', 'LGT', 2000, 500,
      [{ moduleType: 3, buyAllocation: 10000, sellAllocation: 10000, initPayload: abi.encode(['address'], [signer.address]) }],
      2, abi.encode(['int24', 'bool'], [180000, true]), [], j.smoke.salt, { image: '', socials: '', contractURI: '' },
    ], await db.launchFeeBnb());
    const token = await ethers.getContractAt('LumoriaToken', tokenAddress, signer);
    const handler = await ethers.getContractAt('TaxHandler', await db.tokenTaxHandler(tokenAddress), signer);
    assert(await handler.isExcludedFromShares(rebate.target));
    const deadline = async () => (await ethers.provider.getBlock('latest')).timestamp + 180;
    const quoter = new ethers.Contract(base.v4.v4Quoter, [
      'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
    ], signer);
    const quote = async (amount, buy) => (await quoter.quoteExactInputSingle.staticCall({
      poolKey: {currency0:ethers.ZeroAddress,currency1:tokenAddress,fee:0,tickSpacing:60,hooks:base.core.hook},
      zeroForOne:buy,exactAmount:amount,hookData:abi.encode(['address'],[signer.address]),
    })).amountOut * 95n / 100n;
    const buy = async (label, amount) => call(label, router, 'swapExactETHForTokensSupportingFeeOnTransferTokens',
      [await quote(amount, true), [base.wbnb, tokenAddress], signer.address, await deadline()], amount);
    if (!finish) {
      assert(await handler.sniperGuardActive(), 'Guard expired before smoke; inspect recorded transactions');
      await assert.rejects(handler.proposeFeeChange.staticCall(1000, 500));
      const receipt = await buy('smokeGuardBuy', ethers.parseEther('0.001'));
      const purchased = event(receipt, hook, 'TokenPurchased');
      const split = event(receipt, handler, 'SniperOverageDistributed');
      assert(purchased && split, 'Missing guard fee events');
      const timestamp = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      const effective = 9000n - ((timestamp - await handler.sniperGuardStart()) / 30n) * 500n;
      assert.equal(split.args[1], purchased.args.taxTaken * (effective - 2000n) / (4n * effective));
      assert.equal(split.args[2], purchased.args.taxTaken - split.args[1]);
      const funding = purchased.args.tokensOut / 2n;
      await call('smokeApproveRebate', token, 'approve', [rebate.target, funding]);
      await call('smokeFundRebate', rebate, 'fundRebate', [tokenAddress, funding, 1500]);
      assert.equal(await rebate.previewRebate(tokenAddress, ethers.parseEther('80')), 0n);
      const paused = await buy('smokePausedRebateBuy', ethers.parseEther('0.0001'));
      assert(!event(paused, rebate, 'RebateCredited'), 'Rebate paid during guard');
      await call('smokeZeroTransfer', token, 'transfer', [signer.address, 0]);
      j.smoke.end = String(await handler.sniperGuardEnd()); save();
      console.log(`Guard canary ${tokenAddress}; finishes at ${j.smoke.end}`);
    } else {
      if (fork) { await hre.network.provider.send('evm_setNextBlockTimestamp', [Number(j.smoke.end)]); await hre.network.provider.send('evm_mine'); }
      assert.equal(await handler.sniperGuardActive(), false, `Guard ends at ${j.smoke.end}; rerun smoke-finish then`);
      assert.equal(await handler.buyFee(), j.transactions.smokeLowerFee ? 1000n : 2000n);
      const receipt = await buy('smokeNormalBuy', ethers.parseEther('0.0001'));
      const purchased = event(receipt, hook, 'TokenPurchased'), credited = event(receipt, rebate, 'RebateCredited');
      assert(purchased && credited, 'Missing normal rebate');
      assert.equal(credited.args.tokenAmount, purchased.args.tokensOut * 1500n / 8000n);
      assert(!event(receipt, handler, 'SniperOverageDistributed'));
      await call('smokeLowerFee', handler, 'proposeFeeChange', [1000, 500]);
      assert.equal((await rebate.getRebateTerms(tokenAddress)).effectiveRate, 1000n);
      const amount = purchased.args.tokensOut / 2n;
      await call('smokeApproveSell', token, 'approve', [router.target, amount]);
      const sell = await call('smokeSell', router, 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        [amount, await quote(amount, false), [tokenAddress, base.wbnb], signer.address, await deadline()]);
      assert(event(sell, hook, 'TokenSold'));
      j.smokePassed = true; j.smoke.passedAt = new Date().toISOString(); save();
      console.log('Launch protection smoke PASSED');
    }
  }
  if (fork) { await deploy(); await cutover(); await smoke(false); await smoke(true); }
  else if (stage === 'deploy') await deploy();
  else if (stage === 'verify') await verify();
  else if (stage === 'activate') await cutover();
  else await smoke(stage === 'smoke-finish');
}
main().catch(e => { console.error(e.shortMessage || e.reason || e.message || e.code); process.exitCode = 1; });

