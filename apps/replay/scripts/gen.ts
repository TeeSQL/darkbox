/**
 * Emit a deterministic mock replay bundle to public/replay.json so the static
 * app has data to load. Re-run any time: `pnpm --filter @darkbox/replay gen`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateMockBundle } from '../src/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, 'replay.json');

const bundle = generateMockBundle();
writeFileSync(out, JSON.stringify(bundle));

const kb = (JSON.stringify(bundle).length / 1024).toFixed(1);
console.log(
  `replay.json written (${kb} KB): ${bundle.players.length} daemons, ` +
    `${bundle.markets.length} markets, ${bundle.trades.length} trades, ` +
    `${bundle.billboard.length} billboard posts, ${bundle.timeline.length} events.`,
);
