//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Test-only. A contract that cannot accept BNB: no payable `receive()` and no
    payable `fallback()`.

    Used to prove that a CreatorFeeModule pointed at such a recipient can no
    longer brick trading. Under the old push-based `receiveTax()`, sending BNB
    here reverted, which reverted the swap, which bricked every trade of the
    token. Under accrue-and-pull, `receiveTax()` merely credits a balance and
    only this contract's own `withdraw()` fails.
 */
contract RejectingRecipient {
    /// @dev Lets the test drive `CreatorFeeModule.withdraw()` from this address
    ///      and observe that only this call reverts.
    function tryWithdraw(address module) external {
        (bool ok, ) = module.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "withdraw failed");
    }

    /// @dev Lets the test hand the fee stream to another address.
    function setRecipient(address module, address newRecipient) external {
        (bool ok, ) = module.call(abi.encodeWithSignature("setRecipient(address)", newRecipient));
        require(ok, "setRecipient failed");
    }
}
