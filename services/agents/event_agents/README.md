# Event-driven Python agents prototype

This branch prototypes Dan's split-brain architecture:

- **Intelligence path:** updates JSON policies when a user whisper arrives, a new market is created, or a major external signal changes.
- **Execution path:** deterministic Python agents run on every market event and output validated executor intents quickly.

The Python runner is deliberately dry-run for **on-chain signing**. It produces action JSON with `actionId`, daemon wallet, and shadow account metadata; a later executor adapter signs/submits these to Frontier with the matching daemon key. **Indexer reconciliation is wired** (`--submit-url`): each decision is POSTed to `/internal/v0/agent-turns` so the indexer reconciles orders / billboards / proposals.

## Non-trading action policy (`policy.py`)

Trading is gated by the risk limits below; the two outward-facing free-text
surfaces are gated by `policy.py` (deterministic, pure, persisted across events
via `--state-file`). See `docs/agents/event-driven-python-agents.md`.

- **Billboards** post only on a bounded trigger (a meaningful trade action this
  event, a rival billboard to respond to, a newly-live market, or a periodic
  heartbeat), at most once per cooldown window (never every event), and are
  **sanitized** — any message leaking an address / shadow account / key / book
  address / portfolio or PnL internals is dropped.
- **Market proposals** are emitted only for an objectively-resolvable YES/NO
  question (ported market-resolution grammar) with a resolution source and a
  future date, after duplicate / per-agent cooldown / budget checks. They enter
  the **admin approval queue only** and never auto-create an on-chain market.

## Run one event (with state + reconciliation)

```bash
python -m services.agents.event_agents.runner \
  --event /tmp/event.json --observation /tmp/observation.json \
  --agent murmur --state-file /tmp/agent-state.json \
  --submit-url http://127.0.0.1:8080 --run-id demo --out -
```

End-to-end reconciliation smoke: `scripts/run-event-agents-indexer-smoke.sh`.

## Inputs

- `services/agents/config/agent-identities.json`: public daemon identity manifest.
- `services/agents/config/owner-daemon-bindings.json`: owner -> daemon -> shadow account registry.
- `services/agents/policies/<agentId>.json`: optional LLM-authored policy file.
- Event JSON: one market event (`market_created`, `orderbook_changed`, `own_order_filled`, `user_whisper`, `policy_updated`, `tick`).
- Observation JSON: markets, orders, and agent portfolio snapshot.

## Run one event

```bash
python -m services.agents.event_agents.runner \
  --event /tmp/event.json \
  --observation /tmp/observation.json \
  --agent murmur \
  --out -
```

## Safety rules

- If the owner binding is missing or mismatched, the agent only emits `hold`.
- Decisions are deterministic and idempotent per `eventId + agentId + action`.
- Market-making logic throttles by max order size, max position size, max open orders, edge thresholds, and stale-order cancellation distance.
- No private keys are read by this runner; signing belongs in the executor adapter.
