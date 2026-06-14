# @darkbox/market-executor

A private-mesh worker (TypeScript + viem, modeled on `services/bridge`) that turns
**APPROVED** market proposals into live on-chain DarkBox markets.

## What it does

Poll loop (`POLL_INTERVAL_MS`, default 8s):

1. `GET /internal/market-proposals?status=approved` from the indexer.
2. For each proposal, build `CreateMarketParams` and call the hidden-chain
   `DarkBoxMarketFactory.createMarket` (admin/coordinator-gated), signed by the
   **coordinator key**.
3. Parse the receipt for the `MarketCreated` (marketId + market address) and
   `BooksRegistered` (YES/NO books + tokens) events. If `BooksRegistered` is
   missing from the receipt it falls back to the `getBooks(marketId)` view.
4. Write the result back to the indexer: the proposal flips to `deployed` and a
   `markets` row is inserted (one transaction).

**Idempotency** is by `question` (the factory's on-chain duplicate guard keys off
`gameId + question + resolverType + closeTime + metadataURI`). Before sending a
tx the executor calls `findExistingMarketByQuestion(gameId, question)` — a
`getLogs` scan of `MarketCreated` filtered by `gameId`, matched on the exact
question string. If a market already exists (e.g. the process crashed after the
tx but before the write-back), it **recovers**: it writes the result back without
sending a second tx. A factory revert or indexer error for one proposal marks it
`deploy_failed` and the loop continues — it never crashes.

### createMarket params (what the lead should sanity-check)

- `gameId` = `GAME_ID` (config).
- `question` / `description` = from the proposal.
- `metadataURI` = the proposal's `metadata_uri`, or a deterministic
  `darkbox:proposal:<proposal_id>` fallback (the factory reverts on **empty**
  metadata).
- `resolver` = `{ AdminManual, resolver: coordinatorAddress, sourceId:
  keccak256(resolution_source || "admin"), data: 0x }`. NOTE: the factory pins
  the *real* market resolver to `AdminManual` + the factory **owner** regardless
  of what we pass, but `_validate` reverts unless `resolverType == AdminManual`,
  so we must still send a valid config.
- `closeTime` = `CLOSE_TIME_OVERRIDE_UNIX` if set, else the **next Sunday 17:00
  America/New_York** (demo is June → EDT = UTC-4, i.e. 21:00 UTC). `resolveBy` =
  `closeTime + 24h`.
- `creatorBond` / `initialLiquidity` = config (default 0). The factory ignores
  `creatorBond` (proposal approval is the gate); `initialLiquidity > 0` would
  make the factory pull collateral from the coordinator, so it defaults to 0.

## Security

The **coordinator private key** (`COORDINATOR_PRIVATE_KEY`) is read from sealed
env only. It is never hardcoded, logged, echoed, or written to disk — only the
derived coordinator **address** is logged. This is the factory owner/coordinator
and the sUSDC minter.

## Environment

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `HIDDEN_RPC_URL` | no | `http://localhost:8545` | Hidden-chain JSON-RPC. |
| `HIDDEN_CHAIN_ID` | no | `88813` | Hidden-chain id. |
| `MARKET_FACTORY_ADDRESS` | **yes** | — | `DarkBoxMarketFactory` address. |
| `GAME_ID` | **yes** | — | bytes32 game id. |
| `COORDINATOR_PRIVATE_KEY` | **yes** | — | `0x…` factory owner/coordinator + minter. **Never logged.** |
| `INDEXER_INTERNAL_URL` | no | `http://localhost:8080/internal` | Indexer internal base (no trailing slash). |
| `POLL_INTERVAL_MS` | no | `8000` | Poll cadence. |
| `CREATOR_BOND` | no | `0` | uint, micro-USDC. |
| `INITIAL_LIQUIDITY` | no | `0` | uint, micro-USDC; >0 pulls collateral from the coordinator. |
| `CLOSE_TIME_OVERRIDE_UNIX` | no | — | Force a fixed market close time (unix s). |

## New indexer endpoints (added by this change)

Both are internal-only (`services/indexer/src/routes/internal.ts`), mirroring the
existing `market-proposals` routes. Migration `005_market_executor.sql` adds the
`market_id`, `deploy_tx_hash`, `deploy_error`, `deployed_at` columns to
`market_proposals` (the `status` column is free-text, so `deployed` /
`deploy_failed` need no enum change).

- `POST /internal/market-proposals/:proposalId/deployed`
  body `{ marketId, marketAddress, yesBook, noBook, yesToken, noToken, txHash, creatorAddress }`
  → in one transaction: UPDATE the proposal to `status='deployed'` (+ market_id,
  deploy_tx_hash, deployed_at) AND INSERT the `markets` row
  (`game_id` from the indexer's `GAME_ID`, `creator_address` = the executor's
  coordinator, `resolver_type='AdminManual'`, `status='Active'`). Insert is
  `ON CONFLICT (market_id) DO NOTHING` so re-posting is a no-op.
- `POST /internal/market-proposals/:proposalId/deploy-failed` body `{ error }`
  → `status='deploy_failed'` (+ deploy_error).

## Deploy (FROZEN — do not deploy yet)

Deploys are currently frozen; the live composes were intentionally **not**
edited. When the freeze lifts, add a `market-executor` service to the AttestMesh
core compose alongside the other private-mesh workers:

```yaml
# market-executor:
#   build:
#     context: .
#     dockerfile: services/market-executor/Dockerfile
#   restart: unless-stopped
#   mem_limit: 512m
#   network_mode: "service:sidecar"   # runs on the private mesh, behind the sidecar
#   environment:
#     HIDDEN_RPC_URL: http://localhost:8545
#     HIDDEN_CHAIN_ID: "88813"
#     MARKET_FACTORY_ADDRESS: "0x…"           # deployed DarkBoxMarketFactory
#     GAME_ID: "0x…"
#     INDEXER_INTERNAL_URL: http://localhost:8080/internal
#     # COORDINATOR_PRIVATE_KEY is injected from the SEALED env, never inline here.
```

It runs on the private mesh, reads the **sealed** coordinator key, and reaches
the indexer + hidden-chain RPC over the sidecar network.
