// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Common interface for the production candidate and the reference
/// model so differential fuzz tests can drive both identically.
interface IRangeOrderBook {
    /// @notice Place a sell-token0 order over [lower, upper). `liquidity` is
    /// the amount of token0 sold per tick-spacing interval.
    function deposit(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 positionId);

    /// @notice Move the market price. Upward moves consume fully-crossed
    /// intervals: the caller (the "market") receives the consumed token0
    /// principal and pays in the token1 proceeds. Downward moves fill nothing.
    function moveTickTo(int24 newTick) external;

    /// @notice Pay out proceeds for intervals consumed since this position's
    /// deposit that have not been claimed yet.
    function claim(uint256 positionId) external returns (uint256 proceeds1);

    /// @notice Claim everything owed, return unfilled principal, and
    /// permanently retire the position.
    function cancel(uint256 positionId) external returns (uint256 proceeds1, uint256 principal0);

    function currentTick() external view returns (int24);

    /// @notice Aggregate live (unconsumed) sell liquidity in the interval
    /// whose lower tick is `lowerTick`.
    function activeLiquidity(int24 lowerTick) external view returns (uint128);

    /// @notice token1 the position could claim right now.
    function claimable(uint256 positionId) external view returns (uint256);

    /// @notice token0 principal still live (unconsumed) for the position.
    function unfilledPrincipal(uint256 positionId) external view returns (uint256);

    /// @notice True if this position's eligibility for the given interval has
    /// been consumed (filled for this position, whether or not yet claimed).
    function isConsumedFor(uint256 positionId, int24 lowerTick) external view returns (bool);
}
