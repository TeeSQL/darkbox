# DarkBox Market Creation + Split/Join Contract Spec

Status: MVP contract specification for coding agents  
Scope: hidden-chain prediction market factory, binary outcome vault, split/join accounting, and Frontier CLOB integration  
Last updated: 2026-06-13

## 1. Purpose

DarkBox needs two closely related contract layers inside the hidden chain:

1. Market creation/factory contracts that define prediction markets, metadata, resolver rules, lifecycle state, and abuse controls.
2. Split/join contracts that turn collateral into tradable YES/NO outcome claims and later redeem or recombine those claims.

This document is the source of truth for those contracts. Coding agents should not invent a different market primitive without updating this spec.

## 2. Final MVP Decisions

- Market type: binary YES/NO markets.
- Collateral: hidden-chain synthetic USDC credit, backed 1:1 by public escrow deposits.
- Canonical market: hackathon winner market.
- Derivative markets: allowed if created through the factory and bounded by rules.
- Outcome primitive: fully collateralized YES/NO pair.
- Split: lock 1 USDC and mint 1 YES + 1 NO.
- Join: burn 1 YES + 1 NO and unlock 1 USDC before resolution.
- Redeem: after resolution, winning outcome tokens redeem 1:1 for USDC; losing outcome tokens redeem 0.
- Trading: YES and NO outcome tokens trade against USDC through Frontier books/wrappers.
- Void/nullification: ambiguous or abusive markets can be voided; outcome pairs become joinable/redeemable back to collateral according to the void policy.
- Public visibility: market metadata may be public if product chooses; orderbooks, per-agent balances, raw fills, and positions stay hidden until reveal.

Terminology note: this spec uses `join` for the inverse of `split`. Some protocols call this `merge`. Code may expose `join()` and alias `merge()` only if useful, but docs should standardize on split/join.

## 3. Contract Components

### 3.1 `DarkBoxMarketFactory`

Creates and tracks markets.

Responsibilities:

- validate market creation requests
- deploy or initialize market vaults/outcome tokens
- register resolver config
- enforce market creation fees/bonds/limits
- assign canonical `marketId`
- emit creation/lifecycle events for the indexer
- pause, void, or resolve markets through authorized resolver paths

### 3.2 `DarkBoxBinaryMarket`

One market-specific vault/controller.

Responsibilities:

- custody collateral for that market
- mint/burn YES and NO outcome claims
- enforce split/join/redeem lifecycle rules
- store market status and resolution outcome
- expose outcome token addresses/ids
- emit events required for indexer/reveal

Implementation choice:

- ERC-1155 is simplest for YES/NO token ids in one contract.
- ERC-20 per outcome may integrate more easily with some orderbooks.
- For Frontier, choose the shape that best matches its asset/book interface. If unsure, wrap ERC-1155 outcome ids into ERC-20-like adapters.

### 3.3 `OutcomeToken` or Outcome IDs

Each binary market has two claims:

- YES
- NO

Outcome tokens represent a claim on the collateral pool.

Invariants:

- Every minted YES has a paired minted NO at split time.
- Total paired claims cannot exceed locked collateral.
- Before resolution, one YES plus one NO can always join back into one USDC unless market is paused/frozen for incident handling.
- After resolution, only the winning side redeems for collateral.

### 3.4 `ResolverRegistry` or Resolver Config

Can be a separate registry or data stored in factory/market.

Responsibilities:

- declare who/what may resolve a market
- encode resolver template and source of truth
- prevent unauthorized resolution
- preserve enough metadata for reveal/replay

MVP can use an admin/manual resolver with strict metadata and events. More advanced oracle/attested resolvers are stretch.

## 4. Market Lifecycle

States:

```text
Draft -> Active -> Closed -> Resolved -> Settled
              \-> Paused
              \-> Voided
```

Recommended enum:

```solidity
enum MarketStatus {
    Draft,
    Active,
    Paused,
    Closed,
    Resolved,
    Voided
}
```

Meaning:

- `Draft`: created but not yet tradable, optional for MVP.
- `Active`: split/join/trading allowed.
- `Paused`: emergency stop; new split/trade should halt, joins may be allowed depending on incident.
- `Closed`: no new orders/splits after close time; resolution pending.
- `Resolved`: winning outcome is set; redemption allowed.
- `Voided`: market invalidated; collateral returned by void policy.

MVP can collapse `Draft` into immediate `Active` if simpler.

## 5. Market Creation

### 5.1 Creation Inputs

Suggested struct:

```solidity
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
```

Resolver config:

```solidity
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
```

For MVP:

- canonical winner market uses `CanonicalWinner` or `AdminManual`.
- derivatives usually use `AdminManual` with explicit `metadataURI` and source text.

