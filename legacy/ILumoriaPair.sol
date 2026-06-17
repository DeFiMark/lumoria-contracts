//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IERC20.sol";

/**
    Lumoria V2-style AMM pair.

    One pair per Lumoria token (always TOKEN/WBNB).
    LP fee: 0.1% (10 bps) — kept by the pool, grows LP value over time.
    swap() takes an extra `user` parameter so the Factory can emit Buy/Sell
    events attributed to the end user (the Router is the direct caller).
 */
interface ILumoriaPair is IERC20 {

    // ─── Events ─────────────────────────────────────────────────────

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    // ─── Init ───────────────────────────────────────────────────────

    function initialize(address _token0, address _token1) external;

    // ─── Views ──────────────────────────────────────────────────────

    function MINIMUM_LIQUIDITY() external pure returns (uint256);
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);

    // ─── Core ───────────────────────────────────────────────────────

    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, address user) external;
    function skim(address to) external;
    function sync() external;
}
