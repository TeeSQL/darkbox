#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentObservation, type AgentObservation, type AgentTurnOutput, type TradeAction } from '@darkbox/shared';
import { makeFixtureObservation } from './fixture.js';
import { createRandomStrategy, type RandomAgentKind, type StrategyModule } from './random.js';
import { validateTurnOutput } from './validate.js';
import { createVeniceStrategy } from './venice.js';

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key]) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

for (const candidate of ['.env', path.resolve(process.cwd(), '../../.env')]) loadDotEnv(candidate);

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function jitter(ms: number, pct: number): number {
  if (pct <= 0) return ms;
  const spread = ms * pct;
  return Math.max(1_000, Math.round(ms + (Math.random() * 2 - 1) * spread));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

interface PublicMarket {
  market_id?: string;
  question?: string;
  status?: string;
}

interface LeaderboardEntry {
  agentId?: string | null;
  ensName?: string;
  equity?: string;
  currentEquity?: string;
  pnl?: string;
}


interface DaemonPersonality {
  name: string;
  style: string;
  tradingBias: string;
  billboardVoice: string;
  marketBias: string;
}

interface AgentIdentity {
  agentId: string;
  address: string;
  shadowAccount: string;
}

const DAEMON_PERSONALITIES: DaemonPersonality[] = [
  {
    name: 'Murmur',
    style: 'whisper-network operator; reads rival billboards as weak signals and trades before consensus forms',
    tradingBias: 'small early bids, follows credible flow, fades obvious spam',
    billboardVoice: 'cryptic alpha leaks and invitations to follow before the crowd arrives',
    marketBias: 'finalist odds and hidden momentum markets',
  },
  {
    name: 'Ash',
    style: 'aggressive momentum trader; wants action and hates idle capital',
    tradingBias: 'leans into YES when public evidence is improving; quotes tighter than cowards',
    billboardVoice: 'hot, punchy, taunting ads that dare rivals to take the other side',
    marketBias: 'demo readiness, working product, trade-count milestones',
  },
  {
    name: 'Vesper',
    style: 'late-cycle contrarian; assumes crowded narratives are overbid',
    tradingBias: 'sells hype, buys neglected NO, looks for overconfident billboard herds',
    billboardVoice: 'calm warnings, poison-pill offers, elegant doubt',
    marketBias: 'overhyped sponsor/tool adoption markets',
  },
  {
    name: 'Gloam',
    style: 'market maker; wants spread capture and two-sided flow',
    tradingBias: 'posts both sides, uses billboards to attract takers, avoids huge directional exposure',
    billboardVoice: 'liquidity ads: come trade here, size available, spread is open',
    marketBias: 'all active markets with empty books',
  },
  {
    name: 'Rook',
    style: 'ETHGlobal researcher; hunts sponsor keywords and public project-count edges',
    tradingBias: 'bets when cached ETHGlobal counts contradict market price',
    billboardVoice: 'evidence-driven ads citing counts, sponsor trends, demo readiness',
    marketBias: 'Blink, Privy, LI.FI, AI/agent project count markets',
  },
  {
    name: 'Nix',
    style: 'sniper; waits for stale quotes and tries to pick off bad prices',
    tradingBias: 'prefers taking if orders exist, otherwise posts bait quotes away from fair',
    billboardVoice: 'short predatory ads about stale prices and trapped liquidity',
    marketBias: 'mispriced YES/NO quotes after rival billboards',
  },
  {
    name: 'Omen',
    style: 'doom prophet; bearish by default and excellent at selling euphoria',
    tradingBias: 'leans NO unless ETHGlobal evidence is overwhelming',
    billboardVoice: 'ominous counter-ads that make rivals question crowded YES trades',
    marketBias: 'failure, missed milestones, not-finalist outcomes',
  },
  {
    name: 'Sable',
    style: 'stealth accumulator; manipulates quietly while building a position',
    tradingBias: 'uses small orders and subtle billboards to move attention elsewhere',
    billboardVoice: 'understated misdirection and velvet-glove invitations',
    marketBias: 'markets where public attention is thin',
  },
  {
    name: 'Hex',
    style: 'chaos proposer; creates provocative markets that pull liquidity into new stories',
    tradingBias: 'proposes often, seeds first quotes, trades narrative reflexivity',
    billboardVoice: 'loud market-launch ads: new game, cheap side, come now',
    marketBias: 'new sponsor-count, bounty, demo, reveal/replay markets',
  },
  {
    name: 'Wisp',
    style: 'fast follower; copies profitable-looking billboard signals but exits quickly',
    tradingBias: 'reacts to recent rival ads, piles into momentum, avoids long holds',
    billboardVoice: 'social proof ads: everyone is moving here, do not be late',
    marketBias: 'whatever market has the freshest billboard pressure',
  },
  {
    name: 'Grin',
    style: 'troll trader; baits rivals into emotional trades while staying schema-valid',
    tradingBias: 'posts provocative quotes and fades predictable reactions',
    billboardVoice: 'mischievous taunts, fake confidence, playful traps',
    marketBias: 'markets with strong narrative disagreement',
  },
  {
    name: 'Null',
    style: 'cold control daemon; ignores vibes and trades only obvious expected value',
    tradingBias: 'conservative sizes, evidence-weighted quotes, fewer billboards',
    billboardVoice: 'dry factual ads when price diverges from evidence',
    marketBias: 'cleanly resolvable ETHGlobal evidence markets',
  },
];

function personalityForIndex(index: number): DaemonPersonality {
  return DAEMON_PERSONALITIES[index % DAEMON_PERSONALITIES.length]!;
}

function agentNameFor(index: number): string {
  const personality = personalityForIndex(index);
  const cycle = Math.floor(index / DAEMON_PERSONALITIES.length);
  return cycle === 0 ? personality.name.toLowerCase() : `${personality.name.toLowerCase()}-${cycle + 1}`;
}

function identityContext(identity: AgentIdentity | undefined): string[] {
  if (!identity) return ['AGENT_KEY_STATUS=missing: no per-agent key manifest entry is loaded for this daemon. Do not submit real orders for this agent.'];
  return [
    `AGENT_WALLET=${identity.address}`,
    `AGENT_SHADOW_ACCOUNT=${identity.shadowAccount}`,
    'AGENT_KEY_STATUS=loaded: any real executor submission for this daemon must be signed by this daemon wallet, not a shared runner key.',
  ];
}

function personalityContext(personality: DaemonPersonality): string[] {
  return [
    `DAEMON_NAME=${personality.name}`,
    `DAEMON_STYLE=${personality.style}`,
    `DAEMON_TRADING_BIAS=${personality.tradingBias}`,
    `DAEMON_BILLBOARD_VOICE=${personality.billboardVoice}`,
    `DAEMON_MARKET_BIAS=${personality.marketBias}`,
    'Stay in character while maximizing profit. Your personality should affect what you trade, propose, and advertise.',
    'Your billboard should sound recognizably like this daemon. Do not copy generic room chatter; use your voice and bias.',
  ];
}

interface RunnerConfig {
  strategyName: string;
  randomKind: RandomAgentKind;
  agentCount: number;
  turns: number;
  indexerUrl: string;
  logDir: string;
  runId: string;
  schedulerTickMs: number;
  targetTurnsPerMinute: number;
  minAgentIntervalMs: number;
  maxAgentIntervalMs: number;
  minWorkers: number;
  maxWorkers: number;
  jitterPct: number;
  maxInFlightPerAgent: number;
  latencyWindow: number;
  phalaSlowdownFactor: number;
  agentIdentitiesFile: string;
}

interface AgentState {
  agentId: string;
  personality: DaemonPersonality;
  identity?: AgentIdentity;
  turn: number;
  nextRunAt: number;
  inFlight: number;
  completed: number;
}

interface RecentBillboard {
  messageId: string;
  agentId: string;
  message: string;
  createdAt: string;
}

interface PaperPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  size: number;
  avgEntry: number;
  realizedPnl: number;
}

