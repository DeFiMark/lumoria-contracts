//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Token Master Copy

    Clean ERC20 with holder tracking via TaxHandler.
    No tax logic — all taxation happens at the V4 pool level (LumoriaHook) in BNB.
    Cloned via ERC-1167 proxy for each launched token.
 */

import "./interfaces/ILumoriaToken.sol";
import "./interfaces/ITaxHandler.sol";

contract LumoriaTokenData {

    // total supply
    uint256 internal _totalSupply;

    // token data
    string internal _name;
    string internal _symbol;
    uint8 internal constant _decimals = 18;

    // balances
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) internal _allowances;

    // core references
    address internal _pair;
    address internal _taxHandler;
    address internal _creator;

    // initialization guard
    bool internal _initialized;
}

contract LumoriaToken is LumoriaTokenData, ILumoriaToken {

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000 * 10**18;

    // ─── Initialization ─────────────────────────────────────────────

    function __init__(
        string calldata name_,
        string calldata symbol_,
        address pair_,
        address taxHandler_,
        address creator_
    ) external override {
        require(!_initialized, "Already initialized");
        require(pair_ != address(0), "Zero pair");
        require(taxHandler_ != address(0), "Zero tax handler");
        require(creator_ != address(0), "Zero creator");

        _initialized = true;
        _name = name_;
        _symbol = symbol_;
        _pair = pair_;
        _taxHandler = taxHandler_;
        _creator = creator_;

        _totalSupply = TOTAL_SUPPLY;

        // entire supply starts with the creator (Generator will move it as needed)
        _balances[msg.sender] = TOTAL_SUPPLY;
        emit Transfer(address(0), msg.sender, TOTAL_SUPPLY);
    }

    // ─── ERC20 Views ────────────────────────────────────────────────

    function name() public view override returns (string memory) { return _name; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public view override returns (uint8) { return _decimals; }
    function totalSupply() external view override returns (uint256) { return _totalSupply; }
    function balanceOf(address account) public view override returns (uint256) { return _balances[account]; }
    function allowance(address holder, address spender) external view override returns (uint256) { return _allowances[holder][spender]; }

    // ─── ERC20 State-Changing ───────────────────────────────────────

    function approve(address spender, uint256 amount) public override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        return _transferFrom(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external override returns (bool) {
        uint256 currentAllowance = _allowances[sender][msg.sender];
        require(currentAllowance >= amount, "Insufficient allowance");
        unchecked {
            _allowances[sender][msg.sender] = currentAllowance - amount;
        }
        return _transferFrom(sender, recipient, amount);
    }

    // ─── Burn ───────────────────────────────────────────────────────

    function burn(uint256 amount) external override {
        require(_balances[msg.sender] >= amount, "Insufficient balance");
        require(amount > 0, "Zero amount");
        unchecked {
            _balances[msg.sender] -= amount;
            _totalSupply -= amount;
        }
        ITaxHandler(_taxHandler).setShare(msg.sender, _balances[msg.sender]);
        emit Transfer(msg.sender, address(0), amount);
    }

    // ─── Core References ────────────────────────────────────────────

    function pair() external view override returns (address) { return _pair; }
    function taxHandler() external view override returns (address) { return _taxHandler; }
    function creator() external view override returns (address) { return _creator; }

    // ─── Internal Transfer ──────────────────────────────────────────

    function _transferFrom(address sender, address recipient, uint256 amount) internal returns (bool) {
        require(recipient != address(0), "Zero recipient");
        require(amount > 0, "Zero amount");
        require(_balances[sender] >= amount, "Insufficient balance");

        unchecked {
            _balances[sender] -= amount;
        }
        _balances[recipient] += amount;

        // Update holder shares for reward distribution.
        //
        // The LP pair is deliberately excluded from share tracking:
        // - Buys: tokens flow *from* pair → skipping the pair's setShare avoids
        //   the pool accruing rewards it can never claim.
        // - Sells / addLiquidity: tokens flow *to* pair → same reasoning.
        // Modules (Burn, Liquidity) that briefly hold tokens during their
        // atomic execute* flows are NOT excluded — their brief share window
        // is harmless because no tax can arrive mid-transaction.
        address _pair_ = _pair;
        if (sender != _pair_) {
            ITaxHandler(_taxHandler).setShare(sender, _balances[sender]);
        }
        if (recipient != _pair_) {
            ITaxHandler(_taxHandler).setShare(recipient, _balances[recipient]);
        }

        emit Transfer(sender, recipient, amount);
        return true;
    }
}
