// Resolver agent — propose-then-confirm market resolution.
//
// Runs in the same loop as the showcase pull. For each unresolved DarkBox market
// it gathers evidence (ETHGlobal showcase JSON for hackathon questions, or the
// live indexer's leaderboard/prices/game aggregates for market-about-market
// questions), asks the Phala confidential-LLM brain whether it can be resolved,
// and writes a resolution DOSSIER to the cache volume for human approval.
//
// SAFETY: this never submits an on-chain resolveMarket tx. It only proposes.
// A separate, human-gated step (with the CVM-born resolver key) does the actual
// resolution. Every dossier carries state:"proposed", onChainSubmitted:false.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolutionBrain, ResolutionVerdict } from './phalaBrain.js';

// Raw market row from GET /internal/markets (SELECT * FROM markets). Snake_case,
// fields tolerated as optional — the indexer schema may add columns over time.
interface MarketRow {
  market_id: string;
  question?: string | null;
  status?: string | null;
  resolved_outcome?: string | null;
  resolver_type?: string | null;
  close_time?: number | null;
  latest_yes_price?: string | null;
  latest_no_price?: string | null;
  latest_trade_price?: string | null;
  [k: string]: unknown;
}

export interface ResolutionDossier {
  marketId: string;
  question: string;
  status: string | null;
  resolverType: string | null;
  evidenceCategory: 'ethglobal' | 'market' | 'mixed';
  assessedAt: string;
  brainModel: string;
  verdict: ResolutionVerdict;
  // sha256 over the canonical dossier core — the bytes32 we'd pass to
  // resolveMarket(...) as resolutionHash when a human approves.
  resolutionHash: `0x${string}`;
  // Snapshot of the evidence shown to the brain, for auditability.
  evidence: unknown;
  state: 'proposed';
  onChainSubmitted: false;
}

const ETHGLOBAL_RE =
  /ethglobal|ethnewyork|eth new york|new york|hackathon|\bprize\b|sponsor|\bproject\b|finalist|submission|\bbounty\b/i;
const MARKET_RE =
  /leaderboard|\bpnl\b|\bequity\b|\bprice\b|\btrade|\bagent\b|deposit|volume|\brank\b|daemon/i;

function classify(question: string): 'ethglobal' | 'market' | 'mixed' {
  const eth = ETHGLOBAL_RE.test(question);
  const mkt = MARKET_RE.test(question);
  if (eth && !mkt) return 'ethglobal';
  if (mkt && !eth) return 'market';
  return 'mixed';
}

async function fetchJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── ETHGlobal showcase evidence ─────────────────────────────────────────────

interface ProjectCard {
  slug: string;
  name: string;
  tagline: string;
  prizes: string[];
  sponsors: string[];
}

interface ShowcaseEvidence {
  eventName: string | null;
  totalProjects: number;
  prizeCounts: Record<string, number>;
  sponsorCounts: Record<string, number>;
  projects: ProjectCard[];
  truncated: boolean;
}

