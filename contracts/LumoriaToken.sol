//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Token Master Copy

    Clean ERC20 with holder tracking via TaxHandler.
    No tax logic — all taxation happens at the V4 pool level (LumoriaHook) in BNB.
    Cloned via ERC-1167 proxy for each launched token.

    Carries display metadata (artwork / socials / ERC-7572 contractURI) so a
    launched token is legible to any indexer without asking Lumoria — see the
    Display Metadata section. The metadata is the only mutable state a creator
    controls, and `TaxHandler.renounceManagement()` freezes it with everything
    else.
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

    // ─── Display metadata ───────────────────────────────────────────
    // Appended AFTER the original layout. Every token is a fresh ERC-1167
    // clone with zeroed storage, so appending here is safe; reordering
    // anything above would not be, because the deployed master copy and a
    // future one must agree slot-for-slot for the Database's
    // `setTokenMasterCopy` rotation to be a no-op for existing tokens.
    string internal _image;
    string internal _socials;
    string internal _contractURI;
}

contract LumoriaToken is LumoriaTokenData, ILumoriaToken {

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000 * 10**18;

    // ─── Initialization ─────────────────────────────────────────────

    function __init__(
        string calldata name_,
        string calldata symbol_,
        address pair_,
        address taxHandler_,
        address creator_,
        Metadata calldata metadata_
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

        // Metadata is display-only and deliberately unvalidated — same posture
        // as name/symbol. An empty launch is legal (the creator can set it
        // afterwards, or never).
        _image = metadata_.image;
        _socials = metadata_.socials;
        _contractURI = metadata_.contractURI;

        _totalSupply = TOTAL_SUPPLY;

        // entire supply starts with the creator (Generator will move it as needed)
        _balances[msg.sender] = TOTAL_SUPPLY;
        emit Transfer(address(0), msg.sender, TOTAL_SUPPLY);

        // ERC-7572's signal, emitted at birth so a generic indexer that only
        // watches for `ContractURIUpdated()` learns the URI without needing to
        // know anything about Lumoria. Lumoria's own subgraph does NOT rely on
        // this: a dynamic data source created during the launch tx cannot
        // observe events emitted earlier in that same tx, so the launch-time
        // metadata reaches the subgraph via `Generator.TokenMetadataInitialized`
        // instead. Skipped when there is no URI to announce.
        if (bytes(metadata_.contractURI).length > 0) {
            emit ContractURIUpdated();
        }
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

    // ─── Display Metadata ───────────────────────────────────────────
    //
    // Three readers for the same launch, on purpose — no single convention has
    // won, and a token nobody's indexer can read renders as a blank card with
    // "$0" everywhere on every aggregator that isn't ours:
    //
    //   - `contractURI()`  — ERC-7572, the actual standard.
    //   - `image()`/`logo()`/`socials()` — the de-facto launchpad getters
    //     (Clanker/NOXA-style) that most token scanners probe first.
    //   - `Generator.TokenMetadataInitialized` — the log, for indexers that
    //     never make an eth_call.
    //
    // Storage holds POINTERS only; the bytes live on Arweave. See
    // `ILumoriaToken.Metadata`.

    /// @notice ERC-7572 contract-level metadata URI (JSON).
    function contractURI() external view override returns (string memory) { return _contractURI; }

    /// @notice Token artwork URI.
    function image() external view override returns (string memory) { return _image; }

    /// @notice Alias for `image()` — the other half of the scanners read this name.
    function logo() external view override returns (string memory) { return _image; }

    /// @notice Social links as a single JSON string.
    function socials() external view override returns (string memory) { return _socials; }

    /**
     * @dev Metadata is the creator's to edit — until they renounce.
     *
     *      Gating on `TaxHandler.managementRenounced` rather than on a flag of
     *      its own is deliberate: `renounceManagement()` is sold as the
     *      moment a Lumoria token becomes permanently frozen, and a creator who
     *      could still repoint the artwork and the socials after "renouncing"
     *      would make that promise a half-truth — the token's public identity
     *      would remain fully rug-pullable. One switch, everything freezes.
     */
    modifier onlyCreator() {
        require(msg.sender == _creator, "Only creator");
        require(!ITaxHandler(_taxHandler).managementRenounced(), "Renounced");
        _;
    }

    function setContractURI(string calldata uri) external override onlyCreator {
        _contractURI = uri;
        emit ContractURIUpdated();
    }

    function setImage(string calldata image_) external override onlyCreator {
        _image = image_;
        emit ImageUpdated(image_);
    }

    function setSocials(string calldata socials_) external override onlyCreator {
        _socials = socials_;
        emit SocialsUpdated(socials_);
    }

    // ─── Internal Transfer ──────────────────────────────────────────

    function _transferFrom(address sender, address recipient, uint256 amount) internal returns (bool) {
        require(recipient != address(0), "Zero recipient");
        if (amount == 0) {
            emit Transfer(sender, recipient, 0);
            return true;
        }
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
