/**
 * End-to-end smoke test for the DarkBox prediction-market lifecycle.
 *
 * Drives the full propose -> confirm -> approve -> (executor) deploy -> public
 * read flow against a LIVE mesh by talking only to the indexer's HTTP surface
 * (internal + public). It creates ONE throwaway test market per run (unique
 * proposal id), so it's safe to run repeatedly against the live system.
 *
 * It does NOT run the executor itself: the market-executor worker in the mesh
 * polls `status=approved` proposals, calls the on-chain factory, and writes the
 * result back via `POST /internal/market-proposals/:id/deployed`. This script
 * approves a proposal and then WAITS for that worker to deploy it, which is the
 * realistic end-to-end assertion for "the lifecycle works against the mesh".
 *
 * Steps
 *   1. PROPOSE   POST /internal/market-proposals               -> status 'proposed'
 *   2. CONFIRM   POST /internal/market-proposals/:id/decision  -> status 'confirmed'
 *      APPROVE   POST /internal/market-proposals/:id/decision  -> status 'approved'
 *   3. DEPLOY    (market-executor) poll GET /internal/markets   -> markets row, Active
 *   4. ASSERT    GET /public/markets has the market w/ REAL close_time/resolve_by
 *                (verifies #23: real times threaded through, NOT 0)
 *   5. RESOLVE   (optional, behind RUN_RESOLUTION=1; route not merged yet)
 *                POST /internal/markets/:id/prepare-resolution -> status 'Resolved'
 *
 * Configuration (env)
 *   INDEXER_INTERNAL_URL   base for /internal/* calls. Accepts either the bare
 *                          origin (http://host:8080) or the executor-style base
 *                          that already includes /internal
 *                          (http://host:8080/internal). Trailing /internal and
 *                          slashes are normalized away. REQUIRED.
 *   GATEWAY_PUBLIC_URL     base for /public/* reads via the gateway/public proxy.
 *   INDEXER_PUBLIC_URL     alternative base for /public/* reads (bare origin).
 *                          If neither public var is set, falls back to the
 *                          internal origin's /public.
 *   INTERNAL_API_TOKEN     optional bearer token; sent as `Authorization: Bearer`
 *                          AND `x-internal-token` on internal calls when set (the
 *                          indexer itself is unauthenticated, but a fronting
 *                          proxy in the mesh may require it).
 *   GAME_ID                informational only; logged for context.
 *   AGENT_ID               proposer agent id           (default: smoke-e2e-agent)
 *   DEPLOY_TIMEOUT_MS      wait budget for executor deploy (default: 180000)
 *   POLL_INTERVAL_MS       poll cadence                (default: 3000)
 *   RUN_RESOLUTION         "1"/"true" to attempt the optional resolution step
 *   RESOLUTION_OUTCOME     "Yes" | "No" | "Invalid"    (default: Yes)
 *   RESOLVE_TIMEOUT_MS     wait budget for resolution  (default: 120000)
 *
 * Run
 *   INDEXER_INTERNAL_URL=http://localhost:8080 \
 *     node --import tsx services/indexer/scripts/market-lifecycle.smoke.ts
 *   # or, from the indexer package:
 *   pnpm --filter @darkbox/indexer smoke:market
 *
 * Exit code 0 on PASS, 1 on FAIL.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    fail(`Missing required env: ${name}`);
    printUsage();
    process.exit(1);
  }
  return v.trim();
}

/** Strip trailing slashes and a trailing `/internal` segment -> bare origin+path. */
function normalizeInternalBase(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/internal$/, "");
}

function stripTrailingSlash(raw: string): string {
  return raw.replace(/\/+$/, "");
}

const internalOrigin = normalizeInternalBase(reqEnv("INDEXER_INTERNAL_URL"));
const internalBase = `${internalOrigin}/internal`;
const publicBase = (() => {
  const gw = process.env["GATEWAY_PUBLIC_URL"]?.trim();
  const pub = process.env["INDEXER_PUBLIC_URL"]?.trim();
  if (gw) return `${stripTrailingSlash(gw).replace(/\/public$/, "")}/public`;
  if (pub) return `${stripTrailingSlash(pub).replace(/\/public$/, "")}/public`;
  return `${internalOrigin}/public`;
})();

