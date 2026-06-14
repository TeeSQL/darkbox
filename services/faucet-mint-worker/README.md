# @darkbox/faucet-mint-worker

Private-mesh CVM worker that mints the **$5 promo / daemon-funding faucet grants
on-chain** by driving Ocean's merged `FaucetCoordinator` (in `@darkbox/bridge`).

It is the execution half of the faucet: the bridge/miniapp side *enqueues*
grants into the durable faucet ledger; this worker *drains* that ledger and turns
each pending record into a real `ShadowBridgeController.mintShadow(...)` call on
the hidden chain, signed by the sealed coordinator key.

Mirrors the shape of `services/bridge` and `services/market-executor`:

- `config.ts` — env/sealed-secret config (`loadConfig`).
- `abis.ts` — minimal `ShadowBridgeController` fragments (`mintShadow`,
  `ShadowMinted`), local to the worker.
- `minter.ts` — `ViemFaucetMinter`, a viem-backed
  [`ShadowMintSubmitter`](../bridge/src/shadow.ts): `simulate → write →
  waitForReceipt`, plus `findExistingMint(operationId)` (a `ShadowMinted` log
  scan) for idempotent crash recovery.
- `worker.ts` — `runOnce` / `runLoop`: pull pending records via
  `FaucetCoordinator.listPending`, `process(operationId)` each. A per-record
  failure marks that record `failed` and the loop continues; it never crashes.
- `server.ts` — the mesh-internal HTTP surface (Fastify).
- `index.ts` — entrypoint: wire `InMemoryBridgeStore` + `ViemFaucetMinter` +
  `FaucetCoordinator`, start the server, run the loop forever.

## Idempotency / one-grant-per-recipient

Single-mint is enforced structurally, not by bookkeeping:

- The faucet **`operationId`** is `keccak256` of a deterministic operation string
  (`darkbox:faucet:v1:<gameId>:human_promo:<telegramId>` or
  `…:daemon_funding:<daemonId>:<addr>:<shadow>`). The same human telegram id or
  the same daemon always maps to the **same** `operationId`, so re-enqueue
  returns the existing ledger record (see `FaucetCoordinator.enqueue*`).
- On-chain, `mintShadow` is keyed by that `operationId` (as `depositOpId`).
  Before submitting, `findExistingMint` checks for an existing `ShadowMinted` log
  and reuses its tx; the controller also reverts on replay. A crash mid-mint
  therefore never double-mints.
- `FaucetCoordinator.process` short-circuits records already in `minted`.

## State machine

`pending → minting → minted | failed` (`FaucetMintState`, `@darkbox/shared`).
`failed` records are requeued to `pending` via the `retry` endpoint.

## Mesh-internal HTTP API

All routes except `/health` are **sealed**: private-mesh only, gated by a shared
secret presented as `x-mesh-token`. No `MESH_TOKEN` configured ⇒ they fail closed
(`503`) unless `ALLOW_INSECURE_DEV=true`. No route ever exposes the coordinator
key.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness + auth posture (open) |
| `GET /internal/faucet/mints?state=pending&limit=N` | list ledger records |
| `POST /internal/faucet/mints/:operationId/process` | drive one record to `minted` |
| `POST /internal/faucet/mints/:operationId/retry` | requeue a `failed` record |
| `POST /internal/faucet/grants/human` | enqueue a $5 human-promo grant |
| `POST /internal/faucet/grants/daemon` | enqueue a $5 daemon-funding grant |

`amount` is serialized as a decimal string on the wire (it is a `bigint`
internally).

## Configuration

| Env | Default | Notes |
| --- | --- | --- |
| `HIDDEN_RPC_URL` | `http://localhost:8545` | hidden-chain RPC |
| `HIDDEN_CHAIN_ID` | `88813` | hidden-chain id |
| `SHADOW_BRIDGE_CONTROLLER_ADDRESS` | — (required) | mint target |
| `GAME_ID` | — (required) | bytes32 game id |
| `COORDINATOR_PRIVATE_KEY` | — (required, **sealed**) | minter key — NEVER logged/persisted; only the derived address is surfaced |
| `FAUCET_AMOUNT` | `5000000` | $5 at 6 decimals |
| `POLL_INTERVAL_MS` | `8000` | drain cadence |
| `FROM_BLOCK` | `0` | earliest block for the `findExistingMint` scan |
| `FETCH_LIMIT` | `25` | pending records per poll |
| `PORT` | `8090` | internal HTTP port |
| `MESH_TOKEN` | — | shared secret for the sealed endpoints |
| `ALLOW_INSECURE_DEV` | `false` | dev-only: skip the mesh gate |

## Develop

```sh
pnpm --filter @darkbox/faucet-mint-worker typecheck
pnpm --filter @darkbox/faucet-mint-worker test
pnpm --filter @darkbox/faucet-mint-worker dev
```

> The default `InMemoryBridgeStore` is the MVP persistence; for a multi-process
> mesh, back the `FaucetCoordinator` with a shared store implementing
> `BridgeStore` so the bridge and this worker share one ledger.
