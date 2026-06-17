//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Responsible for generating all contracts associated with a new project
    - Token Contract
    - Bonding Curve Contract

    Also adds these addresses and relevant information to the database
 */

import "./lib/Ownable.sol";
import "./interfaces/IBondingCurve.sol";
import "./interfaces/IHoldToken.sol";
import "./interfaces/IGenerator.sol";
import "./interfaces/IDatabase.sol";
import "./interfaces/IHolderRewards.sol";

contract Generator is IGenerator {

    IDatabase public immutable database;

    bool public useVanityClones;

    bytes32 public constant INIT_CODE_PAIR_HASH = 0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5;
    address public constant factory = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant WETH = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    constructor(address _database) {
        database = IDatabase(_database);
        useVanityClones = true;
    }

    function setUseVanityClones(bool _useVanityClones) external {
        require(msg.sender == database.owner(), "Generator: Only owner can set useVanityClones");
        useVanityClones = _useVanityClones;
    }

    /**
        Generates a token and bonding curve, initializes both and returns their addresses
     */
    function generateProject(
        string calldata name, 
        string calldata symbol, 
        bytes calldata tokenPayload, 
        bytes calldata bondingCurvePayload, 
        bytes32 salt
    ) external override returns (address token, address bondingCurve) {
        token = generateToken(salt);
        bondingCurve = generateBondingCurve();
        address holderRewards = generateHolderRewards();
        address pair = pairFor(token, WETH);

        string memory _name = name;
        string memory _symbol = symbol;
        bytes memory _tokenPayload = tokenPayload;
        bytes memory _bondingCurvePayload = bondingCurvePayload;

        IHolderRewards(holderRewards).__init__(token);
        IHoldToken(token).__init__(_tokenPayload, _name, _symbol, bondingCurve, pair, holderRewards, database.getFeeRecipient());
        IBondingCurve(bondingCurve).__init__(_bondingCurvePayload, token);
    }

    /**
        @dev Deploys and returns the address of a clone of the PumpTokenMasterCopy
        Created by DeFi Mark To Allow Clone Contract To Easily Create Clones Of Itself
        Without redundancy
     */
    function generateToken(bytes32 salt) internal returns(address) {
        return (salt != bytes32(0) && useVanityClones) ? _cloneVanity(database.getTokenMasterCopy(), salt) : _clone(database.getTokenMasterCopy());
    }

    /**
        @dev Deploys and returns the address of a clone of the PumpBondingCurveMasterCopy
        Created by DeFi Mark To Allow Clone Contract To Easily Create Clones Of Itself
        Without redundancy
     */
    function generateBondingCurve() internal returns(address) {
        return _clone(database.getBondingCurveMasterCopy());
    }

    /**
        @dev Deploys and returns the address of a clone of the HolderRewardsMasterCopy
        Created by DeFi Mark To Allow Clone Contract To Easily Create Clones Of Itself
        Without redundancy
     */
    function generateHolderRewards() internal returns(address) {
        return _clone(database.getHolderRewardsMasterCopy());
    }

    /**
        @dev Returns the address of the database
     */
    function getDatabase() external view override returns (address) {
        return address(database);
    }

    /**
     * @dev Deploys and returns the address of a clone that mimics the behaviour of `implementation`.
     *
     * This function uses the create opcode, which should never revert.
     */
    function _clone(address implementation) internal returns (address instance) {
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "ERC1167: create failed");
    }

    /**
     * @dev Deploys a clone of `implementation` using CREATE2.
     * The final address of the clone is deterministic based on the salt.
     * @param implementation The address of the contract to clone.
     * @param salt A 32-byte value used to determine the new address.
     */
    function _cloneVanity(address implementation, bytes32 salt) internal returns (address instance) {
        bytes20 implementationBytes = bytes20(implementation);
        
        // This is the ERC-1167 minimal proxy bytecode.
        // It's a template that gets filled with the implementation address.
        bytes memory creationCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            implementationBytes,
            hex"5af43d82803e903d91602b57fd5bf3"
        );

        /// @solidity memory-safe-assembly
        assembly {
            // The `create2` opcode takes 4 arguments:
            // 1. value (amount of ETH to send)
            // 2. memory offset of the creation code
            // 3. length of the creation code
            // 4. the salt
            instance := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }

        require(instance != address(0), "CREATE2: Failed on deploy");
    }

    // calculates the CREATE2 address for a pair without making any external calls
    function pairFor(address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(uint160(uint(keccak256(abi.encodePacked(
            hex'ff',
            factory,
            keccak256(abi.encodePacked(token0, token1)),
            INIT_CODE_PAIR_HASH
        )))));
    }

    // returns sorted token addresses, used to handle return values from pairs sorted in this order
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, 'DEXLibrary: IDENTICAL_ADDRESSES');
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'DEXLibrary: ZERO_ADDRESS');
    }
}