### 5.2 Validation Rules

Factory must validate:

- game is in market-creation window
- creator is an active/funded agent or authorized coordinator
- question is non-empty and under max length
- metadata URI/hash is present
- close time is before or equal to game end unless explicitly allowed
- resolve-by time is reasonable
- resolver config is supported
- creator has enough collateral/bond if required
- creator has not exceeded market count limit
- exact duplicate question hash is not already active

Question hash:

```text
questionHash = keccak256(normalizedQuestion, resolverType, closeTime, metadataURI)
```

Do not rely only on raw string comparison; normalize casing/spacing for duplicate checks in the backend/indexer too.

### 5.3 Creation Fee/Bond

MVP options:

- fixed fee burned or paid to game treasury
- refundable bond returned if market resolves cleanly
- slashed bond if market is voided for ambiguity/spam

Recommended MVP:

- require a small creator bond in synthetic USDC
- lock it in the market
- return on valid resolution
- slash to treasury or prize pool if voided for creator fault

This discourages spam without overcomplicating economics.

### 5.4 Initial Liquidity

If `initialLiquidity > 0`, factory should split that amount into YES/NO for the creator or market-maker strategy.

Simple MVP:

- creator deposits `initialLiquidity`
- market mints YES+NO to creator
- creator/agent can then place one or both sides into Frontier books

Do not auto-place orders inside the factory unless Frontier integration makes that clean. Keep market creation and order placement as separate actions for clarity.

## 6. Split/Join Mechanics

### 6.1 Split

Definition:

```text
split(amount): USDC -> YES + NO
```

Behavior:

- caller transfers/locks `amount` USDC collateral into the market vault
- market mints `amount` YES claims and `amount` NO claims
- emit `Split(marketId, caller, amount)`

Suggested interface:

```solidity
function split(bytes32 marketId, uint256 amount, address receiver) external returns (uint256 yesAmount, uint256 noAmount);
```

Rules:

- market status must be `Active`
- amount must be > 0
- amount must respect collateral decimals
- receiver cannot be zero address
- caller must have approved/available synthetic USDC

### 6.2 Join

Definition:

```text
join(amount): YES + NO -> USDC
```

Behavior:

- caller burns `amount` YES and `amount` NO
- market releases `amount` USDC collateral
- emit `Joined(marketId, caller, amount)`

Suggested interface:

```solidity
function join(bytes32 marketId, uint256 amount, address receiver) external returns (uint256 collateralReturned);
```

Rules:

- allowed while market is `Active` or `Closed` but unresolved
- amount must be > 0
- caller must own at least amount YES and amount NO
- receiver cannot be zero address

Join should usually remain available after close but before resolution because it reduces risk and does not change directional exposure. If this creates resolver edge cases, freeze join at close and document why.

### 6.3 Redeem After Resolution

Definition:

```text
redeem(winningOutcome, amount): winning token -> USDC
```

Behavior:

- market must be `Resolved`
- caller burns winning outcome claims
- market releases equal USDC collateral
- losing outcome tokens cannot redeem
- emit `Redeemed(marketId, caller, outcome, amount)`

Suggested interface:

```solidity
function redeem(bytes32 marketId, Outcome outcome, uint256 amount, address receiver) external returns (uint256 collateralReturned);
```

Rules:

- outcome must equal resolved outcome
- amount > 0
- receiver not zero address
- market vault must have sufficient collateral

### 6.4 Void Redemption

If market is `Voided`, users must be able to recover fair collateral.

Recommended MVP void policy:

- paired YES+NO can join 1:1 as usual
- unpaired outcome claims redeem pro-rata from remaining collateral if needed
- if accounting is complex, restrict MVP voiding to markets before meaningful trading or require admin/indexer-assisted unwind at reveal

Cleaner MVP alternative:

- voided market resolves to `Invalid`
- YES and NO each redeem 0.5 USDC per full token

This is simple but changes incentives after trading. Use only if clearly documented.

Recommended for hackathon:

- prefer “join paired claims, cancel open orders, admin-assisted pro-rata settlement at reveal” for voided markets
- keep voiding rare

## 7. Frontier Integration

Frontier should handle order placement/matching. DarkBox market contracts handle collateral/outcome lifecycle.

For each binary market, create tradable instruments:

- YES/USDC book
- NO/USDC book

Possible integration patterns:

### Pattern A — ERC-20 Outcome Tokens

- deploy/mint ERC-20 YES token and ERC-20 NO token per market
- Frontier books trade each token against synthetic USDC

Pros:

- likely easiest for CLOB integrations expecting ERC-20 assets
- clear balances/allowances

Cons:

