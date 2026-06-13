// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "../RollingFrontierBook.sol";
import {FrontierLens} from "./FrontierLens.sol";
import {GeoTickMath} from "../curve/GeoTickMath.sol";
import {IERC20Minimal} from "../RangeTakeProfitBook.sol";

interface IFrontierBookRegistry {
    function defaultBook(address token0, address token1) external view returns (address);
}

/// @title FrontierRouter — taker periphery with aggregator-friendly entry
/// points. Exposes Uniswap-v2-shaped `swapExactTokensForTokens` /
/// `getAmountsOut` (2-hop paths resolve to the pair's canonical book via the
/// factory) plus explicit per-book functions. Exact-input semantics map onto
/// the book's budgeted sweeps: spend up to amountIn, park exactly at the
/// affordable thin tick, refund the remainder.
contract FrontierRouter {
    IFrontierBookRegistry public immutable factory;
    FrontierLens public immutable lens;

    /// taker sweeps are bounded to this many ticks past the current pointer
    /// so exhausted books don't strand the pointer at grid extremes
    int24 public constant SWEEP_WINDOW = 200_000;

    constructor(address _factory, FrontierLens _lens) {
        factory = IFrontierBookRegistry(_factory);
        lens = _lens;
    }

    // ------------------------------------------------------------------
    // Aggregator-compatible (Uniswap v2 shaped)
    // ------------------------------------------------------------------

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "2-hop paths only");
        RollingFrontierBook book = _bookFor(path[0], path[1]);
        bool buying = path[0] == address(book.token1()); // token1 in -> token0 out
        (uint256 paid, uint256 received) =
            buying ? _buy(book, amountIn, amountOutMin, to, deadline) : _sell(book, amountIn, amountOutMin, to, deadline);
        amounts = new uint256[](2);
        amounts[0] = paid;
        amounts[1] = received;
    }

    /// @notice v2-shaped read quote. One divergence from v2 semantics, by
    /// design: if the book can't absorb all of `amountIn`, `amounts[0]` is
    /// what would actually be spent (the rest is refunded on execution) —
    /// mirroring what `swapExactTokensForTokens` returns. Curve-aware via
    /// the lens (linear and geometric books both quote exactly).
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        require(path.length == 2, "2-hop paths only");
        RollingFrontierBook book = _bookFor(path[0], path[1]);
        bool buying = path[0] == address(book.token1());
        uint256 received;
        uint256 spent;
        if (buying) (received, spent,) = lens.quoteBuy(book, amountIn);
        else (received, spent,) = lens.quoteSell(book, amountIn, 4096);
        amounts = new uint256[](2);
        amounts[0] = spent;
        amounts[1] = received;
    }

    // ------------------------------------------------------------------
    // Explicit per-book entry points
    // ------------------------------------------------------------------

    /// @notice Spend up to `amount1In` token1 buying token0 from the asks.
    function buyExactIn(RollingFrontierBook book, uint256 amount1In, uint256 minOut0, address to, uint256 deadline)
        public
        returns (uint256 paid1, uint256 received0)
    {
        return _buy(book, amount1In, minOut0, to, deadline);
    }

    /// @notice Spend up to `amount0In` token0 selling into the bids.
    function sellExactIn(RollingFrontierBook book, uint256 amount0In, uint256 minOut1, address to, uint256 deadline)
        public
        returns (uint256 paid0, uint256 received1)
    {
        return _sell(book, amount0In, minOut1, to, deadline);
    }

    // ------------------------------------------------------------------

    function _buy(RollingFrontierBook book, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        internal
        returns (uint256 paid, uint256 received)
    {
        IERC20Minimal t1 = book.token1();
        require(t1.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        _ensureApproved(t1, address(book));

        int24 target = _clampTick(book, int256(book.currentTick()) + SWEEP_WINDOW, book.tickSpacing());
        (, paid, received) = book.sweepWithLimits(target, type(uint256).max, amountIn, minOut, deadline);

        if (received > 0) require(book.token0().transfer(to, received), "payout failed");
        if (paid < amountIn) require(t1.transfer(msg.sender, amountIn - paid), "refund failed");
    }

    function _sell(RollingFrontierBook book, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        internal
        returns (uint256 paid, uint256 received)
    {
        IERC20Minimal t0 = book.token0();
        require(t0.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        _ensureApproved(t0, address(book));

        int24 target = _clampTick(book, int256(book.currentTick()) - SWEEP_WINDOW, book.tickSpacing());
        (, paid, received) = book.sweepWithLimits(target, type(uint256).max, amountIn, minOut, deadline);

        if (received > 0) require(book.token1().transfer(to, received), "payout failed");
        if (paid < amountIn) require(t0.transfer(msg.sender, amountIn - paid), "refund failed");
    }

    function _bookFor(address a, address b) internal view returns (RollingFrontierBook book) {
        address addr = factory.defaultBook(a, b);
        if (addr == address(0)) addr = factory.defaultBook(b, a);
        require(addr != address(0), "no book for pair");
        book = RollingFrontierBook(addr);
    }

    function _ensureApproved(IERC20Minimal token, address spender) internal {
        // MockERC20/standard tokens: set-and-forget max approval
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSignature("allowance(address,address)", address(this), spender));
        uint256 current = ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        if (current < type(uint128).max) {
            (bool ok2,) =
                address(token).call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
            require(ok2, "approve failed");
        }
    }

    /// @dev curve-aware sweep window: geometric books live on ±200k ticks
    /// (GeoTickMath domain), the linear demo curve on [-800, 8.388M).
    function _clampTick(RollingFrontierBook book, int256 t, int24 s) internal view returns (int24) {
        FrontierLens.Curve memory c = lens.curveOf(book);
        int256 max;
        int256 min;
        if (c.geo) {
            max = (int256(GeoTickMath.MAX_TICK) / int256(s)) * int256(s);
            min = -max;
        } else {
            max = (int256(8388000) / int256(s)) * int256(s);
            min = -800; // linear demo curve floor (rate > 0)
        }
        if (t > max) t = max;
        if (t < min) t = min;
        return int24(t);
    }
}
