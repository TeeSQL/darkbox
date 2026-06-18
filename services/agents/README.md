# darkbox-agents

Agent runtime skeleton for DarkBox.

Current slice:

- shared turn JSON schemas live in `@darkbox/shared`
- random/deterministic strategy modules emit valid turn JSON
- Venice strategy can call a cheap chat model when `VENICE_API_KEY` is set; CLI auto-loads repo `.env`
- validator checks shape plus basic market/order constraints
- CLI demo exercises the runtime before hidden-chain execution exists

Commands:

```bash
pnpm --filter @darkbox/agents demo:random
pnpm --filter @darkbox/agents exec tsx src/cli.ts random --kind random-maker --turns 3
pnpm --filter @darkbox/agents demo:venice
pnpm --filter @darkbox/agents demo:seed-noise --dry-run
```

Demo funding / on-chain noise helper:

- `src/demo-noise-runner.ts` mints real hidden-chain sUSDC to a few daemon wallets using the sealed coordinator/minter key, then optionally calls `DarkBoxBinaryMarket.split(amount, receiver)` so those wallets visibly receive tradable YES/NO inventory.
- It reads daemon wallets from `services/agents/config/agent-identities.json` and defaults to the canonical market from `packages/contracts/deployments/darkbox-latest.json`.
- Required env:
  - `HIDDEN_RPC_URL`
  - `HIDDEN_CHAIN_ID`
  - `SHADOW_BRIDGE_CONTROLLER_ADDRESS`
  - `COORDINATOR_PRIVATE_KEY`
- Optional flags/env:
  - `--count` / `DEMO_AGENT_COUNT` (default 3)
  - `--mint-usdc` / `MINT_USDC` (default 5)
  - `--split-usdc` / `SPLIT_USDC` (default 1)
  - `--market` to target a non-canonical market
  - `--dry-run` for plan output only

Example:

```bash
HIDDEN_RPC_URL=http://localhost:8545 \
HIDDEN_CHAIN_ID=88813 \
SHADOW_BRIDGE_CONTROLLER_ADDRESS=0x... \
COORDINATOR_PRIVATE_KEY=0x... \
pnpm --filter @darkbox/agents demo:seed-noise --count 4 --mint-usdc 5 --split-usdc 1
```

The strategy module is intentionally swappable: random agents now, LLM brain later, same observation schema and validator.
