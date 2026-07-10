//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Burn Module (Type 1)

    Receives BNB from the TaxHandler, accumulates it, and periodically
    uses the accumulated BNB to buy back tokens from the token's Uniswap
    V4 pool (via the LumoriaSwapRouter) and burn them (reducing totalSupply
    via ILumoriaToken.burn).

    Execution happens OUT OF BAND, never inside a swap: `receiveTax()` only
    accrues, and `executeBurn(minTokensOut, deadline)` performs the buyback in
    its own transaction. The interval caps execution frequency; the caller
    supplies a slippage floor.

    Execution authority comes from the PLATFORM operator registry in the Database,
    never from the token creator. `minTokensOut` spends the MODULE's BNB, not the
    caller's, so an arbitrary caller has no incentive to choose it well — they can
    pass 1 wei and sandwich their own call. Hence:

      - operatorCount == 0        → permissionless immediately (the default)
      - registered operator       → may execute as soon as the interval elapses
      - anyone else               → may execute after PUBLIC_FALLBACK_DELAY, so an
                                    absent backend delays a burn but never strands
                                    the accrued BNB

    The buyback swap re-enters this token's tax path (the hook taxes every swap,
    including ours), which routes a slice of the buy tax back into this module's
    `receiveTax()`. That terminates one level deep because `receiveTax()` only
    accrues — it is exactly the IModule invariant that stops this becoming a loop.

    The module pays the standard 1% Lumoria platform fee on each buyback
    because it swaps through the Lumoria Router — intentional, generates
    real volume for the platform.

    Cloned via ERC-1167 proxy per-token.
 */

import "../interfaces/IModule.sol";
import "../interfaces/ILumoriaRouter.sol";
import "../interfaces/ILumoriaToken.sol";
import "../interfaces/IDatabase.sol";
import "../interfaces/IERC20.sol";
import "../lib/ReentrancyGuard.sol";

contract BurnModule is IModule, ReentrancyGuard {

    uint8 internal constant MODULE_TYPE = 1;

    // safety floor on interval to bound MEV frequency even if creator misconfigures
    uint256 internal constant MIN_INTERVAL = 5 minutes;

    /// @dev Once the interval has elapsed AND this much longer has passed, anyone
    ///      may execute even while operators are registered. Liveness fallback.
    uint256 internal constant PUBLIC_FALLBACK_DELAY = 1 hours;

    // core references
    address public taxHandler;
    address public token;
    address public database;

    // interval config
    uint256 public burnInterval;
    uint256 public lastBurnTime;

    // analytics
    uint256 public totalBurned;
    uint256 public totalBNBSpent;

    bool internal _initialized;

    // ─── Events ─────────────────────────────────────────────────────

    event TaxReceived(uint256 amount, uint256 pendingBNB);
    event BurnExecuted(uint256 bnbSpent, uint256 tokensBurned, uint256 timestamp);
    event IntervalUpdated(uint256 oldInterval, uint256 newInterval);

    // ─── Initialization ─────────────────────────────────────────────

    /// @param payload abi-encoded (token, database, burnInterval).
    /// taxHandler is inferred from msg.sender at init time.
    function __init__(bytes calldata payload) external override {
        require(!_initialized, "Already initialized");
        (
            address token_,
            address database_,
            uint256 burnInterval_
        ) = abi.decode(payload, (address, address, uint256));

        require(token_ != address(0), "Zero token");
        require(database_ != address(0), "Zero database");
        require(burnInterval_ >= MIN_INTERVAL, "Interval too short");

        _initialized = true;
        _status = _NOT_ENTERED;

        taxHandler = msg.sender;
        token = token_;
        database = database_;
        burnInterval = burnInterval_;
        lastBurnTime = block.timestamp;
    }

    // ─── Tax Receipt ────────────────────────────────────────────────

    /// @dev Runs inside the V4 swap callback. Accrues only — no value out, no
    ///      external calls, cannot revert. See IModule.
    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        emit TaxReceived(msg.value, address(this).balance);
    }

    // ─── Execute Burn (out of band) ─────────────────────────────────

    /// @notice Buy back and burn using the full accumulated BNB balance.
    ///
    /// @param minTokensOut Minimum tokens the buyback must return. MUST be > 0 —
    ///        a zero floor lets anyone sandwich the module's own buy. Compute it
    ///        off-chain against the pool's current price minus tolerance.
    /// @param deadline Latest timestamp this may execute (mempool protection).
    function executeBurn(uint256 minTokensOut, uint256 deadline) external nonReentrant {
        require(block.timestamp <= deadline, "Expired");
        require(minTokensOut > 0, "Zero minTokensOut");

        uint256 readyAt = lastBurnTime + burnInterval;
        require(block.timestamp >= readyAt, "Interval not elapsed");
        _requireExecutor(readyAt);

        uint256 bnbBal = address(this).balance;
        require(bnbBal > 0, "No BNB to burn");

        lastBurnTime = block.timestamp;

        address router = IDatabase(database).router();
        address wbnb = IDatabase(database).wbnb();
        require(router != address(0), "Router not set");

        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = token;

        // The router enforces minTokensOut, but it credits `to` — and this
        // swap's own buy tax lands back here mid-call. Measure the delta and
        // re-check, rather than trusting either the router or the balance.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        ILumoriaRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbBal}(
            minTokensOut,
            path,
            address(this),
            deadline
        );
        uint256 tokensReceived = IERC20(token).balanceOf(address(this)) - balBefore;

        require(tokensReceived >= minTokensOut, "Slippage");
        ILumoriaToken(token).burn(tokensReceived);

        totalBurned += tokensReceived;
        totalBNBSpent += bnbBal;

        emit BurnExecuted(bnbBal, tokensReceived, block.timestamp);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Token creator can adjust the burn interval (no timelock — change affects cadence, not economics)
    function setInterval(uint256 newInterval) external {
        require(msg.sender == IDatabase(database).tokenCreator(token), "Only creator");
        require(newInterval >= MIN_INTERVAL, "Interval too short");
        emit IntervalUpdated(burnInterval, newInterval);
        burnInterval = newInterval;
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
            burnInterval,
            lastBurnTime,
            totalBurned,
            totalBNBSpent,
            address(this).balance
        );
    }

    receive() external payable {}
}
