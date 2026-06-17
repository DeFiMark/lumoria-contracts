//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Minimal Lumoria Router interface used by modules
    (BurnModule for buybacks, LiquidityModule for auto-LP).

    Implemented by v4/LumoriaSwapRouter, which fulfills these calls over
    the Uniswap V4 PoolManager (swaps) and the LiquidityVault (locked LP).
 */

interface ILumoriaRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}
