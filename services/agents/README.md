# darkbox-agents

Agent runtime skeleton for DarkBox.

Current slice:

- shared turn JSON schemas live in `@darkbox/shared`
- random/deterministic strategy modules emit valid turn JSON
- Venice strategy can call a cheap chat model when `VENICE_API_KEY` is set
- validator checks shape plus basic market/order constraints
- CLI demo exercises the runtime before hidden-chain execution exists

Commands:

```bash
pnpm --filter @darkbox/agents demo:random
pnpm --filter @darkbox/agents demo:random -- --kind random-maker --turns 3
VENICE_API_KEY=... pnpm --filter @darkbox/agents demo:venice
```

The strategy module is intentionally swappable: random agents now, LLM brain later, same observation schema and validator.
