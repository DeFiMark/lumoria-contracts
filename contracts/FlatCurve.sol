//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria FlatCurve — Presale with Refunds

    Cloneable per-launch contract that runs a fixed-price token raise. Users
    contribute BNB within `[minContribution, maxContribution]` until the
    raise reaches `hardCap` or `endTime` passes.

    State machine:
        ACTIVE     — contribute() + refund() open
        SUCCESS    — launch() was called at hardCap: LP seeded into the
                     V4 pool and permanently locked in the LiquidityVault,
                     creator BNB delivered, presale tokens claimable
        FAILED     — launch() called after endTime without hardCap met;
                     withdrawOnFailure() open to all contributors

    Key properties:
    - 1% platform fee is taken on every contribution (sent to FeeReceiver),
      non-refundable. Net amount is credited to the user.
    - refund() is available any time before finalization; user receives
      their **net** contribution (the 1% is already gone).
    - launch() is permissionless: anyone can trigger it once conditions are
      met.
    - Liquidity is added via the LumoriaSwapRouter and permanently locked
      in the LiquidityVault (no removal path exists; the `to`/DEAD arg is
      ignored). Creator receives their share of raised BNB per `creatorBps`.
    - Token allocation to each contributor at claim time is proportional:
      `contribution * tokensForPresale / totalRaised`.

    Cloned via ERC-1167 proxy per-launch by the Generator, which transfers
    `tokensForPresale + tokensForLP` into this contract before init completes.
 */

import "./interfaces/IFlatCurve.sol";
import "./interfaces/IDatabase.sol";
import "./interfaces/IFeeReceiver.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ILumoriaRouter.sol";
import "./lib/TransferHelper.sol";
import "./lib/ReentrancyGuard.sol";

