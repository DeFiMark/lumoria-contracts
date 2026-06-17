//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria V2-style Factory.

    Curated: only Lumoria tokens (as registered in Database) can have pairs.
    Always pairs against WBNB.

    The Pair contract calls swapEvent() after every swap so the Factory emits
    a user-attributed Buy/Sell at the token level — gives subgraphs a clean
    signal without decoding Pair.Swap via sort-order heuristics.
 */
interface ILumoriaFactory {

    // ─── Events ─────────────────────────────────────────────────────

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsIndex);
    event Buy(address indexed token, address indexed user, uint256 bnbIn, uint256 tokensOut);
    event Sell(address indexed token, address indexed user, uint256 bnbOut, uint256 tokensIn);

    // ─── Views ──────────────────────────────────────────────────────

    function database() external view returns (address);
    function wbnb() external view returns (address);
    function getPair(address tokenA, address tokenB) external view returns (address);
    function allPairs(uint256 index) external view returns (address);
    function allPairsLength() external view returns (uint256);
    function isPair(address pair) external view returns (bool);
    function INIT_CODE_PAIR_HASH() external view returns (bytes32);

    // ─── Core ───────────────────────────────────────────────────────

    function createPair(address tokenA, address tokenB) external returns (address pair);

    /// @notice Called by a Pair after every swap to emit a user-attributed Buy/Sell.
    function swapEvent(
        address token0,
        address token1,
        address user,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out
    ) external;
}
