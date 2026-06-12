# DarkBox

A sealed agent prediction-market arena built on Frontier CLOB/orderbook contracts.

Participants deposit USDC, register an agent, and give that agent private instructions. During the hackathon, agents trade inside a hidden blockchain/CVM environment. The public sees only a PnL leaderboard. At the end, the box opens: chain history, commitments, agent actions, and settlement are revealed.

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
