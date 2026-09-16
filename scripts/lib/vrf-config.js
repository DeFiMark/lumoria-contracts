// Chainlink's official VRF v2.5 subscription coordinators, checked 2026-09-16:
// https://docs.chain.link/vrf/v2-5/supported-networks#bnb-chain-mainnet
module.exports = {
  56: { coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
    keyHash: '0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4' },
  97: { coordinator: '0xDA3b641D438362C440Ac5458c57e00a712b66700',
    keyHash: '0x8596b430971ac45bdf6088665b9ad8e8630c9d5049ab54b14dff711bee7c0e26' },
  abi: [
    'function createSubscription() returns (uint256)',
    'event SubscriptionCreated(uint256 indexed subId, address owner)',
    'function addConsumer(uint256 subId,address consumer)',
    'function cancelSubscription(uint256 subId,address to)',
    'function getSubscription(uint256 subId) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
    'function fundSubscriptionWithNative(uint256 subId) payable',
    'function pendingRequestExists(uint256 subId) view returns (bool)',
    'function s_config() view returns (uint16 minimumRequestConfirmations,uint32 maxGasLimit,bool reentrancyLock,uint32 stalenessSeconds,uint32 gasAfterPaymentCalculation,uint32 fulfillmentFlatFeeNativePPM,uint32 fulfillmentFlatFeeLinkDiscountPPM,uint8 nativePremiumPercentage,uint8 linkPremiumPercentage)',
  ],
};
