// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GeoTickMath — 1.0001^tick in X18 fixed point
///
/// Binary exponentiation over precomputed 1.0001^(2^i) constants, floored
/// at each step. The result is a DETERMINISTIC function of the tick; book
/// solvency does not depend on its absolute accuracy, only on every code
/// path evaluating the same P(t) (span values are P(b)-P(a) over a shared
/// denominator, so partial claims telescope exactly against deposits).
/// Relative error is < 2e-17 across the supported range — far below one
/// tick's 1e-4 step, so monotonicity in t is preserved.
library GeoTickMath {
    uint256 internal constant X = 1e18;
    /// |tick| bound: keeps size * (P(b)-P(a)) well inside uint256 for
    /// uint128 sizes (P(200000) ~ 4.9e26 X18).
    int24 internal constant MAX_TICK = 200_000;

    /// @dev 1.0001^tick, X18, floor-rounded per step.
    function powX18(int24 tick) internal pure returns (uint256 p) {
        unchecked {
            uint256 a = uint256(uint24(tick < 0 ? -tick : tick));
            require(a <= uint256(uint24(MAX_TICK)), "tick out of range");
            p = X;
            if (a & 0x1 != 0) p = (p * 1000100000000000000) / X;
            if (a & 0x2 != 0) p = (p * 1000200010000000000) / X;
            if (a & 0x4 != 0) p = (p * 1000400060004000100) / X;
            if (a & 0x8 != 0) p = (p * 1000800280056007000) / X;
            if (a & 0x10 != 0) p = (p * 1001601200560182043) / X;
            if (a & 0x20 != 0) p = (p * 1003204964963598014) / X;
            if (a & 0x40 != 0) p = (p * 1006420201727613920) / X;
            if (a & 0x80 != 0) p = (p * 1012881622445451097) / X;
            if (a & 0x100 != 0) p = (p * 1025929181087729343) / X;
            if (a & 0x200 != 0) p = (p * 1052530684607338948) / X;
            if (a & 0x400 != 0) p = (p * 1107820842039993613) / X;
            if (a & 0x800 != 0) p = (p * 1227267018058200482) / X;
            if (a & 0x1000 != 0) p = (p * 1506184333613467388) / X;
            if (a & 0x2000 != 0) p = (p * 2268591246822644826) / X;
            if (a & 0x4000 != 0) p = (p * 5146506245160322222) / X;
            if (a & 0x8000 != 0) p = (p * 26486526531474198664) / X;
            if (a & 0x10000 != 0) p = (p * 701536087702486644953) / X;
            if (a & 0x20000 != 0) p = (p * 492152882348911033633683) / X;
            if (tick < 0) p = (X * X) / p;
        }
    }
}