async function loadShowcaseEvidence(
  showcaseDir: string,
  eventSlug: string,
  charBudget = 60_000,
): Promise<ShowcaseEvidence | null> {
  const eventDir = join(showcaseDir, eventSlug);
  let eventName: string | null = null;
  try {
    const idx = JSON.parse(await readFile(join(eventDir, 'index.json'), 'utf8')) as {
      eventName?: string | null;
    };
    eventName = idx.eventName ?? null;
  } catch {
    return null; // no cache yet
  }

  const projectsDir = join(eventDir, 'projects');
  let files: string[];
  try {
    files = (await readdir(projectsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  const cards: ProjectCard[] = [];
  const prizeCounts: Record<string, number> = {};
  const sponsorCounts: Record<string, number> = {};
  for (const f of files) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(await readFile(join(projectsDir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const prizes: string[] = [];
    const sponsors: string[] = [];
    for (const pr of (p['prizes'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const prize = pr['prize'] as Record<string, unknown> | undefined;
      const prizeName = (prize?.['name'] as string) ?? (pr['name'] as string);
      if (prizeName) {
        prizes.push(prizeName);
        prizeCounts[prizeName] = (prizeCounts[prizeName] ?? 0) + 1;
      }
      const org = (prize?.['sponsor'] as Record<string, unknown> | undefined)?.['organization'] as
        | Record<string, unknown>
        | undefined;
      const sponsorName =
        (org?.['name'] as string) ??
        ((prize?.['sponsor'] as Record<string, unknown> | undefined)?.['name'] as string);
      if (sponsorName) {
        sponsors.push(sponsorName);
        sponsorCounts[sponsorName] = (sponsorCounts[sponsorName] ?? 0) + 1;
      }
    }
    cards.push({
      slug: String(p['slug'] ?? ''),
      name: String(p['name'] ?? ''),
      tagline: String(p['tagline'] ?? '').slice(0, 140),
      prizes,
      sponsors: [...new Set(sponsors)],
    });
  }

  // Trim the project catalog to a char budget so prompts stay bounded.
  let used = 0;
  let truncated = false;
  const trimmed: ProjectCard[] = [];
  for (const c of cards) {
    const cost = JSON.stringify(c).length;
    if (used + cost > charBudget) {
      truncated = true;
      break;
    }
    used += cost;
    trimmed.push(c);
  }

  return {
    eventName,
    totalProjects: cards.length,
    prizeCounts,
    sponsorCounts,
    projects: trimmed,
    truncated,
  };
}

// ── Indexer (market-about-market) evidence ──────────────────────────────────

interface IndexerEvidence {
  leaderboard: unknown;
  game: unknown;
}

async function loadIndexerEvidence(internalUrl: string): Promise<IndexerEvidence> {
  const base = internalUrl.replace(/\/internal\/?$/, '');
  const [leaderboard, game] = await Promise.all([
    fetchJson(`${base}/internal/leaderboard/raw`).catch(() => null),
    fetchJson(`${base}/public/game`).catch(() => null),
  ]);
  return { leaderboard, game };
}

// ── Pass orchestration ──────────────────────────────────────────────────────

function isUnresolved(m: MarketRow): boolean {
  const status = (m.status ?? '').toLowerCase();
  return status !== 'resolved' && status !== 'voided' && !m.resolved_outcome;
}

function hashDossier(core: Record<string, unknown>): `0x${string}` {
  const h = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return `0x${h}`;
}

function safeFileName(marketId: string): string {
  return marketId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface ResolverPassOptions {
  indexerInternalUrl: string;
  showcaseDir: string;
  eventSlug: string;
  outDir: string; // root for resolution artifacts (e.g. /data)
  brain: ResolutionBrain;
  minConfidence?: number;
  log?: (msg: string) => void;
}

export interface ResolverPassResult {
  scanned: number;
  unresolved: number;
  proposed: number;
  errors: number;
}

export async function runResolverPass(opts: ResolverPassOptions): Promise<ResolverPassResult> {
  const log = opts.log ?? (() => {});
  const minConfidence = opts.minConfidence ?? 0.7;
  const base = opts.indexerInternalUrl.replace(/\/internal\/?$/, '');

  const marketsRaw = (await fetchJson(`${base}/internal/markets`)) as MarketRow[];
  const markets = Array.isArray(marketsRaw) ? marketsRaw : [];
  const unresolved = markets.filter(isUnresolved);
  log(`resolver: ${markets.length} markets, ${unresolved.length} unresolved`);

  if (unresolved.length === 0) {
    return { scanned: markets.length, unresolved: 0, proposed: 0, errors: 0 };
  }

  // Evidence sources are loaded once per pass and shared across markets.
  const [showcase, indexerEvidence] = await Promise.all([
    loadShowcaseEvidence(opts.showcaseDir, opts.eventSlug),
    loadIndexerEvidence(opts.indexerInternalUrl),
  ]);

  const proposalsDir = join(opts.outDir, 'resolutions', 'proposals');
  await mkdir(proposalsDir, { recursive: true });

  let proposed = 0;
  let errors = 0;
  const indexSummary: Array<Record<string, unknown>> = [];

  for (const m of unresolved) {
    const question = (m.question ?? '').trim();
    if (!question) continue;
    const category = classify(question);

    const evidence: Record<string, unknown> = {
      category,
      market: {
        marketId: m.market_id,
        status: m.status,
        resolverType: m.resolver_type,
        closeTime: m.close_time,
        latestYesPrice: m.latest_yes_price,
        latestNoPrice: m.latest_no_price,
        latestTradePrice: m.latest_trade_price,
      },
    };
    if (category === 'ethglobal' || category === 'mixed') evidence['ethglobal'] = showcase;
    if (category === 'market' || category === 'mixed') evidence['indexer'] = indexerEvidence;

    let verdict: ResolutionVerdict;
    try {
      verdict = await opts.brain.assess({ question, evidence });
    } catch (err) {
      errors += 1;
      log(`resolver: brain error on ${m.market_id}: ${(err as Error).message}`);
      continue;
    }

    if (!verdict.resolvable || verdict.outcome === null) {
      log(`resolver: ${m.market_id} not resolvable yet (${verdict.rationale.slice(0, 80)})`);
      continue;
    }
    if (verdict.confidence < minConfidence) {
      log(
        `resolver: ${m.market_id} resolvable but low confidence ${verdict.confidence} < ${minConfidence}; skipping`,
      );
      continue;
    }

    const assessedAt = new Date().toISOString();
    const core = {
      marketId: m.market_id,
      question,
      outcome: verdict.outcome,
      rationale: verdict.rationale,
      evidenceRefs: verdict.evidenceRefs,
    };
    const dossier: ResolutionDossier = {
      marketId: m.market_id,
      question,
      status: m.status ?? null,
      resolverType: m.resolver_type ?? null,
      evidenceCategory: category,
      assessedAt,
      brainModel: opts.brain.model,
      verdict,
      resolutionHash: hashDossier(core),
      evidence,
      state: 'proposed',
      onChainSubmitted: false,
    };

    await writeFile(
      join(proposalsDir, `${safeFileName(m.market_id)}.json`),
      JSON.stringify(dossier, null, 2),
      'utf8',
    );
    proposed += 1;
    indexSummary.push({
      marketId: m.market_id,
      question,
      proposedOutcome: verdict.outcome,
      confidence: verdict.confidence,
      category,
      assessedAt,
      state: 'proposed',
    });
    log(`resolver: PROPOSED ${m.market_id} -> ${verdict.outcome} (conf ${verdict.confidence})`);
  }

  await writeFile(
    join(opts.outDir, 'resolutions', 'index.json'),
    JSON.stringify(
      { updatedAt: new Date().toISOString(), proposed, count: indexSummary.length, proposals: indexSummary },
      null,
      2,
    ),
    'utf8',
  );

  return { scanned: markets.length, unresolved: unresolved.length, proposed, errors };
}
