//SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
    Test-only import shim.

    Hardhat only compiles sources reachable from `contracts/`. The test
    fixtures deploy a local Uniswap V4 PoolManager (on hardhat/localhost
    the canonical BSC deployment obviously doesn't exist), so we import it
    here to force artifact generation. Never deployed on mainnet — the BSC
    deploy scripts use the canonical PoolManager at
    0x28e2ea090877bf75740558f6bfb36a5ffee9e9df.
 */

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
