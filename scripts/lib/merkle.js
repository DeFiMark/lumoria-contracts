// Merkle tree for PrizePool settlement — the JS mirror of
// contracts/lib/MerkleProof.sol.
//
// Pair hashing is COMMUTATIVE (sorted before hashing), so proofs carry no
// left/right flags. An odd node at any level is carried up unpaired (never
// duplicated). Leaves are keccak256(abi.encode(...)) of 3+ fields, so a leaf
// preimage can never be 64 bytes and collide with an internal node.
//
// Used by the Hardhat tests AND the operator scripts (scripts/operator/*) —
// this file IS the reference tree construction; keep it in lock-step with the
// Solidity verifier and with docs/SUBGRAPH.md's ticket-derivation notes.

const { ethers } = require("hardhat");

const coder = ethers.AbiCoder.defaultAbiCoder();

/** PRO_RATA leaf: keccak256(abi.encode(account, weight, tokensBought)) */
function proRataLeaf({ account, weight, tokensBought }) {
    return ethers.keccak256(
        coder.encode(["address", "uint256", "uint256"], [account, weight, tokensBought]),
    );
}

/** LOTTERY leaf: keccak256(abi.encode(index, account, weight, cumBefore, tokensBought)) */
function lotteryLeaf({ index, account, weight, cumBefore, tokensBought }) {
    return ethers.keccak256(
        coder.encode(
            ["uint256", "address", "uint256", "uint256", "uint256"],
            [index, account, weight, cumBefore, tokensBought],
        ),
    );
}

function hashPair(a, b) {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return ethers.keccak256(ethers.concat([lo, hi]));
}

/**
 * Build a tree from leaf hashes. Returns { root, proof(i) }.
 * A single leaf is its own root with an empty proof.
 */
function buildTree(leaves) {
    if (leaves.length === 0) throw new Error("empty tree");
    const layers = [leaves.slice()];
    while (layers[layers.length - 1].length > 1) {
        const prev = layers[layers.length - 1];
        const next = [];
        for (let i = 0; i < prev.length; i += 2) {
            if (i + 1 < prev.length) next.push(hashPair(prev[i], prev[i + 1]));
            else next.push(prev[i]); // odd node carries up unpaired
        }
        layers.push(next);
    }
    return {
        root: layers[layers.length - 1][0],
        proof(index) {
            const path = [];
            let idx = index;
            for (let level = 0; level < layers.length - 1; level++) {
                const layer = layers[level];
                const sibling = idx ^ 1;
                if (sibling < layer.length) path.push(layer[sibling]);
                idx = Math.floor(idx / 2);
            }
            return path;
        },
    };
}

/**
 * Assemble the PRO_RATA settlement for a ticket list
 * [{ account, weight, tokensBought }] — per-account weights are AGGREGATED
 * (one leaf per account), matching §2.7's account-keyed claim.
 */
function buildProRataSettlement(tickets) {
    const byAccount = new Map();
    for (const t of tickets) {
        const key = ethers.getAddress(t.account);
        const cur = byAccount.get(key) || { account: key, weight: 0n, tokensBought: 0n };
        cur.weight += BigInt(t.weight);
        cur.tokensBought += BigInt(t.tokensBought ?? 0n);
        byAccount.set(key, cur);
    }
    const entries = [...byAccount.values()];
    const leaves = entries.map(proRataLeaf);
    const tree = buildTree(leaves);
    const totalWeight = entries.reduce((a, e) => a + e.weight, 0n);
    return {
        entries,
        totalWeight,
        ticketCount: tickets.length,
        root: tree.root,
        proofFor(account) {
            const i = entries.findIndex(
                (e) => e.account === ethers.getAddress(account),
            );
            if (i < 0) throw new Error("account not in tree");
            return { ...entries[i], proof: tree.proof(i) };
        },
    };
}

/**
 * Assemble the LOTTERY settlement. Tickets are APPEND-ONLY AND NEVER MERGED
 * (§2.5) — a buyer with three buys has three tickets — so cumulative weights
 * stay monotonic and the on-chain range check is O(1).
 *
 * Optional maxWeightBps caps a single ACCOUNT's total weight at that share of
 * the uncapped total, applied deterministically in ticket order (§2.5).
 */
function buildLotterySettlement(tickets, { maxWeightBps = 0n } = {}) {
    let weights = tickets.map((t) => BigInt(t.weight));

    if (maxWeightBps && BigInt(maxWeightBps) > 0n) {
        const uncappedTotal = weights.reduce((a, w) => a + w, 0n);
        const cap = (uncappedTotal * BigInt(maxWeightBps)) / 10000n;
        const used = new Map();
        weights = tickets.map((t, i) => {
            const key = ethers.getAddress(t.account);
            const soFar = used.get(key) || 0n;
            const allowed = cap > soFar ? cap - soFar : 0n;
            const w = weights[i] <= allowed ? weights[i] : allowed;
            used.set(key, soFar + w);
            return w;
        });
    }

    let cum = 0n;
    const entries = tickets.map((t, i) => {
        const e = {
            index: BigInt(i),
            account: ethers.getAddress(t.account),
            weight: weights[i],
            cumBefore: cum,
            tokensBought: BigInt(t.tokensBought ?? 0n),
        };
        cum += weights[i];
        return e;
    });
    const leaves = entries.map(lotteryLeaf);
    const tree = buildTree(leaves);
    return {
        entries,
        totalWeight: cum,
        ticketCount: tickets.length,
        root: tree.root,
        proofFor(index) {
            return { ...entries[index], proof: tree.proof(index) };
        },
        /** Which ticket index wins `slot` for `randomWord` — mirrors the contract. */
        winningIndex(randomWord, slot) {
            const r = BigInt(ethers.keccak256(
                coder.encode(["uint256", "uint256"], [randomWord, slot]),
            )) % cum;
            return entries.findIndex(
                (e) => e.cumBefore <= r && r < e.cumBefore + e.weight,
            );
        },
    };
}

module.exports = {
    proRataLeaf,
    lotteryLeaf,
    hashPair,
    buildTree,
    buildProRataSettlement,
    buildLotterySettlement,
};