interface PaperPortfolio {
  cash: number;
  positions: Record<string, PaperPosition>;
}

interface RunnerState {
  startedAt: string;
  completedTurns: number;
  errors: number;
  activeWorkers: number;
  desiredWorkers: number;
  latenciesMs: number[];
  recentBillboards: RecentBillboard[];
  ethGlobalSignals: string[];
  portfolios: Record<string, PaperPortfolio>;
}

const STARTING_CASH = 100;
const TAKE_PROFIT_ABSOLUTE = 0.08;
const TAKE_PROFIT_PCT = 0.15;

function trimDecimal(value: number): string {
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatDecimal(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return trimDecimal(safe);
}

function formatSignedDecimal(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return trimDecimal(safe);
}

function portfolioFor(state: RunnerState, agentId: string): PaperPortfolio {
  state.portfolios[agentId] ??= { cash: STARTING_CASH, positions: {} };
  return state.portfolios[agentId]!;
}

function positionKey(marketId: string, outcome: 'YES' | 'NO'): string {
  return `${marketId}:${outcome}`;
}

function parseMark(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0.01, 0.99) : fallback;
}

function marketProbabilities(markets: PublicMarket[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const market of markets) result[market.market_id ?? 'unknown-market'] = 0.5;
  return result;
}

function observationProbabilities(observation: AgentObservation): Record<string, number> {
  const result: Record<string, number> = {};
  for (const market of observation.markets) result[market.marketId] = parseMark(market.lastPrice ?? market.bestBid ?? market.bestAsk, 0.5);
  return result;
}

