//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Router

    Orchestrates all trading and liquidity flows against Lumoria pairs.

    Every buy/sell applies fees in this order (all on the BNB side):
        1. Platform fee (Database.platformFeeBps, default 1%) → FeeReceiver.
        2. Token tax (TaxHandler.buyFee / .sellFee) → TaxHandler, which
           distributes to the per-token modules.
        3. Pair LP fee (0.1%) — embedded in the pair's constant-product
           math, kept by the pool.

    On buys, after the swap completes, the Router calls
    RebateContract.creditRebate(token, buyer, tokensReceived) (silent exit
    if the pool is unfunded / inactive / unset).

    Only Lumoria tokens (as tracked by Database.isLumoriaToken) can be
    traded through this Router, and only against WBNB.
 */

import "./interfaces/IDatabase.sol";
import "./interfaces/ILumoriaFactory.sol";
import "./interfaces/ILumoriaPair.sol";
import "./interfaces/ILumoriaRouter.sol";
import "./interfaces/ITaxHandler.sol";
import "./interfaces/IFeeReceiver.sol";
import "./interfaces/IRebate.sol";
import "./interfaces/IWETH.sol";
import "./interfaces/IERC20.sol";
import "./lib/TransferHelper.sol";

contract LumoriaRouter is ILumoriaRouter {

    uint256 public constant BPS = 10000;

    address public immutable WETH;
    IDatabase public immutable database;
    ILumoriaFactory public immutable factory;

    // ─── Events ─────────────────────────────────────────────────────

    event TokenPurchased(
        address indexed token,
        address indexed buyer,
        uint256 bnbIn,
        uint256 platformFee,
        uint256 taxTaken,
        uint256 tokensOut
    );
    event TokenSold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 platformFee,
        uint256 taxTaken,
        uint256 bnbOut
    );

    // ─── Modifiers ──────────────────────────────────────────────────

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "Router: EXPIRED");
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────

    constructor(address _factory, address _database) {
        require(_factory != address(0), "Router: zero factory");
        require(_database != address(0), "Router: zero database");
        factory = ILumoriaFactory(_factory);
        database = IDatabase(_database);
        WETH = IDatabase(_database).wbnb();
    }

    receive() external payable {
        // Only the WBNB contract sends BNB here (during withdraw()).
        require(msg.sender == WETH, "Router: only WBNB");
    }

    // ─── Buy ───────────────────────────────────────────────────────

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable override ensure(deadline) {
        require(path.length == 2, "Router: INVALID_PATH_LENGTH");
        require(path[0] == WETH, "Router: INVALID_PATH");
        address token = path[1];
        require(database.isLumoriaToken(token), "Router: not Lumoria");

        uint256 totalBNB = msg.value;
        require(totalBNB > 0, "Router: zero BNB");

        // 1. Platform fee.
        uint256 platformFee = (totalBNB * database.platformFeeBps()) / BPS;
        if (platformFee > 0) {
            IFeeReceiver(database.feeReceiver()).receiveFee{value: platformFee}(token);
        }
        uint256 afterPlatform = totalBNB - platformFee;

        // 2. Token buy tax.
        address taxHandler = database.tokenTaxHandler(token);
        uint256 taxAmount = (afterPlatform * ITaxHandler(taxHandler).buyFee()) / BPS;
        if (taxAmount > 0) {
            ITaxHandler(taxHandler).receiveBuyTax{value: taxAmount}();
        }
        uint256 swapAmount = afterPlatform - taxAmount;
        require(swapAmount > 0, "Router: zero swap amount");

        // 3. Swap.
        address pair = factory.getPair(token, WETH);
        require(pair != address(0), "Router: no pair");

        (uint256 reserveWbnb, uint256 reserveToken) = _getReservesOrdered(pair, WETH, token);
        uint256 amountOut = _getAmountOut(swapAmount, reserveWbnb, reserveToken);
        require(amountOut >= amountOutMin, "Router: INSUFFICIENT_OUTPUT");

        IWETH(WETH).deposit{value: swapAmount}();
        assert(IWETH(WETH).transfer(pair, swapAmount));

        (address token0, ) = _sortTokens(WETH, token);
        (uint256 amount0Out, uint256 amount1Out) = WETH == token0
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));
        ILumoriaPair(pair).swap(amount0Out, amount1Out, to, to);

        // 4. Rebate (silent). Only runs if a rebate contract is wired.
        address rebate = database.rebateContract();
        if (rebate != address(0)) {
            IRebate(rebate).creditRebate(token, to, amountOut);
        }

        // 5. Volume.
        database.registerVolume(token, to, totalBNB);

        emit TokenPurchased(token, to, totalBNB, platformFee, taxAmount, amountOut);
    }

    // ─── Sell ──────────────────────────────────────────────────────

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path.length == 2, "Router: INVALID_PATH_LENGTH");
        require(path[1] == WETH, "Router: INVALID_PATH");
        address token = path[0];
        require(database.isLumoriaToken(token), "Router: not Lumoria");
        require(amountIn > 0, "Router: zero amountIn");

        address pair = factory.getPair(token, WETH);
        require(pair != address(0), "Router: no pair");

        // 1. Pull tokens from seller → pair.
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountIn);

        // 2. Swap tokens → WBNB (Router receives).
        (uint256 reserveToken, uint256 reserveWbnb) = _getReservesOrdered(pair, token, WETH);
        uint256 bnbOutGross = _getAmountOut(amountIn, reserveToken, reserveWbnb);

        (address token0, ) = _sortTokens(token, WETH);
        (uint256 amount0Out, uint256 amount1Out) = WETH == token0
            ? (bnbOutGross, uint256(0))
            : (uint256(0), bnbOutGross);
        ILumoriaPair(pair).swap(amount0Out, amount1Out, address(this), msg.sender);

        // 3. Unwrap WBNB.
        IWETH(WETH).withdraw(bnbOutGross);

        // 4. Platform fee (on BNB).
        uint256 platformFee = (bnbOutGross * database.platformFeeBps()) / BPS;
        if (platformFee > 0) {
            IFeeReceiver(database.feeReceiver()).receiveFee{value: platformFee}(token);
        }
        uint256 afterPlatform = bnbOutGross - platformFee;

        // 5. Token sell tax.
        address taxHandler = database.tokenTaxHandler(token);
        uint256 taxAmount = (afterPlatform * ITaxHandler(taxHandler).sellFee()) / BPS;
        if (taxAmount > 0) {
            ITaxHandler(taxHandler).receiveSellTax{value: taxAmount}();
        }
        uint256 userReceives = afterPlatform - taxAmount;
        require(userReceives >= amountOutMin, "Router: INSUFFICIENT_OUTPUT");

        // 6. Send to user.
        TransferHelper.safeTransferETH(to, userReceives);

        // 7. Volume.
        database.registerVolume(token, msg.sender, bnbOutGross);

        emit TokenSold(token, msg.sender, amountIn, platformFee, taxAmount, userReceives);
    }

    // ─── Add Liquidity ─────────────────────────────────────────────

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable override ensure(deadline)
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        require(database.isLumoriaToken(token), "Router: not Lumoria");

        // Lazy-create pair on first add.
        address pair = factory.getPair(token, WETH);
        if (pair == address(0)) {
            pair = factory.createPair(token, WETH);
        }

        (amountToken, amountETH) = _calcAddLiquidity(
            pair, token, amountTokenDesired, msg.value, amountTokenMin, amountETHMin
        );

        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        assert(IWETH(WETH).transfer(pair, amountETH));
        liquidity = ILumoriaPair(pair).mint(to);

        // Refund BNB dust.
        if (msg.value > amountETH) {
            TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
        }
    }

    // ─── Remove Liquidity ──────────────────────────────────────────

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        address pair = factory.getPair(token, WETH);
        require(pair != address(0), "Router: no pair");

        ILumoriaPair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = ILumoriaPair(pair).burn(address(this));
        (address token0, ) = _sortTokens(token, WETH);
        (amountToken, amountETH) = token == token0 ? (amount0, amount1) : (amount1, amount0);

        require(amountToken >= amountTokenMin, "Router: INSUFFICIENT_TOKEN");
        require(amountETH >= amountETHMin, "Router: INSUFFICIENT_ETH");

        TransferHelper.safeTransfer(token, to, amountToken);
        IWETH(WETH).withdraw(amountETH);
        TransferHelper.safeTransferETH(to, amountETH);
    }

    // ─── Views / Quotes ────────────────────────────────────────────

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external pure returns (uint256)
    {
        return _getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external pure returns (uint256)
    {
        return _getAmountIn(amountOut, reserveIn, reserveOut);
    }

    /// @notice Quote a buy given BNB in. Returns the components a UI needs.
    function quoteBuy(address token, uint256 bnbIn)
        external view
        returns (uint256 platformFee, uint256 taxAmount, uint256 swapAmount, uint256 tokensOut)
    {
        platformFee = (bnbIn * database.platformFeeBps()) / BPS;
        uint256 afterPlatform = bnbIn - platformFee;
        address taxHandler = database.tokenTaxHandler(token);
        taxAmount = (afterPlatform * ITaxHandler(taxHandler).buyFee()) / BPS;
        swapAmount = afterPlatform - taxAmount;
        address pair = factory.getPair(token, WETH);
        if (pair == address(0) || swapAmount == 0) return (platformFee, taxAmount, swapAmount, 0);
        (uint256 rWbnb, uint256 rToken) = _getReservesOrdered(pair, WETH, token);
        tokensOut = _getAmountOut(swapAmount, rWbnb, rToken);
    }

    /// @notice Quote a sell given tokens in.
    function quoteSell(address token, uint256 tokensIn)
        external view
        returns (uint256 bnbOutGross, uint256 platformFee, uint256 taxAmount, uint256 userReceives)
    {
        address pair = factory.getPair(token, WETH);
        if (pair == address(0)) return (0, 0, 0, 0);
        (uint256 rToken, uint256 rWbnb) = _getReservesOrdered(pair, token, WETH);
        bnbOutGross = _getAmountOut(tokensIn, rToken, rWbnb);
        platformFee = (bnbOutGross * database.platformFeeBps()) / BPS;
        uint256 afterPlatform = bnbOutGross - platformFee;
        address taxHandler = database.tokenTaxHandler(token);
        taxAmount = (afterPlatform * ITaxHandler(taxHandler).sellFee()) / BPS;
        userReceives = afterPlatform - taxAmount;
    }

    // ─── Internal Helpers ──────────────────────────────────────────

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "Router: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "Router: ZERO_ADDRESS");
    }

    /// @dev Returns reserves in the order requested (reserveA first).
    function _getReservesOrdered(address pair, address tokenA, address tokenB)
        internal view returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0, ) = _sortTokens(tokenA, tokenB);
        (uint112 r0, uint112 r1, ) = ILumoriaPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev V2 constant-product with 0.1% LP fee (amountInWithFee = amountIn * 9990).
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal pure returns (uint256 amountOut)
    {
        require(amountIn > 0, "Router: INSUFFICIENT_INPUT");
        require(reserveIn > 0 && reserveOut > 0, "Router: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 9990;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 10000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    function _getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal pure returns (uint256 amountIn)
    {
        require(amountOut > 0, "Router: INSUFFICIENT_OUTPUT");
        require(reserveIn > 0 && reserveOut > 0, "Router: INSUFFICIENT_LIQUIDITY");
        uint256 numerator = reserveIn * amountOut * 10000;
        uint256 denominator = (reserveOut - amountOut) * 9990;
        amountIn = (numerator / denominator) + 1;
    }

    function _calcAddLiquidity(
        address pair,
        address token,
        uint256 amountTokenDesired,
        uint256 amountETHDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin
    ) internal view returns (uint256 amountToken, uint256 amountETH) {
        (uint256 reserveToken, uint256 reserveETH) = _getReservesOrdered(pair, token, WETH);
        if (reserveToken == 0 && reserveETH == 0) {
            (amountToken, amountETH) = (amountTokenDesired, amountETHDesired);
        } else {
            uint256 amountETHOptimal = (amountTokenDesired * reserveETH) / reserveToken;
            if (amountETHOptimal <= amountETHDesired) {
                require(amountETHOptimal >= amountETHMin, "Router: INSUFFICIENT_ETH");
                (amountToken, amountETH) = (amountTokenDesired, amountETHOptimal);
            } else {
                uint256 amountTokenOptimal = (amountETHDesired * reserveToken) / reserveETH;
                require(amountTokenOptimal <= amountTokenDesired, "Router: math");
                require(amountTokenOptimal >= amountTokenMin, "Router: INSUFFICIENT_TOKEN");
                (amountToken, amountETH) = (amountTokenOptimal, amountETHDesired);
            }
        }
    }
}
