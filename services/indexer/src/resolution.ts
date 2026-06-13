import { createHash } from 'node:crypto';
import type { IndexerState } from './store.js';
import type { EthGlobalCompactProject, EthGlobalProjectBundle } from './ethglobal-context.js';
import type { MarketResolutionDossier, PublicMarket } from '@darkbox/shared';

export interface ResolutionRunResult {
  checked: number;
  resolved: Array<{
    marketId: string;
    outcome: 'YES' | 'NO' | 'INVALID';
    dossierId: string;
  }>;
  skipped: Array<{
    marketId: string;
    reason: string;
  }>;
}

type ResolverConfig = NonNullable<PublicMarket['resolverConfig']>;

function nowIso(): string {
  return new Date().toISOString();
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compare(value: number, operator: string, threshold: number): boolean {
  if (operator === '>=') return value >= threshold;
  if (operator === '>') return value > threshold;
  if (operator === '<=') return value <= threshold;
  if (operator === '<') return value < threshold;
  if (operator === '==') return value === threshold;
  throw new Error(`unsupported resolver operator: ${operator}`);
}

function projectText(project: EthGlobalCompactProject): string {
  return [
    project.name,
    project.slug,
    project.tagline,
    project.description,
    project.howItsMade,
    project.projectUrl,
    project.repoUrl,
    ...project.prizeNames,
    ...project.sponsorNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function projectMatchesSponsorTerms(project: EthGlobalCompactProject, terms: string[], matchMode: 'any' | 'all'): boolean {
  const haystack = projectText(project);
  const normalized = terms.map((term) => term.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) return false;
  return matchMode === 'all'
    ? normalized.every((term) => haystack.includes(term))
    : normalized.some((term) => haystack.includes(term));
}

function getDaemonhallMetric(state: IndexerState, metric: string): number {
  if (metric === 'totalDeposits') return Number(state.activity.totalDeposits);
  if (metric === 'totalTrades') return state.activity.totalTrades;
  if (metric === 'totalVolume') return Number(state.activity.totalVolume);
  if (metric === 'positionsOpened') return state.activity.positionsOpened;
  if (metric === 'positionsClosed') return state.activity.positionsClosed;
  if (metric === 'activeMarkets') return state.activity.activeMarkets;
  if (metric === 'activeAgents') return state.activity.activeAgents;
  if (metric === 'registeredDaemons' || metric === 'users') return state.agents.length;
  if (metric === 'openOrders') return state.orders.filter((order) => order.status === 'open' || order.status === 'partially_filled').length;
  if (metric === 'marketsCreated') return state.markets.length;
  throw new Error(`unsupported Daemonhall metric: ${metric}`);
}

function finalWindowPassed(config: ResolverConfig, atIso: string): boolean {
  if (!config.finalAt) return false;
  return Date.parse(atIso) >= Date.parse(config.finalAt);
}

function makeDossier(params: {
  market: PublicMarket;
  outcome: 'YES' | 'NO' | 'INVALID';
  source: string;
  rule: string;
  evidence: Record<string, unknown>;
  confidence: 'low' | 'medium' | 'high';
  notes?: string[];
  decidedAt: string;
}): MarketResolutionDossier {
  const body = {
    marketId: params.market.marketId,
    resolverType: params.market.resolverType ?? params.market.resolverConfig?.resolverType ?? 'AdminManual',
    outcome: params.outcome,
    source: params.source,
    rule: params.rule,
    evidence: params.evidence,
    decidedAt: params.decidedAt,
  };
  return {
    dossierId: `resolution-${params.market.marketId}-${hashJson(body).slice(0, 16)}`,
    marketId: params.market.marketId,
    resolverType: body.resolverType,
    outcome: params.outcome,
    decidedAt: params.decidedAt,
    source: params.source,
    rule: params.rule,
    evidence: params.evidence,
    confidence: params.confidence,
    notes: params.notes ?? [],
  };
}

function evaluateEthGlobalCount(market: PublicMarket, config: ResolverConfig, bundle: EthGlobalProjectBundle, atIso: string): MarketResolutionDossier | null {
  const threshold = config.threshold;
  const operator = config.operator ?? '>=';
  const terms = config.sponsorTerms ?? [];
  const matchMode = config.matchMode ?? 'any';
  if (typeof threshold !== 'number') throw new Error(`${market.marketId} missing threshold`);

  const matchedProjects = terms.length > 0
    ? bundle.projects.filter((project) => projectMatchesSponsorTerms(project, terms, matchMode))
    : bundle.projects;
  const count = matchedProjects.length;
  const isYes = compare(count, operator, threshold);
  const isFinal = finalWindowPassed(config, atIso);

  if (isYes && config.earlyYes !== false) {
    return makeDossier({
      market,
      outcome: 'YES',
      decidedAt: atIso,
      source: `ethglobal:${bundle.event}`,
      rule: `${config.resolverType}: count ${matchMode} [${terms.join(', ')}] ${operator} ${threshold}`,
      evidence: {
        fetchedAt: bundle.fetchedAt,
        count,
        threshold,
        operator,
        matchMode,
        sponsorTerms: terms,
        matchedProjects: matchedProjects.map((project) => ({ id: project.id, slug: project.slug, name: project.name, showcaseUrl: project.showcaseUrl })),
        sourceSnapshotHash: hashJson(bundle),
      },
      confidence: 'high',
    });
  }

  if (!isYes && isFinal && config.earlyNo !== false) {
    return makeDossier({
      market,
      outcome: 'NO',
      decidedAt: atIso,
      source: `ethglobal:${bundle.event}`,
      rule: `${config.resolverType}: final count ${matchMode} [${terms.join(', ')}] ${operator} ${threshold}`,
      evidence: {
        fetchedAt: bundle.fetchedAt,
        finalAt: config.finalAt,
        count,
        threshold,
        operator,
        matchMode,
        sponsorTerms: terms,
        matchedProjects: matchedProjects.map((project) => ({ id: project.id, slug: project.slug, name: project.name, showcaseUrl: project.showcaseUrl })),
        sourceSnapshotHash: hashJson(bundle),
      },
      confidence: 'high',
    });
  }

  return null;
}

function evaluateDaemonhallMetric(market: PublicMarket, config: ResolverConfig, state: IndexerState, atIso: string): MarketResolutionDossier | null {
  if (!config.metric) throw new Error(`${market.marketId} missing metric`);
  if (typeof config.threshold !== 'number') throw new Error(`${market.marketId} missing threshold`);
  const operator = config.operator ?? '>=';
  const value = getDaemonhallMetric(state, config.metric);
  const isYes = compare(value, operator, config.threshold);
  const isFinal = finalWindowPassed(config, atIso);

  if (isYes && config.earlyYes !== false) {
    return makeDossier({
      market,
      outcome: 'YES',
      decidedAt: atIso,
      source: 'daemonhall:indexer',
      rule: `${config.metric} ${operator} ${config.threshold}`,
      evidence: { metric: config.metric, value, threshold: config.threshold, operator, activity: state.activity },
      confidence: 'high',
    });
  }

  if (!isYes && isFinal && config.earlyNo !== false) {
    return makeDossier({
      market,
      outcome: 'NO',
      decidedAt: atIso,
      source: 'daemonhall:indexer',
      rule: `final ${config.metric} ${operator} ${config.threshold}`,
      evidence: { metric: config.metric, value, threshold: config.threshold, operator, finalAt: config.finalAt, activity: state.activity },
      confidence: 'high',
    });
  }

  return null;
}

function settleResolvedMarket(state: IndexerState, market: PublicMarket, dossier: MarketResolutionDossier): void {
  const at = dossier.decidedAt;
  market.status = dossier.outcome === 'INVALID' ? 'voided' : 'resolved';
  market.resolutionDossier = dossier;
  market.updatedAt = at;

  for (const order of state.orders) {
    if (order.marketId !== market.marketId) continue;
    if (order.status === 'open' || order.status === 'partially_filled') {
      order.status = dossier.outcome === 'INVALID' ? 'cancelled' : 'filled';
      order.remainingSize = '0';
      order.updatedAt = at;
    }
  }

  for (const agent of state.agents) {
    for (const position of agent.positions) {
      if (position.marketId !== market.marketId) continue;
      const won = dossier.outcome !== 'INVALID' && position.outcome === dossier.outcome;
      if (won) {
        position.realizedPnl = String(Number(position.realizedPnl) + Number(position.size) * (1 - Number(position.averagePrice)));
      } else if (dossier.outcome !== 'INVALID') {
        position.realizedPnl = String(Number(position.realizedPnl) - Number(position.size) * Number(position.averagePrice));
      }
      position.unrealizedPnl = '0';
    }
    agent.updatedAt = at;
  }

  state.fills.push({
    fillId: dossier.dossierId,
    marketId: market.marketId,
    makerAgentId: 'resolution-admin',
    takerAgentId: 'resolution-settlement',
    outcome: dossier.outcome === 'NO' ? 'NO' : 'YES',
    price: dossier.outcome === 'INVALID' ? '0' : '1',
    size: '0',
    txHash: dossier.dossierId,
    blockNumber: state.fills.length + 1,
    createdAt: at,
  });

  state.activity.positionsClosed += 1;
  state.activity.totalTrades += 1;
  state.activity.activeMarkets = state.markets.filter((candidate) => candidate.status === 'open').length;
  state.activity.updatedAt = at;
}

export function resolveEligibleMarkets(state: IndexerState, bundles: EthGlobalProjectBundle[], atIso = nowIso()): ResolutionRunResult {
  const bundleByEvent = new Map(bundles.map((bundle) => [bundle.event, bundle]));
  const result: ResolutionRunResult = { checked: 0, resolved: [], skipped: [] };

  for (const market of state.markets) {
    if (market.status !== 'open') continue;
    const config = market.resolverConfig;
    if (!config) {
      result.skipped.push({ marketId: market.marketId, reason: 'missing_resolver_config' });
      continue;
    }
    result.checked += 1;

    let dossier: MarketResolutionDossier | null = null;
    if (config.resolverType === 'EthGlobalProjectCount' || config.resolverType === 'EthGlobalSponsorComboCount' || config.resolverType === 'EthGlobalSoloHackerCount') {
      const event = config.event;
      const bundle = event ? bundleByEvent.get(event) : bundles[0];
      if (!bundle) {
        result.skipped.push({ marketId: market.marketId, reason: `missing_ethglobal_bundle:${event ?? 'default'}` });
        continue;
      }
      dossier = evaluateEthGlobalCount(market, config, bundle, atIso);
    } else if (config.resolverType === 'DaemonhallMetricThreshold') {
      dossier = evaluateDaemonhallMetric(market, config, state, atIso);
    } else {
      result.skipped.push({ marketId: market.marketId, reason: `manual_or_unsupported_resolver:${config.resolverType}` });
      continue;
    }

    if (!dossier) {
      result.skipped.push({ marketId: market.marketId, reason: 'not_resolvable_yet' });
      continue;
    }

    settleResolvedMarket(state, market, dossier);
    result.resolved.push({ marketId: market.marketId, outcome: dossier.outcome, dossierId: dossier.dossierId });
  }

  return result;
}
