# Indexer PnL Blockers

Current status: deterministic maker/taker/split/join/redeem/cancel coverage
exists in `test/pnl-acceptance.test.ts`. The indexer can now materialize exact
snapshot and public leaderboard PnL for direct Frontier taker transactions by
attaching `tx.from` to each normalized log.

Remaining blockers for claiming production-grade PnL across all live trading:

1. Router/executor taker attribution may require an explicit policy. For direct
   Frontier transactions, `tx.from` is the taker and is resolved through
   `agents.owner_address` to `shadow_account`. If a router, batch executor, or
   delegated account submits Frontier sweeps on behalf of an agent, `tx.from`
   will identify the router/executor rather than the economic taker unless that
   address is registered as the owner or the router emits/passes agent identity.

   Required router contract: either submit directly from the agent owner/shadow
   execution address, or emit a same-transaction agent/taker identity event that
   the indexer can correlate to Frontier fills.

2. Requote and position transfer accounting is not implemented in the reducer.
   The current ABI exposes `Requote(positionId, lower, upper, liquidity)` and
   `PositionTransferred(positionId, from, to)`, but the reducer does not update
   order owner/shadow attribution or locked-liquidity state from those events.

   Required reducer behavior: on transfer, remap the order to the new owner and
   shadow account before later claim/cancel events; on requote, update order
   ticks/liquidity without changing owned positions or realized PnL.

3. Exact multi-level `RunFilled` notional reconstruction needs persisted book
   tick spacing and Frontier amount replay. The reducer can attribute direct
   one-level taker sweeps through `tx.from`, and latest market marks use the
   Frontier geometric tick price (`1.0001^tick`) from real fill events. For
   multi-level runs, the event fields (`fromLevel`, `toBoundary`, `startSize`,
   `slopePerLevel`) must be replayed with the book's tick spacing and Frontier
   run formulas before claiming exact taker quantity/cost basis for all sweeps.

Public leaderboard fields: `equity` and `netDeposits` are retained because the
public product requirement is rank/PnL visibility, and these values are already
aggregated at public agent level without exposing `shadow_account`, balances,
orders, fills, or per-market positions. If the product privacy boundary changes
to hide capital base or marked equity, remove those fields from
`toPublicLeaderboardEntry` and `/public/leaderboard`.

## Deployment follow-up

This indexer/PnL version must be redeployed after merge to:

- the local DevNet / live Anvil indexer stack used for demos
- the CVM / AttestMesh DarkBox deployment

The deployment must run migrations `003_mark_to_market_pnl.sql` and
`004_raw_events_tx_from.sql`, then restart the indexer so new poll cycles attach
`tx_from` and direct taker fills can be attributed to `agents.owner_address`.
