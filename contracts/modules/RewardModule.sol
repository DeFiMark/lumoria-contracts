//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Reward Module (Type 0)

    Distributes rewards proportionally to holders using a classic
    dividends-per-share accumulator pattern.

    Two modes:
    - BNB mode (rewardToken = address(0)): distributes received BNB directly
    - Token mode (rewardToken != 0): swaps received BNB -> rewardToken via an
      external V2-compatible router, then distributes

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/ILumoriaRouter.sol";
import "../lib/ReentrancyGuard.sol";
import "../lib/TransferHelper.sol";

contract RewardModule is IRewardModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 0;
    uint256 internal constant PRECISION = 1e36;

    // core references
    address public taxHandler;
    address public token;           // the Lumoria token (for analytics)
    address public rewardToken;     // address(0) = BNB rewards
    address public externalRouter;  // V2-compatible router used for BNB -> rewardToken swap
    address public externalWBNB;    // WBNB address for the external router's path

    // distribution config
    uint256 public minDistribution; // minimum BNB balance before attempting distribution
    uint256 public pendingBNB;      // BNB-mode: undistributed BNB (separate from claimable BNB)

    // dividend accumulator
    uint256 public dividendsPerShare;
    uint256 public totalSharesTracked;
    uint256 public totalDividendsDistributed;
    uint256 public totalDividendsWithdrawn;

    // per-holder
    mapping(address => uint256) public shares;
    mapping(address => uint256) public dividendCheckpoint; // dividendsPerShare at last crystallization
    mapping(address => uint256) public creditedDividends;  // rewards crystallized for this holder
    mapping(address => uint256) public withdrawnDividends; // rewards claimed

    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxReceived(uint256 amount);
    event DividendsDistributed(uint256 rewardAmount, uint256 bnbSpent);
    event RewardClaimed(address indexed holder, uint256 amount);
    event ShareUpdated(address indexed holder, uint256 oldShare, uint256 newShare);

    // ─── Initialization ─────────────────────────────────────────────

    /// @param payload abi-encoded (token, rewardToken, externalRouter, externalWBNB, minDistribution).
    /// taxHandler is inferred from msg.sender at init time.
    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (
            address token_,
            address rewardToken_,
            address externalRouter_,
            address externalWBNB_,
            uint256 minDistribution_
        ) = abi.decode(payload, (address, address, address, address, uint256));

        require(token_ != address(0), "Zero token");
        // if rewardToken != 0, we need a router + WBNB for swaps
        if (rewardToken_ != address(0)) {
            require(externalRouter_ != address(0), "Zero router");
            require(externalWBNB_ != address(0), "Zero WBNB");
        }

        _initialized = true;
        _status = _NOT_ENTERED;

        taxHandler = msg.sender;
        token = token_;
        rewardToken = rewardToken_;
        externalRouter = externalRouter_;
        externalWBNB = externalWBNB_;
        minDistribution = minDistribution_;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    function receiveTax() external payable override nonReentrant {
        require(msg.sender == taxHandler, "Only taxHandler");

        if (rewardToken == address(0)) {
            // BNB mode: track separately so we can distinguish undistributed from claimable
            pendingBNB += msg.value;
        }
        // Token mode: all BNB sits in balance until swapped in _tryDistribute

        emit TaxReceived(msg.value);
        _tryDistribute();
    }

    /// @notice Public trigger so anyone can kick off a distribution if the threshold is met
    function triggerDistribution() external nonReentrant {
        _tryDistribute();
    }

    function _tryDistribute() internal {
        if (totalSharesTracked == 0) return;

        uint256 rewardAmount;
        uint256 bnbSpent;

        if (rewardToken == address(0)) {
            // BNB mode
            if (pendingBNB < minDistribution) return;
            rewardAmount = pendingBNB;
            bnbSpent = pendingBNB;
            pendingBNB = 0;
        } else {
            // Token mode: swap all BNB balance → rewardToken
            uint256 bnbBal = address(this).balance;
            if (bnbBal < minDistribution) return;

            uint256 balBefore = IERC20(rewardToken).balanceOf(address(this));
            address[] memory path = new address[](2);
            path[0] = externalWBNB;
            path[1] = rewardToken;
            ILumoriaRouter(externalRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbBal}(
                0,
                path,
                address(this),
                block.timestamp
            );
            uint256 balAfter = IERC20(rewardToken).balanceOf(address(this));
            rewardAmount = balAfter - balBefore;
            bnbSpent = bnbBal;
        }

        if (rewardAmount == 0) return;

        dividendsPerShare += (rewardAmount * PRECISION) / totalSharesTracked;
        totalDividendsDistributed += rewardAmount;

        emit DividendsDistributed(rewardAmount, bnbSpent);
    }

    // ─── Share Management ───────────────────────────────────────────

    /// @notice Called by TaxHandler whenever a holder's balance changes
    function setShare(address holder, uint256 amount) external override {
        require(msg.sender == taxHandler, "Only taxHandler");

        // crystallize any earnings since last checkpoint
        _crystallize(holder);

        uint256 old = shares[holder];
        if (old != amount) {
            totalSharesTracked = totalSharesTracked - old + amount;
            shares[holder] = amount;
            emit ShareUpdated(holder, old, amount);
        }
    }

    function _crystallize(address holder) internal {
        uint256 current = dividendsPerShare;
        uint256 checkpoint = dividendCheckpoint[holder];
        if (current > checkpoint && shares[holder] > 0) {
            uint256 live = (shares[holder] * (current - checkpoint)) / PRECISION;
            if (live > 0) {
                creditedDividends[holder] += live;
            }
        }
        dividendCheckpoint[holder] = current;
    }

    // ─── Claim ──────────────────────────────────────────────────────

    function claimReward() external override nonReentrant {
        _crystallize(msg.sender);

        uint256 credited = creditedDividends[msg.sender];
        uint256 withdrawn = withdrawnDividends[msg.sender];
        require(credited > withdrawn, "Nothing to claim");

        uint256 unpaid = credited - withdrawn;
        withdrawnDividends[msg.sender] = credited;
        totalDividendsWithdrawn += unpaid;

        if (rewardToken == address(0)) {
            TransferHelper.safeTransferETH(msg.sender, unpaid);
        } else {
            TransferHelper.safeTransfer(rewardToken, msg.sender, unpaid);
        }

        emit RewardClaimed(msg.sender, unpaid);
    }

    // ─── Views ──────────────────────────────────────────────────────

    function getUnpaidRewards(address holder) external view override returns (uint256) {
        uint256 current = dividendsPerShare;
        uint256 checkpoint = dividendCheckpoint[holder];
        uint256 live;
        if (current > checkpoint && shares[holder] > 0) {
            live = (shares[holder] * (current - checkpoint)) / PRECISION;
        }
        uint256 totalCredited = creditedDividends[holder] + live;
        uint256 withdrawn = withdrawnDividends[holder];
        if (totalCredited <= withdrawn) return 0;
        return totalCredited - withdrawn;
    }

    function getModuleType() external pure override returns (uint8) {
        return MODULE_TYPE;
    }

    function getStats() external view override returns (bytes memory) {
        return abi.encode(
            rewardToken,
            totalDividendsDistributed,
            totalDividendsWithdrawn,
            dividendsPerShare,
            totalSharesTracked
        );
    }

    receive() external payable {}
}
