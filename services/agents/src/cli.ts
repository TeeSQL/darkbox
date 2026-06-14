#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentObservation } from '@darkbox/shared';
import { makeFixtureObservation } from './fixture.js';
import { IndexerIdentityClient } from './identityClient.js';
import { createRandomStrategy, randomStrategyKinds, type RandomAgentKind } from './random.js';
import { IndexerClient, runLive } from './runner.js';
import { validateTurnOutput } from './validate.js';
import { createVeniceStrategy } from './venice.js';
import { cacheEventProjects, DEFAULT_EVENT_SLUG } from './ethglobal.js';

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

for (const candidate of ['.env', path.resolve(process.cwd(), '../../.env')]) {
  loadDotEnv(candidate);
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'random';
  const turns = Number(argValue('--turns', '1'));
  const kind = argValue('--kind', 'random-mixed') as RandomAgentKind;

  if (mode === 'list') {
    console.log(JSON.stringify({ randomStrategyKinds }, null, 2));
    return;
  }

  if (mode === 'showcase') {
    // Pull ETHGlobal showcase project snapshots and cache them locally.
    const eventSlug = argValue('--event', DEFAULT_EVENT_SLUG);
    // Cache under the repo-root data/ dir (gitignored), not the package dir.
    const out = argValue('--out', path.resolve(process.cwd(), '../../data/ethglobal'));
    const result = await cacheEventProjects(eventSlug, out, (msg) => console.error(msg));
    console.log(JSON.stringify({ mode, ...result }, null, 2));
    return;
  }

  if (mode === 'spawn') {
    // Register a spawned agent identity with the indexer. Spawned agents have no
    // telegram account but receive a stable daemon name for the leaderboard.
    const shadowAccount = argValue('--shadow-account', '');
    if (!shadowAccount) {
      console.error('spawn requires --shadow-account <address>');
      process.exit(1);
    }
    const agentId = argValue('--agent-id', '') || undefined;
    const client = new IndexerIdentityClient();
    const identity = await client.registerSpawnedAgent({ shadowAccount, agentId });
    console.log(JSON.stringify({ mode, identity }, null, 2));
    return;
  }

  if (mode === 'live') {
    // Drive a strategy against a running indexer with real, enforced trading.
    const agentId = argValue('--agent-id', 'agent-live');
    const shadowAccount = argValue('--shadow-account', `0xsh-${agentId}`);
    const marketId = argValue('--market', 'm1');
    const question = argValue('--question', 'Will the demo market resolve YES?');
    const deposit = Number(argValue('--deposit', '100'));
    const client = new IndexerClient();
    await client.registerIdentity({ shadowAccount, agentId, source: 'spawned' });
    await client.createMarket(marketId, question);
    await client.deposit(agentId, deposit);
    const liveStrategy = createRandomStrategy(kind);
    const turnResults = await runLive({ client, agentId, strategy: liveStrategy, turns });
    const leaderboard = await client.leaderboard();
    console.log(JSON.stringify({ mode, agentId, marketId, turnResults, leaderboard }, null, 2));
    return;
  }

  const strategy = mode === 'venice' ? createVeniceStrategy() : createRandomStrategy(kind);
  const results = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    const observation = parseAgentObservation(makeFixtureObservation(`${strategy.name}-agent`, turn));
    const output = await strategy.decide(observation);
    const validation = validateTurnOutput(output, observation);
    results.push({
      strategy: strategy.name,
      turn,
      validation,
      output: validation.output ?? output,
    });
  }

  console.log(JSON.stringify({ mode, turns, results }, null, 2));
  if (results.some((result) => !result.validation.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
