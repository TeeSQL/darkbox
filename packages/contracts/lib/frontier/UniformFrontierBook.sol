// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRangeOrderBook} from "./IRangeOrderBook.sol";
import {FrontierBookBase} from "./FrontierBookBase.sol";
import {IFrontierHooks, FrontierHookFlags} from "./hooks/IFrontierHooks.sol";

/// @title UniformFrontierBook — uniform-only sibling of RollingFrontierBook
///
/// Same width-O(1) rolling-frontier venue as RollingFrontierBook, but the ASK
/// side carries NO shaped-ladder (slope) machinery: ladders are uniform-only.
/// This is the base the deployed GeometricFrontierBook builds on, so the
/// production book's runtime links no slope arithmetic, no second-order
/// frontierSlope roll, no _positionSlope, and exposes no depositShaped /
/// requoteShaped surface. (RollingFrontierBook keeps the full shaped path for
/// the linear demo curve and the differential/shape test suites.)
///
/// The bid side, the down-sweep, the sweep harness, and the maker-management
/// forwarders are identical to RollingFrontierBook by construction — bids were
/// always uniform — so only the ask-side deposit/claim/up-sweep/views differ
/// (they call the flat `_addFlatOrder`/`_askRun`/`_askSpan` helpers in
/// FrontierBookBase instead of the slope-bearing ones). Keep the two books'
/// shared surface in lockstep when editing either.
contract UniformFrontierBook is IRangeOrderBook, FrontierBookBase {
    /// @notice Companion contract executing requotes/cancels/transfers via
    /// delegatecall (same storage layout + immutables; see FrontierBookBase).
    address public immutable makerOps;

    constructor(
        address _token0,
        address _token1,
        int24 _tickSpacing,
        int24 _initialTick,
        address _hooks,
        address _permissions,
        address _makerOps,
        address _feeRecipient,
        uint16 _makerFeeBps,
        uint16 _takerFeeBps
    )
        FrontierBookBase(
            _token0,
            _token1,
            _tickSpacing,
            _initialTick,
            _hooks,
            _permissions,
            _feeRecipient,
            _makerFeeBps,
            _takerFeeBps
        )
    {
        makerOps = _makerOps;
    }

    // ------------------------------------------------------------------
    // Orders (ask side, uniform only)
    // ------------------------------------------------------------------

    /// @notice O(1): two endpoint writes regardless of range width. `liquidity`
    /// rests at every covered level (uniform ladder).
    function deposit(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId) {
        require(liquidity > 0, "zero liquidity");
        _checkRange(lower, upper);
        if (address(hooks) != address(0)) _callBeforeDepositHook(msg.sender, lower, upper, liquidity, 0, false);

        _addFlatOrder(lower, upper, liquidity);

        positionId = _nextPositionId++;
        _storePosition(positionId, msg.sender, lower, upper, liquidity, fillClock, lower, false);

        uint256 amount0 = uint256(liquidity) * uint256(_levels(lower, upper));
        _pull0(msg.sender, amount0);
        emit Deposit(positionId, msg.sender, lower, upper, liquidity);
        if (address(hooks) != address(0)) _callAfterDepositHook(msg.sender, positionId, false);
    }

    /// @notice O(1) claim against a boundary witness: pays the span
    /// (claimedUpper, target]. Underclaiming is harmless; overclaiming is
    /// impossible because `target`'s interval must have filled after deposit,
    /// and prefix-contiguity covers everything below it.
    function claimTo(uint256 positionId, int24 target) public returns (uint256 proceeds1) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(!p.isBid, "use bid methods");
        _authOwner(p.owner);
        require(target > p.claimedUpper && target <= p.upper, "bad target");
        require((target - p.lower) % tickSpacing == 0, "unaligned target");
        require(_highSince(p.depositClock) >= target, "not filled");

        (proceeds1,) = _chargeMakerFee(token1, positionId, _askSpan(p, p.claimedUpper, target));
        p.claimedUpper = target;

        if (proceeds1 > 0) require(token1.transfer(p.owner, proceeds1), "transfer out failed");
        emit Claim(positionId, proceeds1);
        _callHook(
            FrontierHookFlags.AFTER_CLAIM_FLAG,
            abi.encodeCall(IFrontierHooks.afterClaim, (msg.sender, positionId, proceeds1)),
            IFrontierHooks.afterClaim.selector
        );
    }

    /// @notice Convenience variant: finds the frontier itself in O(log width).
    function claim(uint256 positionId) external returns (uint256 proceeds1) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(!p.isBid, "use bid methods");
        _authOwner(p.owner);
        int24 frontier = _frontier(p);
        if (frontier <= p.claimedUpper) {
            emit Claim(positionId, 0);
            return 0;
        }
        return claimTo(positionId, frontier);
    }

    // ------------------------------------------------------------------
    // BID side: buy token0 with token1, resting below the price
    // (identical to RollingFrontierBook — bids are always uniform)
    // ------------------------------------------------------------------

    /// @notice O(1) bid: `liquidity` token0-units wanted per level over
    /// [lower, upper), which must sit entirely at/below the current price.
    /// Pulls the token1 value of the span (ceil; book-favorable).
    function depositBid(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId) {
        return _depositBid(lower, upper, liquidity);
    }

    function _depositBid(int24 lower, int24 upper, uint128 liquidity) internal returns (uint256 positionId) {
        require(liquidity > 0, "zero liquidity");
        require(lower < upper, "empty range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "unaligned");
        require(upper <= _currentTick, "range not below price");
        if (address(hooks) != address(0)) _callBeforeDepositHook(msg.sender, lower, upper, liquidity, 0, true);

        _addBid(lower, upper, liquidity);

        positionId = _nextPositionId++;
        _storePosition(positionId, msg.sender, lower, upper, liquidity, fillClock, upper, true);

        uint256 amount1 = _uniformSpanValue(lower, upper, liquidity, true);
        _transferInExact(token1, msg.sender, amount1, "non-exact token1 transfer");
        emit Deposit(positionId, msg.sender, lower, upper, liquidity);
        if (address(hooks) != address(0)) _callAfterDepositHook(msg.sender, positionId, true);
    }

    /// @notice O(1) bid claim against a boundary witness: pays the token0 for
    /// filled levels [target, cursor). Mirror of claimTo.
    function claimBidTo(uint256 positionId, int24 target) public returns (uint256 proceeds0) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(p.isBid, "not a bid");
        _authOwner(p.owner);
        require(target < p.claimedUpper && target >= p.lower, "bad target");
        require((target - p.lower) % tickSpacing == 0, "unaligned target");
        require(_lowSince(p.depositClock) <= target, "not filled");

        (proceeds0,) = _chargeMakerFee(
            token0,
            positionId,
            uint256(p.liquidity) * (uint256(uint24(p.claimedUpper - target)) / uint256(uint24(tickSpacing)))
        );
        p.claimedUpper = target;

        if (proceeds0 > 0) require(token0.transfer(p.owner, proceeds0), "transfer out failed");
        emit Claim(positionId, proceeds0);
        _callHook(
            FrontierHookFlags.AFTER_CLAIM_FLAG,
            abi.encodeCall(IFrontierHooks.afterClaim, (msg.sender, positionId, proceeds0)),
            IFrontierHooks.afterClaim.selector
        );
    }

    /// @notice Convenience variant: finds the bid frontier in O(log width).
    function claimBid(uint256 positionId) external returns (uint256 proceeds0) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(p.isBid, "not a bid");
        _authOwner(p.owner);
        int24 frontier = _bidFrontier(p);
        if (frontier >= p.claimedUpper) {
            emit Claim(positionId, 0);
            return 0;
        }
        return claimBidTo(positionId, frontier);
    }

    // ------------------------------------------------------------------
    // Maker management (requotes / cancels / transfers): delegated to the
    // UniformMakerOps companion. Identical forwarding to RollingFrontierBook,
    // minus the shaped requoteShaped entrypoint (uniform book has no shapes).
    // ------------------------------------------------------------------

    function transferPosition(uint256, address) external {
        _makerOpsCall();
    }

    function requote(uint256, int24, int24, uint128) external {
        _makerOpsCall();
    }

    function requoteBid(uint256, int24, int24, uint128) external {
        _makerOpsCall();
    }

    function cancelWithWitness(uint256, int24) external returns (uint256 proceeds1, uint256 principal0) {
        _makerOpsCall();
    }

    function cancel(uint256) external returns (uint256 proceeds1, uint256 principal0) {
        _makerOpsCall();
    }

    function cancelBidWithWitness(uint256, int24) external returns (uint256 proceeds0, uint256 refund1) {
        _makerOpsCall();
    }

    function cancelBid(uint256) external returns (uint256 proceeds0, uint256 refund1) {
        _makerOpsCall();
    }

    function _makerOpsCall() private {
        address m = makerOps;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    // ------------------------------------------------------------------
    // Market simulation (stands in for the venue's swap path)
    // ------------------------------------------------------------------

    /// @notice Unbounded sweep (interface compatibility). Downward moves are
    /// free pointer retreats; depositors should BUNDLE a retreat with their
    /// deposit (retreats change no fills, stamps, or deltas).
    function moveTickTo(int24 newTick) external {
        sweep(newTick, type(uint256).max);
    }

    /// @notice Bounded, resumable taker sweep with no price/size protection
    /// (kept for compatibility; takers should prefer sweepWithLimits).
    function sweep(int24 target, uint256 maxFills) public returns (int24 reached) {
        (reached,,) = sweepWithLimits(target, maxFills, type(uint256).max, 0, block.timestamp);
    }

    /// @notice Taker entry, both directions. UP-sweeps buy token0 from asks
    /// (pay token1); DOWN-sweeps sell token0 into bids (pay token0, receive
    /// token1). Identical harness to RollingFrontierBook; only _sweepUp is
    /// uniform here.
    function sweepWithLimits(int24 target, uint256 maxFills, uint256 maxPay, uint256 minOut, uint256 deadline)
        public
        returns (int24 reached, uint256 paid, uint256 received)
    {
        require(block.timestamp <= deadline, "expired");
        int24 oldTick = _currentTick;
        if (target == oldTick) return (oldTick, 0, 0);
        _callHook(
            FrontierHookFlags.BEFORE_SWEEP_FLAG,
            abi.encodeCall(IFrontierHooks.beforeSweep, (msg.sender, oldTick, target)),
            IFrontierHooks.beforeSweep.selector
        );
        if (target > oldTick) {
            (reached, paid, received) = _sweepUp(oldTick, target, maxFills, _maxGrossForTotal(maxPay, takerFeeBps));
            uint256 fee;
            (paid, fee) = _takerTotal(paid);
            _currentTick = reached;
            require(received >= minOut, "insufficient output");
            if (paid > 0) _transferInExact(token1, msg.sender, paid, "non-exact token1 transfer");
            _payTakerFee(token1, msg.sender, paid - fee, fee, paid);
            if (received > 0) require(token0.transfer(msg.sender, received), "fill payout failed");
        } else {
            (reached, paid, received) = _sweepDown(oldTick, target, maxFills, _maxGrossForTotal(maxPay, takerFeeBps));
            uint256 fee;
            (paid, fee) = _takerTotal(paid);
            _currentTick = reached;
            require(received >= minOut, "insufficient output");
            if (paid > 0) _transferInExact(token0, msg.sender, paid, "non-exact token0 transfer");
            _payTakerFee(token0, msg.sender, paid - fee, fee, paid);
            if (received > 0) require(token1.transfer(msg.sender, received), "fill payout failed");
        }
        _callHook(
            FrontierHookFlags.AFTER_SWEEP_FLAG,
            abi.encodeCall(IFrontierHooks.afterSweep, (msg.sender, oldTick, reached, paid, received)),
            IFrontierHooks.afterSweep.selector
        );
    }

    /// @dev ENDPOINT-TELESCOPED up-sweep, uniform-only. Between order endpoints
    /// (set bits) aggregate ask liquidity is CONSTANT (no slope), so a whole
    /// run of thin levels settles with ONE closed form and ONE absorption.
    /// The storage end-state matches the per-level roll (survivors materialize
    /// once at the sweep end / park point). One high-water record per
    /// liquidity-moving sweep. Cost: O(endpoints crossed + bitmap words).
    struct UpSweep {
        int256 B; // rolled base: size sold at the previous level
        uint256 steps;
        uint64 clock;
        bool parked;
        int24 reached;
        uint256 owed0;
        uint256 owed1;
    }

    function _sweepUp(int24 oldTick, int24 target, uint256 maxSteps, uint256 maxPay)
        internal
        returns (int24, uint256, uint256)
    {
        int24 lastLevel = target - tickSpacing;
        UpSweep memory S;
        S.reached = target;

        (int24 e, bool found) = _nextActive(_nextBoundaryAbove(oldTick) - tickSpacing, lastLevel);
        while (found) {
            (int24 e2, bool found2) = _nextActive(e + tickSpacing, lastLevel);
            int24 runEnd = found2 ? e2 : target;

            // absorb endpoint e (locally; storage zeroed only if we proceed)
            int256 a0 = S.B + frontierDelta[e]; // uniform: size constant across the run
            require(a0 >= 0, "negative run");
            uint256 n = uint256(uint24(runEnd - e)) / uint256(uint24(tickSpacing));

            (uint256 out0, uint256 cost1) = _askRun(e, a0, n);

            if (S.steps == maxSteps || S.owed1 + cost1 > maxPay) {
                _parkUp(S, e, a0, n, maxSteps, maxPay, oldTick);
                break;
            }

            _writeFlatDelta(e, 0);
            if (out0 > 0) {
                S.owed0 += out0;
                S.owed1 += cost1;
                if (S.clock == 0) S.clock = ++fillClock;
                emit RunFilled(e, runEnd, uint256(a0), 0, S.clock);
            }

            S.B = a0; // uniform: arrival base at runEnd unchanged
            unchecked {
                S.steps++;
            }
            e = e2;
            found = found2;
        }

        if (!S.parked) {
            // materialize survivors once at the sweep end
            if (S.B != 0) _writeFlatDelta(target, frontierDelta[target] + S.B);
        }
        if (S.clock != 0) _pushHighWater(S.clock, S.reached);
        return (S.reached, S.owed1, S.owed0);
    }

    /// @dev Budget/step-limit exhausted at endpoint `e`: fill the affordable
    /// prefix of the run and park before the first unfilled level.
    function _parkUp(UpSweep memory S, int24 e, int256 a0, uint256 n, uint256 maxSteps, uint256 maxPay, int24 oldTick)
        internal
    {
        uint256 fit = 0;
        if (S.steps != maxSteps && maxPay > S.owed1) {
            fit = _maxAffordable(e, a0, n, maxPay - S.owed1);
        }
        if (fit > 0) {
            (uint256 fo0, uint256 fc1) = _askRun(e, a0, fit);
            S.owed0 += fo0;
            S.owed1 += fc1;
            if (S.clock == 0) S.clock = ++fillClock;
            int24 park = e + int24(uint24(fit)) * tickSpacing;
            emit RunFilled(e, park, uint256(a0), 0, S.clock);
            _writeFlatDelta(e, 0);
            // survivors materialize at the park point, per-level-equivalent
            _writeFlatDelta(park, frontierDelta[park] + a0);
            S.reached = park;
        } else {
            // park before this endpoint; leave the rolled state on it
            if (S.B != 0) _writeFlatDelta(e, frontierDelta[e] + S.B);
            S.reached = e > oldTick ? e : oldTick;
        }
        S.parked = true;
    }

    /// @dev Largest prefix m <= n of the run whose cost fits the budget
    /// (binary search over the closed form).
    function _maxAffordable(int24 e, int256 a0, uint256 n, uint256 budget) internal view returns (uint256 m) {
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            (, uint256 c) = _askRun(e, a0, mid);
            if (c <= budget) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @dev ENDPOINT-TELESCOPED down-sweep, exact mirror of RollingFrontierBook
    /// (bids were always uniform). One arithmetic series + one absorption per
    /// run, the rolled base carried locally; one low-water record per
    /// liquidity-moving sweep.
    struct DownSweep {
        int256 B; // rolled base: size bought at the previous (higher) level
        uint256 steps;
        uint64 clock;
        bool parked;
        int24 reached;
        uint256 owed0;
        uint256 owed1;
    }

    function _sweepDown(int24 oldTick, int24 target, uint256 maxSteps, uint256 maxPay)
        internal
        returns (int24, uint256, uint256)
    {
        DownSweep memory S;
        S.reached = target;

        (int24 e, bool found) = _prevActive(_floorAligned(oldTick - 1), target);
        while (found) {
            (int24 e2, bool found2) = _prevActive(e - tickSpacing, target);
            // run fills levels e, e-s, ..., runEnd+s (descending)
            int24 runEnd = found2 ? e2 : target - tickSpacing;

            // absorb endpoint e (locally; storage zeroed only if we proceed)
            int256 a0 = S.B + bidDelta[e];
            // crossings happen right-to-left, so every covering bid has
            // rolled into e before e is crossed; negative is unreachable
            require(a0 >= 0, "negative bid run");
            uint256 n = uint256(uint24(e - runEnd)) / uint256(uint24(tickSpacing));

            (uint256 in0, uint256 out1) = _bidRunAmounts(e, a0, n);

            if (S.steps == maxSteps || S.owed0 + in0 > maxPay) {
                _parkDown(S, e, a0, n, maxSteps, maxPay, oldTick);
                break;
            }

            _writeBidDelta(e, 0);
            if (in0 > 0) {
                S.owed0 += in0;
                S.owed1 += out1;
                if (S.clock == 0) S.clock = ++fillClock;
                emit RunFilled(e, runEnd, uint256(a0), 0, S.clock);
            }

            S.B = a0; // uniform: arrival base at runEnd unchanged
            unchecked {
                S.steps++;
            }
            e = e2;
            found = found2;
        }

        if (!S.parked) {
            // materialize survivors once at the sweep end
            if (S.B != 0) _writeBidDelta(target - tickSpacing, bidDelta[target - tickSpacing] + S.B);
        }
        if (S.clock != 0) _pushLowWater(S.clock, S.reached);
        return (S.reached, S.owed0, S.owed1);
    }

    /// @dev Budget/step-limit exhausted at endpoint `e`: fill the affordable
    /// prefix of the run (uniform cost => subdivision is one division) and
    /// park just above the first unfilled level.
    function _parkDown(
        DownSweep memory S,
        int24 e,
        int256 a0,
        uint256 n,
        uint256 maxSteps,
        uint256 maxPay,
        int24 oldTick
    ) internal {
        uint256 fit = 0;
        if (S.steps != maxSteps && maxPay > S.owed0 && a0 > 0) {
            fit = (maxPay - S.owed0) / uint256(a0);
            if (fit > n) fit = n;
        }
        if (fit > 0) {
            (uint256 fi0, uint256 fo1) = _bidRunAmounts(e, a0, fit);
            S.owed0 += fi0;
            S.owed1 += fo1;
            if (S.clock == 0) S.clock = ++fillClock;
            int24 firstUnfilled = e - int24(uint24(fit)) * tickSpacing;
            emit RunFilled(e, firstUnfilled, uint256(a0), 0, S.clock);
            _writeBidDelta(e, 0);
            // survivors materialize at the park point, per-level-equivalent
            _writeBidDelta(firstUnfilled, bidDelta[firstUnfilled] + a0);
            S.reached = firstUnfilled + tickSpacing;
        } else {
            // park above this endpoint; leave the rolled state on it
            if (S.B != 0) _writeBidDelta(e, bidDelta[e] + S.B);
            S.reached = e + tickSpacing < oldTick ? e + tickSpacing : oldTick;
        }
        S.parked = true;
    }

    // ------------------------------------------------------------------
    // Views (interface compatibility — kept for correctness tests and
    // differential fuzz. Bid-side helpers and rateAt moved to FrontierLens.)
    // ------------------------------------------------------------------

    /// @notice Explicit getter (the variable lives in FrontierBookBase as
    /// internal state: a public var in a base cannot satisfy the interface).
    function currentTick() external view returns (int24) {
        return _currentTick;
    }

    function claimable(uint256 positionId) external view returns (uint256) {
        Position storage p = _positions[positionId];
        if (!p.live || p.isBid) return 0;
        int24 frontier = _frontier(p);
        if (frontier <= p.claimedUpper) return 0;
        uint256 gross = _askSpan(p, p.claimedUpper, frontier);
        return gross - _feeAmount(gross, makerFeeBps);
    }

    function unfilledPrincipal(uint256 positionId) external view returns (uint256) {
        Position storage p = _positions[positionId];
        if (!p.live || p.isBid) return 0;
        int24 frontier = _frontier(p);
        return uint256(p.liquidity) * uint256(_levels(p.lower, p.upper) - _levelOf(p, frontier));
    }

    function isConsumedFor(uint256 positionId, int24 lowerTick) external view returns (bool) {
        Position storage p = _positions[positionId];
        return _highSince(p.depositClock) >= lowerTick + tickSpacing;
    }

    /// @notice The book's price curve at a tick (X18 token1 per token0).
    function rateAt(int24 t) external view returns (uint256) {
        return _rate(t);
    }

    /// @notice Aggregate live BID size (token0 units) at a level: suffix sum
    /// of bid endpoint deltas from above (mirror of activeLiquidity).
    function bidLiquidity(int24 lowerTick) external view returns (uint128) {
        int24 maxBoundary = _floorAligned(_currentTick - 1);
        if (lowerTick > maxBoundary) return 0;
        int256 sum;
        for (int24 u = maxBoundary; u >= lowerTick; u -= tickSpacing) {
            sum += bidDelta[u];
        }
        require(sum >= 0, "negative active");
        return uint128(uint256(sum));
    }

    /// @notice token0 a bid could claim right now.
    function bidClaimable(uint256 positionId) external view returns (uint256) {
        Position storage p = _positions[positionId];
        if (!p.live || !p.isBid) return 0;
        int24 frontier = _bidFrontier(p);
        if (frontier >= p.claimedUpper) return 0;
        uint256 gross =
            uint256(p.liquidity) * (uint256(uint24(p.claimedUpper - frontier)) / uint256(uint24(tickSpacing)));
        return gross - _feeAmount(gross, makerFeeBps);
    }

    /// @notice token1 still backing a bid's unfilled levels (floor).
    function bidRefundable(uint256 positionId) external view returns (uint256) {
        Position storage p = _positions[positionId];
        if (!p.live || !p.isBid) return 0;
        int24 frontier = _bidFrontier(p);
        if (frontier <= p.lower) return 0;
        return _uniformSpanValue(p.lower, frontier, p.liquidity, false);
    }

    /// @dev Aggregate live liquidity covering [lowerTick, lowerTick+s) =
    /// prefix sum of endpoint deltas (uniform: no slope accumulator).
    function activeLiquidity(int24 lowerTick) external view returns (uint128) {
        if (_minBoundary == type(int24).max || lowerTick < _minBoundary) return 0;
        int256 sum;
        for (int24 u = _minBoundary; u <= lowerTick; u += tickSpacing) {
            sum += frontierDelta[u];
        }
        require(sum >= 0, "negative active");
        return uint128(uint256(sum));
    }
}
