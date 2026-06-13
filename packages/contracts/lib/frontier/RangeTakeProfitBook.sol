// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRangeOrderBook} from "./IRangeOrderBook.sol";

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title RangeTakeProfitBook — production candidate
///
/// One-way range take-profit orders: users sell token0 for token1 across a
/// tick range. The range is decomposed into tick-spacing intervals, each an
/// aggregate bucket. When price fully crosses an interval upward, the ENTIRE
/// bucket converts to token1 at that interval's deterministic rate and the
/// bucket's liquidity resets to zero — consumed liquidity cannot resurrect.
///
/// Eligibility bookkeeping uses a single global fill clock:
///  - every fill stamps the interval with `lastFillClock = ++fillClock`
///  - a position stores only `depositClock` (the clock at deposit time)
///  - interval consumed-for-position  <=>  lastFillClock > depositClock
///
/// Because a fill consumes the whole bucket, an interval pays a position at
/// most once (the first fill after its deposit); a lazily-written per-interval
/// `claimed` flag prevents double payment. Per-liquidity proceeds for an
/// interval are a pure function of the interval (full conversion of principal
/// across a fixed price segment), so no per-epoch proceeds ledger is needed —
/// this also holds with real sqrt-price math as long as swap fees are not
/// credited to orders.
///
/// Complexity (n = intervals in the position's range, c = intervals crossed):
///  - deposit: O(n); independent of existing users and of history
///  - swap:    O(c); independent of users behind the crossed intervals
///  - claim:   O(n); independent of other users and of history depth
///  - cancel:  O(n)
contract RangeTakeProfitBook is IRangeOrderBook {
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;
    int24 public immutable tickSpacing;

    int24 public currentTick;
    uint64 public fillClock;
    uint256 public nextPositionId = 1;

    struct IntervalState {
        uint128 totalLiquidity; // live liquidity in the current lifecycle
        uint64 lastFillClock; // global clock at most recent fill (0 = never)
    }

    struct Position {
        address owner;
        int24 lower;
        int24 upper;
        uint128 liquidity; // token0 sold per interval
        uint64 depositClock;
        bool live;
    }

    mapping(int24 => IntervalState) public intervals;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => mapping(int24 => bool)) public claimedInterval;

    event Deposit(uint256 indexed positionId, address indexed owner, int24 lower, int24 upper, uint128 liquidity);
    event IntervalFilled(int24 indexed lowerTick, uint128 liquidity, uint256 proceeds1, uint64 clock);
    event Claim(uint256 indexed positionId, uint256 proceeds1);
    event Cancel(uint256 indexed positionId, uint256 proceeds1, uint256 principal0);

    constructor(address _token0, address _token1, int24 _tickSpacing, int24 _initialTick) {
        require(_tickSpacing > 0, "bad spacing");
        token0 = IERC20Minimal(_token0);
        token1 = IERC20Minimal(_token1);
        tickSpacing = _tickSpacing;
        currentTick = _initialTick;
    }

    // ------------------------------------------------------------------
    // Orders
    // ------------------------------------------------------------------

    function deposit(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId) {
        require(liquidity > 0, "zero liquidity");
        require(lower < upper, "empty range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "unaligned");
        // Sell-above-price only: the whole range must sit strictly above the
        // interval containing the current price.
        require(lower > currentTick, "range not above price");

        uint256 amount0;
        for (int24 t = lower; t < upper; t += tickSpacing) {
            intervals[t].totalLiquidity += liquidity;
            amount0 += _amount0(liquidity);
        }

        positionId = nextPositionId++;
        positions[positionId] = Position({
            owner: msg.sender,
            lower: lower,
            upper: upper,
            liquidity: liquidity,
            depositClock: fillClock,
            live: true
        });

        require(token0.transferFrom(msg.sender, address(this), amount0), "transfer in failed");
        emit Deposit(positionId, msg.sender, lower, upper, liquidity);
    }

    function claim(uint256 positionId) public returns (uint256 proceeds1) {
        Position storage p = positions[positionId];
        require(p.live, "not live");
        require(msg.sender == p.owner, "not owner");

        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (claimedInterval[positionId][t]) continue;
            if (intervals[t].lastFillClock > p.depositClock) {
                claimedInterval[positionId][t] = true;
                proceeds1 += _amount1(t, p.liquidity);
            }
        }

        if (proceeds1 > 0) require(token1.transfer(p.owner, proceeds1), "transfer out failed");
        emit Claim(positionId, proceeds1);
    }

    function cancel(uint256 positionId) external returns (uint256 proceeds1, uint256 principal0) {
        proceeds1 = claim(positionId); // also checks live + owner

        Position storage p = positions[positionId];
        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (intervals[t].lastFillClock <= p.depositClock) {
                intervals[t].totalLiquidity -= p.liquidity;
                principal0 += _amount0(p.liquidity);
            }
        }
        p.live = false;

        if (principal0 > 0) require(token0.transfer(p.owner, principal0), "transfer out failed");
        emit Cancel(positionId, proceeds1, principal0);
    }

    // ------------------------------------------------------------------
    // Market simulation (stands in for the AMM / v4 afterSwap hook)
    // ------------------------------------------------------------------

    /// @dev Upward moves fill every interval whose upper boundary lies in
    /// (oldTick, newTick]. The caller pays token1 proceeds and receives the
    /// consumed token0, so conservation is real. Downward moves fill nothing.
    function moveTickTo(int24 newTick) external {
        int24 oldTick = currentTick;
        currentTick = newTick;
        if (newTick <= oldTick) return;

        uint256 owed0;
        uint256 owed1;
        for (int24 u = _nextBoundaryAbove(oldTick); u <= newTick; u += tickSpacing) {
            int24 lower = u - tickSpacing;
            IntervalState storage s = intervals[lower];
            uint128 liq = s.totalLiquidity;
            if (liq == 0) continue;

            s.totalLiquidity = 0;
            uint64 clock = ++fillClock;
            s.lastFillClock = clock;

            uint256 proceeds1 = _amount1(lower, liq);
            owed0 += _amount0(liq);
            owed1 += proceeds1;
            emit IntervalFilled(lower, liq, proceeds1, clock);
        }

        if (owed1 > 0) require(token1.transferFrom(msg.sender, address(this), owed1), "fill payment failed");
        if (owed0 > 0) require(token0.transfer(msg.sender, owed0), "fill payout failed");
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function activeLiquidity(int24 lowerTick) external view returns (uint128) {
        return intervals[lowerTick].totalLiquidity;
    }

    function claimable(uint256 positionId) external view returns (uint256 proceeds1) {
        Position storage p = positions[positionId];
        if (!p.live) return 0;
        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (claimedInterval[positionId][t]) continue;
            if (intervals[t].lastFillClock > p.depositClock) {
                proceeds1 += _amount1(t, p.liquidity);
            }
        }
    }

    function unfilledPrincipal(uint256 positionId) external view returns (uint256 principal0) {
        Position storage p = positions[positionId];
        if (!p.live) return 0;
        for (int24 t = p.lower; t < p.upper; t += tickSpacing) {
            if (intervals[t].lastFillClock <= p.depositClock) {
                principal0 += _amount0(p.liquidity);
            }
        }
    }

    function isConsumedFor(uint256 positionId, int24 lowerTick) external view returns (bool) {
        Position storage p = positions[positionId];
        return claimedInterval[positionId][lowerTick] || intervals[lowerTick].lastFillClock > p.depositClock;
    }

    // ------------------------------------------------------------------
    // Pricing curve — swappable; real implementation would use sqrt-price
    // tick math. Linear is enough for mechanism correctness here.
    // ------------------------------------------------------------------

    uint256 internal constant PRICE_SCALE = 1e18;

    /// @dev token0 principal per unit liquidity (1:1 in the prototype).
    function _amount0(uint128 liquidity) internal pure returns (uint256) {
        return uint256(liquidity);
    }

    /// @dev token1 received for converting `liquidity` across the interval
    /// starting at `lowerTick`. Pure function of the interval — constant
    /// across lifecycles — which is what lets the book skip per-epoch records.
    function _amount1(int24 lowerTick, uint128 liquidity) internal view virtual returns (uint256) {
        int256 rate = int256(PRICE_SCALE) + int256(lowerTick) * 1e15;
        require(rate > 0, "rate underflow");
        return (uint256(liquidity) * uint256(rate)) / PRICE_SCALE;
    }

    /// @dev Smallest aligned tick boundary strictly above `tick`.
    function _nextBoundaryAbove(int24 tick) internal view returns (int24) {
        int24 b = (tick / tickSpacing) * tickSpacing;
        if (b <= tick) b += tickSpacing;
        return b;
    }
}
