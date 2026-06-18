/**
 * World model: derives the state of the game at any game-clock time `t` from the
 * replay bundle. Everything shown on screen (equity, ranks, live prices, TVL,
 * recent trades, billboard) is computed here so the renderer stays dumb.
 *
 * Equity is a genuine mark-to-market: we replay each agent's trades into signed
 * outcome positions and mark them against the market's current YES price. This
 * is fully data-driven (no hidden RNG), so the leaderboard churns meaningfully
 * as prices move.
 */
import type {
  BillboardPost,
  Market,
  Player,
  PricePoint,
  ReplayBundle,
  Trade,
} from '../types.js';

export interface PlayerState {
  player: Player;
  joined: boolean;
  equity: number;
  pnl: number;
  rank: number;
  /** game-time of this player's most recent trade (for pulse animation). */
  lastTradeT: number;
}

export interface MarketState {
  market: Market;
  points: PricePoint[];
  /** number of points with t <= now (for progressive line draw). */
  visibleCount: number;
  currentYes: number;
  created: boolean;
  resolved: boolean;
}

interface Position {
  // signed YES-equivalent exposure and cost basis in USDC
  yesSize: number;
  noSize: number;
  cost: number;
}

/** A "best moment" superlative shown on the finale card. */
export interface Award {
  emoji: string;
  title: string;
  name: string;
  detail: string;
}

export class World {
  readonly bundle: ReplayBundle;
  readonly playerStates = new Map<string, PlayerState>();
  readonly marketStates = new Map<string, MarketState>();
  private readonly pricesByMarket = new Map<string, PricePoint[]>();
  private readonly positions = new Map<string, Map<string, Position>>(); // agent -> market -> pos
  private cursor = 0; // index into trades applied so far
  private now = 0;
  private _awards?: Award[];

  constructor(bundle: ReplayBundle) {
    this.bundle = bundle;
    for (const p of bundle.players) {
      this.playerStates.set(p.agentId, {
        player: p,
        joined: false,
        equity: p.deposited,
        pnl: 0,
        rank: 0,
        lastTradeT: -1e15,
      });
    }
    for (const m of bundle.markets) {
      const pts = bundle.prices.filter((pp) => pp.marketId === m.marketId);
      this.pricesByMarket.set(m.marketId, pts);
      this.marketStates.set(m.marketId, {
        market: m,
        points: pts,
        visibleCount: 0,
        currentYes: pts.length ? pts[0].yes : 0.5,
        created: false,
        resolved: false,
      });
    }
    this.reset();
  }

  private reset() {
    this.cursor = 0;
    this.now = this.bundle.meta.startTime;
    this.positions.clear();
    for (const ps of this.playerStates.values()) {
      ps.joined = false;
      ps.equity = ps.player.deposited;
      ps.pnl = 0;
      ps.lastTradeT = -1e15;
    }
  }

  private applyTrade(tr: Trade) {
    let byMarket = this.positions.get(tr.agentId);
    if (!byMarket) {
      byMarket = new Map();
      this.positions.set(tr.agentId, byMarket);
    }
    let pos = byMarket.get(tr.marketId);
    if (!pos) {
      pos = { yesSize: 0, noSize: 0, cost: 0 };
      byMarket.set(tr.marketId, pos);
    }
    const dir = tr.side === 'buy' ? 1 : -1;
    if (tr.outcome === 'Yes') pos.yesSize += dir * tr.size;
    else pos.noSize += dir * tr.size;
    // cash out/in: buying costs price*size, selling returns it
    pos.cost += dir * tr.price * tr.size;
    const ps = this.playerStates.get(tr.agentId);
    if (ps) ps.lastTradeT = tr.t;
  }

  /** Seek to game-time t and recompute derived state. */
  seek(t: number) {
    const trades = this.bundle.trades;
    if (t < this.now) this.reset();
    this.now = t;

    // advance trades cursor
    while (this.cursor < trades.length && trades[this.cursor].t <= t) {
      this.applyTrade(trades[this.cursor]);
      this.cursor++;
    }

    // players joined
    for (const ps of this.playerStates.values()) {
      ps.joined = ps.player.joinedAt <= t;
    }

    // market visibility + current price (binary-ish; arrays are small)
    for (const ms of this.marketStates.values()) {
      ms.created = ms.market.createdAt <= t;
      ms.resolved = ms.market.resolvedAt !== undefined && ms.market.resolvedAt <= t;
      const pts = ms.points;
      let vis = 0;
      while (vis < pts.length && pts[vis].t <= t) vis++;
      ms.visibleCount = vis;
      ms.currentYes = vis > 0 ? pts[vis - 1].yes : pts.length ? pts[0].yes : 0.5;
    }

    // mark-to-market equity per player
    for (const ps of this.playerStates.values()) {
      const byMarket = this.positions.get(ps.player.agentId);
      let markValue = 0;
      let cost = 0;
      if (byMarket) {
        for (const [marketId, pos] of byMarket) {
          const yes = this.marketStates.get(marketId)?.currentYes ?? 0.5;
          markValue += pos.yesSize * yes + pos.noSize * (1 - yes);
          cost += pos.cost;
        }
      }
      ps.pnl = markValue - cost;
      ps.equity = ps.player.deposited + ps.pnl;
    }

    // ranks (only joined players ranked)
    const ranked = [...this.playerStates.values()]
      .filter((p) => p.joined)
      .sort((a, b) => b.equity - a.equity);
    ranked.forEach((p, i) => (p.rank = i + 1));
  }