- many token contracts if many markets
- more deployment overhead

### Pattern B — ERC-1155 Outcome Claims + Adapter

- one market/vault contract mints ERC-1155 ids for YES/NO
- adapters expose ERC-20-like wrappers for Frontier books

Pros:

- cleaner native market accounting
- fewer contracts

Cons:

- adapter complexity
- possible integration risk

Recommendation:

- choose Pattern A if Frontier expects ERC-20s and hackathon speed matters
- choose Pattern B only if Frontier supports it cleanly or adapter already exists

## 8. Accounting Invariants

These invariants must hold in tests.

### Collateralization

Before resolution:

```text
vaultCollateral >= max(totalYESSupply, totalNOSupply)
```

For pure paired issuance with joins:

```text
totalYESSupply == totalNOSupply
vaultCollateral == totalYESSupply == totalNOSupply
```

This equality may diverge after outcome tokens trade between agents, but total supplies remain paired unless redemption/burn happens.

After resolution:

```text
vaultCollateral >= winningOutcomeSupply
```

After all winning tokens redeem:

```text
vaultCollateral == 0
winningOutcomeSupply == 0
```

### Conservation

For any successful split/join/redeem sequence:

```text
collateralLocked - collateralReleased == outstandingRedeemableClaim
```

### Lifecycle

- cannot split after close/resolution/void
- cannot redeem before resolution
- cannot resolve twice
- cannot change resolver config after activation except through explicit admin/governance event
- cannot create market after game market-creation deadline

### Authorization

- only authorized resolver can resolve
- only factory/coordinator can create canonical market if configured
- derivative creation requires active/funded agent or authorized coordinator
- emergency pause/void requires admin/resolver role and must emit reason

## 9. Events

Events are part of the product because the indexer/reveal pipeline depends on them.

Suggested events:

```solidity
event MarketCreated(
    bytes32 indexed gameId,
    bytes32 indexed marketId,
    address indexed creator,
    string question,
    string metadataURI,
    uint64 closeTime,
    uint64 resolveBy,
    ResolverType resolverType
);

event MarketActivated(bytes32 indexed marketId);
event MarketPaused(bytes32 indexed marketId, string reason);
event MarketClosed(bytes32 indexed marketId);
event MarketResolved(bytes32 indexed marketId, Outcome outcome, bytes32 resolutionHash);
event MarketVoided(bytes32 indexed marketId, string reason, bytes32 evidenceHash);

event Split(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount);
event Joined(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount);
event Redeemed(bytes32 indexed marketId, address indexed caller, address indexed receiver, Outcome outcome, uint256 amount);

event CreatorBondLocked(bytes32 indexed marketId, address indexed creator, uint256 amount);
event CreatorBondReturned(bytes32 indexed marketId, address indexed creator, uint256 amount);
event CreatorBondSlashed(bytes32 indexed marketId, address indexed creator, uint256 amount, string reason);
```

Keep event fields stable because coding agents will build indexer schemas from them.

## 10. Suggested Solidity Interfaces

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

interface IDarkBoxMarketFactory {
    function createMarket(CreateMarketParams calldata params) external returns (bytes32 marketId, address market);
    function pauseMarket(bytes32 marketId, string calldata reason) external;
    function closeMarket(bytes32 marketId) external;
    function resolveMarket(bytes32 marketId, Outcome outcome, bytes32 resolutionHash) external;
    function voidMarket(bytes32 marketId, string calldata reason, bytes32 evidenceHash) external;
    function getMarket(bytes32 marketId) external view returns (address market);
}

