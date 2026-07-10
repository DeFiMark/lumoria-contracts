//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Liquidity Module (Type 2)

    Receives BNB from the TaxHandler, accumulates it, and periodically
    auto-injects liquidity into the token's Uniswap V4 pool:
      1. Swap half the accumulated BNB for tokens (via the LumoriaSwapRouter).
      2. Add the remaining BNB + received tokens as full-range liquidity.
      3. Liquidity is permanently locked in the LiquidityVault (no removal
         path exists).

    Execution happens OUT OF BAND, never inside a swap: `receiveTax()` only
    accrues, and `executeLiquidity(...)` does the work in its own transaction
    with caller-supplied slippage floors on both legs.

    Execution authority comes from the PLATFORM operator registry in the Database,
    never from the token creator — the minimums spend the MODULE's BNB, not the
    caller's, so an arbitrary caller has no incentive to choose them well:

      - operatorCount == 0        → permissionless immediately (the default)
      - registered operator       → may execute as soon as the interval elapses
      - anyone else               → may execute after PUBLIC_FALLBACK_DELAY

    The swap leg re-enters this token's tax path (the hook taxes every swap,
    including ours), routing a slice of the buy tax back into `receiveTax()`.
    That terminates one level deep because `receiveTax()` only accrues — the
    IModule invariant is what stops this becoming a loop.

    Leftover dust (unused tokens or BNB from imperfect ratios) stays in
    the module and is consumed in the next round.

    The module pays the standard 1% Lumoria platform fee on the swap
    portion because it routes through the Lumoria Router — intentional,
    generates real volume for the platform. addLiquidityETH does not
    charge the platform fee (it provides, not swaps).

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../interfaces/ILumoriaRouter.sol";
import "../interfaces/IDatabase.sol";
import "../interfaces/IERC20.sol";
import "../lib/ReentrancyGuard.sol";
import "../lib/TransferHelper.sol";

contract LiquidityModule is IModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 2;

    uint256 internal constant MIN_INTERVAL = 5 minutes;

    /// @dev Once the interval has elapsed AND this much longer has passed, anyone
    ///      may execute even while operators are registered. Liveness fallback.
    uint256 internal constant PUBLIC_FALLBACK_DELAY = 1 hours;

    // LP tokens are sent here — permanently locked, no rug possible
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // core references
    address public taxHandler;
    address public token;
    address public database;

    // interval config
    uint256 public liquidityInterval;
    uint256 public lastLiquidityTime;

    // analytics
    uint256 public totalTokensLiquified;
    uint256 public totalBNBLiquified;
    uint256 public totalLPLocked;

    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxReceived(uint256 amount, uint256 pendingBNB);
    event LiquidityAdded(
        uint256 bnbAmount,
        uint256 tokenAmount,
        uint256 lpTokens,
        uint256 timestamp
    );
    event IntervalUpdated(uint256 oldInterval, uint256 newInterval);

    // ─── Initialization ─────────────────────────────────────────────

    /// @param payload abi-encoded (token, database, liquidityInterval).
    /// taxHandler is inferred from msg.sender at init time.
    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (
            address token_,
            address database_,
            uint256 liquidityInterval_
        ) = abi.decode(payload, (address, address, uint256));

        require(token_ != address(0), "Zero token");
        require(database_ != address(0), "Zero database");
        require(liquidityInterval_ >= MIN_INTERVAL, "Interval too short");

        _initialized = true;
        _status = _NOT_ENTERED;

        taxHandler = msg.sender;
        token = token_;
        database = database_;
        liquidityInterval = liquidityInterval_;
        lastLiquidityTime = block.timestamp;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    /// @dev Runs inside the V4 swap callback. Accrues only — no value out, no
    ///      external calls, cannot revert. See IModule.
    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        emit TaxReceived(msg.value, address(this).balance);
    }

    // ─── Execute Liquidity Injection (out of band) ──────────────────

    /// @notice Auto-LP using the full accumulated BNB balance (half swapped for
    ///         tokens, half paired against them).
    ///
    /// @param minTokensOut Minimum tokens the swap leg must return. MUST be > 0 —
    ///        a zero floor lets anyone sandwich the module's own buy.
    /// @param minTokenLP  Minimum tokens actually consumed by the add-liquidity leg.
    /// @param minBnbLP    Minimum BNB actually consumed by the add-liquidity leg.
    /// @param deadline    Latest timestamp this may execute (mempool protection).
    function executeLiquidity(
        uint256 minTokensOut,
        uint256 minTokenLP,
        uint256 minBnbLP,
        uint256 deadline
    ) external nonReentrant {
        require(block.timestamp <= deadline, "Expired");
        require(minTokensOut > 0, "Zero minTokensOut");

        uint256 readyAt = lastLiquidityTime + liquidityInterval;
        require(block.timestamp >= readyAt, "Interval not elapsed");
        _requireExecutor(readyAt);

        uint256 bnbBal = address(this).balance;
        require(bnbBal >= 2, "Insufficient BNB"); // need at least 2 wei to split

        lastLiquidityTime = block.timestamp;

        address router = IDatabase(database).router();
        address wbnb = IDatabase(database).wbnb();
        require(router != address(0), "Router not set");

        uint256 halfForSwap = bnbBal / 2;
        uint256 halfForLP = bnbBal - halfForSwap;

        // 1. Swap half BNB → tokens (tokens land in this contract)
        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = token;
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        ILumoriaRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: halfForSwap}(
            minTokensOut,
            path,
            address(this),
            deadline
        );
        uint256 tokensForLP = IERC20(token).balanceOf(address(this)) - balBefore;
        require(tokensForLP >= minTokensOut, "Slippage");

        // 2. Approve router, add the remaining BNB + tokens as full-range
        //    liquidity → permanently locked in the LiquidityVault (the DEAD
        //    `to` arg below is ignored; no LP tokens are minted).
        TransferHelper.safeApprove(token, router, tokensForLP);
        (uint256 amountToken, uint256 amountETH, uint256 liquidity) = ILumoriaRouter(router).addLiquidityETH{value: halfForLP}(
            token,
            tokensForLP,
            minTokenLP,
            minBnbLP,
            DEAD,
            deadline
        );

        totalTokensLiquified += amountToken;
        totalBNBLiquified += (halfForSwap + amountETH);
        totalLPLocked += liquidity;

        emit LiquidityAdded(halfForSwap + amountETH, amountToken, liquidity, block.timestamp);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function setInterval(uint256 newInterval) external {
        require(msg.sender == IDatabase(database).tokenCreator(token), "Only creator");
        require(newInterval >= MIN_INTERVAL, "Interval too short");
        emit IntervalUpdated(liquidityInterval, newInterval);
        liquidityInterval = newInterval;
    }

    /// @dev Gate for swap execution, resolved against the PLATFORM operator
    ///      registry — never a per-token setting. See the header for the policy.
    function _requireExecutor(uint256 readyAt) internal view {
        IDatabase db = IDatabase(database);
        if (db.operatorCount() == 0) return;          // permissionless by default
        if (db.isOperator(msg.sender)) return;        // Lumoria backend
        require(block.timestamp >= readyAt + PUBLIC_FALLBACK_DELAY, "Operator window");
    }

    // ─── Views ──────────────────────────────────────────────────────

    function getModuleType() external pure override returns (uint8) {
        return MODULE_TYPE;
    }

    function getStats() external view override returns (bytes memory) {
        return abi.encode(
            liquidityInterval,
            lastLiquidityTime,
            totalTokensLiquified,
            totalBNBLiquified,
            totalLPLocked,
            address(this).balance
        );
    }

    receive() external payable {}
}