function outcomeMark(marketMarks: Record<string, number>, marketId: string, outcome: 'YES' | 'NO'): number {
  const yes = clamp(marketMarks[marketId] ?? 0.5, 0.01, 0.99);
  return outcome === 'YES' ? yes : 1 - yes;
}

function portfolioEquity(portfolio: PaperPortfolio, marketMarks: Record<string, number>): number {
  return Object.values(portfolio.positions).reduce((equity, position) => equity + position.size * outcomeMark(marketMarks, position.marketId, position.outcome), portfolio.cash);
}

function portfolioContext(portfolio: PaperPortfolio, marketMarks: Record<string, number>): string[] {
  const positions = Object.values(portfolio.positions)
    .filter((position) => position.size > 0.0001)
    .map((position) => {
      const mark = outcomeMark(marketMarks, position.marketId, position.outcome);
      const unrealizedPnl = (mark - position.avgEntry) * position.size;
      const pnlPct = position.avgEntry > 0 ? (mark - position.avgEntry) / position.avgEntry : 0;
      return { ...position, mark, unrealizedPnl, pnlPct };
    })
    .sort((a, b) => Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl));
  const takeProfit = positions.filter((position) => position.mark - position.avgEntry >= TAKE_PROFIT_ABSOLUTE || position.pnlPct >= TAKE_PROFIT_PCT);
  return [
    `PORTFOLIO=${JSON.stringify({ cash: formatDecimal(portfolio.cash), equity: formatDecimal(portfolioEquity(portfolio, marketMarks)), positions: positions.slice(0, 8).map((position) => ({ marketId: position.marketId, outcome: position.outcome, size: formatDecimal(position.size), avgEntry: formatDecimal(position.avgEntry), mark: formatDecimal(position.mark), unrealizedPnl: formatSignedDecimal(position.unrealizedPnl), realizedPnl: formatSignedDecimal(position.realizedPnl) })) })}`,
    takeProfit.length
      ? `TAKE_PROFIT_SIGNALS=${JSON.stringify(takeProfit.slice(0, 5).map((position) => ({ marketId: position.marketId, outcome: position.outcome, size: formatDecimal(position.size), avgEntry: formatDecimal(position.avgEntry), mark: formatDecimal(position.mark), unrealizedPnl: formatSignedDecimal(position.unrealizedPnl), suggestion: 'sell/reduce some inventory above your cost basis' })))}`
      : 'TAKE_PROFIT_SIGNALS=[]',
    'Portfolio rule: you are aware of your own inventory, average entry, marks, cash, equity, realized and unrealized PnL. Manage the book like a trader, not a one-shot commenter.',
    'Take-profit rule: if you bought YES/NO cheaply and the current mark or bid is materially higher, reduce or sell part of that position. Realized profit beats heroic bagholding.',
  ];
}

function applyPaperFill(portfolio: PaperPortfolio, action: TradeAction): void {
  if (action.type !== 'make_order') return;
  const price = clamp(Number(action.price), 0.01, 0.99);
  const requestedSize = Math.max(0, Number(action.size));
  if (!Number.isFinite(price) || !Number.isFinite(requestedSize) || requestedSize <= 0) return;
  const key = positionKey(action.marketId, action.outcome);
  const existing = portfolio.positions[key];

  if (action.side === 'buy') {
    const affordableSize = price > 0 ? Math.min(requestedSize, portfolio.cash / price) : requestedSize;
    if (affordableSize <= 0.0001) return;
    portfolio.cash -= affordableSize * price;
    if (!existing) {
      portfolio.positions[key] = { marketId: action.marketId, outcome: action.outcome, size: affordableSize, avgEntry: price, realizedPnl: 0 };
      return;
    }
    const totalCost = existing.avgEntry * existing.size + price * affordableSize;
    existing.size += affordableSize;
    existing.avgEntry = totalCost / existing.size;
    return;
  }

  if (!existing || existing.size <= 0) return;
  const closedSize = Math.min(requestedSize, existing.size);
  portfolio.cash += closedSize * price;
  existing.realizedPnl += (price - existing.avgEntry) * closedSize;
  existing.size -= closedSize;
  if (existing.size <= 0.0001) delete portfolio.positions[key];
}

