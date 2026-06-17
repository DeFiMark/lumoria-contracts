//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Minimal CREATE2 deployer (test + deploy tooling).

    Uniswap V4 hook permissions are encoded in the low 14 bits of the
    hook contract's address, so the LumoriaHook must be deployed via
    CREATE2 with a salt mined off-chain (see scripts/lib/hook-miner.js).
    On public networks the canonical deterministic-deployment proxy can
    be used instead; this contract keeps local test deployments simple.
 */

contract Create2Deployer {
    event Deployed(address addr, bytes32 salt);

    function deploy(bytes32 salt, bytes memory creationCode) external payable returns (address addr) {
        assembly {
            addr := create2(callvalue(), add(creationCode, 0x20), mload(creationCode), salt)
        }
        require(addr != address(0), "Create2Deployer: failed");
        emit Deployed(addr, salt);
    }

    function computeAddress(bytes32 salt, bytes32 creationCodeHash) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, creationCodeHash))))
        );
    }
}
