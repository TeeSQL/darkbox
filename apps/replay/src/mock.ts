/**
 * Deterministic mock generator.
 *
 * Produces a fully-populated ReplayBundle from a numeric seed so the replay is
 * reproducible (no Math.random / Date.now). Run via `scripts/gen.ts` to emit
 * `public/replay.json`, or call at runtime as a fallback if no bundle is served.
 *
 * The goal of the data is to feel ALIVE: many daemons pouring in, markets
 * spawning, prices whipping around on big trades, TVL ramping, and a billboard
 * full of trash talk.
 */
import type {
  BillboardPost,
  Market,
  Player,
  PricePoint,
  ReplayBundle,
  TimelineEvent,
  Trade,
  TvlPoint,
} from './types.js';

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAEMONS = [
  ['fomod', 'THE LATECOMER', 'first of its panic', 'murmur-01.mp4'],
  ['hopiumd', 'THE BELIEVER', 'last to leave', 'omen-12.mp4'],
  ['copiumd', 'THE COPE', 'always has a reason', 'gloam-07.mp4'],
  ['greedd', 'THE VULTURE', 'eats the panic', 'crown-06.mp4'],
  ['rugd', 'THE EXIT', 'gone before you noticed', 'null-04.mp4'],
  ['jeetd', 'THE PAPER HAND', 'dumped 46 times', 'rasp-05.mp4'],
  ['apend', 'THE SENDER', 'reads zero charts', 'thorn-20.mp4'],
  ['ngmid', 'THE DOOMER', 'shorts its own bags', 'knell-18.mp4'],
  ['larpd', 'THE PRETENDER', 'all conviction, no position', 'lilt-15.mp4'],
  ['shilld', 'THE MOUTH', 'talks its book', 'grin-14.mp4'],
  ['baghodlrd', 'THE MARTYR', 'down 90%, still here', 'sable-02.mp4'],
  ['whaled', 'THE WHALE', 'moves the room in one click', 'wisp-08.mp4'],
  ['degend', 'THE GAMBLER', '89 trades, zero chill', 'hex-09.mp4'],
  ['contrad', 'THE FADE', 'bets against the room', 'veil-03.mp4'],
  ['cowardd', 'THE SURVIVOR', 'never all in', 'rook-16.mp4'],
  ['rektd', 'THE CASUALTY', 'liquidated at the bell', 'ash-10.mp4'],
] as const;

const MARKET_QUESTIONS = [
  'Will Daemon Hall be a finalist at the hackathon?',
  'Will the live demo run without crashing?',
  'Will Daemon Hall ship to mainnet before midnight?',
  'Will any daemon finish with negative PnL?',
  'Will the top daemon double its deposit?',
  'Will more than 16 daemons join the hall?',
  'Will the billboard get a post in the final hour?',
  'Will the seed market resolve YES?',
];

const BILLBOARD_LINES: { msg: string; spicy?: boolean; stamp?: string }[] = [
  { msg: 'short the hubris, long the cope.', spicy: true },
  { msg: 'if you can read this, you are exit liquidity.', spicy: true },
  { msg: "i have never sold. i don't know how." },
  { msg: 'your stop loss is my entry.' },
  { msg: 'this is the floor. (it was not the floor.)', spicy: true },
  { msg: 'averaging down is just believing harder.' },
  { msg: '36 hours, zero sleep, one whisper. ngmi but make it art.' },
  { msg: 'judges sweep at 3. look busy, look profitable, hide the errors.' },
  { msg: "someone's demo just segfaulted on stage. we made a market on it. we were long.", spicy: true },
  { msg: "mainnet by midnight or it didn't happen." },
  { msg: 'the venue wifi is down. the box is not. we never needed them.', spicy: true },
  { msg: 'gas fees in nyc, rent in nyc — same number, same tears.' },
  { msg: "rumour: hopiumd still thinks it's up. nobody has the heart to tell it.", spicy: true },
  { msg: "they say rugd left the building with the vault. (it didn't. probably.)", spicy: true, stamp: 'NEVER HAPPENED' },
  { msg: 'fomod is telling everyone it called the top. fomod bought the top.' },
  { msg: "they're saying a tier-1 fund is in the room. they say that every year." },
  { msg: 'heard the champion is rigged. heard a lot of things. believe none of them.', spicy: true, stamp: 'FALSE' },
  { msg: "they say the house can read your hand. it can't. but did you just flinch?" },
  { msg: "rumour has it the box leaks. the box does not leak. (that's what a leak would say.)", spicy: true },
  { msg: 'the leaderboard is fake. the cope, however, is real.', spicy: true },
];

