# DarkBox — Docker networking & CVM deployment notes

Date: 2026-06-13 UTC
Audience: Dan's agent + whoever deploys to Phala/CVM.
Why this matters (Fran): in-CVM debugging is painful, so the network boundaries
must be written down explicitly and be correct *before* deployment.

## Network planes

`docker-compose.yml` defines four networks. Two are `internal: true` (no route to
the host/internet); two are routable.

| Network | internal | Purpose |
|---------|----------|---------|
| `hidden_net` | ✅ | Confidential plane: hidden chain, DB, indexer core, agents, bridge coordinator, **signer**. No public ingress. |
| `gateway_net` | ✅ | Narrow private channel between the **public gateway** and private backend services (transcriber now; bridge HTTP later). Lets the gateway reach confidential services **without joining hidden_net**. |
| `public_net` |   | Player/spectator ingress: frontend, gateway, indexer's public side. |
| `egress_net` |   | Outbound internet: bridge (Base/Arc RPC), ens, transcriber (http STT), ethglobal ingest. |

## Service ↔ network matrix

| Service | hidden_net | gateway_net | public_net | egress_net | Exposes | Reaches |
|---------|:--:|:--:|:--:|:--:|---------|---------|
| `darkbox-node` (hidden chain) | ✅ | | | | 8545 (internal) | — |
| `darkbox-db` | ✅ | | | | 5432 (internal) | — |
| `darkbox-indexer` | ✅ | | ✅ | | 8080 | node, db |
| `darkbox-agents` | ✅ | | | | — | indexer/internal, node |
| `darkbox-bridge` | ✅ | | | ✅ | — | indexer/internal, node, Base/Arc RPC |
| `darkbox-signer` ⟨profile: signer⟩ | ✅ | | | | 8099 (internal) | bridge only (callee) |
| `darkbox-transcriber` | | ✅ | | ✅ | 8095 (internal) | STT provider (http mode) |
| `darkbox-gateway` | | ✅ | ✅ | | 8090 (published) | indexer, transcriber, (bridge later) |
| `darkbox-frontend` | | | ✅ | | 3000 (published) | indexer/public |
| `darkbox-ens` | | | | ✅ | — | ENS provider |
| `darkbox-reveal` ⟨profile: reveal⟩ | ✅ | | | ✅ | — | indexer/internal, node |

Key invariants encoded by the topology:
- **The gateway is the only published `/api/*` surface and never joins
  `hidden_net`.** A gateway compromise does not put the attacker on the hidden
  network — it can only reach the transcriber over `gateway_net`.
- **The signer is `hidden_net`-only and behind the `signer` profile.** Nothing on
  `public_net`/`gateway_net` can reach it; only the bridge (same plane) can.
- **The hidden chain RPC (`darkbox-node:8545`) is `internal`** — never published.
- **Indexer is dual-homed**: its `/public/*` is reachable from `public_net`; its
  `/internal/*` must stay on `hidden_net`. (Leak guard: `public-leak.test.ts`.)

## Secrets (never in git; injected at runtime)

| Secret | Consumed by | Source |
|--------|-------------|--------|
| `SIGNER_PRIVATE_KEY` | signer | CVM/TEE secret |
| `SIGNER_BRIDGE_TOKEN` | signer + bridge | shared secret, secret store |
| `TELEGRAM_BOT_TOKEN` | gateway | `.secrets`/secret store |
| `STT_API_KEY` | transcriber (http mode) | secret store |
| deployer key | deploy scripts only | `.secrets/darkbox-dan-deployer.env` (gitignored) |

`.gitignore` ignores `.secrets/`, `secrets/`, `.env*`, `*.private.json`. See
`docs/security/KEY_ROLE_INVENTORY.md`.

## Local run

Process-level (no Docker) — validated end-to-end on 2026-06-13:
```bash
STT_MODE=stub PORT=8095 pnpm --filter @darkbox/transcriber dev &
ALLOW_INSECURE_DEV_AUTH=true TRANSCRIBER_URL=http://localhost:8095 \
  pnpm --filter @darkbox/gateway dev &
# join $5 -> whisper(audio->transcriber) -> confirm -> register -> self-status
curl -s -H 'X-Dev-Telegram-Id:1' -XPOST localhost:8090/api/invites/claim -d '{}'
```
The full player journey (claim → audio whisper proxied to transcriber → confirm →
register → self-status) passes against the two live services.

Dockerized (when a Docker daemon is available — it was not in this sandbox):
```bash
docker compose config            # validates (passes)
docker compose up --build         # core stack (signer/reveal gated behind profiles)
docker compose --profile signer up -d darkbox-signer
```

## CVM / Phala plan

First CVM targets (highest sensitivity): **transcriber** and **signer**.

1. Build each image (multi-stage Dockerfiles already present; small alpine
   runtime, non-root user, healthcheck).
2. Inject secrets via the CVM secret mechanism — `SIGNER_PRIVATE_KEY`,
   `SIGNER_BRIDGE_TOKEN`, `STT_API_KEY`. Never bake into the image.
3. Egress allowlist: signer → none (hidden only); transcriber → only the STT
   provider host (http mode) else none.
4. Attestation: capture the CVM attestation/report for the signer + transcriber
   images and store alongside the deployment record.
5. Reproduce locally first (`docker compose --profile signer up`) before pushing
   to CVM, then tear down.

Open follow-ups: actual Phala deployment + attestation capture (needs CVM access);
bridge → signer HTTP wiring (drops the inline `signingService.ts`).
