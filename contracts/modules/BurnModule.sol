//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Burn Module (Type 1)

    Receives BNB from the TaxHandler, accumulates it, and periodically
    uses the accumulated BNB to buy back tokens from the token's Uniswap
    V4 pool (via the LumoriaSwapRouter) and burn them (reducing totalSupply
    via ILumoriaToken.burn).

    Execution is permissionless: anyone can trigger executeBurn() once
    the configured interval has elapsed. The interval caps the frequency
    at which the module can be executed, which bounds MEV opportunities.

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

    function receiveTax() external payable override {
        require(msg.sender == taxHandler, "Only taxHandler");
        emit TaxReceived(msg.value, address(this).balance);
    }

    // ─── Execute Burn (permissionless) ──────────────────────────────

    /// @notice Anyone can trigger the burn once the interval has elapsed.
    ///         Uses the full accumulated BNB balance for the buyback.
    function executeBurn() external nonReentrant {
        require(block.timestamp >= lastBurnTime + burnInterval, "Interval not elapsed");
        uint256 bnbBal = address(this).balance;
        require(bnbBal > 0, "No BNB to burn");

        lastBurnTime = block.timestamp;

        address router = IDatabase(database).router();
        address wbnb = IDatabase(database).wbnb();
        require(router != address(0), "Router not set");

        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = token;

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        ILumoriaRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnbBal}(
            0,
            path,
            address(this),
            block.timestamp
        );
        uint256 balAfter = IERC20(token).balanceOf(address(this));
        uint256 tokensReceived = balAfter - balBefore;

        require(tokensReceived > 0, "No tokens received");
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
