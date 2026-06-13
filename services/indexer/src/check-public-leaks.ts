import { createSeedState, publicLeaderboard } from './store.js';

const forbiddenKeys = new Set([
  'availableBalance',
  'equity',
  'positions',
  'orders',
  'fills',
  'remainingSize',
  'txHash',
  'blockNumber',
  'makerAgentId',
  'takerAgentId',
]);

function scan(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => scan(item, [...path, String(index)]));
  return Object.entries(value).flatMap(([key, nested]) => {
    const current = [...path, key];
    const hit = forbiddenKeys.has(key) ? [current.join('.')] : [];
    return [...hit, ...scan(nested, current)];
  });
}

const state = createSeedState();
const publicPayloads = {
  game: state.game,
  markets: state.markets,
  leaderboard: publicLeaderboard(state),
  activity: state.activity,
};

const leaks = scan(publicPayloads);
if (leaks.length > 0) {
  console.error(JSON.stringify({ ok: false, leaks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checkedPayloads: Object.keys(publicPayloads) }, null, 2));
