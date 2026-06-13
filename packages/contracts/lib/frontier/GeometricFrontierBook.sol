// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FrontierBookBase} from "./FrontierBookBase.sol";
import {RollingFrontierBook} from "./RollingFrontierBook.sol";
import {FrontierMakerOps} from "./FrontierMakerOps.sol";
import {GeoTickMath} from "./curve/GeoTickMath.sol";

/// @title GeometricCurve — the production 1.0001^tick price curve
///
/// Same machinery as the linear demo curve with the geometric one swapped
/// in. The key insight that keeps sweeps O(endpoints): geometric sums
/// TELESCOPE — for uniform per-level size L over levels [a, b) stepping s,
///
///   sum L * 1.0001^t  =  L * (P(b) - P(a)) / (P(s) - 1e18)
///
/// with P(t) = 1.0001^t in X18. One pow per run endpoint replaces the
/// quadratic series, and because every span value is a difference of the
/// SAME deterministic P over a shared per-book denominator, partial claims
/// telescope exactly against ceil-rounded deposits:
/// floor(x) + floor(y) <= floor(x+y) — no rounding leak by construction.
///
/// Limitation: shaped (sloped) ladders are ask-side sugar whose value sums
/// are arithmetico-geometric under this curve; the rounding-consistency
/// argument above doesn't extend to them mechanically, so shapes are
/// disabled here (slope must be 0). Approximate a shape with a few uniform
/// ladders instead.
///
/// A mixin (not a concrete book) so the EIP-170 pair — the deployed book
/// and its delegatecalled FrontierMakerOps companion — share one
/// implementation of the curve overrides. The concrete contracts below
/// carry solc's required diamond-join boilerplate (6480): each re-override
/// is a plain `super` dispatch that resolves to this mixin.
abstract contract GeometricCurve is FrontierBookBase {
    /// P(tickSpacing) - 1e18: the shared span denominator.
    uint256 public immutable geoD;

    constructor(int24 _tickSpacing) {
        geoD = GeoTickMath.powX18(_tickSpacing) - 1e18;
    }

    function _checkShape(int24 lower, int24 upper, uint128 l0, int128 m) internal view virtual override {
        require(m == 0, "geometric: uniform only");
        super._checkShape(lower, upper, l0, m);
    }

    function _rate(int24 t) internal pure virtual override returns (uint256) {
        return GeoTickMath.powX18(t);
    }

    /// @dev sum of size * rate over levels [a, b) stepping tickSpacing.
    /// The size == 0 short-circuit is load-bearing: the closing run of a
    /// fully-consumed side spans from the last endpoint to the sweep
    /// target, which may lie beyond GeoTickMath's tick domain — zero-size
    /// spans must not evaluate P there.
    function _geoSpan(int24 a, int24 b, uint256 size, bool roundUp) internal view returns (uint256) {
        if (b <= a || size == 0) return 0;
        uint256 num = size * (GeoTickMath.powX18(b) - GeoTickMath.powX18(a));
        return roundUp ? (num + geoD - 1) / geoD : num / geoD;
    }

    function _uniformSpanValue(int24 a, int24 b, uint128 size, bool roundUp)
        internal
        view
        virtual
        override
        returns (uint256)
    {
        return _geoSpan(a, b, size, roundUp);
    }

    function _spanAmt1(Position storage p, int128, int24 a, int24 b) internal view virtual override returns (uint256) {
        // slope is always 0 here (enforced at deposit)
        return _geoSpan(a, b, p.liquidity, false);
    }

    function _runAmounts(int24 e, int256 a0, int256 slope, uint256 n)
        internal
        view
        virtual
        override
        returns (uint256 out0, uint256 cost1)
    {
        require(slope == 0, "geometric: uniform only");
        require(a0 >= 0, "negative run");
        out0 = uint256(a0) * n;
        // levels e .. e+(n-1)s ascending; taker pays ceil
        cost1 = _geoSpan(e, e + int24(uint24(n)) * tickSpacing, uint256(a0), true);
    }

    function _bidRunAmounts(int24 e, int256 a0, uint256 n)
        internal
        view
        virtual
        override
        returns (uint256 in0, uint256 out1)
    {
        require(a0 >= 0, "negative run");
        in0 = uint256(a0) * n;
        // levels e-(n-1)s .. e descending; taker receives floor
        out1 = _geoSpan(e - int24(uint24(n - 1)) * tickSpacing, e + tickSpacing, uint256(a0), false);
    }
}

/// @notice The deployable geometric-curve book.
contract GeometricFrontierBook is RollingFrontierBook, GeometricCurve {
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
        RollingFrontierBook(
            _token0,
            _token1,
            _tickSpacing,
            _initialTick,
            _hooks,
            _permissions,
            _makerOps,
            _feeRecipient,
            _makerFeeBps,
            _takerFeeBps
        )
        GeometricCurve(_tickSpacing)
    {}

    // solc 6480 diamond-join boilerplate; every body dispatches to
    // GeometricCurve via super.
    function _checkShape(int24 lower, int24 upper, uint128 l0, int128 m)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
    {
        super._checkShape(lower, upper, l0, m);
    }

    function _rate(int24 t) internal pure override(FrontierBookBase, GeometricCurve) returns (uint256) {
        return super._rate(t);
    }

    function _uniformSpanValue(int24 a, int24 b, uint128 size, bool roundUp)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._uniformSpanValue(a, b, size, roundUp);
    }

    function _spanAmt1(Position storage p, int128 slope, int24 a, int24 b)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._spanAmt1(p, slope, a, b);
    }

    function _runAmounts(int24 e, int256 a0, int256 slope, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 out0, uint256 cost1)
    {
        return super._runAmounts(e, a0, slope, n);
    }

    function _bidRunAmounts(int24 e, int256 a0, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 in0, uint256 out1)
    {
        return super._bidRunAmounts(e, a0, n);
    }
}

/// @notice Maker-ops companion for geometric books (curve must match the
/// book's: cancels and requotes price spans with it).
contract GeometricMakerOps is FrontierMakerOps, GeometricCurve {
    constructor(
        address _token0,
        address _token1,
        int24 _tickSpacing,
        address _hooks,
        address _permissions,
        address _feeRecipient,
        uint16 _makerFeeBps,
        uint16 _takerFeeBps
    )
        FrontierMakerOps(
            _token0, _token1, _tickSpacing, _hooks, _permissions, _feeRecipient, _makerFeeBps, _takerFeeBps
        )
        GeometricCurve(_tickSpacing)
    {}

    // solc 6480 diamond-join boilerplate; every body dispatches to
    // GeometricCurve via super.
    function _checkShape(int24 lower, int24 upper, uint128 l0, int128 m)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
    {
        super._checkShape(lower, upper, l0, m);
    }

    function _rate(int24 t) internal pure override(FrontierBookBase, GeometricCurve) returns (uint256) {
        return super._rate(t);
    }

    function _uniformSpanValue(int24 a, int24 b, uint128 size, bool roundUp)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._uniformSpanValue(a, b, size, roundUp);
    }

    function _spanAmt1(Position storage p, int128 slope, int24 a, int24 b)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._spanAmt1(p, slope, a, b);
    }

    function _runAmounts(int24 e, int256 a0, int256 slope, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 out0, uint256 cost1)
    {
        return super._runAmounts(e, a0, slope, n);
    }

    function _bidRunAmounts(int24 e, int256 a0, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 in0, uint256 out1)
    {
        return super._bidRunAmounts(e, a0, n);
    }
}
