// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared enums/structs for the DarkBox prediction-market layer.
///         Mirrors `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md` §10.

enum Outcome {
    Unset,
    Yes,
    No,
    Invalid
}

enum MarketStatus {
    Draft,
    Active,
    Paused,
    Closed,
    Resolved,
    Voided
}

enum ResolverType {
    AdminManual,
    CanonicalWinner,
    DependentMarket,
    ExternalAttested,
    VoidOnly
}

struct ResolverConfig {
    ResolverType resolverType;
    address resolver;
    bytes32 sourceId;
    bytes data;
}

struct CreateMarketParams {
    bytes32 gameId;
    string question;
    string description;
    string metadataURI;
    ResolverConfig resolver;
    uint64 closeTime;
    uint64 resolveBy;
    uint256 creatorBond;
    uint256 initialLiquidity;
}
