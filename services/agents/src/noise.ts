#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentObservation, type AgentObservation, type AgentTurnOutput } from '@darkbox/shared';
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
}

interface AgentState {
  agentId: string;
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

interface RunnerState {
  startedAt: string;
  completedTurns: number;
  errors: number;
  activeWorkers: number;
  desiredWorkers: number;
  latenciesMs: number[];
  recentBillboards: RecentBillboard[];
  ethGlobalSignals: string[];
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

async function makeLiveObservation(indexerUrl: string, agentId: string, turn: number, recentBillboards: RecentBillboard[], ethGlobalSignals: string[]): Promise<AgentObservation> {
  const [markets, leaderboard] = await Promise.all([
    fetchJson<PublicMarket[]>(`${indexerUrl}/public/markets`),
    fetchJson<LeaderboardEntry[]>(`${indexerUrl}/public/leaderboard`),
  ]);

  if (!markets?.length) return parseAgentObservation(makeFixtureObservation(agentId, turn));

  const now = new Date().toISOString();
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
    balances: [{ agentId, available: '100', equity: '100' }],
    billboardSinceLastTurn: recentBillboards.filter((message) => message.agentId !== agentId).slice(-20),
    marketProposals: [],
    sharedContext: [
      `live_indexer=${indexerUrl}`,
      `leaderboard_entries=${leaderboard?.length ?? 0}`,
      `visible_markets=${markets.length}`,
      'NOISE_MODE=true: quote the empty market and take risk; do not hold just because the live book is thin.',
      'Seed pricing for empty books: fair value starts around 0.50, quote 0.35-0.65 with small sizes unless you have a stronger view.',
      'No live orderbook submission is wired into this runner yet; outputs are validated and logged but not submitted onchain.',
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
    const observation = await makeLiveObservation(config.indexerUrl, agent.agentId, turn, state.recentBillboards, state.ethGlobalSignals);
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
  };

  const strategy = config.strategyName === 'venice' ? createVeniceStrategy() : createRandomStrategy(config.randomKind);
  const jsonlPath = path.join(config.logDir, `${config.runId}.jsonl`);
  const summaryPath = path.join(config.logDir, `${config.runId}.summary.log`);
  const latestPath = path.join(config.logDir, 'latest.json');
  const agents: AgentState[] = Array.from({ length: config.agentCount }, (_, index) => ({
    agentId: `${strategy.name}-agent-${index + 1}`,
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
  };

  const started = { type: 'run_started', at: state.startedAt, runId: config.runId, strategy: strategy.name, scheduler: 'bounded-worker-pool', config, ethGlobalSignals: state.ethGlobalSignals, agents: agents.map((agent) => agent.agentId), jsonlPath, summaryPath };
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