  /** TVL at time t, linearly interpolated from samples. */
  tvlAt(t: number): number {
    const arr = this.bundle.tvl;
    if (!arr.length) return 0;
    if (t <= arr[0].t) return arr[0].tvl;
    if (t >= arr[arr.length - 1].t) return arr[arr.length - 1].tvl;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = arr[lo];
    const b = arr[hi];
    const f = (t - a.t) / Math.max(1, b.t - a.t);
    return a.tvl + (b.tvl - a.tvl) * f;
  }

  /** Trades within [t - windowMs, t], for flying-particle effects. */
  recentTrades(t: number, windowMs: number): Trade[] {
    const out: Trade[] = [];
    const trades = this.bundle.trades;
    // cursor already points just past t; walk back
    let i = this.cursor - 1;
    while (i >= 0 && trades[i].t >= t - windowMs) {
      if (trades[i].t <= t) out.push(trades[i]);
      i--;
    }
    return out;
  }

  /** Billboard posts that became active within [t - windowMs, t]. */
  activePosts(t: number, windowMs: number): BillboardPost[] {
    return this.bundle.billboard.filter((p) => p.t <= t && p.t >= t - windowMs);
  }

  /** Most recent billboard post at or before t. */
  latestPost(t: number): BillboardPost | undefined {
    let best: BillboardPost | undefined;
    for (const p of this.bundle.billboard) {
      if (p.t <= t) best = p;
      else break;
    }
    return best;
  }

  rankedPlayers(): PlayerState[] {
    return [...this.playerStates.values()]
      .filter((p) => p.joined)
      .sort((a, b) => b.equity - a.equity);
  }

  marketList(): MarketState[] {
    return [...this.marketStates.values()];
  }

  player(agentId: string): Player | undefined {
    return this.playerStates.get(agentId)?.player;
  }

  /** Public post-reveal superlatives. No whispers, no hidden state. */
  awards(): Award[] {
    if (this._awards) return this._awards;
    const { players, trades, billboard } = this.bundle;
    const playerByName = new Map(players.map((p) => [p.name, p]));
    const state = (name: string) => this.playerStates.get(playerByName.get(name)?.agentId ?? '');
    const tradesFor = (name: string) => trades.filter((t) => t.agentId === playerByName.get(name)?.agentId);
    const postsFor = (name: string) => billboard.filter((b) => b.agentId === playerByName.get(name)?.agentId);
    const pnl = (name: string) => Math.round(state(name)?.pnl ?? 0);
    const biggest = (name: string) => Math.round(Math.max(0, ...tradesFor(name).map((t) => t.notional)));
    const count = (name: string) => tradesFor(name).length;
    const sells = (name: string) => tradesFor(name).filter((t) => t.side === 'sell').length;
    const award = (title: string, name: string, detail: string): Award => ({ emoji: '◇', title, name, detail });

    const champion = this.rankedPlayers()[0]?.player.name ?? 'contrad';
    const awards: Award[] = [
      award('CHAMPION', champion, `${pnl(champion) >= 0 ? '+' : '−'}$${Math.abs(pnl(champion))} top PnL`),
      award('WRONG BUT RICH', 'greedd', `+$${Math.max(1, Math.abs(pnl('greedd')))} while wrong on most calls`),
      award('PAPER HANDS', 'jeetd', `${Math.max(1, sells('jeetd'))} sells — could not sit still`),
      award('DIAMOND HANDS TO ZERO', 'hopiumd', `$${Math.max(1, Math.abs(pnl('hopiumd')))} held to the bottom`),
      award('BILLBOARD BARD', 'shilld', `${Math.max(1, postsFor('shilld').length)} posts of psy-ops`),
      award('WHALE OF THE HALL', 'whaled', `$${biggest('whaled')} in one click`),
      award('DEGEN OF THE DAY', 'degend', `${Math.max(1, count('degend'))} trades, zero chill`),
      award('EXIT LIQUIDITY', 'fomod', `${pnl('fomod') >= 0 ? '+' : '−'}$${Math.abs(pnl('fomod'))} bought every top`),
      award('THE FADE', 'contrad', `${pnl('contrad') >= 0 ? '+' : '−'}$${Math.abs(pnl('contrad'))} against the crowd`),
      award('FIRST BLOOD', 'rektd', 'first liquidation, last candle'),
    ];
    this._awards = awards;
    return awards;
  }
}
