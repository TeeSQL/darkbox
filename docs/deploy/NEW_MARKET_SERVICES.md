# New DarkBox market services — fresh-core deploy stanzas

> Audience: the overseer who owns the AttestMesh core CVM + the fresh-chain bump.
> Status: **staged, not live.** These compose stanzas are NOT applied to any live
> `deploy/attestmesh/*.yaml` in this PR — they are ready-to-paste blocks for the
> overseer to fold into the **fresh-core** deploy.

## What this covers

Three new private-mesh CVM workers that create / fund / resolve DarkBox markets,
all signed by the **sealed coordinator/minter key**:

| Service | Image | Status on `main` | Stanza below |
|---|---|---|---|
| `market-executor` | `ghcr.io/teesql/darkbox-market-executor:latest` | **merged** (PR #23) — has `services/market-executor/Dockerfile` | full, ready now |
| `faucet-mint-worker` | `ghcr.io/teesql/darkbox-faucet-mint-worker:latest` | **not merged yet** | template only |
| `resolution-executor` | `ghcr.io/teesql/darkbox-resolution-executor:latest` | **not merged yet** | template only |

CI: the `market-executor` image builds on push to `main` via
`.github/workflows/build-darkbox-images.yml` (added to the matrix in this PR). The
two siblings are intentionally **not** in the CI matrix yet — their code/Dockerfile
isn't on `main`, so adding them would break the build. Add them to the matrix in
the same PR that merges each service.

## ⚠️ Deploy ordering — read first

These services deploy **only AFTER**:

1. the **fresh hidden chain is verified** (the bumped tdx.xlarge core is up,
   geth-1 + geth-2 peered, mesh converged), **and**
2. the **contracts are redeployed** on that fresh chain — i.e. a new
   `DarkBoxMarketFactory` + synthetic-USDC + `ShadowBridgeController` set, with
   their addresses captured (the `deployed-addresses-<chainId>.json` equivalent).

Until both are true, `MARKET_FACTORY_ADDRESS` / `SHADOW_BRIDGE_CONTROLLER_ADDRESS`
are empty and these workers would just no-op / error on every poll. They are safe
to add to the compose with empty placeholders (every DarkBox worker tolerates an
unset upstream and retries per poll cycle, never hard-exiting), but they do real
work only once the overseer injects the fresh addresses via the post-deploy env
refresh.

## The sealed coordinator/minter key

All three workers sign with `COORDINATOR_PRIVATE_KEY` — the hidden-chain
**factory owner / coordinator + shadow-USDC minter** key.

- **It is the same EOA as the deployer / signer in the current testnet posture.**
  Per `docs/security/KEY_ROLE_INVENTORY.md`, today `deployer == admin == signer ==
  coordinator == one EOA`, and on the AttestMesh core it is the sealed key pinned
  as `GETH1_NODEKEY` (geth-1's nodekey) and used as the deployer's `DEPLOYER_KEY`.
  So `COORDINATOR_PRIVATE_KEY`, `GETH1_NODEKEY`, and the deployer key are the
  **same secret** in the demo deploy.
- **It is supplied only in the sealed `-e` env by the overseer. Never in the
  repo.** It is never hardcoded, logged, echoed, or written to disk — the workers
  log only the derived coordinator *address*. Inject it the same way the signer
  key (`SIGNER_PRIVATE_KEY`) and `GETH1_NODEKEY` are injected today.

> Hidden-chain coordinator/minter authority is confined to the `hidden_net` CVM
> and must never egress. Keep it out of any public-edge member.

---

## `market-executor` — ready-to-paste (add now)

Fold this into the core member compose
(`deploy/attestmesh/darkbox-geth-1-core.yaml`), alongside the other private-mesh
workers (indexer / bridge / transcriber / reveal). Env names are the exact ones
read by `services/market-executor/src/config.ts` (see
`services/market-executor/README.md` for the full table).

```yaml
  # ── Market executor (APPROVED proposals -> on-chain createMarket) ────────────
  market-executor:
    image: ghcr.io/teesql/darkbox-market-executor:latest
    restart: unless-stopped
    mem_limit: 512m
    mem_reservation: 128m
    network_mode: "service:sidecar"
    depends_on: [ sidecar ]
    environment:
      - HIDDEN_RPC_URL=http://localhost:8545
      - HIDDEN_CHAIN_ID=88813
      # DarkBoxMarketFactory on the fresh hidden chain — placeholder now, injected
      # by the overseer's post-deploy env refresh (no compose-hash churn). Empty
      # until the fresh-chain contracts are redeployed.
      - MARKET_FACTORY_ADDRESS=${MARKET_FACTORY_ADDRESS}
      - GAME_ID=${GAME_ID}
      - INDEXER_INTERNAL_URL=http://localhost:8080/internal
      # Sealed coordinator/minter key (== GETH1_NODEKEY / deployer key). From the
      # sealed -e file ONLY — never inline here, never logged.
      - COORDINATOR_PRIVATE_KEY=${COORDINATOR_PRIVATE_KEY}
```

Optional knobs (all have safe defaults in `config.ts`; add only if overriding):
`POLL_INTERVAL_MS` (default `8000`), `CREATOR_BOND` (default `0`),
`INITIAL_LIQUIDITY` (default `0`; `>0` pulls collateral from the coordinator),
`CLOSE_TIME_OVERRIDE_UNIX` (force a fixed market close time).

---

## `faucet-mint-worker` — TEMPLATE (do not deploy until merged)

> Mints $5 shadow USDC via the bridge `ShadowBridgeController`, signed by the
> coordinator/minter key. **The service is not on `main` yet** — env names below
> are the established conventions (`SHADOW_BRIDGE_CONTROLLER_ADDRESS` is already
> read by the indexer in `services/indexer/src/config.ts`), but **confirm against
> the service's own `src/config.ts` / `README.md` when it merges** before relying
> on this verbatim.

```yaml
  # ── Faucet mint worker (mints $5 sUSDC via ShadowBridgeController) ───────────
  faucet-mint-worker:
    image: ghcr.io/teesql/darkbox-faucet-mint-worker:latest
    restart: unless-stopped
    mem_limit: 512m
    mem_reservation: 128m
    network_mode: "service:sidecar"
    depends_on: [ sidecar ]
    environment:
      - HIDDEN_RPC_URL=http://localhost:8545
      - HIDDEN_CHAIN_ID=88813
      # ShadowBridgeController (the shadow-USDC minter contract) on the fresh
      # hidden chain — placeholder; injected post-deploy. Empty until redeploy.
      - SHADOW_BRIDGE_CONTROLLER_ADDRESS=${SHADOW_BRIDGE_CONTROLLER_ADDRESS}
      - GAME_ID=${GAME_ID}
      - INDEXER_INTERNAL_URL=http://localhost:8080/internal
      # Sealed coordinator/minter key (== GETH1_NODEKEY / deployer key). From the
      # sealed -e file ONLY — never inline here, never logged.
      - COORDINATOR_PRIVATE_KEY=${COORDINATOR_PRIVATE_KEY}
      # TODO(when merged): reconcile exact env names ($5 amount, poll cadence,
      # any faucet ledger endpoint) against services/faucet-mint-worker/src/config.ts.
```

---

## `resolution-executor` — TEMPLATE (do not deploy until merged)

> Admin on-chain market resolution, signed by the coordinator key. **Not on
> `main` yet** — treat the env below as a template and confirm against the
> service's own config when it merges.

```yaml
  # ── Resolution executor (admin on-chain market resolution) ──────────────────
  resolution-executor:
    image: ghcr.io/teesql/darkbox-resolution-executor:latest
    restart: unless-stopped
    mem_limit: 512m
    mem_reservation: 128m
    network_mode: "service:sidecar"
    depends_on: [ sidecar ]
    environment:
      - HIDDEN_RPC_URL=http://localhost:8545
      - HIDDEN_CHAIN_ID=88813
      # DarkBoxMarketFactory (and/or the resolver target) on the fresh hidden
      # chain — placeholder; injected post-deploy. Empty until redeploy.
      - MARKET_FACTORY_ADDRESS=${MARKET_FACTORY_ADDRESS}
      - GAME_ID=${GAME_ID}
      - INDEXER_INTERNAL_URL=http://localhost:8080/internal
      # Sealed coordinator/minter key (== GETH1_NODEKEY / deployer key). From the
      # sealed -e file ONLY — never inline here, never logged.
      - COORDINATOR_PRIVATE_KEY=${COORDINATOR_PRIVATE_KEY}
      # TODO(when merged): reconcile exact env names (resolver address, poll
      # cadence, resolution-source endpoint) against
      # services/resolution-executor/src/config.ts.
```

---

## Overseer checklist

1. Bump the core to the fresh tdx.xlarge CVM; bring up geth-1 + geth-2; wait for
   mesh convergence + chain verification.
2. Redeploy contracts on the fresh chain; capture `MARKET_FACTORY_ADDRESS`,
   `SHADOW_BRIDGE_CONTROLLER_ADDRESS`, synthetic-USDC, `GAME_ID`.
3. Paste the `market-executor` stanza (above) into
   `deploy/attestmesh/darkbox-geth-1-core.yaml`. Add the two sibling stanzas only
   once their images exist (`ghcr.io/teesql/darkbox-faucet-mint-worker`,
   `…-resolution-executor`) and their CI matrix entries have merged.
4. Provide `COORDINATOR_PRIVATE_KEY` (== the sealed `GETH1_NODEKEY`/deployer key)
   in the sealed `-e` file — never in the repo.
5. Inject the fresh contract addresses via the post-deploy env refresh; the
   workers pick them up and begin creating/funding/resolving markets.
