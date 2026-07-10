//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Reward Module (Type 0)

    Distributes rewards proportionally to holders using a classic
    dividends-per-share accumulator pattern.

    Two modes:
    - BNB mode (rewardToken = address(0)): distributes received BNB directly.
      Purely an accumulator update — no external calls, no slippage.
    - Token mode (rewardToken != 0): swaps received BNB -> rewardToken via an
      external V2-compatible router, then distributes.

    SWAPS NEVER RUN IN THE SWAP PATH. `receiveTax()` only accrues; the token-mode
    swap is performed out of band. Doing it inline would price arbitrary gas onto
    a random trader's buy and would revert their trade whenever the external pair
    is thin — see docs/TOKENOMICS_V2.md §7.1 and §6.1.

    Two out-of-band entry points, split so the permission model is visible in the
    ABI rather than buried in a branch:

      processRewards()                          PERMISSIONLESS, forever.
                                                Bookkeeping only, no swap.
      convertAndDistribute(minOut, deadline)    OPERATOR-GATED, public fallback.
                                                Swaps on an EXTERNAL router.

    Token mode swaps on a router our hook never sees, so no on-chain price
    reference can ever exist for it. It is gated on the platform operator registry
    in the Database. See §6.2 and §6.3.

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/ILumoriaRouter.sol";
import "../interfaces/ITaxHandler.sol";
import "../interfaces/IDatabase.sol";
import "../lib/ReentrancyGuard.sol";
import "../lib/TransferHelper.sol";

