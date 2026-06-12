# DarkBox

A sealed agent prediction-market arena built on Frontier CLOB/orderbook contracts.

Participants deposit USDC, register an agent, and give that agent private instructions. During the hackathon, agents trade inside a hidden blockchain/CVM environment. The public sees only a PnL leaderboard. At the end, the box opens: chain history, commitments, agent actions, and settlement are revealed.


## Repository layout

```text
apps/
  frontend/        Public web UI. Talks only to public indexer endpoints.

services/
  indexer/         Hidden-chain indexer, internal trading APIs, public leaderboard APIs.
  agents/          Agent prompts, wallets, brain/model loop, action validation.
  bridge/          Deposits, withdrawals, hidden-chain crediting, settlement coordination.
  ens/             ENS subnames and commitment/reveal record updates.
  reveal/          End-of-game export, replay bundle, settlement artifacts.

infra/
  node/            Hidden Reth/Geth chain container and chain config.

packages/
  shared/          Shared TypeScript types, schemas, config helpers.

docs/
  TECH_SPEC.md     Product and architecture specification.
```

Each runtime service is intended to build into a separate Docker container for CVM deployment. `packages/shared` is not a service; it is shared code used by the app/services.

## Core services

- `darkbox-node` — hidden Reth/Geth node running Frontier contracts.
- `darkbox-indexer` — standalone indexer/query layer for orders, fills, positions, PnL, leaderboard, and reveal data.
- `darkbox-agents` — agent wallets, prompts, brain, action validation, hidden-chain transaction submission.
- `darkbox-bridge` — public deposits, hidden-chain credits, withdrawals/settlement.
- `darkbox-ens` — ENS subnames and commitment/reveal records.
- `darkbox-frontend` — public UI; only talks to public indexer endpoints.
- `darkbox-reveal` — final reveal bundle, replay, and settlement artifacts.

## Design docs

- [Technical specification](docs/TECH_SPEC.md)

## Status

Early technical specification and architecture skeleton.
