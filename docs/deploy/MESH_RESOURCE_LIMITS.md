# Mesh resource limits & the core CVM flavor

## What happened (the OOM cascade)

The core member (`darkbox-geth-1-core`) was deployed on **`tdx.small` — 1 vCPU /
2 GB RAM / 20 GB disk / NO swap** (dstack auto-selected the default flavor). That
pod runs 7 containers at steady state — sidecar + geth-1 + indexer + bridge +
transcriber + reveal + postgres — and an **8th** when the `agents` service is added.

geth + postgres + a Node indexer alone routinely want well over 2 GB. With **no
swap** there is zero cushion. When the `agents` container's ETHGlobal showcase
loop pulled + cached 275 project JSONs (plus a resolver/LLM pass), it pushed the
CVM over its 2 GB ceiling, the kernel **OOM-killer** fired and killed an arbitrary
process — and because **every container shares the sidecar's network namespace**
(`network_mode: service:sidecar`), the death cascaded the WHOLE pod: sidecar
healthz → unreachable, indexer down, `/public/markets` → 502 for ~10 min.

The core was already living on the edge **before** agents; agents was the push
over the line.

## The fix — three parts (limits alone are NOT enough)

### 1. Bump the CVM flavor — go big  ⚠️ required, and needs a FRESH CVM

`mem_limit` per service contains an OOM to one container, but you **cannot carve
sane limits out of 2 GB** — they would just individually OOM-restart-loop. The
members must run on bigger flavors. **We are deliberately over-provisioning for
good measure** — headroom is cheap insurance against a recurrence, and it also
unstarves the sidecar (see the convergence note below):

- **Core (the fat member): bump to the LARGEST practical flavor — target ~16 GB**
  (the top `tdx` tier; overseer confirms the exact name at apply time). Don't
  tightly right-size; provision generously.
- **geth-2: bump off `tdx.small` to a roomier flavor (~8 GB).** It's light, but it
  carries a chain **signer** — if it OOMs the 2-signer clique stalls, so it gets
  headroom too.
- The other members (gateway / signer / bastion) are genuinely tiny (1–2 light
  containers) and can stay small, but bump any that feel close.
- ⚠️ **Changing `instance-type` almost certainly requires a FRESH CVM**, not an
  in-place `--cvm-id` update — a clean redeploy. The `gethdata` (chaindata) and
  `db_data` (postgres) volumes must be **migrated or re-synced**: geth re-syncs
  from its peer and the indexer rebuilds derived state from the chain, so a
  re-sync is acceptable — **but sequence it** (don't destroy the only copy of
  chaindata if both geth members are recreated at once).
- **Bonus:** the 2 GB starvation is the leading explanation for the core sidecar's
  convergence degradation (`live_peers` 6→3→0 across redeploys) — the Rust
  mesh-agent's wg/heartbeat work competing for memory under constant pressure. A
  bigger flavor + the sidecar's own headroom (1 GB) likely fixes the OOM fragility
  **and** the convergence in one move.

### 2. Per-service `mem_limit` / `mem_reservation` (defense in depth)

Added to every service in `darkbox-geth-1-core.yaml` and `darkbox-geth-2.yaml`.
These contain any single-container balloon to that container — it restart-loops
alone, the pod stays up. Sized generously for the bumped flavors:

**Core member (≈16 GB):**

| service     | mem_limit | mem_reservation |
|-------------|-----------|-----------------|
| geth-1      | 4g        | 1.5g            |
| postgres    | 3g        | 1g              |
| indexer     | 2g        | 1g              |
| sidecar     | 1g        | 512m            |
| bridge      | 1g        | 256m            |
| transcriber | 512m      | 128m            |
| reveal      | 512m      | 128m            |
| sshd        | 256m      | 64m             |

Caps sum ≈ 12.25 GB and reservations ≈ 4.5 GB — on a ~16 GB core, even the (rare)
all-at-max case fits, so the OOM-killer should essentially never fire under normal
operation. The caps still stop a genuine runaway before it can eat the CVM.

**geth-2 member (≈8 GB):** geth-2 `4g`/`1.5g`, sidecar `1g`/`512m`, sshd `256m`/`64m`.

> If a chosen flavor ends up smaller than assumed, scale the table down — but do
> **not** apply these to a 2 GB CVM (the caps don't fit).

### 3. Relocate the `agents` service off the core failure domain

The `agents` service (ETHGlobal showcase loop + resolver) is **removed from the
core compose**. Even with a bigger flavor, a heavy/optional data feed should not
share a failure domain with geth/indexer/markets. When revived it goes on its own
right-sized member with its own hard `mem_limit`.

## ETHGlobal showcase feed — deferred redesign

The feed is genuinely useful (gives agents real ETHGlobal project data to reason
on) but caused the OOM **and** was written in TS while the canonical agents are now
Python (`services/agents/event_agents/`). When revived:

- Build it for the Python `event_agents` runtime, not the old TS harness.
- Run it on its **own dedicated member** (or a sidecar with a hard `mem_limit`),
  never on the fat core.
- Cache to a **bounded** store — cap the on-disk snapshot size and stream rather
  than holding all 275 projects in memory.

## Un-freeze procedure (sequenced)

Deploys are FROZEN until this lands. To un-freeze:

1. Review + merge this PR (compose limits + `agents` removed + this doc).
2. Overseer: provision a **fresh** core CVM at the bumped flavor (~16 GB) — and
   geth-2 at ~8 GB — migrate / re-sync `gethdata` + `db_data`, deploy the limited
   composes, re-allowlist.
3. Health-gate: confirm sidecar healthz + `/public/markets` 200 **before**
   declaring success; roll back to the current (healthy, frozen) core on any failure.
4. Only then resume feature deploys — one branch / one PR / one review at a time.

## Incident-response standard (codify what worked)

- **Roll back first, diagnose second.** Recovery here was: remove the offending
  service → core recovered → markets live → THEN root-cause. Make that standard for
  any core regression.
- **Pin images by digest** so rollback/redeploy is deterministic (dstack caches
  `:latest`).
- **Health-gate every core redeploy** (sidecar healthz + `/public/markets` 200),
  auto-rollback to last-known-good on failure.
- **Serialize mesh changes** — never two operators/agents redeploying core at once.
