//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Test-only. Accepts BNB but burns every unit of gas it is given in
    `receive()`. Used to prove a hostile holder cannot exhaust a
    `RewardModule.pushRewards` batch: the per-recipient gas cap bounds the
    damage and the batch carries on to the next holder.
 */
contract GasBurningRecipient {
    uint256 public sink;

    receive() external payable {
        for (;;) {
            sink++;
        }
    }
}
