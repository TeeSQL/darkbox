// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFrontierHooks} from "../IFrontierHooks.sol";

/// @dev Shared no-op boilerplate: every callback a hook doesn't care about
/// still has to return its selector when flagged; unflagged callbacks are
/// never called at all, so these defaults cost nothing in practice.
abstract contract BaseHook is IFrontierHooks {
    function beforeDeposit(address, int24, int24, uint128, int128, bool) external virtual returns (bytes4) {
        return IFrontierHooks.beforeDeposit.selector;
    }

    function afterDeposit(address, uint256, bool) external virtual returns (bytes4) {
        return IFrontierHooks.afterDeposit.selector;
    }

    function beforeSweep(address, int24, int24) external virtual returns (bytes4) {
        return IFrontierHooks.beforeSweep.selector;
    }

    function afterSweep(address, int24, int24, uint256, uint256) external virtual returns (bytes4) {
        return IFrontierHooks.afterSweep.selector;
    }

    function afterClaim(address, uint256, uint256) external virtual returns (bytes4) {
        return IFrontierHooks.afterClaim.selector;
    }

    function afterCancel(address, uint256, uint256, uint256) external virtual returns (bytes4) {
        return IFrontierHooks.afterCancel.selector;
    }
}

/// @notice Experiment: the book as its own price oracle. The book's tick
/// only ever moves through sweeps, so an AFTER_SWEEP hook observes every
/// price change — a v3-style cumulative-tick TWAP oracle falls out in ~60
/// lines, with no keeper and no external feed. One observation per second
/// at most (several sweeps in one second collapse to the last, as in v3's
/// per-block observations); ring buffer of 256.
///
/// Flags: AFTER_SWEEP_FLAG.
contract TwapOracleHook is BaseHook {
    struct Observation {
        uint32 blockTimestamp;
        int24 tick; // tick in effect from this observation onward
        int56 tickCumulative; // sum of tick * seconds elapsed, up to blockTimestamp
    }

    uint256 public constant CARDINALITY = 256;
    Observation[256] public observations;
    uint64 public count; // observations ever written; ring slot = (count-1) % CARDINALITY

    function afterSweep(address, int24, int24 reached, uint256, uint256) external override returns (bytes4) {
        uint32 t = uint32(block.timestamp);
        int56 cum = 0;
        if (count > 0) {
            uint256 slot = uint256((count - 1) % CARDINALITY);
            Observation memory last = observations[slot];
            if (t == last.blockTimestamp) {
                observations[slot].tick = reached;
                return IFrontierHooks.afterSweep.selector;
            }
            cum = last.tickCumulative + int56(last.tick) * int56(uint56(t - last.blockTimestamp));
        }
        observations[uint256(count % CARDINALITY)] = Observation(t, reached, cum);
        count++;
        return IFrontierHooks.afterSweep.selector;
    }

    /// @notice time-weighted average tick over the trailing `secondsAgo` window
    function consult(uint32 secondsAgo) external view returns (int24) {
        require(secondsAgo > 0, "zero window");
        require(count > 0, "no observations");
        uint32 t = uint32(block.timestamp);
        int56 delta = _cumulativeAt(t) - _cumulativeAt(t - secondsAgo);
        return int24(delta / int56(uint56(secondsAgo)));
    }

    function _cumulativeAt(uint32 t) private view returns (int56) {
        Observation memory o = _newestAtOrBefore(t);
        return o.tickCumulative + int56(o.tick) * int56(uint56(t - o.blockTimestamp));
    }

    function _newestAtOrBefore(uint32 t) private view returns (Observation memory) {
        uint64 lo = count > CARDINALITY ? count - uint64(CARDINALITY) : 0;
        uint64 hi = count - 1;
        require(t >= observations[uint256(lo % CARDINALITY)].blockTimestamp, "lookback beyond history");
        while (lo < hi) {
            uint64 mid = (lo + hi + 1) / 2;
            if (observations[uint256(mid % CARDINALITY)].blockTimestamp <= t) lo = mid;
            else hi = mid - 1;
        }
        return observations[uint256(lo % CARDINALITY)];
    }
}

/// @notice Experiment: a per-block price-move limit, enforced by veto. The
/// first sweep of each block pins a reference tick; any sweep TARGETING a
/// price further than `maxMovePerBlock` from it reverts. Note this judges
/// the taker's stated target, not the realized fill — a bounded sweep that
/// would have parked inside the band but aims beyond it is still blocked,
/// so takers quote honest targets. Crude on purpose: it demonstrates that
/// a `before` hook is a real veto point, the building block for circuit
/// breakers, batch-auction windows, or MEV speed bumps.
///
/// Flags: BEFORE_SWEEP_FLAG.
contract SweepCircuitBreakerHook is BaseHook {
    int24 public immutable maxMovePerBlock;
    uint64 public refBlock;
    int24 public refTick;

    constructor(int24 _maxMovePerBlock) {
        maxMovePerBlock = _maxMovePerBlock;
    }

    function beforeSweep(address, int24 fromTick, int24 target) external override returns (bytes4) {
        if (uint64(block.number) != refBlock) {
            refBlock = uint64(block.number);
            refTick = fromTick;
        }
        int24 dev = target > refTick ? target - refTick : refTick - target;
        require(dev <= maxMovePerBlock, "circuit breaker: move too large");
        return IFrontierHooks.beforeSweep.selector;
    }
}

/// @notice Experiment: maker incentives as a pure observation layer. Fills
/// only become attributable at settlement (claims and cancels report exact
/// proceeds), so crediting there counts each filled wei exactly once —
/// claim now or claim in a month, same credit. `miles` is filled volume in
/// proceeds-token units; an incentive program would convert it to rewards.
/// Unfilled principal returned by a cancel earns nothing.
///
/// Flags: AFTER_CLAIM_FLAG | AFTER_CANCEL_FLAG.
contract MakerMilesHook is BaseHook {
    mapping(address => uint256) public miles;
    uint256 public totalMiles;

    function afterClaim(address caller, uint256, uint256 proceeds) external override returns (bytes4) {
        miles[caller] += proceeds;
        totalMiles += proceeds;
        return IFrontierHooks.afterClaim.selector;
    }

    function afterCancel(address caller, uint256, uint256 proceeds, uint256) external override returns (bytes4) {
        miles[caller] += proceeds;
        totalMiles += proceeds;
        return IFrontierHooks.afterCancel.selector;
    }
}