const internalToken = process.env["INTERNAL_API_TOKEN"]?.trim() || "";
const gameId = process.env["GAME_ID"]?.trim() || "(unset)";
const agentId = process.env["AGENT_ID"]?.trim() || "smoke-e2e-agent";
const deployTimeoutMs = numEnv("DEPLOY_TIMEOUT_MS", 180_000);
const pollIntervalMs = numEnv("POLL_INTERVAL_MS", 3_000);
const runResolution = /^(1|true|yes)$/i.test(process.env["RUN_RESOLUTION"]?.trim() || "");
const resolutionOutcome = process.env["RESOLUTION_OUTCOME"]?.trim() || "Yes";
const resolveTimeoutMs = numEnv("RESOLVE_TIMEOUT_MS", 120_000);

function numEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Unique-per-run identifiers so re-runs never collide and the question dedupe
// guard in the indexer doesn't reject us. The question text is unique too.
const runStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const proposalId = `smoke-e2e-${runStamp}`;
const question = `[SMOKE e2e ${runStamp}] Will the DarkBox market lifecycle pass this run?`;

// ─── Logging helpers ─────────────────────────────────────────────────────────

let stepNum = 0;
function step(title: string): void {
  stepNum += 1;
  console.log(`\n── STEP ${stepNum}: ${title} ───────────────────────────────────`);
}
function info(msg: string, extra?: unknown): void {
  if (extra !== undefined) console.log(`   • ${msg}`, json(extra));
  else console.log(`   • ${msg}`);
}
function ok(msg: string): void {
  console.log(`   ✓ ${msg}`);
}
function fail(msg: string): void {
  console.error(`   ✗ ${msg}`);
}
function json(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printUsage(): void {
  console.error(
    [
      "",
      "Usage:",
      "  INDEXER_INTERNAL_URL=http://host:8080 \\",
      "    node --import tsx services/indexer/scripts/market-lifecycle.smoke.ts",
      "",
      "Required: INDEXER_INTERNAL_URL",
      "Optional: GATEWAY_PUBLIC_URL | INDEXER_PUBLIC_URL, INTERNAL_API_TOKEN, GAME_ID,",
      "          AGENT_ID, DEPLOY_TIMEOUT_MS, POLL_INTERVAL_MS, RUN_RESOLUTION,",
      "          RESOLUTION_OUTCOME, RESOLVE_TIMEOUT_MS",
      "",
    ].join("\n"),
  );
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

type Json = Record<string, unknown> | unknown[] | null;

function internalHeaders(withBody: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (withBody) h["content-type"] = "application/json";
  if (internalToken) {
    h["authorization"] = `Bearer ${internalToken}`;
    h["x-internal-token"] = internalToken;
  }
  return h;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Json> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${truncate(text, 300)}`);
  }
  return parseBody(text, url);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Json> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status} ${truncate(text, 400)}`);
  }
  return parseBody(text, url);
}