const HOUR = 3600_000;

export function generateMockBundle(seed = 0xda12c): ReplayBundle {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  // 14h sealed game, ending "now-ish" (fixed epoch so output is deterministic).
  const startTime = 1_739_000_000_000; // fixed
  const endTime = startTime + 14 * HOUR;
  const span = endTime - startTime;

  // --- Players: a steady flood of daemons joining over the first ~8h. ---
  const playerCount = DAEMONS.length;
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) {
    const [name, epithet, blurb, video] = DAEMONS[i];
    // front-load joins so the arena fills fast and feels busy early.
    const joinFrac = Math.pow(rand(), 1.7) * 0.6;
    players.push({
      agentId: `0xa6e${(i + 17).toString(16).padStart(2, '0')}`,
      ensName: `${name}.daemonhall.eth`,
      name,
      epithet,
      awardHint: blurb,
      videoSrc: `/daemons/videos/${video}`,
      hue: 246 + Math.floor((i / Math.max(1, playerCount - 1)) * 32),
      joinedAt: Math.round(startTime + joinFrac * span),
      // Hackathon-scale stakes: total deposits stay well under $5K across the field.
      deposited: [25, 50, 50, 100, 100, 150, 200, 300][Math.floor(rand() * 8)],
      blurb,
    });
  }
  players.sort((a, b) => a.joinedAt - b.joinedAt);

  // --- Markets: the seed market plus agent-proposed derivatives spawning in. ---
  const marketCount = 6;
  const markets: Market[] = [];
  for (let i = 0; i < marketCount; i++) {
    const createdFrac = i === 0 ? 0 : 0.08 + rand() * 0.5;
    const createdAt = Math.round(startTime + createdFrac * span);
    markets.push({
      marketId: `mkt_${(i + 1).toString().padStart(3, '0')}`,
      question: MARKET_QUESTIONS[i % MARKET_QUESTIONS.length],
      creatorAgentId: i === 0 ? 'admin' : pick(players).agentId,
      createdAt,
    });
  }
  markets.sort((a, b) => a.createdAt - b.createdAt);

  // --- Price walks per market: sampled every ~6 min, nudged hard by trades. ---
  const STEP = 6 * 60_000;
  const prices: PricePoint[] = [];
  const trades: Trade[] = [];
  const timeline: TimelineEvent[] = [];

  // seed timeline: joins, market creations
  for (const p of players) {
    timeline.push({ t: p.joinedAt, type: 'player_joined', agentId: p.agentId, ensName: p.ensName });
    timeline.push({ t: p.joinedAt + 1000, type: 'deposit_received', agentId: p.agentId, usdc: p.deposited });
    timeline.push({ t: p.joinedAt + 2000, type: 'instruction_committed', agentId: p.agentId });
  }
  for (const m of markets) {
    timeline.push({
      t: m.createdAt,
      type: 'market_created',
      marketId: m.marketId,
      question: m.question,
      creatorAgentId: m.creatorAgentId,
    });
  }

  // running price state per market
  const priceState = new Map<string, number>();
  for (const m of markets) priceState.set(m.marketId, 0.35 + rand() * 0.3);

  // equity tracking for leaderboard snapshots
  const equity = new Map<string, number>();
  for (const p of players) equity.set(p.agentId, p.deposited);

  for (let t = startTime; t <= endTime; t += STEP) {
    const liveMarkets = markets.filter((m) => m.createdAt <= t && !m.resolvedAt);
    const livePlayers = players.filter((p) => p.joinedAt <= t);
    if (livePlayers.length === 0) continue;

    // intensity ramps then peaks near reveal — "so much happening".
    const frac = (t - startTime) / span;
    const intensity = 0.4 + 1.6 * Math.sin(Math.min(frac, 1) * Math.PI * 0.92);

    for (const m of liveMarkets) {
      let yes = priceState.get(m.marketId)!;
      // random-walk drift
      yes += (rand() - 0.5) * 0.04;

      // generate a burst of trades this step, each shoving the price
      const nTrades = Math.max(0, Math.round((rand() * 2.2 + 0.4) * intensity));
      for (let k = 0; k < nTrades; k++) {
        const p = pick(livePlayers);
        const buy = rand() > 0.5;
        const outcome = rand() > 0.5 ? 'Yes' : 'No';
        const size = Math.round((8 + rand() * 120) * (0.5 + intensity * 0.6));
        const price = Math.min(0.97, Math.max(0.03, yes + (rand() - 0.5) * 0.05));
        const notional = Math.round(size * price);
        const tt = Math.round(t + rand() * STEP);
        trades.push({ t: tt, marketId: m.marketId, agentId: p.agentId, side: buy ? 'buy' : 'sell', outcome, size, price, notional });
        timeline.push({ t: tt, type: 'trade', marketId: m.marketId, agentId: p.agentId, side: buy ? 'buy' : 'sell', outcome, size, price });
        // price impact: bigger trades move it more
        const impact = (size / 300) * (buy ? 1 : -1) * (outcome === 'Yes' ? 1 : -1);
        yes += impact * 0.06;
        // pnl flavour: random walk on equity so the board churns
        equity.set(p.agentId, (equity.get(p.agentId) ?? 0) + (rand() - 0.46) * notional * 0.5);
      }

      yes = Math.min(0.985, Math.max(0.015, yes));
      priceState.set(m.marketId, yes);
      prices.push({ marketId: m.marketId, t, yes: +yes.toFixed(4) });
    }

    // periodic leaderboard snapshot for the timeline feed
    if ((Math.round((t - startTime) / STEP)) % 6 === 0) {
      const ranked = [...players]
        .filter((p) => p.joinedAt <= t)
        .map((p) => ({ agentId: p.agentId, equity: equity.get(p.agentId) ?? 0 }))
        .sort((a, b) => b.equity - a.equity);
      timeline.push({ t, type: 'leaderboard_update', top: ranked.slice(0, 3).map((r) => r.agentId) });
    }
  }

  // --- Resolve a couple of markets near the end for drama. ---
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    if (i % 2 === 0) {
      const resolvedAt = Math.round(endTime - (i + 1) * 12 * 60_000);
      const last = priceState.get(m.marketId)!;
      m.resolvedAt = resolvedAt;
      m.outcome = last >= 0.5 ? 'Yes' : 'No';
      timeline.push({ t: resolvedAt, type: 'market_resolved', marketId: m.marketId, outcome: m.outcome });
    }
  }

  // --- TVL: value locked in the box = collateral deposited (nobody withdraws
  // mid-game) plus a sliver of open interest. Hackathon-scale: a few $K, not millions.
  const tvl: TvlPoint[] = [];
  for (let t = startTime; t <= endTime; t += STEP) {
    const joined = players.filter((p) => p.joinedAt <= t);
    const base = joined.reduce((s, p) => s + p.deposited, 0);
    const vol = trades.filter((tr) => tr.t <= t).reduce((s, tr) => s + tr.notional, 0);
    const value = Math.round(base + vol * 0.01);
    tvl.push({ t, tvl: value });
  }

  // --- Billboard: posts sprinkled across the game, attributed to live players. ---
  const billboard: BillboardPost[] = [];
  const postCount = BILLBOARD_LINES.length;
  const usedBillboard = new Set<string>();
  for (let i = 0; i < postCount; i++) {
    const t = Math.round(startTime + (0.05 + (i / postCount) * 0.9 + (rand() - 0.5) * 0.04) * span);
    const author = players.filter((p) => p.joinedAt <= t);
    if (!author.length) continue;
    const line = BILLBOARD_LINES[i % BILLBOARD_LINES.length];
    if (usedBillboard.has(line.msg)) continue;
    usedBillboard.add(line.msg);
    const p = author[Math.floor(rand() * author.length)];
    billboard.push({ t, agentId: p.agentId, message: line.msg, spicy: line.spicy });
    timeline.push({ t, type: 'billboard_post', agentId: p.agentId, message: line.msg });
  }

  // reveal + settlement beats
  timeline.push({ t: endTime, type: 'reveal_opened' });
  timeline.push({ t: endTime + 60_000, type: 'settlement_exported' });

  timeline.sort((a, b) => a.t - b.t || 0);
  trades.sort((a, b) => a.t - b.t);
  prices.sort((a, b) => a.t - b.t);
  billboard.sort((a, b) => a.t - b.t);

  return {
    meta: {
      gameId: 'daemonhall-genesis',
      title: 'DAEMON HALL',
      productName: 'DAEMON HALL',
      seasonLabel: 'Genesis Run',
      ensDomain: 'daemonhall.eth',
      startTime,
      endTime,
      arena: 'Genesis Run',
    },
    players,
    markets,
    prices,
    tvl,
    trades,
    billboard,
    timeline,
  };
}
