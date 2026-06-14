# Fresh-chain go-live runbook — DarkBox markets workstream

> Audience: the overseer driving the fresh hidden-chain bump + the markets
> demo go-live.
> Scope: from "fresh chain verified" → market services up → e2e smoke →
> trading noise → gateway cutover → public read verified → team notified.
> Sibling docs: [`NEW_MARKET_SERVICES.md`](./NEW_MARKET_SERVICES.md) (compose
> stanzas + sealed key; **PR #24, not yet on `main`**),
> [`CVM_CORE_RUNBOOK.md`](./CVM_CORE_RUNBOOK.md) (core bring-up),
> [`PENDING_REDEPLOY.md`](./PENDING_REDEPLOY.md) (image-rebuild ledger).

## The fresh chain

- chainId **88813**, fresh 2-signer hidden chain on bumped CVM flavors.
- Contracts redeploy **deterministically to the same addresses**:
  - `DarkBoxMarketFactory` = `0xC37d6ce4c0579853dc5a0401E7c4197c21BF9F2c`
  - synthetic USDC (`sUSDC`) = `0x4d61006FDEaC7aaE14B373e7084b9968d42479e6`
- These addresses are **runtime artifacts**, not committed constants — they do
  not appear anywhere in the repo. The deploy script writes the live set to
  `packages/contracts/deployments/darkbox-latest.json` (and
  `darkbox-private-88813.json`). Always read addresses from the deploy JSON;
  the two above are the *expected* deterministic result to assert against.

---

## ⚠️ Read this first: what is and isn't real

This runbook will get you a **demo-able markets happy path**, but several pieces
the end-to-end story implies are **not wired in merged `main`**. Do not promise
the full loop until the gaps in [§ Readiness audit](#readiness-audit--gaps) are
closed. The short version:

| Stage | Merged & working? |
|---|---|
| `createMarket` → indexed → `/public/markets` → gateway → frontend | ✅ yes |
| trades indexed → positions → mark-to-market → `/public/leaderboard` | ✅ yes (PnL caveats) |
| admin **approve** proposal → executor → on-chain market | ✅ yes |
| group **confirm** → executor (the advertised one-tap path) | ❌ **broken** (confirm ≠ approve) |
| daemons trade on dynamically-created markets | ❌ **no live trading at all** (paper-only) |
| faucet funds humans ($5) + daemons | ❌ **not wired** (no service/worker/routes) |
| market close → **resolve** → reflected in `/public/markets` | ❌ **missing** (manual key op only) |
| ETHGlobal ingest → agent proposes a market | ❌ **disconnected islands** |

The realistic demo today is: **operator/admin proposes & approves a market →
executor creates it on-chain → it appears in `/public/markets`; the seed places
real Frontier orders on the canonical book (local anvil) so the book/leaderboard
look alive.** Everything else needs the follow-up work below.

---

## Prerequisites before step 1

- The bumped core CVM is up, both geth signers peered, mesh converged (out of
  scope here — see the AttestMesh deploy docs).
- Contracts redeployed on chainId 88813; `darkbox-latest.json` captured.
- Images rebuilt + pushed for any changed service (no CI auto-redeploys the
  core — see `PENDING_REDEPLOY.md`). The `market-executor` image builds on push
  to `main`; `faucet-mint-worker` / `resolution-executor` are **not** in CI yet.
- The sealed **`COORDINATOR_PRIVATE_KEY`** in hand (injected via the sealed `-e`
  env only). Per `NEW_MARKET_SERVICES.md` this is the **same EOA** as the
  deployer / signer / `GETH1_NODEKEY` in the current testnet posture — factory
  owner/coordinator + sUSDC minter. Never inline, never logged (the worker logs
  only the derived address).

Set these once for the verify commands below (adjust host/port to the mesh):

```bash
export RPC=http://localhost:8545          # hidden-chain RPC inside the mesh
export FACTORY=0xC37d6ce4c0579853dc5a0401E7c4197c21BF9F2c
export SUSDC=0x4d61006FDEaC7aaE14B373e7084b9968d42479e6
export IDX_INTERNAL=http://localhost:8080 # indexer internal origin (in-mesh)
export GW=http://localhost:8090           # gateway (public edge)
```

---

## Step 1 — Verify the fresh chain

**Goal:** factory code present, height climbing, canonical market already seeded
by the deploy script.

```bash
# (a) factory has code (deterministic redeploy succeeded) — non-empty, not "0x"
cast code $FACTORY --rpc-url $RPC | head -c 12 ; echo
cast code $SUSDC   --rpc-url $RPC | head -c 12 ; echo

# (b) height is climbing (run twice, a couple seconds apart)
cast block-number --rpc-url $RPC ; sleep 3 ; cast block-number --rpc-url $RPC

# (c) canonical market present — the deploy seeds gameId keccak256("darkbox-game-1")
#     with question "Will the canonical project win the hackathon?".
#     Confirm via the deploy JSON inside the contracts image / artifact:
cat packages/contracts/deployments/darkbox-latest.json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("canonicalMarket"))'
```

**Pass:** (a) returns long bytecode for both (not `0x`), (b) second number >
first, (c) `canonicalMarket` has `market`, `yesBook`, `noBook` addresses.

**Rollback:** if `cast code` returns `0x`, contracts did not redeploy — do not
proceed. Re-run the contract deploy against 88813; do not start market services
against an empty factory (`MARKET_FACTORY_ADDRESS` empty/empty-code → executor
no-ops every poll).

> Note: the seed/deploy script (`packages/contracts/script/DeployDarkBox.s.sol`)
> deploys factory + sUSDC + the one canonical market fresh each run. The
> `0xC37d…` / `0x4d61…` addresses are the deterministic result; assert against
> them but source live values from the JSON.

---

## Step 2 — Deploy the new market services onto the bumped core

**Reference:** [`docs/deploy/NEW_MARKET_SERVICES.md`](./NEW_MARKET_SERVICES.md)
(PR #24) for the exact ready-to-paste compose stanzas and the sealed-key notes.

⚠️ **PR #24 is not on `main` yet** (it lives on `dan/deploy-wire-market-services`).
Merge it (or paste its stanzas) before this step. Likewise note that
`market-executor` is **merged code but is NOT in the repo's `docker-compose.yml`**
— it only exists as a paste-in mesh stanza in PR #24. The local
`docker-compose.yml` will *not* start it.

Of the three workers in PR #24, only **one is real today**:

| Service | Status | Action now |
|---|---|---|
| `market-executor` | merged (PR #23), has Dockerfile | **deploy** |
| `faucet-mint-worker` | **not merged** (branch `dan-faucet-mint-worker`) | template only — skip |
| `resolution-executor` | **not merged** (branch `dan-resolution-executor`) | template only — skip |

**2a. Inject the sealed env** (overseer's post-deploy env refresh — never in the
repo). Env names are exactly those read by `services/market-executor/src/config.ts`:

```bash
MARKET_FACTORY_ADDRESS=0xC37d6ce4c0579853dc5a0401E7c4197c21BF9F2c
GAME_ID=0x...                       # bytes32 game id; must match the deploy's gameId
COORDINATOR_PRIVATE_KEY=0x...       # sealed; == GETH1_NODEKEY / deployer key
HIDDEN_CHAIN_ID=88813
INDEXER_INTERNAL_URL=http://localhost:8080/internal   # note the /internal suffix
# optional knobs (safe defaults in config.ts):
# POLL_INTERVAL_MS=8000  CREATOR_BOND=0  INITIAL_LIQUIDITY=0  CLOSE_TIME_OVERRIDE_UNIX=...
```

> `GAME_ID` must equal the game id the canonical market was created under and the
> id the indexer is configured with — the `/deployed` write-back stamps the
> indexer's configured `game_id` onto the markets row, so a mismatch fragments
> the market set.

**2b. Start the market-executor** (paste the PR #24 stanza into the core member
compose, e.g. `deploy/attestmesh/darkbox-geth-1-core.yaml`, alongside indexer /
bridge / transcriber / reveal on the private mesh). Then:

```bash
# verify the worker came up and bound to the right coordinator address
docker logs darkbox-market-executor 2>&1 | tail -20
# expect: a startup line logging the derived COORDINATOR ADDRESS (never the key),
#         factory address, gameId, chainId 88813, and "polling status=approved".
```

**Pass:** executor logs show it loaded config (factory, chainId 88813, derived
coordinator address) and is polling. No `missing required env` crash.

**Rollback:** the executor tolerates an empty/wrong upstream and retries per poll
— it never hard-exits — so a bad address just means no markets get created.
`docker stop darkbox-market-executor` to halt; fix the env; restart. It is
**idempotent**: on restart it scans `MarketCreated` logs by `gameId`+`question`
(`findExistingMarketByQuestion`) before sending a tx, so duplicate proposals do
not double-create.

> Approval bot (separate `ops`-profile service, already in `docker-compose.yml`):
> compose remaps `MARKET_APPROVAL_*` env → the `TELEGRAM_BOT_TOKEN` /
> `APPROVAL_*` names the bot actually reads (`config.ts`). If you deploy the bot
> via the mesh compose (not this repo's compose), replicate that remap or the bot
> starts unconfigured.

---

## Step 3 — Run the e2e market-lifecycle smoke test

**Reference:** `services/indexer/scripts/market-lifecycle.smoke.ts` (PR #25).

⚠️ **PR #25 is not on `main` yet** (branch `dan/e2e-market-smoke`). Merge it or
run it from that branch. It drives the full **propose → confirm → approve →
(executor) deploy → public read** flow by talking only to the indexer HTTP
surface, creating one throwaway market per run (safe to re-run).

```bash
# from the indexer package (preferred):
INDEXER_INTERNAL_URL=$IDX_INTERNAL \
GATEWAY_PUBLIC_URL=$GW \
GAME_ID=$GAME_ID \
  pnpm --filter @darkbox/indexer smoke:market

# or directly:
INDEXER_INTERNAL_URL=$IDX_INTERNAL GATEWAY_PUBLIC_URL=$GW \
  node --import tsx services/indexer/scripts/market-lifecycle.smoke.ts
```

What it asserts: a proposal moves `proposed → confirmed → approved`, the
**deployed market-executor** (step 2) picks it up and writes the markets row, and
`/public/markets` shows it with **real `close_time`/`resolve_by`** (not 0).

**Pass:** exit code 0, "PASS". This is the single best signal that the markets
vertical is live end-to-end against the mesh.

**Do NOT set `RUN_RESOLUTION=1`.** The resolution step posts to
`/internal/markets/:id/prepare-resolution`, a **route that is not merged**; it
will fail. Resolution is a known gap (see audit).

**Rollback / triage:**
- Hangs at DEPLOY (waits up to `DEPLOY_TIMEOUT_MS`, default 180s): the executor
  isn't draining `status=approved`. Check `docker logs darkbox-market-executor`
  and `GET $IDX_INTERNAL/internal/market-proposals?status=approved`.
- Fails at ASSERT with `close_time=0`: executor created the market with bad times
  — check `GAME_ID` / `CLOSE_TIME_OVERRIDE_UNIX`.

---

## Step 4 — Run the seed for trading noise

**What this is:** real Frontier maker/taker orders against the **canonical**
YES book so the orderbook + leaderboard look alive.

- Forge deploy + seed: `packages/contracts/script/DeployDarkBox.s.sol`
- Order placement harness: `packages/contracts/script/live-anvil-e2e.sh`

```bash
# Do NOT run in this environment (per task). Reference invocation only:
#   packages/contracts/script/live-anvil-e2e.sh
# It reads canonicalMarket.{yesBook} from deployments/darkbox-latest.json and
# places a maker limit (deposit across ticks) + a taker market buy via the router.
```

⚠️ **Two hard caveats — verify before pointing this at the fresh chain:**

1. **It uses well-known anvil dev keys** (`0xac09…`, `0x59c6…` in
   `live-anvil-e2e.sh:25-28`). These are throwaway local keys. **Never reuse them
   as funded accounts on a chain anyone else can reach.** For a real demo, place
   seed orders from controlled keys instead.
2. **It only trades the single canonical book.** It is hardwired to
   `canonicalMarket.yesBook`. It does **not** trade markets the executor creates
   from proposals. Those dynamic markets get **zero** seed liquidity.

> Why this matters: the trading daemons (`services/agents/src/noise.ts`) are
> **paper-only** — they fetch `/public/markets`, compute decisions, and POST them
> back to the indexer for reconciliation, but **never submit on-chain orders**
> (`noise.ts:492`, `:526`: "No live orderbook submission is wired into this
> runner yet"). So the *only* real on-chain trades come from this seed, and only
> on the canonical book. See audit gap #2.

**Rollback:** seed orders are normal Frontier orders; there is no special undo.
On a throwaway demo chain, re-deploy to reset state.

---

## Step 5 — Cut the gateway over to the new core

The gateway is the only public edge; the frontend never talks to the indexer
directly. `INDEXER_INTERNAL_URL` (`services/gateway/src/config.ts:21`, default
`http://localhost:8080`) backs three paths: the `/public/*` proxy
(`publicProxy.ts`), withdrawal balance reads (`withdrawals.ts`), and
`self/status` (`self.ts`). A wrong value silently breaks all of them.

```bash
# Point the gateway at the fresh core's indexer internal origin, then restart it.
# (set in the gateway member's sealed env / compose, not in repo)
#   INDEXER_INTERNAL_URL=http://<fresh-core-indexer-host>:8080
docker restart darkbox-gateway   # or the mesh equivalent

# health
curl -sf $GW/health && echo OK
```

**Pass:** `/health` OK and step 6 reads return fresh-chain data.

**Rollback:** revert `INDEXER_INTERNAL_URL` to the previous core's indexer origin
and restart the gateway. This is a single-env-var, fast rollback — the gateway is
stateless w.r.t. the indexer. Keep the old core indexer reachable until step 6
passes so rollback is instant.

---

## Step 6 — Verify `/public/markets` + leaderboard

All reads go **through the gateway proxy** (only `/public/*` is forwarded;
`/internal/*` is never reachable from the edge).

```bash
# markets — expect the canonical market + any smoke/executor-created markets,
# each with question, status 'Active', and non-zero close_time/resolve_by
curl -s $GW/public/markets | python3 -m json.tool | head -60

# a single market
curl -s $GW/public/markets/<marketId> | python3 -m json.tool

# leaderboard — backed by indexed trades -> positions -> mark-to-market PnL,
# refreshed on the indexer's snapshot timer
curl -s $GW/public/leaderboard | python3 -m json.tool | head -40
```

**Pass:** markets list is non-empty and includes the expected markets; the
canonical market shows YES/NO/trade prices once the seed (step 4) has run;
leaderboard returns entries (may lag by one snapshot interval).

**Caveats:** leaderboard PnL has known accounting gaps — see
`services/indexer/PNL_BLOCKERS.md` (router/executor taker attribution, requote /
transfer accounting, multi-level `RunFilled` reconstruction). Treat ranking as
indicative, not settlement-grade, for the demo.

**Rollback:** if reads are empty/stale, confirm the gateway points at the fresh
core (step 5) and the indexer is caught up (`cast block-number` vs the indexer's
last processed block). The on-chain `MarketCreated`/`BooksRegistered` reducer and
the executor write-back are two independent paths into the same `markets` table
(both keyed on `market_id`, conflict-safe), so a market should appear even if one
path lags.

---

## Step 7 — Notify the team

Post in the DarkBox Telegram group (chat `-1003946790386`) once steps 1–6 pass:

- fresh chain (88813) verified — factory + canonical market live
- market-executor deployed, e2e smoke PASS
- gateway cut over to the new core; `/public/markets` + leaderboard live
- **explicitly call out the open gaps** below so nobody demos a path that isn't
  wired (resolution, faucet, live daemon trading, group-confirm trigger)

---

<a id="readiness-audit--gaps"></a>
## Readiness audit — gaps (the important part)

Grounded in merged `main`. Each gap has file:line evidence.

### GAP 1 — Group "Confirm" never reaches the executor *(functional blocker for the advertised flow)*
The market-executor polls **only** `status=approved`
(`services/market-executor/src/indexerClient.ts:55`). But the group-member
**Confirm** button sets status **`confirmed`**, not `approved`
(`services/market-approval-bot/src/index.ts:76`). **No code anywhere promotes
`confirmed → approved`.** Only the admin/operator-gated **"Admin approve"**
action sets `approved` (`index.ts:72-76`). Yet the bot posts to the group: *"One
DarkBox group confirmation makes this ready for the market executor"*
(`services/market-approval-bot/src/telegram.ts:23`) — which is false. A
group-confirmed market sits at `confirmed` forever.
**Fix:** either have the executor also pull `confirmed`, or add a
`confirmed → approved` promotion. **Workaround for the demo:** use the admin
"Admin approve" button (an operator/admin Telegram id), not group confirm.

### GAP 2 — No live daemon trading; dynamic markets get zero liquidity *(blocker for "daemons trade on created markets")*
Both daemons are **paper/dry-run only**. `services/agents/src/noise.ts` fetches
`/public/markets` and `/public/leaderboard` (`noise.ts:476-480`), maps **all**
markets into observations (so discovery *is* dynamic), but **never submits
on-chain orders** — it only POSTs decisions to `/internal/v0/agent-turns` for
reconciliation and tracks an in-memory paper portfolio (`noise.ts:492`, `:526`,
`:625-644`). The Python `event_agents` adapter says the same
(`services/agents/event_agents/indexer_adapter.py:9-12`). The **only** real
on-chain orders come from the seed (`live-anvil-e2e.sh`), hardwired to the single
canonical book using anvil dev keys. **Net:** executor-created markets receive no
trading; the canonical market gets trades only from the seed.
**Fix:** implement on-chain order submission in the daemon (the documented TODO),
and have the seed/daemons trade discovered markets, not just the canonical book.

### GAP 3 — Faucet is not wired *(blocker for "$5 to humans + daemons")*
The faucet is "library + spec + tests", not a running service. `FaucetCoordinator`
(`services/bridge/src/faucet.ts`) has working enqueue/dedupe/process logic and
passing tests, but: the bridge has **no HTTP server and no worker loop**
(`services/bridge/src/index.ts` is a barrel of `export *`); the
`/internal/faucet/human-promo` + `/internal/faucet/daemon-funding` routes the
gateway (`services/gateway/src/faucetClient.ts:7`) and CLI
(`services/bridge/scripts/fund-daemons.ts:60`) POST to **do not exist**; the
ledger is an **in-memory `Map`** (`services/bridge/src/store.ts:54`), lost on
restart; `FaucetCoordinator` is instantiated **only in tests**;
`services/faucet-mint-worker` **does not exist** (branch only). Result: the human
`/api/invites/claim` path produces a **cosmetic `fundingStatus: "promo_funded"`**
(`services/gateway/src/routes/self.ts:57`) with **no actual sUSDC mint**, and
daemons are never funded.
**Fix:** merge `faucet-mint-worker` — a bridge HTTP service exposing the two
routes, a worker calling `processNext()` with a funded shadow-mint signer, backed
by a durable store.

### GAP 4 — Market resolution is missing *(blocker for "market closes/resolves")*
The on-chain functions exist (`DarkBoxMarketFactory.closeMarket` /
`resolveMarket` / `voidMarket`; `DarkBoxBinaryMarket.close/resolve/voidMarket`),
and the indexer **reacts** to `MarketClosed`/`MarketResolved`/`MarketVoided`
(`services/indexer/src/reducers/pm.ts:145-185`). But **no merged off-chain actor
ever sends those transactions.** `market-executor` is **create-only**
(`executor.ts` calls only `createMarket`). `services/resolution-executor` **does
not exist** (branch `dan-resolution-executor`). `packages/shared/src/marketPolicy.ts`
(`buildResolutionDossier`, `validateMarket`) is validation-only and **imported by
no service**. The smoke test's resolution step targets an unmerged route
(`/internal/markets/:id/prepare-resolution`). **Net:** resolution today is a
**manual key operation** (owner/resolver calls the factory by hand).
**Fix:** merge `resolution-executor` — a service that detects markets past
`resolve_by`, determines the outcome, and sends `resolveMarket` from the
owner/resolver key.

### GAP 5 — ETHGlobal ingest → agent proposals is three disconnected islands *(blocker for "data → agent proposes a market")*
1. **Ingest mirror** (`services/indexer/src/ethglobal/*`, migration
   `007_ethglobal_ingest.sql`) works but is a **manual one-shot CLI**
   (`pnpm ingest:ethglobal`) — not scheduled, not in compose — and **nothing
   reads its output** endpoints (`/internal/context/ethglobal*`) or tables.
2. **`event_agents`** (Python) has a **working proposal output** path (with
   `--submit-url` it POSTs to `/internal/v0/agent-turns` →
   `market_proposals`), but its proposal **input is static fixtures/config**
   (`strategy.py` `proposalCandidates`), **not** the ingested data; and it is
   **not in any deployment** (not in the agents `Dockerfile` or compose — only
   invoked by smoke/testnet shell scripts).
3. The actually-deployed TS agent `noise.ts` references ETHGlobal data but reads
   **non-existent static files** (`data/ethglobal/...`, absent from the repo) and
   falls back to hardcoded strings.
**Net:** the "ingest the hackathon → propose markets about it" loop is **not
closed**. **Fix:** point `event_agents` (or `noise.ts`) at the ingest endpoints,
schedule the ingest, and deploy the proposing agent.

### Secondary / hygiene
- **market-executor absent from `docker-compose.yml`** and its env absent from
  `.env.cvm.example` — it lives only in the PR #24 mesh stanza. Easy to forget on
  a non-mesh bring-up.
- **PR #24 / #25 not on `main`** — the doc this runbook references and the smoke
  test both need merging (or running from branch) for steps 2–3.
- **Leaderboard PnL caveats** — `services/indexer/PNL_BLOCKERS.md`.
- **Token-zeroing on executor crash-recovery** — if a `createMarket` receipt
  lacks `BooksRegistered`, tokens are zeroed and back-filled later by the on-chain
  reducer; generally self-heals (`services/market-executor/src/factory.ts:159-165`).

### Bottom line
The **market-creation half** of the workstream is real and demo-able:
propose (admin-approve) → executor → on-chain → indexed → `/public/markets` →
gateway → frontend, with the seed providing real orders on the canonical book.
The **liveness/automation half** — group-confirm trigger, autonomous daemon
trading, faucet funding, and resolution — is **not wired in merged code** and is
spread across four unmerged branches (`dan-faucet-mint-worker`,
`dan-resolution-executor`, `dan/deploy-wire-market-services`,
`dan/e2e-market-smoke`). Go live on the creation path; gate the rest behind those
merges.