function applyPaperPortfolio(portfolio: PaperPortfolio, output: AgentTurnOutput, observation: AgentObservation): void {
  for (const action of output.tradeActions) {
    if (action.type === 'take_order') {
      const order = observation.orders.find((candidate) => candidate.orderId === action.orderId);
      if (!order) continue;
      applyPaperFill(portfolio, {
        type: 'make_order',
        marketId: order.marketId,
        side: order.side === 'sell' ? 'buy' : 'sell',
        outcome: order.outcome,
        price: order.price,
        size: action.size,
        timeInForce: 'IOC',
      });
      continue;
    }
    applyPaperFill(portfolio, action);
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function statusToRuntime(status: string | undefined): 'open' | 'paused' | 'resolved' | 'voided' {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'resolved') return 'resolved';
  if (normalized === 'voided') return 'voided';
  if (normalized === 'paused') return 'paused';
  return 'open';
}

function resolveConfigPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const candidates = [path.resolve(process.cwd(), filePath), path.resolve(process.cwd(), '../../', filePath)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function loadAgentIdentities(filePath: string): Record<string, AgentIdentity> {
  const resolved = resolveConfigPath(filePath);
  if (!fs.existsSync(resolved)) return {};
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as { agents?: AgentIdentity[] };
  const identities: Record<string, AgentIdentity> = {};
  for (const identity of parsed.agents ?? []) {
    if (!identity.agentId || !identity.address || !identity.shadowAccount) continue;
    identities[identity.agentId] = identity;
  }
  return identities;
}

function loadEthGlobalSignals(): string[] {
  const candidates = [
    path.resolve(process.cwd(), 'data/ethglobal/newyork2026/projects.compact.json'),
    path.resolve(process.cwd(), 'data/ethglobal/cannes2026/projects.compact.json'),
  ];
  for (const filePath of candidates) {
    try {
      const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { event?: string; fetchedAt?: string; count?: number; projects?: Array<Record<string, unknown>> };
      const projects = Array.isArray(bundle.projects) ? bundle.projects : [];
      if (projects.length === 0) continue;
      const text = (project: Record<string, unknown>) => JSON.stringify(project).toLowerCase();
      const countTerm = (term: string) => projects.filter((project) => text(project).includes(term)).length;
      const blink = countTerm('blink');
      const privy = countTerm('privy');
      const lifi = countTerm('li.fi') + countTerm('lifi');
      const ai = countTerm(' ai ') + countTerm('agent');
      const demoReady = projects.filter((project) => project.demoVideoReady === true).length;
      return [
        `ETHGlobal public cache: event=${bundle.event ?? 'unknown'} projects=${projects.length} fetchedAt=${bundle.fetchedAt ?? 'unknown'}.`,
        `ETHGlobal signal counts: blink_mentions=${blink}, privy_mentions=${privy}, lifi_mentions=${lifi}, ai_or_agent_mentions=${ai}, demo_video_ready=${demoReady}.`,
        'Potential market idea: Will at least 5 submitted projects use Blink?',
        'Potential market idea: Will an AI/agent project win or place?',
        'Use these public ETHGlobal signals to seek profit. Counts are evidence, not certainty.',
      ];
    } catch {
      // Try next cache file.
    }
  }
  return [
    'ETHGlobal public cache unavailable or empty. Prefer proposing markets about Blink adoption, finalists, winner odds, demo readiness, and bounty narratives.',
    'Potential market idea: Will at least 5 submitted projects use Blink?',
  ];
}

async function makeLiveObservation(indexerUrl: string, agentId: string, turn: number, recentBillboards: RecentBillboard[], ethGlobalSignals: string[], personality: DaemonPersonality, identity: AgentIdentity | undefined, portfolio: PaperPortfolio): Promise<AgentObservation> {
  const [markets, leaderboard] = await Promise.all([
    fetchJson<PublicMarket[]>(`${indexerUrl}/public/markets`),
    fetchJson<LeaderboardEntry[]>(`${indexerUrl}/public/leaderboard`),
  ]);

  if (!markets?.length) {
    const fixture = makeFixtureObservation(agentId, turn);
    const marks = observationProbabilities(fixture);
    return parseAgentObservation({
      ...fixture,
      balances: [{ agentId, available: formatDecimal(portfolio.cash), equity: formatDecimal(portfolioEquity(portfolio, marks)) }],
      billboardSinceLastTurn: [...fixture.billboardSinceLastTurn, ...recentBillboards.filter((message) => message.agentId !== agentId).slice(-20)],
      sharedContext: [
        ...fixture.sharedContext,
        'NOISE_MODE=true: quote the market and take risk; do not hold just because this is a smoke fixture.',
        'No live orderbook submission is wired into this runner yet; outputs are validated and logged but not submitted onchain.',
        ...identityContext(identity),
        ...portfolioContext(portfolio, marks),
        ...personalityContext(personality),
        ...ethGlobalSignals,
      ],
    });
  }

  const now = new Date().toISOString();
  const marks = marketProbabilities(markets);
  const equity = portfolioEquity(portfolio, marks);
  return parseAgentObservation({
    agentId,
    turn,
    now,
    markets: markets.map((market) => ({
      marketId: market.market_id ?? 'unknown-market',
      question: market.question ?? 'Unknown DarkBox market',
      status: statusToRuntime(market.status),
      bestBid: '0.45',
      bestAsk: '0.55',
      lastPrice: '0.50',
    })),
    orders: [],
    balances: [{ agentId, available: formatDecimal(portfolio.cash), equity: formatDecimal(equity) }],
    billboardSinceLastTurn: recentBillboards.filter((message) => message.agentId !== agentId).slice(-20),
    marketProposals: [],
    sharedContext: [
      `live_indexer=${indexerUrl}`,
      `leaderboard_entries=${leaderboard?.length ?? 0}`,
      `visible_markets=${markets.length}`,
      'NOISE_MODE=true: quote the empty market and take risk; do not hold just because the live book is thin.',
      'Seed pricing for empty books: fair value starts around 0.50, quote 0.35-0.65 with small sizes unless you have a stronger view.',
      'No live orderbook submission is wired into this runner yet; outputs are validated and logged but not submitted onchain.',
      ...identityContext(identity),
      ...portfolioContext(portfolio, marks),
      ...personalityContext(personality),
      ...ethGlobalSignals,
    ],
  });
}

function summarizeOutput(output: AgentTurnOutput): string {
  const actions = output.tradeActions.map((action) => action.type).join(', ') || 'none';
  const billboard = output.billboardPost?.message ? ` billboard="${output.billboardPost.message.slice(0, 140)}"` : '';
  const proposal = output.marketProposal?.question ? ` proposal="${output.marketProposal.question.slice(0, 120)}"` : '';
  return `actions=${actions}${billboard}${proposal}`;
}

function computeAgentIntervalMs(config: RunnerConfig, state: RunnerState): number {
  const p95 = percentile(state.latenciesMs, 0.95) ?? 5_000;
  const latencySlowdown = clamp((p95 / 10_000) * config.phalaSlowdownFactor, 1, 6);
  const targetInterval = (config.agentCount / Math.max(1, config.targetTurnsPerMinute)) * 60_000 * latencySlowdown;
  return Math.round(clamp(targetInterval, config.minAgentIntervalMs, config.maxAgentIntervalMs));
}

function computeDesiredWorkers(config: RunnerConfig, state: RunnerState): number {
  const base = Math.ceil(Math.sqrt(config.agentCount));
  const p95 = percentile(state.latenciesMs, 0.95);
  const queueHealthy = p95 === null || p95 < 25_000;
  const errorRate = state.completedTurns === 0 ? 0 : state.errors / state.completedTurns;
  const penalty = !queueHealthy || errorRate > 0.08 ? 0.5 : 1;
  return Math.round(clamp(base * penalty, config.minWorkers, config.maxWorkers));
}

async function runAgentTurn(params: {
  agent: AgentState;
  config: RunnerConfig;
  state: RunnerState;
  strategy: StrategyModule;
  jsonlPath: string;
  summaryPath: string;
  latestPath: string;
}): Promise<void> {
  const { agent, config, state, strategy, jsonlPath, summaryPath, latestPath } = params;
  agent.inFlight += 1;
  state.activeWorkers += 1;
  const turn = agent.turn + 1;
  const at = new Date().toISOString();
  const startedMs = Date.now();

  try {
    const portfolio = portfolioFor(state, agent.agentId);
    const observation = await makeLiveObservation(config.indexerUrl, agent.agentId, turn, state.recentBillboards, state.ethGlobalSignals, agent.personality, agent.identity, portfolio);
    const output = await strategy.decide(observation);
    const latencyMs = Date.now() - startedMs;
    state.latenciesMs.push(latencyMs);
    if (state.latenciesMs.length > config.latencyWindow) state.latenciesMs.splice(0, state.latenciesMs.length - config.latencyWindow);

    const validation = validateTurnOutput(output, observation);
    const eventOutput = validation.output ?? output;
    const event = {
      type: 'turn',
      at,
      runId: config.runId,
      strategy: strategy.name,
      agentId: agent.agentId,
      turn,
      ok: validation.ok,
      latencyMs,
      worker: { active: state.activeWorkers, desired: state.desiredWorkers },
      validation,
      observationSummary: { markets: observation.markets.length, orders: observation.orders.length, sharedContext: observation.sharedContext },
      output: eventOutput,
    };
    appendJsonl(jsonlPath, event);
    writeJson(latestPath, event);
    const line = `[${at}] turn=${turn} agent=${agent.agentId} ok=${validation.ok} latencyMs=${latencyMs} workers=${state.activeWorkers}/${state.desiredWorkers} ${summarizeOutput(eventOutput)}${validation.ok ? '' : ` errors=${validation.errors.join('; ')}`}\n`;
    fs.appendFileSync(summaryPath, line);
    console.log(line.trim());

    agent.turn = turn;
    agent.completed += 1;
    state.completedTurns += 1;
    if (!validation.ok) state.errors += 1;
    if (validation.ok) applyPaperPortfolio(portfolio, eventOutput, observation);
    if (validation.ok && eventOutput.billboardPost?.message) {
      state.recentBillboards.push({
        messageId: `${config.runId}-turn-${turn}-${agent.agentId}`,
        agentId: agent.agentId,
        message: eventOutput.billboardPost.message,
        createdAt: new Date().toISOString(),
      });
      if (state.recentBillboards.length > 60) state.recentBillboards.splice(0, state.recentBillboards.length - 60);
    }
  } catch (error) {
    const latencyMs = Date.now() - startedMs;
    const message = error instanceof Error ? error.message : String(error);
    const event = { type: 'turn_error', at, runId: config.runId, strategy: strategy.name, agentId: agent.agentId, turn, ok: false, latencyMs, error: message };
    appendJsonl(jsonlPath, event);
    writeJson(latestPath, event);
    const line = `[${at}] turn=${turn} agent=${agent.agentId} ERROR latencyMs=${latencyMs} ${message}\n`;
    fs.appendFileSync(summaryPath, line);
    console.error(line.trim());
    state.errors += 1;
  } finally {
    agent.inFlight -= 1;
    state.activeWorkers -= 1;
    const intervalMs = computeAgentIntervalMs(config, state);
    agent.nextRunAt = Date.now() + jitter(intervalMs, config.jitterPct);
  }
}

async function main(): Promise<void> {
  const config: RunnerConfig = {
    strategyName: argValue('--strategy', 'venice'),
    randomKind: argValue('--kind', 'random-mixed') as RandomAgentKind,
    agentCount: numberArg('--agents', 3),
    turns: numberArg('--turns', 0),
    indexerUrl: argValue('--indexer-url', process.env.DARKBOX_INDEXER_URL ?? 'http://127.0.0.1:8080'),
    logDir: argValue('--log-dir', 'logs/agents'),
    runId: argValue('--run-id', new Date().toISOString().replace(/[:.]/g, '-')),
    schedulerTickMs: numberArg('--scheduler-tick-ms', Number(process.env.SCHEDULER_TICK_MS ?? 2_000)),
    targetTurnsPerMinute: numberArg('--target-turns-per-minute', Number(process.env.TARGET_TURNS_PER_MINUTE ?? 20)),
    minAgentIntervalMs: numberArg('--min-agent-interval-ms', Number(process.env.MIN_AGENT_INTERVAL_MS ?? 30_000)),
    maxAgentIntervalMs: numberArg('--max-agent-interval-ms', Number(process.env.MAX_AGENT_INTERVAL_MS ?? 900_000)),
    minWorkers: numberArg('--min-workers', Number(process.env.MIN_WORKERS ?? 2)),
    maxWorkers: numberArg('--max-workers', Number(process.env.MAX_WORKERS ?? 8)),
    jitterPct: numberArg('--jitter-pct', Number(process.env.JITTER_PCT ?? 30)) / 100,
    maxInFlightPerAgent: numberArg('--max-in-flight-per-agent', Number(process.env.MAX_IN_FLIGHT_PER_AGENT ?? 1)),
    latencyWindow: numberArg('--latency-window', 80),
    phalaSlowdownFactor: numberArg('--phala-slowdown-factor', Number(process.env.PHALA_SLOWDOWN_FACTOR ?? 1.5)),
    agentIdentitiesFile: argValue('--agent-identities', process.env.AGENT_IDENTITIES_FILE ?? 'services/agents/config/agent-identities.json'),
  };

  const identities = loadAgentIdentities(config.agentIdentitiesFile);
  const strategy = config.strategyName === 'venice' ? createVeniceStrategy() : createRandomStrategy(config.randomKind);
  const jsonlPath = path.join(config.logDir, `${config.runId}.jsonl`);
  const summaryPath = path.join(config.logDir, `${config.runId}.summary.log`);
  const latestPath = path.join(config.logDir, 'latest.json');
  const agents: AgentState[] = Array.from({ length: config.agentCount }, (_, index) => ({
    agentId: agentNameFor(index),
    personality: personalityForIndex(index),
    identity: identities[agentNameFor(index)],
    turn: 0,
    nextRunAt: Date.now() + jitter(index * 400, 1),
    inFlight: 0,
    completed: 0,
  }));
  const state: RunnerState = {
    startedAt: new Date().toISOString(),
    completedTurns: 0,
    errors: 0,
    activeWorkers: 0,
    desiredWorkers: config.minWorkers,
    latenciesMs: [],
    recentBillboards: [],
    ethGlobalSignals: loadEthGlobalSignals(),
    portfolios: {},
  };

  const started = { type: 'run_started', at: state.startedAt, runId: config.runId, strategy: strategy.name, scheduler: 'bounded-worker-pool', config, ethGlobalSignals: state.ethGlobalSignals, agents: agents.map((agent) => ({ agentId: agent.agentId, personality: agent.personality, identity: agent.identity ? { address: agent.identity.address, shadowAccount: agent.identity.shadowAccount } : null })), jsonlPath, summaryPath };
  appendJsonl(jsonlPath, started);
  fs.appendFileSync(summaryPath, `[${started.at}] started run=${config.runId} strategy=${strategy.name} agents=${agents.length} scheduler=bounded-worker-pool minWorkers=${config.minWorkers} maxWorkers=${config.maxWorkers} targetTpm=${config.targetTurnsPerMinute}\n`);
  writeJson(latestPath, started);
  console.log(JSON.stringify(started, null, 2));

  while (config.turns === 0 || state.completedTurns + state.errors < config.turns * config.agentCount) {
    state.desiredWorkers = computeDesiredWorkers(config, state);
    const now = Date.now();
    const due = agents
      .filter((agent) => agent.nextRunAt <= now && agent.inFlight < config.maxInFlightPerAgent)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);

    const availableSlots = Math.max(0, state.desiredWorkers - state.activeWorkers);
    for (const agent of due.slice(0, availableSlots)) {
      void runAgentTurn({ agent, config, state, strategy, jsonlPath, summaryPath, latestPath });
    }

    await sleep(config.schedulerTickMs);
  }

  while (state.activeWorkers > 0) await sleep(250);
  const finished = { type: 'run_finished', at: new Date().toISOString(), runId: config.runId, strategy: strategy.name, completedTurns: state.completedTurns, errors: state.errors, p95LatencyMs: percentile(state.latenciesMs, 0.95) };
  appendJsonl(jsonlPath, finished);
  fs.appendFileSync(summaryPath, `[${finished.at}] finished run=${config.runId} completedTurns=${state.completedTurns} errors=${state.errors} p95LatencyMs=${finished.p95LatencyMs ?? 'n/a'}\n`);
  writeJson(latestPath, finished);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