interface IDarkBoxBinaryMarket {
    function split(uint256 amount, address receiver) external returns (uint256 yesAmount, uint256 noAmount);
    function join(uint256 amount, address receiver) external returns (uint256 collateralReturned);
    function redeem(Outcome outcome, uint256 amount, address receiver) external returns (uint256 collateralReturned);
    function status() external view returns (MarketStatus);
    function resolvedOutcome() external view returns (Outcome);
    function collateralToken() external view returns (address);
    function yesToken() external view returns (address);
    function noToken() external view returns (address);
}
```

## 11. Indexer Requirements

The indexer must track:

- market creation parameters
- resolver config
- lifecycle state
- outcome token addresses/ids
- split events
- join events
- redemption events
- creator bonds
- Frontier book ids for YES/USDC and NO/USDC
- orders/fills linked to market/outcome
- void/resolution evidence hashes

Public indexer may expose:

- market list/metadata if product chooses
- market status
- aggregate activity stats
- reveal status

Public indexer must not expose before reveal:

- orderbook depth
- raw fills
- per-agent positions
- per-agent balances
- per-agent/per-market PnL

## 12. Test Plan

Contract tests should cover:

- create valid canonical market
- create valid derivative market
- reject duplicate/invalid market creation
- enforce market creation window
- enforce creator bond/fee
- split mints equal YES/NO and locks collateral
- join burns equal YES/NO and releases collateral
- cannot split after close/resolution/void
- cannot redeem before resolution
- resolve YES and redeem YES only
- resolve NO and redeem NO only
- cannot resolve twice
- void market path emits reason/evidence
- unauthorized resolver/admin calls fail
- event fields are emitted correctly
- indexer fixture can reconstruct market state from events

Property-style invariants:

- collateral never becomes underfunded
- total YES supply equals total NO supply before redemption, excluding burns from joins
- user cannot extract more collateral than deposited plus valid winnings
- lifecycle transitions are one-way except explicit pause/unpause if implemented

## 13. Open Implementation Choices

These should be resolved by the coding agent after checking Frontier’s exact asset interface:

- ERC-20 per outcome vs ERC-1155 with adapters.
- Whether `DarkBoxBinaryMarket` is deployed per market or uses minimal proxies/clones.
- Whether factory auto-creates Frontier books or a coordinator/indexer registers them after market creation.
- Exact creator bond amount.
- Exact void policy for already-traded markets.

Default recommendation:

- use ERC-20 YES/NO outcome tokens per market for fastest Frontier compatibility
- use minimal proxies if deployment cost matters
- keep order placement separate from market creation
- implement strict events first so indexer/reveal can be built reliably

## Resolution Scope and Market Grammar

DarkBox intentionally keeps resolution offchain. `resolver_type` is an admin-agent policy, not an onchain oracle integration. The admin agent resolves markets from inspectable data and writes a resolution dossier; contracts/state only need the final outcome plus a dossier identifier/hash.

Agent-generated markets should be constrained to facts that resolve from one of three sources:

1. ETHGlobal submitted-project dataset.
2. Daemonhall indexed platform metrics.
3. Fran/admin-provided finalist or winner lists, because ETHGlobal does not expose finalists.

Markets outside those sources must be rejected or explicitly marked `AdminManual`.

Allowed ETHGlobal market families:

- Sponsor popularity: `count(projects mentioning Sponsor X) >= N`.
- Submitted project totals: `count(projects) >= N`.
- Solo hacker/team-count markets only if ETHGlobal exposes team/member counts reliably.
- Sponsor combo markets: `count(projects mentioning all/any of X,Y,Z) >= N`.
- Finalist/winner markets only through manual finalist/winner input.

Allowed Daemonhall market families:

- Registered users/daemons.
- Deposits/cash in game.
- Posted liquidity.
- Trade count.
- Total volume.
- Number of markets created.
- Number of active agents.
- Deterministic leaderboard/rank-change metrics.

Rejected unless explicitly `AdminManual`:

- Subjective quality: best UX, most innovative, judges impressed, funniest demo.
- Private/social evidence: Discord vibes, Twitter chatter, judge opinions.
- “Uses X meaningfully” unless “meaningfully” is defined as concrete ETHGlobal fields/terms.

Each resolvable market must define:

- `resolverType`
- source dataset/metric
- exact count/filter rule
- threshold/operator
- `earlyYes` / `earlyNo` behavior
- final cutoff time for NO decisions
- fallback behavior if data is unavailable or ambiguous

## Resolution Dossiers

The admin resolver produces a resolution dossier before settling a market. A dossier contains:

- market id and question
- resolver type
- source (`ethglobal:<event>` or `daemonhall:indexer`)
- exact rule
- snapshot/fetched timestamp
- matched project UUIDs/slugs/names when ETHGlobal is used
- observed metric/count
- source snapshot hash
- outcome (`YES`, `NO`, or `INVALID`)
- confidence and ambiguity notes

Resolution dossiers are audit artifacts. They do not need to be verified onchain, but they must be inspectable and reproducible enough for admin review.

## 15-Minute Resolution Loop

The ETHGlobal watcher runs every 15 minutes:

1. Fetch the latest ETHGlobal submitted-project dataset.
2. Store compact/raw snapshots under `data/ethglobal/<event>/`.
3. POST the hidden indexer internal endpoint `/internal/resolution/check?event=<event>`.
4. The indexer evaluates open markets with resolver configs against the fresh dataset and Daemonhall metrics.
5. If a market resolves, the indexer records the dossier, marks the market resolved/voided, closes open orders, and triggers settlement/payout accounting.

For threshold count markets, YES may resolve early once the dataset proves the threshold. NO should usually wait until the submission/update window has passed. Finalist/winner markets wait for Fran/admin input because ETHGlobal does not expose finalists.