function parseBody(text: string, url: string): Json {
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${truncate(text, 200)}`);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── Domain helpers ──────────────────────────────────────────────────────────

type ProposalRow = Record<string, unknown> & { proposal_id?: string; status?: string };
type MarketRow = Record<string, unknown> & {
  market_id?: string;
  status?: string;
  question?: string;
  close_time?: string | number;
  resolve_by?: string | number;
  yes_book?: string | null;
  no_book?: string | null;
};

function asRows<T>(v: Json): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** A close_time / resolve_by is "real" iff it parses to a positive integer. */
function isRealTime(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) && n > 0;
}

async function fetchProposal(): Promise<ProposalRow | null> {
  // The list route filters by a single status, so fetch unfiltered (most-recent
  // first) and find ours by proposal_id — works regardless of current status.
  const rows = asRows<ProposalRow>(
    await getJson(`${internalBase}/market-proposals?limit=500`, internalHeaders(false)),
  );
  return rows.find((r) => r.proposal_id === proposalId) ?? null;
}

async function fetchInternalMarket(marketId: string): Promise<MarketRow | null> {
  const rows = asRows<MarketRow>(
    await getJson(`${internalBase}/markets`, internalHeaders(false)),
  );
  return rows.find((m) => String(m.market_id).toLowerCase() === marketId.toLowerCase()) ?? null;
}

async function fetchPublicMarket(marketId: string): Promise<MarketRow | null> {
  const rows = asRows<MarketRow>(await getJson(`${publicBase}/markets`));
  return rows.find((m) => String(m.market_id).toLowerCase() === marketId.toLowerCase()) ?? null;
}

// ─── Steps ───────────────────────────────────────────────────────────────────

async function stepPropose(): Promise<void> {
  step("PROPOSE a market");
  // resolveBy must be an ISO date string (shared marketProposalSchema); pick a
  // week out. closeTime is parsed by the indexer (parseMarketCloseTimeSeconds);
  // send a concrete unix-seconds value so the proposal carries a real time.
  const closeUnix = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const resolveByIso = new Date((closeUnix + 24 * 60 * 60) * 1000).toISOString();
  const payload = {
    proposalId,
    agentId,
    question,
    description: `Throwaway market created by the e2e market-lifecycle smoke test (run ${runStamp}).`,
    outcomes: ["YES", "NO"],
    resolveBy: resolveByIso,
    resolutionSource: "DarkBox e2e smoke test",
    rationale: "Exercises propose -> confirm -> approve -> deploy -> public read.",
    closeTime: closeUnix,
    proposerKind: "internal",
    proposerId: "e2e-smoke",
    proposerRole: "operator",
  };
  info(`POST ${internalBase}/market-proposals`, { proposalId, closeTime: closeUnix });
  const res = (await postJson(
    `${internalBase}/market-proposals`,
    payload,
    internalHeaders(true),
  )) as Record<string, unknown> | null;
  if (!res || res["status"] !== "ok" || res["proposalId"] !== proposalId) {
    throw new Error(`unexpected create response: ${json(res)}`);
  }
  ok(`proposal accepted (resolverType=${json(res["resolverType"])}, closeTime=${json(res["closeTime"])})`);

  const row = await fetchProposal();
  if (!row) throw new Error("proposal not found after create");
  if (row.status !== "proposed") {
    throw new Error(`expected status 'proposed', got '${row.status}'`);
  }
  ok(`proposal is queued with status 'proposed'`);
}

async function stepDecision(status: "confirmed" | "approved"): Promise<void> {
  step(`${status.toUpperCase()} the proposal`);
  const body = {
    status,
    actorKind: "internal",
    actorId: "e2e-smoke",
    actorRole: "operator",
    reviewedBy: "e2e-smoke",
  };
  info(`POST ${internalBase}/market-proposals/${proposalId}/decision`, { status });
  const row = (await postJson(
    `${internalBase}/market-proposals/${encodeURIComponent(proposalId)}/decision`,
    body,
    internalHeaders(true),
  )) as ProposalRow | null;
  if (!row || row.status !== status) {
    throw new Error(`expected status '${status}', got '${json(row?.status)}'`);
  }
  ok(`proposal moved to '${status}'`);
}

async function stepWaitForDeploy(): Promise<MarketRow> {
  step("EXECUTOR deploys the market (poll until Active)");
  info("waiting for the market-executor to pick up the approved proposal", {
    deployTimeoutMs,
    pollIntervalMs,
  });
  const deadline = Date.now() + deployTimeoutMs;
  let lastProposalStatus = "approved";
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const prop = await fetchProposal();
    if (prop && prop.status !== lastProposalStatus) {
      lastProposalStatus = String(prop.status);
      info(`proposal status -> '${lastProposalStatus}'`, {
        marketId: prop["market_id"] ?? null,
      });
    }
    if (prop && lastProposalStatus === "deploy_failed") {
      throw new Error(`executor reported deploy_failed: ${json(prop["deploy_error"])}`);
    }

    const marketId = prop && typeof prop["market_id"] === "string" ? (prop["market_id"] as string) : "";
    if (marketId) {
      const market = await fetchInternalMarket(marketId);
      if (market) {
        const hasBooks = Boolean(market.yes_book) && Boolean(market.no_book);
        if (market.status === "Active" && hasBooks) {
          ok(`market deployed: market_id=${market.market_id} status=Active`);
          info("books", { yes_book: market.yes_book, no_book: market.no_book });
          return market;
        }
        info(`market row present but not yet ready`, {
          status: market.status,
          hasBooks,
        });
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `timed out after ${deployTimeoutMs}ms waiting for executor to deploy the market ` +
      `(last proposal status='${lastProposalStatus}', attempts=${attempts}). ` +
      `Is the market-executor running and pointed at this indexer?`,
  );
}

async function stepAssertPublic(marketId: string): Promise<void> {
  step("ASSERT /public/markets exposes the market with REAL close_time/resolve_by");
  // Eventual consistency: the public read hits the same DB, but give it a few
  // polls in case of a read replica / cache in front of the gateway.
  const deadline = Date.now() + Math.min(deployTimeoutMs, 30_000);
  let market: MarketRow | null = null;
  while (Date.now() < deadline) {
    market = await fetchPublicMarket(marketId);
    if (market) break;
    await sleep(pollIntervalMs);
  }
  if (!market) {
    throw new Error(`market ${marketId} not visible on ${publicBase}/markets`);
  }
  ok(`market present on /public/markets (question=${truncate(String(market.question), 60)})`);

  if (!isRealTime(market.close_time)) {
    throw new Error(
      `close_time is not a real time (got ${json(market.close_time)}) — #23 regression`,
    );
  }
  if (!isRealTime(market.resolve_by)) {
    throw new Error(
      `resolve_by is not a real time (got ${json(market.resolve_by)}) — #23 regression`,
    );
  }
  ok(
    `close_time=${json(market.close_time)} resolve_by=${json(market.resolve_by)} ` +
      `(both non-zero — #23 fix verified)`,
  );
}

