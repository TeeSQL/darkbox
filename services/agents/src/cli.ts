#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentObservation } from '@darkbox/shared';
import { makeFixtureObservation } from './fixture.js';
import { createRandomStrategy, randomStrategyKinds, type RandomAgentKind } from './random.js';
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
