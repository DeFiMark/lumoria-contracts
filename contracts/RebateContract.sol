//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Rebate Contract

    A single global pool holding per-token rebate funds. Creators fund it
    with their own token supply and configure a rebate percentage; the
    Router calls `creditRebate` after every buy, which sends the configured
    % of tokens bought to the buyer as a bonus — funded from the creator's
    pool.

    This enables high-tax tokens where buyers still get tokens back (taxes
    feed modules, rebate makes buying attractive).

    Key design decisions:
    - **Silent exit** — if a rebate is inactive, empty, or the creator has
      withdrawn funds, creditRebate returns without reverting. A failing
      rebate must never block a trade.
    - **Simple percentage** — buyer bought N tokens → gets (N * bps / 10000)
      bonus tokens. No BNB conversion, no dynamic pricing. Creator just
      tops up the pool.
    - **Authorized creditors** — only whitelisted addresses (typically the
      Router) can credit. Admin can rotate.
    - **Re-activation** — a deactivated rebate (empty balance) reactivates
      automatically when topped up, so creators don't need to re-call
      fundRebate.
 */

import "./interfaces/IRebate.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IDatabase.sol";
import "./lib/Ownable.sol";
import "./lib/TransferHelper.sol";
import "./lib/ReentrancyGuard.sol";

contract RebateContract is IRebate, Ownable, ReentrancyGuard {

    uint256 public constant BPS = 10000;
    uint256 public constant MAX_REBATE_BPS = 10000; // up to 100% match

    IDatabase public immutable database;

    mapping(address => RebateConfig) public rebates;
    mapping(address => bool) public authorizedCreditors;

    constructor(address _database) {
        require(_database != address(0), "Rebate: zero database");
        database = IDatabase(_database);
    }

    // ─── Views ──────────────────────────────────────────────────────

    function getRebate(address token) external view returns (RebateConfig memory) {
        return rebates[token];
    }

    // ─── Creator-facing ─────────────────────────────────────────────

    /// @notice Fund (or re-fund) a token's rebate pool and set the bps rate.
    ///         Caller must be the creator as recorded in Database.
    function fundRebate(address token, uint256 amount, uint256 rebateBps) external override nonReentrant {
        require(amount > 0, "Rebate: zero amount");
        require(rebateBps > 0 && rebateBps <= MAX_REBATE_BPS, "Rebate: bad bps");
        require(database.isLumoriaToken(token), "Rebate: not Lumoria token");
        require(msg.sender == database.tokenCreator(token), "Rebate: only creator");

        RebateConfig storage cfg = rebates[token];
        // First funding or re-funding — set/rebind creator + rate.
        cfg.creator = msg.sender;
        cfg.rebateBps = rebateBps;
        cfg.active = true;

        // Pull tokens; measure actual delta to stay FOT-safe even though
        // our token isn't FOT — defense in depth.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        cfg.fundedBalance += received;

        emit RebateFunded(token, msg.sender, received, rebateBps);
    }

    /// @notice Top up an existing rebate pool without changing its rate.
    function topUpRebate(address token, uint256 amount) external override nonReentrant {
        require(amount > 0, "Rebate: zero amount");
        RebateConfig storage cfg = rebates[token];
        require(cfg.creator != address(0), "Rebate: not funded");
        require(msg.sender == cfg.creator, "Rebate: only creator");

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        cfg.fundedBalance += received;
        // Reactivate if a previous credit drained the pool.
        if (!cfg.active && cfg.fundedBalance > 0) {
            cfg.active = true;
        }

        emit RebateToppedUp(token, received, cfg.fundedBalance);
    }

    function setRebateBps(address token, uint256 rebateBps) external override {
        require(rebateBps > 0 && rebateBps <= MAX_REBATE_BPS, "Rebate: bad bps");
        RebateConfig storage cfg = rebates[token];
        require(msg.sender == cfg.creator, "Rebate: only creator");
        uint256 old = cfg.rebateBps;
        cfg.rebateBps = rebateBps;
        emit RebateBpsUpdated(token, old, rebateBps);
    }

    function withdrawFunds(address token, uint256 amount) external override nonReentrant {
        RebateConfig storage cfg = rebates[token];
        require(msg.sender == cfg.creator, "Rebate: only creator");
        require(amount > 0 && amount <= cfg.fundedBalance, "Rebate: bad amount");
        cfg.fundedBalance -= amount;
        if (cfg.fundedBalance == 0) {
            cfg.active = false;
        }
        TransferHelper.safeTransfer(token, msg.sender, amount);
        emit RebateWithdrawn(token, amount);
    }

    // ─── Router-facing ──────────────────────────────────────────────

    /// @notice Credit a buyer with their rebate. Silent exit when the pool
    ///         is empty / inactive / unset — must never revert a trade.
    function creditRebate(address token, address buyer, uint256 tokensBought) external override {
        require(authorizedCreditors[msg.sender], "Rebate: unauthorized");
        if (tokensBought == 0) return;

        RebateConfig storage cfg = rebates[token];
        if (!cfg.active || cfg.fundedBalance == 0 || cfg.rebateBps == 0) return;

        uint256 rebateAmount = (tokensBought * cfg.rebateBps) / BPS;
        if (rebateAmount == 0) return;
        if (rebateAmount > cfg.fundedBalance) {
            rebateAmount = cfg.fundedBalance;
        }

        cfg.fundedBalance -= rebateAmount;
        TransferHelper.safeTransfer(token, buyer, rebateAmount);

        if (cfg.fundedBalance == 0) {
            cfg.active = false;
            emit RebateDeactivated(token);
        }
        emit RebateCredited(token, buyer, rebateAmount);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function setAuthorizedCreditor(address creditor, bool authorized) external override onlyOwner {
        require(creditor != address(0), "Rebate: zero creditor");
        authorizedCreditors[creditor] = authorized;
        emit CreditorUpdated(creditor, authorized);
    }
}
