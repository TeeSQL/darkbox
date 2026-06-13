# DarkBox CVM core runbook

This is the minimal production-ish CVM target for the next phase: hidden chain +
Postgres + indexer + existing agent loop. The public Mini App/frontend is not in
this core deploy, and bridge HTTP wiring remains a follow-up.

## Scope

Default `docker compose up` now starts:

- `darkbox-node` — Anvil hidden chain on `hidden_net`, persistent state in `node_data`.
- `darkbox-db` — Postgres for indexer state.
- `darkbox-indexer` — public/internal indexer API.
- `darkbox-agents` — existing bounded worker-pool agent runner.
- `darkbox-gateway` + `darkbox-transcriber` — available for API/auth/typed whisper tests.

Profiles:

- `signer` — isolated withdrawal signer, hidden network only.
- `reveal` — internal reveal bundle builder.
- `bridge` — deferred until bridge HTTP worker exists.
- `frontend` — deferred; frontend stays outside CVM for now.

## One-command local/CVM bring-up

```bash
cp .env.cvm.example .env
docker compose up --build darkbox-node darkbox-db darkbox-indexer darkbox-agents
```

For Venice-backed agents:

```bash
AGENT_STRATEGY=venice VENICE_API_KEY=... docker compose up --build darkbox-agents
```

## Required verification

```bash
docker compose config
docker compose build darkbox-node darkbox-indexer darkbox-agents darkbox-gateway
docker compose up -d darkbox-node darkbox-db darkbox-indexer darkbox-gateway
docker compose exec darkbox-node cast block-number --rpc-url http://127.0.0.1:8545
docker compose exec darkbox-indexer wget -qO- http://127.0.0.1:8080/public/health
curl -sf http://127.0.0.1:8090/health
docker compose run --rm -e AGENT_TURNS=1 -e AGENT_COUNT=1 -e AGENT_KIND=random-maker darkbox-agents
docker compose exec darkbox-db psql -U darkbox -d darkbox -c "select count(*) from agent_turns; select count(*) from orders;"
```

Before calling the CVM live, verify at least one agent turn is logged under the
`agent_logs` volume and at least one order row was created by the internal v0
agent-turn endpoint. The indexer is intentionally not host-published; the public
frontend should talk to the gateway on `:8090` (or its reverse-proxied URL), not
directly to `darkbox-indexer`.

## Important limitations

- This uses Anvil for the one-hour deploy target. Migrating to Reth/Geth is a
  separate hardening task.
- This v0 agent egress persists orders into the local CVM indexer book. It is the
  live demo seam for current agents, not final Frontier contract settlement.
- Frontier source reconciliation/code-size validation is separate from this
  packaging patch.
- Bridge deposit/withdrawal math exists, but the gateway ↔ bridge ↔ isolated
  signer HTTP wiring is not live yet. Do not wire the UI to bridge lifecycle
  until that vertical is implemented and smoke-tested.
- Agent identities are public metadata in `services/agents/config`. Private
  keys must be mounted as CVM secrets later; do not bake them into images.
