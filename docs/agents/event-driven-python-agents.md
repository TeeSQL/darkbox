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

## Current branch status

Implemented as dry-run Python modules under `services/agents/event_agents/` with unit tests. The current TypeScript LLM runner remains untouched.
