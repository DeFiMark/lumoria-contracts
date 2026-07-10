//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Test-only. Stands in for the external V2-compatible router a token-mode
    RewardModule swaps through, and always reverts.

    Models the realistic failure: the external reward-token pair is thin,
    missing, or paused. Under the old `receiveTax()`, that swap ran inside the
    Uniswap V4 swap callback, so this revert propagated up through the hook and
    bricked EVERY trade of the Lumoria token. Now the swap is deferred to the
    operator-gated `convertAndDistribute()`, so only the keeper's call fails.
 */
contract RevertingRouter {
    error RouterDown();

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256,
        address[] calldata,
        address,
        uint256
    ) external payable {
        revert RouterDown();
    }

    function addLiquidityETH(address, uint256, uint256, uint256, address, uint256)
        external
        payable
        returns (uint256, uint256, uint256)
    {
        revert RouterDown();
    }
}
