//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRebate {

    struct RebateConfig {
        uint256 rebateBps;
        uint256 fundedBalance;
        address creator;
        bool active;
    }

    event RebateFunded(address indexed token, address indexed creator, uint256 amount, uint256 rebateBps);
    event RebateToppedUp(address indexed token, uint256 amount, uint256 newBalance);
    event RebateCredited(address indexed token, address indexed buyer, uint256 tokenAmount);
    event RebateBpsUpdated(address indexed token, uint256 oldBps, uint256 newBps);
    event RebateWithdrawn(address indexed token, uint256 amount);
    event RebateDeactivated(address indexed token);
    event CreditorUpdated(address indexed creditor, bool authorized);

    function fundRebate(address token, uint256 amount, uint256 rebateBps) external;
    function topUpRebate(address token, uint256 amount) external;
    function setRebateBps(address token, uint256 rebateBps) external;
    function withdrawFunds(address token, uint256 amount) external;
    function creditRebate(address token, address buyer, uint256 tokensBought) external;
    function setAuthorizedCreditor(address creditor, bool authorized) external;
}