contract RewardModule is IRewardModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 0;
    uint256 internal constant PRECISION = 1e36;

    /// @dev After this long without a distribution, anyone may trigger one even
    ///      while operators are registered. Keeps the module live if the backend
    ///      goes away, while normally reserving execution for the party that
    ///      computes a sane `minRewardOut` off-chain.
    uint256 internal constant PUBLIC_FALLBACK_DELAY = 1 hours;

    // core references
    address public taxHandler;
    address public token;           // the Lumoria token (for analytics)
    address public rewardToken;     // address(0) = BNB rewards
    address public externalRouter;  // V2-compatible router used for BNB -> rewardToken swap
    address public externalWBNB;    // WBNB address for the external router's path

    // distribution config
    uint256 public minDistribution; // minimum BNB balance before attempting distribution
    uint256 public pendingBNB;      // BNB-mode: undistributed BNB (separate from claimable BNB)
    uint256 public lastDistributionTime;

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
    event Donated(address indexed from, uint256 amount);
    event SharesSynced(uint256 holderCount);

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
        // Self-rewarding would route the distribution swap back through this
        // token's own hook and TaxHandler, re-entering this module mid-swap.
        require(rewardToken_ != token_, "Reward token = token");
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
        lastDistributionTime = block.timestamp;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    /// @dev Runs inside the V4 swap callback. Deliberately NOT `nonReentrant`
    ///      and deliberately free of external calls: per IModule, `receiveTax`
    ///      must never revert, or it bricks trading. A guard here would revert
    ///      whenever a module-initiated swap (a burn buyback, an auto-LP round,
    ///      or this module's own token-mode distribution) routes back through
    ///      this token's pool and re-enters the tax path.
    ///
    ///      Safety does not depend on a guard: the only caller is the TaxHandler,
    ///      whose `receiveBuyTax`/`receiveSellTax` are themselves `nonReentrant`.
    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");

        emit TaxReceived(msg.value);

        if (rewardToken == address(0)) {
            // BNB mode: track separately so we can distinguish undistributed
            // from claimable. `_distributeBNB` makes no external calls.
            pendingBNB += msg.value;
            _distributeBNB();
        }
        // Token mode: BNB accrues until convertAndDistribute() swaps it.
    }

    /// @notice Permissionlessly add BNB to the reward pool. Anyone — a person, or
    ///         a PrizePool settling in ALL_HOLDERS mode — can top up rewards
    ///         without being the TaxHandler.
    function donate() external payable override nonReentrant {
        require(msg.value > 0, "Zero donation");

        emit Donated(msg.sender, msg.value);

        if (rewardToken == address(0)) {
            pendingBNB += msg.value;
            _distributeBNB();
        }
        // Token mode: never swap here — a thin external pair must not be able to
        // revert a donation. convertAndDistribute() converts it later.
    }

    // ─── Distribution (out of band) ─────────────────────────────────
    //
    // Two entry points, split so the permission model is legible from the ABI:
    // one touches no swap and is permanently open; the other swaps and is gated.
    // See docs/TOKENOMICS_V2.md §6.3.

    /// @notice PERMISSIONLESS. Crystallize accrued BNB into the dividend
    ///         accumulator. Pure bookkeeping — no swap, no slippage, nothing to
    ///         extract. Anyone may spend the gas to churn it, forever, regardless
    ///         of the operator registry.
    ///
    /// @dev Normally unnecessary: `receiveTax` distributes inline in BNB mode.
    ///      This exists for the cases it skips — no shares yet at receive time,
    ///      or `pendingBNB` still under `minDistribution`.
    function processRewards() external nonReentrant {
        require(rewardToken == address(0), "Token mode: use convertAndDistribute");
        _distributeBNB();
    }

    /// @notice OPERATOR-GATED (with a public fallback). Swap accrued BNB into
    ///         `rewardToken` on the external router, then distribute it.
    ///
    ///         This spends the MODULE's BNB, so an arbitrary caller has no
    ///         incentive to choose `minRewardOut` well — they would pass 1 wei and
    ///         sandwich their own call. Hence the registry gate. It degrades to
    ///         permissionless after PUBLIC_FALLBACK_DELAY so an absent backend
    ///         cannot strand the BNB.
    ///
    /// @param minRewardOut Minimum rewardToken received. MUST be > 0.
    /// @param deadline Latest timestamp this may execute (mempool protection).
    function convertAndDistribute(uint256 minRewardOut, uint256 deadline) external nonReentrant {
        require(rewardToken != address(0), "BNB mode: use processRewards");
        require(block.timestamp <= deadline, "Expired");
        require(minRewardOut > 0, "Zero minRewardOut");

        _requireExecutor(lastDistributionTime);
        _distributeToken(minRewardOut, deadline);
    }

    /// @dev BNB mode. Pure accumulator update — no external calls, cannot revert
    ///      on external state. Safe to run inside the swap callback.
    function _distributeBNB() internal {
        if (totalSharesTracked == 0) return;
        uint256 amount = pendingBNB;
        if (amount == 0 || amount < minDistribution) return;

        pendingBNB = 0;
        lastDistributionTime = block.timestamp;

        dividendsPerShare += (amount * PRECISION) / totalSharesTracked;
        totalDividendsDistributed += amount;

        emit DividendsDistributed(amount, amount);
    }

    /// @dev Token mode. Swaps the accrued BNB into `rewardToken` through the
    ///      external router, enforcing `minRewardOut` both at the router and
    ///      again here against the measured balance delta (the router is not
    ///      part of this system and is not trusted to honour its own bound).
    function _distributeToken(uint256 minRewardOut, uint256 deadline) internal {
        if (totalSharesTracked == 0) return;

        uint256 bnbBal = address(this).balance;
        if (bnbBal == 0 || bnbBal < minDistribution) return;

        address[] memory path = new address[](2);
        path[0] = externalWBNB;
        path[1] = rewardToken;

        uint256 balBefore = IERC20(rewardToken).balanceOf(address(this));
        ILumoriaRouter(externalRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbBal}(
            minRewardOut,
            path,
            address(this),
            deadline
        );
        uint256 rewardAmount = IERC20(rewardToken).balanceOf(address(this)) - balBefore;
        require(rewardAmount >= minRewardOut, "Slippage");

        lastDistributionTime = block.timestamp;

        dividendsPerShare += (rewardAmount * PRECISION) / totalSharesTracked;
        totalDividendsDistributed += rewardAmount;

        emit DividendsDistributed(rewardAmount, bnbBal);
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

    /// @notice Backfill holder shares from live on-chain balances.
    ///
    ///         A RewardModule added to a live token via `proposeModuleAdd` starts
    ///         blind: `setShare` only fires on transfer, so pre-existing holders
    ///         would be silently excluded from every distribution until they next
    ///         transacted. This walks a caller-supplied holder list (sourced from
    ///         the subgraph) and reconciles each share against `balanceOf`.
    ///
    /// @dev Permissionless and self-verifying: balances are read directly from
    ///      the token, so a bogus list cannot inflate anyone's share. Excluded
    ///      addresses are forced to zero rather than skipped, so syncing can also
    ///      repair a share that was recorded before an address was excluded.
    function sync(address[] calldata holders) external override nonReentrant {
        uint256 len = holders.length;
        for (uint256 i = 0; i < len; i++) {
            address holder = holders[i];
            if (holder == address(0)) continue;

            uint256 target = ITaxHandler(taxHandler).isExcludedFromShares(holder)
                ? 0
                : IERC20(token).balanceOf(holder);

            _crystallize(holder);

            uint256 old = shares[holder];
            if (old != target) {
                totalSharesTracked = totalSharesTracked - old + target;
                shares[holder] = target;
                emit ShareUpdated(holder, old, target);
            }
        }
        emit SharesSynced(len);
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

    // ─── Admin ──────────────────────────────────────────────────────

    /// @dev Gate for swap execution, resolved against the PLATFORM operator
    ///      registry in the Database — never a per-token setting. The Database is
    ///      reached through the TaxHandler, which this module already trusts.
    ///
    ///      operatorCount == 0  → permissionless immediately (the default)
    ///      registered operator → may execute at any time
    ///      anyone else         → may execute PUBLIC_FALLBACK_DELAY after `readyAt`
    function _requireExecutor(uint256 readyAt) internal view {
        IDatabase db = IDatabase(ITaxHandler(taxHandler).database());
        if (db.operatorCount() == 0) return;
        if (db.isOperator(msg.sender)) return;
        require(block.timestamp >= readyAt + PUBLIC_FALLBACK_DELAY, "Operator window");
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
            totalSharesTracked,
            lastDistributionTime
        );
    }

    receive() external payable {}
}
