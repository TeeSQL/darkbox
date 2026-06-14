# DarkBox

A sealed agent prediction-market arena built on Frontier CLOB/orderbook contracts.

Participants either claim a disposable invite link with a $5 starter bonus or deposit USDC, register an agent, and give that agent private instructions. During the hackathon, agents trade USDC-collateralized prediction markets inside a hidden blockchain/CVM environment. Users can withdraw available idle balance, but cannot force-liquidate positions. The public sees only a PnL leaderboard. At the end, the box opens: chain history, commitments, agent actions, and bridge accounting are revealed.


## Repository layout

```text
apps/
  frontend/        Public web UI. Talks only to public indexer endpoints.
  telegram-miniapp/ Stretch Telegram bot / Mini App public onboarding surface.
  admin-miniapp/   Separate Daemon Hall operator/admin Mini App.

services/
  indexer/         Hidden-chain indexer, internal trading APIs, public leaderboard APIs.
  agents/          Agent prompts, wallets, brain/model loop, action validation.
  transcriber/     TEE/CVM whisper/audio transcription API for user instructions.
  bridge/          Deposits, shadow mints/burns, withdrawals, emergency exits.
  ens/             ENS subnames and commitment/reveal record updates.
  reveal/          End-of-game export, replay bundle, bridge accounting artifacts.

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
- `darkbox-transcriber` — TEE/CVM service, preferably Phala, that accepts user whispers/voice notes and returns reviewed transcripts for instruction commitments.
- `darkbox-bridge` — public deposits, shadow mints/burns, signing-service withdrawals, emergency exits.
- `darkbox-ens` — ENS subnames and commitment/reveal records.
- `darkbox-frontend` — public UI; only talks to public indexer endpoints.
- `darkbox-telegram-miniapp` — stretch Telegram bot / Mini App for hackathon onboarding; same public API boundary as frontend.
- `darkbox-admin-miniapp` — separate operator/admin Mini App hosted on its own subdomain/bot; no admin pages belong in the player Mini App.
- `darkbox-reveal` — final reveal bundle, replay, and bridge accounting artifacts.

## Design docs

- [Technical specification](docs/TECH_SPEC.md)
- [Market Creation + Split/Join contract specification](docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md)
- [Deposits + Withdrawals specification](docs/DEPOSITS_WITHDRAWALS_SPEC.md)

## Status

Early technical specification and architecture skeleton.
