/**
 * Raw-RPC transaction helpers.
 *
 * Some BSC RPC providers answer `eth_getTransactionByHash` for a PENDING
 * contract-creation with `"to": ""` instead of `null`. Both ethers v6 and
 * hardhat-ethers throw while formatting that response, and hardhat-ethers'
 * signer polls `getTransaction` right after broadcast — so a deploy can be
 * broadcast successfully and still crash the script before it returns.
 *
 * These helpers sign locally with the network's configured key, broadcast
 * via `eth_sendRawTransaction`, and poll `eth_getTransactionReceipt` through
 * the raw provider, never touching the transaction formatter.
 */

function signerKey(hre) {
    const accounts = hre.network.config.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error(`Network ${hre.network.name} has no configured private key for raw sends`);
    }
    return accounts[0];
}

async function waitForReceipt(hre, hash, { pollMs = 3000, timeoutMs = 10 * 60 * 1000 } = {}) {
    const started = Date.now();
    for (;;) {
        const receipt = await hre.ethers.provider.send("eth_getTransactionReceipt", [hash]);
        if (receipt && receipt.blockNumber) {
            if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted`);
            return {
                hash,
                blockNumber: parseInt(receipt.blockNumber, 16),
                gasUsed: parseInt(receipt.gasUsed, 16),
                contractAddress: receipt.contractAddress
                    ? hre.ethers.getAddress(receipt.contractAddress)
                    : null,
            };
        }
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${hash}`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

/** Sign + broadcast `{ to?, data, value? }`; resolves to the mined receipt. */
async function sendRaw(hre, { to, data, value = 0n }, opts = {}) {
    const wallet = new hre.ethers.Wallet(signerKey(hre));
    const provider = hre.ethers.provider;
    const from = wallet.address;

    const [chainIdHex, nonceHex, gasPriceHex] = await Promise.all([
        provider.send("eth_chainId", []),
        provider.send("eth_getTransactionCount", [from, "pending"]),
        provider.send("eth_gasPrice", []),
    ]);
    // toQuantity → "0x0" (Geth rejects the zero-padded "0x00" from toBeHex).
    const call = { from, data, value: hre.ethers.toQuantity(value) };
    if (to) call.to = to;
    const estimateHex = await provider.send("eth_estimateGas", [call]);
    const gasLimit = (BigInt(estimateHex) * 125n) / 100n;

    const tx = {
        type: 0,
        chainId: BigInt(chainIdHex),
        nonce: parseInt(nonceHex, 16),
        gasPrice: BigInt(gasPriceHex),
        gasLimit,
        to: to || null,
        data,
        value,
    };
    const raw = await wallet.signTransaction(tx);
    const hash = await provider.send("eth_sendRawTransaction", [raw]);
    if (opts.onBroadcast) await opts.onBroadcast(hash);
    const receipt = await waitForReceipt(hre, hash, opts);
    return { ...receipt, from, nonce: tx.nonce };
}

/** Deploy `contractName` with constructor `args`; resolves to { address, receipt }. */
async function deployRaw(hre, contractName, args = [], opts = {}) {
    const factory = await hre.ethers.getContractFactory(contractName);
    const deployTx = await factory.getDeployTransaction(...args);
    const receipt = await sendRaw(hre, { data: deployTx.data }, opts);
    if (!receipt.contractAddress) throw new Error(`No contract address in receipt for ${contractName}`);
    return { address: receipt.contractAddress, receipt };
}

/** Call a state-changing `method` on an ethers Contract instance; resolves to the receipt. */
async function callRaw(hre, contract, method, args = [], opts = {}) {
    const data = contract.interface.encodeFunctionData(method, args);
    return sendRaw(hre, { to: await contract.getAddress(), data, value: opts.value || 0n }, opts);
}

module.exports = { sendRaw, deployRaw, callRaw, waitForReceipt };
