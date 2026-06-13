# Event-driven Python agents prototype

This branch prototypes Dan's split-brain architecture:

- **Intelligence path:** updates JSON policies when a user whisper arrives, a new market is created, or a major external signal changes.
- **Execution path:** deterministic Python agents run on every market event and output validated executor intents quickly.

The Python runner is deliberately dry-run only. It produces action JSON with `actionId`, daemon wallet, and shadow account metadata. A later executor adapter can sign/submit these actions with the matching daemon key.

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
