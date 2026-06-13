// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRangeOrderBook} from "./IRangeOrderBook.sol";
import {IERC20Minimal} from "./RangeTakeProfitBook.sol";

/// @title ReferenceBook — correctness oracle, NOT a production design
///
/// Eager accounting: every fill immediately loops over every position ever
/// created and credits/consumes it individually. O(positions) swaps are the
/// point — the logic is a direct transcription of the requirements, with no
/// lazy-evaluation cleverness, so the production candidate can be fuzzed
/// against it.
contract ReferenceBook is IRangeOrderBook {
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;
    int24 public immutable tickSpacing;

    int24 public currentTick;
    uint256 public nextPositionId = 1;

    struct Position {
        address owner;
        int24 lower;
        int24 upper;
        uint128 liquidity;
        bool live;
        uint256 claimable1; // credited eagerly at fill time
    }

    mapping(uint256 => Position) public positions;
    // consumed[id][lowerTick]: this position's eligibility for the interval is spent
    mapping(uint256 => mapping(int24 => bool)) public consumed;

    constructor(address _token0, address _token1, int24 _tickSpacing, int24 _initialTick) {
        require(_tickSpacing > 0, "bad spacing");
        token0 = IERC20Minimal(_token0);
        token1 = IERC20Minimal(_token1);
        tickSpacing = _tickSpacing;
        currentTick = _initialTick;
    }

    function deposit(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId) {
        require(liquidity > 0, "zero liquidity");
        require(lower < upper, "empty range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "unaligned");
        require(lower > currentTick, "range not above price");

        positionId = nextPositionId++;
        positions[positionId] = Position({
            owner: msg.sender,
            lower: lower,
            upper: upper,
            liquidity: liquidity,
            live: true,
            claimable1: 0
        });

        uint256 amount0 = uint256(liquidity) * uint256(uint24((upper - lower)) / uint24(tickSpacing));
        require(token0.transferFrom(msg.sender, address(this), amount0), "transfer in failed");
    }

    function moveTickTo(int24 newTick) external {
        int24 oldTick = currentTick;
        currentTick = newTick;
        if (newTick <= oldTick) return;

        uint256 owed0;
        uint256 owed1;
        for (int24 u = _nextBoundaryAbove(oldTick); u <= newTick; u += tickSpacing) {
            int24 lower = u - tickSpacing;
            // Reference model: loop every position individually.
            for (uint256 id = 1; id < nextPositionId; id++) {
                Position storage p = positions[id];
                if (!p.live) continue;
                if (lower < p.lower || lower >= p.upper) continue;
                if (consumed[id][lower]) continue;

                consumed[id][lower] = true;
                uint256 proceeds1 = _amount1(lower, p.liquidity);
                p.claimable1 += proceeds1;
                owed0 += uint256(p.liquidity);
                owed1 += proceeds1;
            }
        }

        if (owed1 > 0) require(token1.transferFrom(msg.sender, address(this), owed1), "fill payment failed");
        if (owed0 > 0) require(token0.transfer(msg.sender, owed0), "fill payout failed");
    }

    function claim(uint256 positionId) public returns (uint256 proceeds1) {
        Position storage p = positions[positionId];
        require(p.live, "not live");
        require(msg.sender == p.owner, "not owner");

        proceeds1 = p.claimable1;
        p.claimable1 = 0;
        if (proceeds1 > 0) require(token1.transfer(p.owner, proceeds1), "transfer out failed");
    }

    function cancel(uint256 positionId) external returns (uint256 proceeds1, uint256 principal0) {
        proceeds1 = claim(positionId);

        Position storage p = positions[positionId];
        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (!consumed[positionId][t]) {
                principal0 += uint256(p.liquidity);
            }
        }
        p.live = false;

        if (principal0 > 0) require(token0.transfer(p.owner, principal0), "transfer out failed");
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function activeLiquidity(int24 lowerTick) external view returns (uint128 total) {
        for (uint256 id = 1; id < nextPositionId; id++) {
            Position storage p = positions[id];
            if (!p.live) continue;
            if (lowerTick < p.lower || lowerTick >= p.upper) continue;
            if (consumed[id][lowerTick]) continue;
            total += p.liquidity;
        }
    }

    function claimable(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (!p.live) return 0;
        return p.claimable1;
    }

    function unfilledPrincipal(uint256 positionId) external view returns (uint256 principal0) {
        Position storage p = positions[positionId];
        if (!p.live) return 0;
        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (!consumed[positionId][t]) {
                principal0 += uint256(p.liquidity);
            }
        }
    }

    function isConsumedFor(uint256 positionId, int24 lowerTick) external view returns (bool) {
        return consumed[positionId][lowerTick];
    }

    // ------------------------------------------------------------------

    uint256 internal constant PRICE_SCALE = 1e18;

    /// @dev Must match the production candidate's curve exactly.
    function _amount1(int24 lowerTick, uint128 liquidity) internal pure returns (uint256) {
        int256 rate = int256(PRICE_SCALE) + int256(lowerTick) * 1e15;
        require(rate > 0, "rate underflow");
        return (uint256(liquidity) * uint256(rate)) / PRICE_SCALE;
    }

    function _nextBoundaryAbove(int24 tick) internal view returns (int24) {
        int24 b = (tick / tickSpacing) * tickSpacing;
        if (b <= tick) b += tickSpacing;
        return b;
    }
}
