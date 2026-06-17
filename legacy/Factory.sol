//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria V2 Factory

    Curated-only pair creation: tokenA or tokenB must be a Lumoria token
    (as tracked by Database.isLumoriaToken), and the *other* side must be
    WBNB. External random tokens cannot list on Lumoria.

    Pair creation is restricted to the Generator and Router:
    - Generator: creates the pair at token-launch time.
    - Router: creates the pair lazily when the first addLiquidity call
      arrives (needed for BYOL / FlatCurve launch modes).

    Re-emits user-attributed Buy / Sell events after every swap.
 */

import "./interfaces/ILumoriaFactory.sol";
import "./interfaces/IDatabase.sol";
import "./Pair.sol";

contract LumoriaFactory is ILumoriaFactory {

    bytes32 public constant override INIT_CODE_PAIR_HASH = keccak256(abi.encodePacked(type(LumoriaPair).creationCode));

    address public immutable override database;
    address public immutable override wbnb;

    mapping(address => mapping(address => address)) public override getPair;
    mapping(address => bool) public override isPair;
    address[] private _allPairs;

    constructor(address _database, address _wbnb) {
        require(_database != address(0), "Factory: zero database");
        require(_wbnb != address(0), "Factory: zero wbnb");
        database = _database;
        wbnb = _wbnb;
    }

    // ─── Views ──────────────────────────────────────────────────────

    function allPairs(uint256 index) external view override returns (address) {
        return _allPairs[index];
    }

    function allPairsLength() external view override returns (uint256) {
        return _allPairs.length;
    }

    // ─── Create Pair ────────────────────────────────────────────────

    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        require(tokenA != tokenB, "Factory: IDENTICAL_ADDRESSES");
        require(tokenA != address(0) && tokenB != address(0), "Factory: ZERO_ADDRESS");

        // Exactly one side must be WBNB; the other must be a registered Lumoria token.
        (address lumoriaToken, bool tokenAisWbnb) = tokenA == wbnb
            ? (tokenB, true)
            : (tokenB == wbnb ? (tokenA, false) : (address(0), false));
        require(lumoriaToken != address(0), "Factory: WBNB pair required");
        require(IDatabase(database).isLumoriaToken(lumoriaToken), "Factory: token not curated");

        // Only the Generator or the Router can create pairs.
        IDatabase db = IDatabase(database);
        require(
            msg.sender == db.generator() || msg.sender == db.router(),
            "Factory: unauthorized"
        );

        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(getPair[token0][token1] == address(0), "Factory: PAIR_EXISTS");

        bytes memory bytecode = type(LumoriaPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        require(pair != address(0), "Factory: create2 failed");

        ILumoriaPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        isPair[pair] = true;
        _allPairs.push(pair);

        // silence unused-var warning for tokenAisWbnb (the ternary needs both slots)
        tokenAisWbnb;

        emit PairCreated(token0, token1, pair, _allPairs.length);
    }

    // ─── Swap Event Relay ───────────────────────────────────────────

    function swapEvent(
        address token0,
        address token1,
        address user,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out
    ) external override {
        require(isPair[msg.sender], "Factory: NOT_PAIR");

        bool isWETH0 = token0 == wbnb;
        address token = isWETH0 ? token1 : token0;
        bool isBuy = isWETH0 ? amount0In > 0 : amount1In > 0;

        if (isBuy) {
            uint256 bnbIn = isWETH0 ? amount0In : amount1In;
            uint256 tokensOut = isWETH0 ? amount1Out : amount0Out;
            emit Buy(token, user, bnbIn, tokensOut);
        } else {
            uint256 bnbOut = isWETH0 ? amount0Out : amount1Out;
            uint256 tokensIn = isWETH0 ? amount1In : amount0In;
            emit Sell(token, user, bnbOut, tokensIn);
        }
    }
}
