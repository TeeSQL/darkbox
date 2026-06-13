// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRangeOrderBook} from "./IRangeOrderBook.sol";
import {FrontierBookBase} from "./FrontierBookBase.sol";
import {IFrontierHooks, FrontierHookFlags} from "./hooks/IFrontierHooks.sol";

/// @title RollingFrontierBook — width-O(1) production candidate
///
/// Exploits a property the fill-clock book leaves on the table: because a
/// valid sell-above position is born with `lower > currentTick`, its personal
/// filled region can never fragment — it is always a contiguous prefix
/// `[lower, frontier)` of its range. (The GLOBAL set of intervals filled
/// since a timestamp fragments under price oscillation, but any one
/// position's view of it is prefix-shaped: to fill a higher interval of the
/// range, price must first have crossed every lower one after the deposit.)
///
/// So instead of materializing per-interval buckets at deposit, each order
/// contributes two endpoint deltas:
///
///   frontierDelta[lower] += L      (its current unfilled frontier)
///   frontierDelta[upper] -= L
///
/// When price fully crosses interval [t, t+s), the liquidity whose frontier
/// is t — exactly `frontierDelta[t]`, since earlier crossings rolled
/// everyone else forward — is consumed, and the surviving suffix rolls:
/// `frontierDelta[t+s] += frontierDelta[t]`. A fully consumed order's +L
/// rolls into its own upper and cancels against its -L. Filled liquidity
/// ceases to exist at the interval, so no-resurrection holds by construction,
/// same as the bucket design — the bucket is just implicit now.
///
/// Eligibility uses the same global fill clock, keyed by UPPER boundary:
/// `boundaryFillClock[u] > depositClock` proves interval [u-s, u) filled
/// after deposit; prefix-contiguity then proves everything below it in the
/// range filled too. Hence O(1) claims/cancels against a caller-supplied
/// boundary witness, or O(log width) without one (binary search over the
/// prefix-monotone fill predicate).
///
/// Complexity: deposit O(1), requote O(1), claimTo/cancelWithWitness O(1),
/// sweeps O(endpoints crossed + bitmap words) — see _sweepUp/_sweepDown.
///
/// EIP-170: this contract is the deployed book; the cold maker-management
/// surface (requotes, cancels, transfers) lives in a FrontierMakerOps
/// companion reached via delegatecall — see FrontierBookBase for the
/// layout-sharing contract.
///
/// Venue caveat: this CANNOT back a vanilla v4 hook holding real pool
/// liquidity — only the frontier interval would be materialized in the pool,
/// so a single swap sweeping several intervals would glide through the
/// unmaterialized ones without converting them. It is a standalone venue
/// (order book / vault / custom-accounting AMM).
///
/// Partial fills: whole-interval granularity by design ("thin ticks"); the
/// watermark sub-interval design was prototyped and reverted — see
/// NOTES-partial-fills.md.
///
/// Dust policy (differs from the bucket book): fills collect
/// ceil(totalL * rate) per interval; claims pay floor(L * spanRate) over the
/// claimed span in one rounding. Sum of span-floors <= sum of interval-ceils,
/// so no overclaim; payouts remain claim-order independent per position.
contract RollingFrontierBook is IRangeOrderBook, FrontierBookBase {
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
    // Orders
    // ------------------------------------------------------------------

    /// @notice O(1): two endpoint writes regardless of range width.
    function deposit(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId) {
        return depositShaped(lower, upper, liquidity, 0);
    }

    /// @notice O(1) SHAPED ladder: size at level j is `liquidity + slope*j`
    /// (piecewise-linear profiles compose from multiple positions). Four
    /// endpoint writes regardless of range width. Every level's size must be
    /// >= 1 so covered levels are always visible to the sweep bitmap.
    function depositShaped(int24 lower, int24 upper, uint128 liquidity, int128 slope)
        public
        returns (uint256 positionId)
    {
        require(liquidity > 0, "zero liquidity");
        _checkRange(lower, upper);
        _checkShape(lower, upper, liquidity, slope);
        if (address(hooks) != address(0)) _callBeforeDepositHook(msg.sender, lower, upper, liquidity, slope, false);

        _addOrder(lower, upper, liquidity, slope);

        positionId = _nextPositionId++;
        _storePosition(positionId, msg.sender, lower, upper, liquidity, fillClock, lower, false);
        if (slope != 0) _positionSlope[positionId] = slope;

        uint256 amount0 = _principalSpan(liquidity, slope, 0, _levels(lower, upper));
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

        (proceeds1,) = _chargeMakerFee(token1, positionId, _spanAmt1(p, _positionSlope[positionId], p.claimedUpper, target));
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
    // FrontierMakerOps companion. Each forwarder replays the exact calldata
    // against the module's code in this contract's storage context, then
    // returns/reverts with whatever the module produced. The assembly
    // `return` exits before the declared return values are touched, so the
    // signatures below are pure ABI surface.
    // ------------------------------------------------------------------

    function transferPosition(uint256, address) external {
        _makerOpsCall();
    }

    function requote(uint256, int24, int24, uint128) external {
        _makerOpsCall();
    }

    function requoteShaped(uint256, int24, int24, uint128, int128) external {
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
    /// deposit (retreats change no fills, stamps, or deltas, so they are
    /// harmless to third parties — and the bundle defeats pointer-pinning
    /// griefing, since a pin cannot land inside someone else's transaction).
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
    /// token1). Walks the side's tick bitmap so empty price regions cost one
    /// word-read per 256 intervals. Crosses at most `maxFills` levels and
    /// never commits more than `maxPay` of the input token: on either budget
    /// the pointer parks adjacent to the first unfilled level and a later
    /// sweep resumes exactly there. Reverts if total output < `minOut` or
    /// past `deadline`. Never touches positions.
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

    /// @dev ENDPOINT-TELESCOPED up-sweep ("tick ozempic"): between order
    /// endpoints (set bits), aggregate liquidity evolves affinely
    /// (A(e+k) = a0 + k*S), so a whole run of thin levels settles with ONE
    /// closed-form series and ONE absorption — no per-level state
    /// transitions. The storage end-state is identical to the per-level
    /// roll (survivors materialize once at the sweep end / park point), so
    /// claims, cancels, and views are unchanged. Per-boundary clock stamps
    /// are replaced by one high-water record per liquidity-moving sweep.
    /// Cost: O(endpoints crossed + bitmap words), independent of tick count.
    ///
    /// Mutable up-sweep state lives in memory, not the stack: the loop
    /// plus the park branch otherwise exceeds via-ir's stack budget once the
    /// optimizer inlines _runAmounts/_nextActive into it.
    struct UpSweep {
        int256 B; // rolled base: size sold at the previous level
        int256 S; // absolute per-level slope in effect
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
            int256 S2 = S.S + frontierSlope[e];
            int256 a0 = S.B + frontierDelta[e] + S2; // size sold at level e
            uint256 n = uint256(uint24(runEnd - e)) / uint256(uint24(tickSpacing));
            {
                int256 aLast = a0 + int256(n - 1) * S2;
                // endpoints of an affine run bound every level in it
                require(a0 >= 0 && aLast >= 0, "negative run");
            }

            (uint256 out0, uint256 cost1) = _runAmounts(e, a0, S2, n);

            if (S.steps == maxSteps || S.owed1 + cost1 > maxPay) {
                _parkUp(S, e, a0, S2, n, maxSteps, maxPay, oldTick);
                break;
            }

            _writeDelta(e, 0);
            _writeSlope(e, 0);
            if (out0 > 0) {
                S.owed0 += out0;
                S.owed1 += cost1;
                if (S.clock == 0) S.clock = ++fillClock;
                emit RunFilled(e, runEnd, uint256(a0), S2, S.clock);
            }

            S.B = a0 + int256(n - 1) * S2; // arrival base at runEnd
            S.S = S2;
            unchecked {
                S.steps++;
            }
            e = e2;
            found = found2;
        }

        if (!S.parked) {
            // materialize survivors once at the sweep end
            if (S.B != 0) _writeDelta(target, frontierDelta[target] + S.B);
            if (S.S != 0) _writeSlope(target, frontierSlope[target] + S.S);
        }
        if (S.clock != 0) _pushHighWater(S.clock, S.reached);
        return (S.reached, S.owed1, S.owed0);
    }

    /// @dev Budget/step-limit exhausted at endpoint `e`: fill the affordable
    /// prefix of the run and park before the first unfilled level.
    function _parkUp(
        UpSweep memory S,
        int24 e,
        int256 a0,
        int256 S2,
        uint256 n,
        uint256 maxSteps,
        uint256 maxPay,
        int24 oldTick
    ) internal {
        uint256 fit = 0;
        if (S.steps != maxSteps && maxPay > S.owed1) {
            fit = _maxAffordable(e, a0, S2, n, maxPay - S.owed1);
        }
        if (fit > 0) {
            (uint256 fo0, uint256 fc1) = _runAmounts(e, a0, S2, fit);
            S.owed0 += fo0;
            S.owed1 += fc1;
            if (S.clock == 0) S.clock = ++fillClock;
            int24 park = e + int24(uint24(fit)) * tickSpacing;
            emit RunFilled(e, park, uint256(a0), S2, S.clock);
            _writeDelta(e, 0);
            _writeSlope(e, 0);
            // survivors materialize at the park point, per-level-equivalent
            _writeDelta(park, frontierDelta[park] + a0 + int256(fit - 1) * S2);
            _writeSlope(park, frontierSlope[park] + S2);
            S.reached = park;
        } else {
            // park before this endpoint; leave the rolled state on it
            if (S.B != 0) _writeDelta(e, frontierDelta[e] + S.B);
            if (S.S != 0) _writeSlope(e, frontierSlope[e] + S.S);
            S.reached = e > oldTick ? e : oldTick;
        }
        S.parked = true;
    }

    /// @dev Largest prefix m <= n of the run whose cost fits the budget
    /// (binary search over the closed form).
    function _maxAffordable(int24 e, int256 a0, int256 slope, uint256 n, uint256 budget)
        internal
        view
        returns (uint256 m)
    {
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            (, uint256 c) = _runAmounts(e, a0, slope, mid);
            if (c <= budget) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @dev ENDPOINT-TELESCOPED down-sweep, exact mirror of _sweepUp: bid
    /// sizes are uniform between endpoints (no shapes on the bid side), so
    /// a whole run of thin levels settles with ONE arithmetic series and
    /// ONE absorption, the rolled base carried locally. Storage end-state
    /// is identical to the per-level roll (survivors materialize once at
    /// the park point / sweep end). Per-boundary clock stamps are replaced
    /// by one low-water record per liquidity-moving sweep.
    /// Cost: O(endpoints crossed + bitmap words), independent of tick count.
    ///
    /// Mutable down-sweep state lives in memory, not the stack: the
    /// loop plus the park branch otherwise exceeds via-ir's stack budget
    /// once the optimizer inlines _bidRunAmounts/_prevActive into it.
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
        uint256 gross = _spanAmt1(p, _positionSlope[positionId], p.claimedUpper, frontier);
        return gross - _feeAmount(gross, makerFeeBps);
    }

    function unfilledPrincipal(uint256 positionId) external view returns (uint256) {
        Position storage p = _positions[positionId];
        if (!p.live || p.isBid) return 0;
        int24 frontier = _frontier(p);
        return _principalSpan(p.liquidity, _positionSlope[positionId], _levelOf(p, frontier), _levels(p.lower, p.upper));
    }

    function isConsumedFor(uint256 positionId, int24 lowerTick) external view returns (bool) {
        Position storage p = _positions[positionId];
        return _highSince(p.depositClock) >= lowerTick + tickSpacing;
    }

    /// @notice The book's price curve at a tick (X18 token1 per token0).
    /// Periphery contracts (YieldRangeLP, FrontierPositionNFT) need this for
    /// cost estimation across curve types; FrontierLens uses it for quotes.
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
    /// prefix sum of endpoint deltas: +L counted iff frontier <= t, -L
    /// cancels it iff upper <= t — i.e. exactly orders with
    /// frontier <= t < upper.
    function activeLiquidity(int24 lowerTick) external view returns (uint128) {
        if (_minBoundary == type(int24).max || lowerTick < _minBoundary) return 0;
        int256 sum;
        int256 slope;
        for (int24 u = _minBoundary; u <= lowerTick; u += tickSpacing) {
            slope += frontierSlope[u];
            sum += frontierDelta[u] + slope;
        }
        require(sum >= 0, "negative active");
        return uint128(uint256(sum));
    }
}
