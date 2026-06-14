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
members run on bigger flavors. Exact targets (dstack prod5 `tdx` catalog):

- **Core → `tdx.xlarge` (8 vCPU / 16 GB).** The largest *practical* tier — the true
  max (`tdx.8xlarge` / 128 GB) is 8× the cost and overkill. Over-provisioned for
  good measure.
- **geth-2 → `tdx.large` (4 vCPU / 8 GB).** Light, but it carries a chain **signer**.
- Other members (gateway / signer / bastion) stay `tdx.small` (genuinely tiny).
- **Cost:** core $0.464 + geth-2 $0.232 + 3×`tdx.small` $0.058 ≈ **$0.87/hr (~$21/day)**,
  up from ~$0.29/hr — fine for a demo.
- **The 8 vCPU (vs 1) matters as much as the RAM:** the sidecar convergence
  degradation (`live_peers` 6→3→0) is likely **CPU** starvation — 1 vCPU shared
  across 8 containers — so the bump should fix the convergence too. (The 1 GB
  sidecar mem_limit was never the constraint; CPU was.)
- ⚠️ **Changing `instance-type` requires a FRESH CVM** (not an in-place `--cvm-id`
  update). The chaindata/db re-sync is the delicate part — see the sequenced
  procedure below.

### 2. Per-service `mem_limit` / `mem_reservation` (defense in depth)

Added to every service in `darkbox-geth-1-core.yaml` and `darkbox-geth-2.yaml`.
These contain any single-container balloon to that container — it restart-loops
alone, the pod stays up.

**Core member (`tdx.xlarge`, 16 GB):**

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

Caps sum ≈ 12.25 GB and reservations ≈ 4.5 GB — on 16 GB even the (rare) all-at-max
case fits, so the OOM-killer should essentially never fire under normal operation.
The caps still stop a genuine runaway before it can eat the CVM.

**geth-2 member (`tdx.large`, 8 GB):** geth-2 `4g`/`1.5g`, sidecar `1g`/`512m`,
sshd `256m`/`64m` (≈ 5.25 GB caps).

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

## Un-freeze procedure (STRICT SEQUENCE — chain-integrity-gated)

Deploys are FROZEN until this lands. ⚠️ The contracts (factory `0xC37d6ce4…` + the
canonical market) live **ONLY** in the two geth chaindata volumes — a fresh CVM has
empty `gethdata` and must re-sync from the OTHER geth. So `/public/markets` 200 is
**NOT** a sufficient gate (the indexer can serve stale/empty data while the chain
regressed). Gate on the CHAIN, in this exact order:

1. **Review + merge this PR.** (Overseer has infra-signed-off.)
2. **Redeploy the BASTION with the debug keys FIRST** (env-only, quick, no flavor
   change). The bump only recreates core + geth-2; the bastion + gateway are NOT
   flavor-bumped, so they keep their current `authorized_keys` until redeployed — and
   the bastion is the operator's SSH entry point for the live checks below, so it MUST
   get the keys BEFORE the bump. (Dan's, Ocean's, and DarkDan's `darkdan@darkbox-debug`
   keys are already appended to the sealed bastion env.)
3. **(recommended) Snapshot geth-1's `gethdata` first** if the bastion can reach the
   volume — there is NO other backup of the contracts.
4. **Bump geth-2 FIRST → `tdx.large`** (fresh CVM, empty gethdata → re-syncs from
   geth-1). **Expect a clique stall:** with one geth being recreated the other is the
   sole active signer, so block height FREEZES until the new geth catches up +
   co-signs. Normal, not a failure.
5. **CHAIN-INTEGRITY GATE (the real gate):** from a geth RPC (via the bastion), verify
   on geth-2 that `eth_getCode(0xC37d6ce4…)` is **non-empty** AND its block height ≈
   geth-1's. **Do NOT proceed to geth-1 until geth-2 holds the FULL chain.**
6. **Only THEN bump core/geth-1 → `tdx.xlarge`** (fresh: empty gethdata re-syncs from
   the now-good geth-2; empty db_data → indexer re-scans from block 1). Expect another
   clique stall during the recreation.
7. **Gates before declaring success:**
   - **chain-integrity:** `eth_getCode(0xC37d6ce4…)` non-empty on geth-1 + height
     parity with geth-2;
   - **markets:** `/public/markets` returns the ACTUAL market (**non-empty array**) —
     `[]` is also a 200 and would pass prematurely during the re-scan;
   - **sidecar healthz** green.
   Auto-rollback to the prior (still-running) core on any failure.
8. **Endpoint handover:** fresh CVMs get new app_ids → new deterministic mesh IPs. As
   each fresh member registers, the overseer hands the operator the NEW bastion app_id
   (→ `<app_id>-2222s` SSH endpoint for the ProxyCommand) + the NEW core/geth-2 mesh
   IPs (gateway + signer keep their current app_ids/IPs — not bumped). The operator
   connects via the bastion to run the step-5 / step-7 checks.
9. Only after all gates green → resume feature deploys, one branch / PR / review at a
   time.

## Incident-response standard (codify what worked)

- **Roll back first, diagnose second.** Recovery from the OOM was: remove the
  offending service → core recovered → markets live → THEN root-cause. Make that
  standard for any core regression.
- **Pin images by digest** so rollback/redeploy is deterministic (dstack caches
  `:latest`).
- **Gate on chain-integrity, not just HTTP 200** (see above) for any geth recreation.
- **Serialize mesh changes** — never two operators/agents redeploying core at once,
  and never recreate both geth members at the same time.
