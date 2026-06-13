// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of the real Frontier orderbook the DarkBox PM layer
///         needs. Mirrors `FrontierGeoBookFactory` in the vendored Frontier
///         source (`lib/frontier/FrontierGeoBookFactory.sol`). The PM contracts
///         depend ONLY on this interface so they stay decoupled from Frontier
///         internals (curve math, deployers, hooks, etc.).
interface IFrontierGeoBookFactory {
    /// @notice Create a fee-configured geometric book for a (token0, token1) pair.
    /// @param token0 base asset (sold by asks / bought by bids) — the outcome token.
    /// @param token1 quote asset — synthetic USDC.
    function createGeoBookWithFees(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address book);

    function createGeoBook(address token0, address token1, int24 tickSpacing, int24 startTick)
        external
        returns (address book);

    function getBook(address token0, address token1, int24 tickSpacing) external view returns (address book);
    function defaultBook(address token0, address token1) external view returns (address book);
    function bookCount() external view returns (uint256);
}
