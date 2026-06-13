// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "../RollingFrontierBook.sol";
import {IERC20Minimal} from "../RangeTakeProfitBook.sol";

/// @title FrontierMakerKit — expressive maker periphery: compose arbitrary
/// piecewise-linear liquidity curves (each segment is one O(1) position) and
/// place them in a single transaction; batch-settle whole portfolios.
/// Positions are owned by the CALLER (the kit only routes), so all
/// management/claiming stays delegatable via the permission registry.
contract FrontierMakerKit {
    struct Segment {
        int24 lower;
        int24 upper;
        uint128 size; // size at the segment's first level
        int128 slope; // per-level increment (0 = flat)
        bool isBid; // bids must be flat (slope ignored)
    }

    /// @notice Place a whole quoting curve in one tx. Pulls exact totals from
    /// the caller, deposits each segment in the caller's name via
    /// transferFrom-funded book deposits, returns the position ids.
    function placeCurve(RollingFrontierBook book, Segment[] calldata segments)
        external
        returns (uint256[] memory ids)
    {
        ids = new uint256[](segments.length);
        IERC20Minimal t0 = book.token0();
        IERC20Minimal t1 = book.token1();
        for (uint256 i = 0; i < segments.length; i++) {
            Segment calldata seg = segments[i];
            if (seg.isBid) {
                uint256 cost = _bidCost(book, seg);
                require(t1.transferFrom(msg.sender, address(this), cost), "pull1 failed");
                _approve(address(t1), address(book));
                ids[i] = book.depositBid(seg.lower, seg.upper, seg.size);
            } else {
                uint256 cost = _askCost(book, seg);
                require(t0.transferFrom(msg.sender, address(this), cost), "pull0 failed");
                _approve(address(t0), address(book));
                ids[i] = seg.slope == 0
                    ? book.deposit(seg.lower, seg.upper, seg.size)
                    : book.depositShaped(seg.lower, seg.upper, seg.size, seg.slope);
            }
            // hand the position to the caller — positions are transferable
            book.transferPosition(ids[i], msg.sender);
        }
    }

    function _askCost(RollingFrontierBook book, Segment calldata seg) internal view returns (uint256) {
        uint24 n = uint24(seg.upper - seg.lower) / uint24(book.tickSpacing());
        int256 tot = int256(uint256(seg.size)) * int256(uint256(n))
            + (int256(seg.slope) * int256(uint256(n)) * (int256(uint256(n)) - 1)) / 2;
        return uint256(tot);
    }

    function _bidCost(RollingFrontierBook book, Segment calldata seg) internal view returns (uint256 cost) {
        int24 s = book.tickSpacing();
        for (int24 t = seg.lower; t < seg.upper; t += s) {
            int256 r = int256(1e18) + int256(t) * 1e15;
            cost += (uint256(seg.size) * uint256(r) + 1e18 - 1) / 1e18;
        }
    }

    function _approve(address token, address spender) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve failed");
    }
}
