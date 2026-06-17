//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Token Master Copy, all tokens will be created from this contract
 */

import "./interfaces/IHoldToken.sol";
import "./interfaces/IBondingCurve.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IHolderRewards.sol";
import "./interfaces/IFeeRecipient.sol";

contract TokenData {

    // total supply
    uint256 internal _totalSupply;

    // token data
    string internal _name;
    string internal _symbol;
    uint8  internal _decimals;

    // bonding curve contract
    address internal bondingCurve;

    // fee recipient
    address internal feeRecipient;

    // balances
    mapping (address => uint256) internal _balances;
    mapping (address => mapping (address => uint256)) internal _allowances;

    // main LP / pair token
    address internal pair;

    // holder rewards
    address internal holderRewards;

    // fees
    uint256 public sellFee;

    // swap threshold
    uint256 public swapThreshold;

    // allows external transfer
    modifier allowExternalTransfer() {
        if (IBondingCurve(bondingCurve).isBonded()) {
            _;
        } else {
            require(
                IBondingCurve(bondingCurve).allowEarlyTransfer(msg.sender), 
                'Not Authorized'
            );
            _;
        }
    }

    // is swapping
    bool internal inSwap;

    // router
    IUniswapV2Router02 public router;

    // prevents reentrancy
    modifier handleSwap() { 
        inSwap = true; 
        _; 
        inSwap = false; 
    }
}

contract HoldToken is TokenData, IHoldToken {

    function __init__(
        bytes calldata, 
        string calldata name_, 
        string calldata symbol_, 
        address bondingCurve_, 
        address pair_, 
        address holderRewards_,
        address feeRecipient_
    ) external override {
        require(bondingCurve == address(0), 'Already Initialized');
        require(bondingCurve_ != address(0), 'Zero Bonding Curve');
        require(feeRecipient_ != address(0), 'Zero Fee Recipient');
        require(holderRewards_ != address(0), 'Zero Holder Rewards');
        require(pair_ != address(0), 'Zero Pair');

        // decode payload
        // (
        //     uint256 sellFee_
        // ) = abi.decode(payload, (uint256));

        // set name and symbol
        _name = name_;
        _symbol = symbol_;
        pair = pair_;
        holderRewards = holderRewards_;
        feeRecipient = feeRecipient_;

        // set sell fee
        sellFee = 4;

        // set bonding curve
        bondingCurve = bondingCurve_;

        // set token metadata
        _decimals = 18;
        _totalSupply = 1_000_000_000 * 10**18;
        swapThreshold = 1 ether;
        inSwap = false;

        // set router
        router = IUniswapV2Router02(0x10ED43C718714eb63d5aA57B78B54704E256024E);

        // allocate initial balance to be the total supply
        _balances[bondingCurve] = _totalSupply;
        emit Transfer(address(0), bondingCurve, _totalSupply);        
    }

    function totalSupply() external view override returns (uint256) { return _totalSupply; }
    function balanceOf(address account) public view override returns (uint256) { return _balances[account]; }
    function allowance(address holder, address spender) external view override returns (uint256) { return _allowances[holder][spender]; }
    
    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /** Transfer Function */
    function transfer(address recipient, uint256 amount) external override allowExternalTransfer returns (bool) {
        return _transferFrom(msg.sender, recipient, amount);
    }

    /** Transfer Function */
    function transferFrom(address sender, address recipient, uint256 amount) external override allowExternalTransfer returns (bool) {
        require(
            amount <= _allowances[sender][msg.sender],
            'Insufficient Allowance'
        );
        unchecked {
            _allowances[sender][msg.sender] -= amount;
        }
        return _transferFrom(sender, recipient, amount);
    }

    function burn(uint256 qty) external override {
        require(_balances[msg.sender] >= qty, 'Insufficient Balance');
        require(qty > 0, 'Zero Amount');
        unchecked {
            _balances[msg.sender] -= qty;
            _totalSupply -= qty;
        }
        IHolderRewards(holderRewards).setShare(msg.sender, _balances[msg.sender]);
        emit Transfer(msg.sender, address(0), qty);
    }

    /** Internal Transfer */
    function _transferFrom(address sender, address recipient, uint256 amount) internal returns (bool) {
        require(
            recipient != address(0),
            'Zero Recipient'
        );
        require(
            amount > 0,
            'Zero Amount'
        );
        require(
            amount <= _balances[sender],
            'Insufficient Balance'
        );

        // handle swap state
        if (inSwap) { 
            return _basicTransfer(sender, recipient, amount); 
        }

        // allocate fee first if applicable
        uint256 feeAmount = shouldTakeFee(sender, recipient) ? ( amount * sellFee ) / 100 : 0;
        if (feeAmount > 0) {
            _balances[sender] -= feeAmount;
            _balances[address(this)] += feeAmount;
            emit Transfer(sender, address(this), feeAmount);
        }
        
        // handle swap back
        if(shouldSwapBack()) { 
            swapBack();
        }

        // decrement remaining sender balance
        uint256 remainingAmount = amount - feeAmount;
        _balances[sender] -= remainingAmount;
        _balances[recipient] += remainingAmount;
        emit Transfer(sender, recipient, remainingAmount);

        // if sender is pair, register recipient for holder rewards
        if (sender == pair) {
            IHolderRewards(holderRewards).registerHolder(recipient);
        }

        // set shares for holder reward contract
        IHolderRewards(holderRewards).setShare(sender, _balances[sender]);
        IHolderRewards(holderRewards).setShare(recipient, _balances[recipient]);

        // after shares are set, distribute rewards if any
        if (address(this).balance > 0) {
            // send BNB to fee distributor
            IFeeRecipient(feeRecipient).takeTradeFee{value: address(this).balance}(address(this));
        }

        return true;
    }

    function _basicTransfer(address sender, address recipient, uint256 amount) internal returns (bool) {
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
        return true;
    }

    function shouldSwapBack() internal view returns (bool) {
        return msg.sender != pair
        && IBondingCurve(bondingCurve).isBonded()
        && !inSwap
        && _balances[address(this)] >= swapThreshold;
    }

    function shouldTakeFee(address sender, address recipient) internal view returns (bool) {
        return 
            recipient == pair && 
            sender != IBondingCurve(bondingCurve).getLiquidityAdder() && 
            IBondingCurve(bondingCurve).isBonded() && 
            sender != address(this) && 
            sender != bondingCurve;
    }

    function swapBack() internal handleSwap {

        // construct path
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = router.WETH();

        // approve router
        _allowances[address(this)][address(router)] = _balances[address(this)];

        // make the swap
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            _balances[address(this)],
            1,
            path,
            address(this),
            block.timestamp
        );

        // delete path
        delete path;
    }

    function getBondingCurve() external view override returns (address) {
        return bondingCurve;
    }

    function getPair() external view override returns (address) {
        return pair;
    }

    function getHolderRewards() external view override returns (address) {
        return holderRewards;
    }

    receive() external payable {}

}