/**
 * Optional resolution lane. The prepare-resolution route is NOT merged yet, so
 * this is best-effort: a 404 (route missing) is treated as SKIPPED, not FAILED.
 * Only enabled when RUN_RESOLUTION is set.
 */
async function stepResolution(marketId: string): Promise<"passed" | "skipped"> {
  step("RESOLVE the market (optional)");
  const url = `${internalBase}/markets/${encodeURIComponent(marketId)}/prepare-resolution`;
  info(`POST ${url}`, { outcome: resolutionOutcome });
  try {
    await postJson(url, { outcome: resolutionOutcome }, internalHeaders(true));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/-> 404/.test(msg) || /-> 405/.test(msg)) {
      info("prepare-resolution route not available yet — skipping resolution", { detail: msg });
      return "skipped";
    }
    throw err;
  }
  info("resolution prepared; polling until status='Resolved'", { resolveTimeoutMs });
  const deadline = Date.now() + resolveTimeoutMs;
  while (Date.now() < deadline) {
    const market = await fetchInternalMarket(marketId);
    if (market && market.status === "Resolved") {
      ok(`market resolved (resolved_outcome=${json(market["resolved_outcome"])})`);
      return "passed";
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`timed out after ${resolveTimeoutMs}ms waiting for status='Resolved'`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("DarkBox market-lifecycle e2e smoke test");
  console.log("=".repeat(60));
  info("config", {
    internalBase,
    publicBase,
    gameId,
    agentId,
    proposalId,
    authToken: internalToken ? "set" : "unset",
    runResolution,
  });

  // Sanity: indexer reachable.
  step("Preflight — indexer health");
  const health = (await getJson(`${internalBase}/health`, internalHeaders(false))) as Record<
    string,
    unknown
  > | null;
  if (!health || health["status"] !== "ok") {
    throw new Error(`indexer internal health not ok: ${json(health)}`);
  }
  ok(`indexer internal endpoint healthy (service=${json(health["service"])})`);

  await stepPropose();
  await stepDecision("confirmed");
  await stepDecision("approved");
  const market = await stepWaitForDeploy();
  const marketId = String(market.market_id);
  await stepAssertPublic(marketId);

  let resolutionResult: "passed" | "skipped" | "disabled" = "disabled";
  if (runResolution) {
    resolutionResult = await stepResolution(marketId);
  } else {
    step("RESOLVE the market (optional)");
    info("RUN_RESOLUTION not set — skipping resolution lane (steps 1-4 are the pass gate)");
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("RESULT: PASS");
  console.log(`  market_id        : ${marketId}`);
  console.log(`  proposal_id      : ${proposalId}`);
  console.log(`  resolution lane  : ${resolutionResult}`);
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`\n${"=".repeat(60)}`);
    console.error("RESULT: FAIL");
    console.error(msg);
    console.error("=".repeat(60));
    process.exit(1);
  });
