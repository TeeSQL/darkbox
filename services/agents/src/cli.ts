#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentObservation } from '@darkbox/shared';
import { makeFixtureObservation } from './fixture.js';
import { createRandomStrategy, randomStrategyKinds, type RandomAgentKind } from './random.js';
import { validateTurnOutput } from './validate.js';
import { createVeniceStrategy } from './venice.js';
import { cacheEventProjects, DEFAULT_EVENT_SLUG } from './ethglobal.js';
import { createPhalaBrain } from './phalaBrain.js';
import { runResolverPass } from './resolver.js';

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
    const out = argValue('--out', path.resolve(process.cwd(), '../../data/ethglobal'));
    const result = await cacheEventProjects(eventSlug, out, (msg) => console.error(msg));
    console.log(JSON.stringify({ mode, ...result }, null, 2));
    return;
  }

  if (mode === 'resolve') {
    // Propose-then-confirm market resolution. Reads markets from the indexer +
    // cached ETHGlobal snapshots, asks the Phala brain, writes dossiers. Never
    // submits an on-chain tx.
    const eventSlug = argValue('--event', DEFAULT_EVENT_SLUG);
    const dataRoot = argValue('--data', path.resolve(process.cwd(), '../../data'));
    const indexerInternalUrl =
      process.env['INDEXER_INTERNAL_URL'] ?? 'http://localhost:8080/internal';
    const brain = createPhalaBrain();
    if (!brain) {
      console.error('resolve: PHALA_LLM_URL/PHALA_LLM_API_KEY not set; skipping resolution pass');
      console.log(JSON.stringify({ mode, skipped: 'phala_not_configured' }, null, 2));
      return;
    }
    const result = await runResolverPass({
      indexerInternalUrl,
      showcaseDir: path.join(dataRoot, 'ethglobal'),
      eventSlug,
      outDir: dataRoot,
      brain,
      minConfidence: Number(argValue('--min-confidence', process.env['RESOLVER_MIN_CONFIDENCE'] ?? '0.7')),
      log: (msg) => console.error(msg),
    });
    console.log(JSON.stringify({ mode, ...result }, null, 2));
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
