# @darkbox/resolution-executor

A private-mesh CVM worker that **executes** already-approved admin market
resolutions **on-chain**. It mirrors `services/market-executor` (which executes
approved market *creations*) and the `services/bridge` viem/service pattern.

> **It does not decide outcomes.** It only executes explicit, already-approved
> decisions. The coordinator/admin key is loaded from sealed env and is **never
> logged**.

## What it does

A poll loop:

1. `getPendingResolutions()` — pull approved, not-yet-executed resolutions from
   the decision source.
2. For each, **validate** the outcome (safety gate), **skip** if the market is
   already resolved on-chain (idempotency), otherwise **resolve on-chain to the
   EXPLICIT outcome**, then `markResolved(txHash)`.
3. A per-item error → `markFailed(error)`; the loop continues to the next item.

### Safety

- Only an **explicit, valid** outcome is executed:
  `resolveMarket` ⇒ `Yes`/`No`, `voidMarket` ⇒ `Invalid`, `closeMarket` ⇒ no
  outcome.
- A **missing / ambiguous / mismatched** outcome is **SKIPPED and flagged**
  (via `markFailed`) — never inferred, never defaulted, never resolved.
- **Idempotent**: before sending a tx we read the market's on-chain `status()`;
  an already-`Resolved`/`Voided` market is marked done with `txHash = null` and
  no second tx is sent.

## On-chain primitive

Resolution is **factory-gated** — the market's own `resolve`/`voidMarket` are
`onlyFactory`, so the worker calls the admin entrypoints on
`DarkBoxMarketFactory`:

| intent          | factory call                                              | effect                          |
| --------------- | --------------------------------------------------------- | ------------------------------- |
| `resolveMarket` | `resolveMarket(marketId, outcome, resolutionHash)`        | `market.resolve(...)` (Yes/No)  |
| `voidMarket`    | `voidMarket(marketId, reason, evidenceHash)`              | `market.voidMarket(...)` (Invalid) |
| `closeMarket`   | `closeMarket(marketId)`                                   | `market.close()` (no outcome)   |

The factory authorizes the caller as the `owner` or the market's configured
`resolver` (pinned to `AdminManual` + owner at creation). `Outcome` enum:
`Unset=0, Yes=1, No=2, Invalid=3`. Each call simulates → writes → waits for the
receipt.

## Decision source (PR #22 seam)

The decisions come from **Ocean's market-closing lane (PR #22)**, which writes
`market_lifecycle_actions` rows carrying an `onchain_intent`
(`{ type, outcome? }`). #22 is **not merged to `main` yet**, so the executor only
ever talks to an abstracted `DecisionSource` interface:

```ts
getPendingResolutions(): Promise<{ marketId, marketAddress, intentType, outcome }[]>
markResolved(marketId, { txHash }): Promise<void>
markFailed(marketId, error): Promise<void>
```

`HttpDecisionSource` is a **provisional** wiring matching the documented #22
contract — swap/adjust it when #22 lands; nothing else changes:

- Poll: `GET /internal/markets?action_type=prepare_resolution&pending=true`
  (equivalently `market_lifecycle_actions WHERE action_type='prepare_resolution'
  AND tx_hash IS NULL`).
- Complete: `POST /internal/markets/:id/complete-resolution`
  `{ actorId, actorRole: 'admin', txHash }`.
- Failure: `POST /internal/markets/:id/resolution-failed`
  `{ actorId, actorRole: 'admin', error }`.

## Config (env)

| var                     | default                          | notes                                   |
| ----------------------- | -------------------------------- | --------------------------------------- |
| `HIDDEN_RPC_URL`        | `http://localhost:8545`          | hidden-chain RPC                        |
| `HIDDEN_CHAIN_ID`       | `88813`                          |                                         |
| `MARKET_FACTORY_ADDRESS`| —  (**required**)                | `DarkBoxMarketFactory`                  |
| `COORDINATOR_PRIVATE_KEY`| — (**required**, sealed)        | factory owner/resolver key — never logged |
| `INDEXER_INTERNAL_URL`  | `http://localhost:8080/internal` | decision-source base URL                |
| `POLL_INTERVAL_MS`      | `8000`                           |                                         |
| `RESOLUTION_ACTOR_ID`   | `resolution-executor`            | recorded on complete-resolution         |

## Develop

```sh
pnpm --filter @darkbox/resolution-executor typecheck
pnpm --filter @darkbox/resolution-executor test
pnpm --filter @darkbox/resolution-executor dev   # runs the poll loop
```
