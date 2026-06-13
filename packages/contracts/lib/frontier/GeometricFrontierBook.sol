// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FrontierBookBase} from "./FrontierBookBase.sol";
import {UniformFrontierBook} from "./UniformFrontierBook.sol";
import {UniformMakerOps} from "./UniformMakerOps.sol";
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
/// Uniform-only by construction: this mixin sits on top of the uniform-curve
/// book/ops (UniformFrontierBook / UniformMakerOps), which carry no shaped
/// ladder (slope) machinery at all. The arithmetico-geometric value sums of a
/// sloped ladder do not telescope cleanly under this curve, so shapes never
/// belonged here; the deployed geometric runtime therefore links no slope
/// arithmetic, no second-order frontierSlope roll, no _positionSlope, and
/// exposes no depositShaped / requoteShaped surface. Approximate a shape with
/// a few uniform ladders instead.
///
/// A mixin (not a concrete book) so the EIP-170 pair — the deployed book
/// and its delegatecalled maker-ops companion — share one implementation of
/// the curve overrides. The concrete contracts below carry solc's required
/// diamond-join boilerplate (6480): each re-override is a plain `super`
/// dispatch that resolves to this mixin.
abstract contract GeometricCurve is FrontierBookBase {
    /// P(tickSpacing) - 1e18: the shared span denominator.
    uint256 public immutable geoD;

    constructor(int24 _tickSpacing) {
        geoD = GeoTickMath.powX18(_tickSpacing) - 1e18;
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

    /// @dev Uniform ask claim span (floor), geometric curve.
    function _askSpan(Position storage p, int24 a, int24 b) internal view virtual override returns (uint256) {
        return _geoSpan(a, b, p.liquidity, false);
    }

    /// @dev Uniform ask run [e, e+n*s): token0 sold and token1 collected
    /// (ceil), geometric curve.
    function _askRun(int24 e, int256 a0, uint256 n)
        internal
        view
        virtual
        override
        returns (uint256 out0, uint256 cost1)
    {
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

/// @notice The deployable geometric-curve book (uniform-only).
contract GeometricFrontierBook is UniformFrontierBook, GeometricCurve {
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
        UniformFrontierBook(
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

    function _askSpan(Position storage p, int24 a, int24 b)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._askSpan(p, a, b);
    }

    function _askRun(int24 e, int256 a0, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 out0, uint256 cost1)
    {
        return super._askRun(e, a0, n);
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
/// book's: cancels and requotes price spans with it). Uniform-only.
contract GeometricMakerOps is UniformMakerOps, GeometricCurve {
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
        UniformMakerOps(
            _token0, _token1, _tickSpacing, _hooks, _permissions, _feeRecipient, _makerFeeBps, _takerFeeBps
        )
        GeometricCurve(_tickSpacing)
    {}

    // solc 6480 diamond-join boilerplate; every body dispatches to
    // GeometricCurve via super.
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

    function _askSpan(Position storage p, int24 a, int24 b)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256)
    {
        return super._askSpan(p, a, b);
    }

    function _askRun(int24 e, int256 a0, uint256 n)
        internal
        view
        override(FrontierBookBase, GeometricCurve)
        returns (uint256 out0, uint256 cost1)
    {
        return super._askRun(e, a0, n);
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