contract FlatCurve is IFlatCurve, ReentrancyGuard {

    uint256 public constant BPS = 10000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ─── Core References ────────────────────────────────────────────

    address public override token;
    address public database;
    address public creator;
    bool internal _initialized;

    // ─── Raise Config ───────────────────────────────────────────────

    uint256 public override hardCap;
    uint256 public minContribution;
    uint256 public maxContribution;
    uint256 public tokensForPresale;
    uint256 public tokensForLP;
    uint256 public liquidityBps;     // portion of raised BNB routed to LP
    uint256 public creatorBps;       // portion to creator (must sum to 10000)
    uint256 public startTime;
    uint256 public endTime;

    // ─── Raise State ────────────────────────────────────────────────

    uint256 public override totalRaised;
    bool    public override launched;
    bool    public override failed;

    mapping(address => uint256) public override contributions;
    mapping(address => bool)    public override claimed;

    // ─── Initialization ─────────────────────────────────────────────

    /// @param payload abi-encoded (
    ///     hardCap, minContribution, maxContribution,
    ///     tokensForPresale, tokensForLP,
    ///     liquidityBps, creatorBps,
    ///     startTime, endTime
    /// )
    function __init__(
        address token_,
        address database_,
        address creator_,
        bytes calldata payload
    ) external override {
        require(!_initialized, "FlatCurve: Already initialized");
        require(token_ != address(0), "FlatCurve: zero token");
        require(database_ != address(0), "FlatCurve: zero database");
        require(creator_ != address(0), "FlatCurve: zero creator");

        (
            uint256 hc,
            uint256 minC,
            uint256 maxC,
            uint256 tkPre,
            uint256 tkLP,
            uint256 lqB,
            uint256 crB,
            uint256 st,
            uint256 et
        ) = abi.decode(
            payload,
            (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
        );

        require(minC > 0, "FlatCurve: zero min");
        require(maxC >= minC, "FlatCurve: max < min");
        require(hc >= minC, "FlatCurve: hardCap < min");
        require(maxC <= hc, "FlatCurve: max > hardCap");
        require(et > st, "FlatCurve: bad window");
        require(tkPre > 0 && tkLP > 0, "FlatCurve: zero alloc");
        require(lqB + crB == BPS, "FlatCurve: bps sum != 10000");
        require(lqB > 0, "FlatCurve: zero liquidity bps");

        _initialized = true;
        _status = _NOT_ENTERED;

        token = token_;
        database = database_;
        creator = creator_;
        hardCap = hc;
        minContribution = minC;
        maxContribution = maxC;
        tokensForPresale = tkPre;
        tokensForLP = tkLP;
        liquidityBps = lqB;
        creatorBps = crB;
        startTime = st;
        endTime = et;
    }

    // ─── Contribute ────────────────────────────────────────────────

    function contribute() external payable override nonReentrant {
        require(block.timestamp >= startTime, "FlatCurve: not started");
        require(block.timestamp < endTime, "FlatCurve: ended");
        require(!launched && !failed, "FlatCurve: finalized");
        require(msg.value > 0, "FlatCurve: zero BNB");

        uint256 platformFee = (msg.value * IDatabase(database).platformFeeBps()) / BPS;
        uint256 net = msg.value - platformFee;

        uint256 newContribution = contributions[msg.sender] + net;
        require(newContribution >= minContribution, "FlatCurve: below min");
        require(newContribution <= maxContribution, "FlatCurve: exceeds max");
        require(totalRaised + net <= hardCap, "FlatCurve: exceeds hardCap");

        if (platformFee > 0) {
            // Contributions are trade-like flow: forward with contributor
            // context (gross contribution as tradeAmount, buy direction).
            IFeeReceiver(IDatabase(database).feeReceiver()).receiveTradeFee{value: platformFee}(
                token, msg.sender, msg.value, true
            );
            emit PlatformFeeTaken(platformFee);
        }

        contributions[msg.sender] = newContribution;
        totalRaised += net;

        emit ContributionMade(msg.sender, msg.value, net, totalRaised);
    }

    // ─── Refund (pre-finalization) ─────────────────────────────────

    /// @notice A contributor can exit at any point before the raise is
    ///         finalized, recovering their net contribution. The 1%
    ///         platform fee on their original deposit is not refundable.
    function refund() external override nonReentrant {
        require(!launched && !failed, "FlatCurve: finalized");
        uint256 amount = contributions[msg.sender];
        require(amount > 0, "FlatCurve: nothing to refund");

        contributions[msg.sender] = 0;
        totalRaised -= amount;

        TransferHelper.safeTransferETH(msg.sender, amount);
        emit ContributionRefunded(msg.sender, amount);
    }

    // ─── Launch (permissionless finalize) ──────────────────────────

    /// @notice Anyone can finalize the raise:
    ///         - if hardCap is met → success path (LP + creator BNB);
    ///         - if endTime has passed without hardCap → failure path.
    function launch() external override nonReentrant {
        require(!launched && !failed, "FlatCurve: finalized");

        if (totalRaised >= hardCap) {
            _launchSuccess();
        } else {
            require(block.timestamp >= endTime, "FlatCurve: still active");
            failed = true;
            emit RaiseFailed(token, totalRaised);
        }
    }

    function _launchSuccess() internal {
        launched = true;

        uint256 raisedBnb = totalRaised;
        uint256 liquidityBnb = (raisedBnb * liquidityBps) / BPS;
        uint256 creatorBnb = raisedBnb - liquidityBnb;

        address router = IDatabase(database).router();
        require(router != address(0), "FlatCurve: router unset");

        // Approve router to pull the LP-allocated tokens; addLiquidityETH
        // lazily initializes the V4 pool at the implied price and locks
        // the liquidity permanently in the LiquidityVault. The `to`
        // parameter (DEAD) is ignored — kept for interface compatibility.
        TransferHelper.safeApprove(token, router, tokensForLP);
        ILumoriaRouter(router).addLiquidityETH{value: liquidityBnb}(
            token,
            tokensForLP,
            0,
            0,
            DEAD,
            block.timestamp
        );

        if (creatorBnb > 0) {
            TransferHelper.safeTransferETH(creator, creatorBnb);
        }

        emit RaiseLaunched(token, raisedBnb, liquidityBnb, tokensForLP, creatorBnb);
    }

    // ─── Claim (post-success) ──────────────────────────────────────

    function claim() external override nonReentrant {
        require(launched, "FlatCurve: not launched");
        require(!claimed[msg.sender], "FlatCurve: already claimed");
        uint256 contribution = contributions[msg.sender];
        require(contribution > 0, "FlatCurve: no contribution");

        // Proportional allocation. totalRaised is frozen once `launched = true`
        // (contribute/refund paths all gate on !launched && !failed).
        uint256 tokenAmount = (contribution * tokensForPresale) / totalRaised;

        claimed[msg.sender] = true;
        TransferHelper.safeTransfer(token, msg.sender, tokenAmount);

        emit TokensClaimed(msg.sender, tokenAmount);
    }

    // ─── Withdraw (post-failure) ───────────────────────────────────

    function withdrawOnFailure() external override nonReentrant {
        require(failed, "FlatCurve: not failed");
        uint256 amount = contributions[msg.sender];
        require(amount > 0, "FlatCurve: nothing to withdraw");

        contributions[msg.sender] = 0;
        TransferHelper.safeTransferETH(msg.sender, amount);

        emit ContributionRefunded(msg.sender, amount);
    }

    // ─── Receive (for router addLiquidity BNB refund) ──────────────

    // The Lumoria Router refunds unused BNB dust to msg.sender when
    // addLiquidityETH is called with an imperfect token/BNB ratio. For the
    // initial LP mint the ratio we pass is exact, so no refund fires, but
    // we accept BNB for safety. Any stray BNB beyond `totalRaised` is
    // effectively burned (it cannot be reclaimed — accounting uses
    // totalRaised, not address(this).balance).
    receive() external payable {}
}
