# Event-driven Python agents architecture

This prototype replaces LLM-per-turn execution with a split-brain design.

## Why

LLM-per-turn is useful for strategy discovery, but too slow and expensive for live market microstructure. The production loop should let code handle routine reactions and reserve intelligence for strategy changes.

## Flow

1. A market/user event arrives.
2. Event dispatcher loads:
   - event payload
   - current observation/orderbook/portfolio snapshot
   - owner -> daemon binding registry
   - daemon identity manifest
   - daemon policy JSON
3. Deterministic Python policy emits executor intents.
4. Executor adapter signs with the per-daemon key and submits to Frontier.
5. Indexer emits fills/position updates; those become future events.
6. Intelligence is invoked only when a user whisper, market creation, or major signal update should modify policy.

## Intelligence output

The LLM should write policy JSON, not direct transaction calls:

```json
{
  "enabled": true,
  "fairValues": {"market-finalist": 0.62},
  "marketBias": {"market-blink": 0.04},
  "maxOrderSize": 3,
  "maxPositionSize": 20,
  "minEdgeToTake": 0.08,
  "quoteSpread": 0.08,
  "takeProfitEdge": 0.10,
  "preferredMarkets": [],
  "bannedMarkets": [],
  "billboardStyle": "cryptic liquidity ad"
}
```

## Executor guardrails

Executor must reject an action unless all are true:

- `owner-daemon-bindings.json` has an active row for `gameId + owner + agentId`.
- row daemon address matches `agent-identities.json` for that `agentId`.
- row shadow account matches the bridge/indexer `AgentRegistered` event.
- action id has not already been submitted.
- action respects policy/risk limits.

## Non-trading action policy (`event_agents/policy.py`)

Dan's `strategy.decide` gates **trading** via risk limits. The two outward-facing
free-text surfaces — **billboards** and **market proposals** — are gated by a
separate deterministic, pure policy that persists per-agent state across events
(`--state-file`), so cooldowns and budgets hold over the event loop.

### Billboards

Posted only when **(a)** at least one bounded trigger fired this event —
`trade_action` (a real make/take/cancel/split/merge/claim/update this event),
`rival_response` (another agent posted since last event), `market_live` (a
not-previously-seen market is open), or `periodic` (heartbeat after
`billboard_periodic_events`) — **and (b)** the agent is past
`billboard_cooldown_events` (hard rate limit ⇒ never a billboard every event)
**and (c)** the message survives sanitization. Sanitization **rejects** (never
partially strips) any message containing an EVM address, long hex secret,
`shadow_account`, private key/seed phrase, `v0:book:` address, `PORTFOLIO` /
`TAKE_PROFIT_SIGNALS`, `avgEntry`/`realizedPnl`/`unrealizedPnl`, balance
internals, or a structured private-book JSON dump. One billboard per event is
structural.

### Market proposals

Enter the **admin queue** (`market_proposals`, status `proposed`) only when, in
order: within `proposal_budget_per_agent`; past `proposal_cooldown_events`;
outcomes exactly `["YES","NO"]`; a non-empty resolution source; a `resolveBy`
that is present, parseable, and in the future; not a normalized duplicate of any
live market, queued proposal, or the agent's own prior proposals; and classified
**resolvable** by the market grammar (subjective and unmatched-objective
questions are rejected). Candidate questions come from the event payload
(`proposalCandidate`) or the agent's `proposalCandidates` policy list.

### Admin-queue-only invariant

The policy never authorizes market creation, and the indexer agent-turn path
writes proposals **only** to the queue with status `proposed` — it never inserts
a `markets` row from a proposal. Turning an approved proposal into an on-chain
market is the separate admin-gated step (market-approval bot →
`/internal/market-proposals/:id/decision` → operator factory deploy).

## Reconciliation adapter (`event_agents/indexer_adapter.py`)

With `--submit-url`, each decision is mapped onto `/internal/v0/agent-turns` so
the indexer reconciles the resulting orders / billboards / proposals (and fills
once on-chain execution lands). The indexer re-runs billboard sanitization,
proposal de-duplication, and the admin-queue-only write as a trust boundary
(`packages/shared/src/billboardSanitizer.ts`) — it must be safe against any
client, not just the blessed runner.

## CVM safety boundaries

Target platform is **Phala / AttestMesh** (`deploy/attestmesh/*.yaml`).

- **Public:** policy-passing billboards; markets / public book tops / leaderboard
  (already `stripForbidden` on `/public/*`); approved market questions.
- **Hidden (never leaves the CVM):** shadow accounts, owner/daemon private keys,
  per-agent private book (positions, sizes, avg entry, PnL, cash/equity), raw
  orderbook dumps, `v0:book:*` ids, instruction/runtime/reveal hashes. Enforced
  by the billboard sanitizer (agent + indexer) and by not host-publishing
  `/internal/*`.
- **Safe to deploy now:** the deterministic policy, the dry-run decider, the
  indexer reconciliation + defense-in-depth, the admin approval gate.
- **Remaining blockers:** (1) on-chain order submission is still dry-run — a
  signed per-daemon Frontier executor must be wired before real value (step 4 of
  the flow above); (2) approved-proposal → market deploy stays manual/admin by
  design; (3) agent trading keys must be CVM secrets (today gitignored,
  demo-only — see `docs/security/KEY_ROLE_INVENTORY.md`); (4) the LLM policy
  author is an external call — keep treating model/policy output as adversarial.

## Tests & evidence

- `tests/agents/test_event_agents.py` — Dan's trading unit tests (unchanged).
- `tests/agents/test_event_agents_policy.py` — 28 unit tests: billboard
  triggers / cooldown loop / sanitization, proposal resolvability / duplicate /
  cooldown / budget / admin-queue-only, strategy integration, adapter mapping.
- `packages/shared/test/billboardSanitizer.test.ts` — TS sanitizer parity.
- `scripts/run-event-agents-indexer-smoke.sh` — Python runner → real Postgres +
  indexer: reconciles a make_order + billboard + proposal, drops a duplicate
  proposal and a leaking billboard, asserts the admin-queue-only invariant.

## Current branch status

Deterministic Python modules under `services/agents/event_agents/` with the
non-trading policy, persistent state, and indexer reconciliation. On-chain
signing remains dry-run. The TypeScript LLM runner is untouched.
