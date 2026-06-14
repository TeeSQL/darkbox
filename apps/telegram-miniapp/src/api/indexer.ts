/**
 * DarkBox indexer client — the public spectator API (`/public/*`).
 *
 * No auth. This is the live data that `public/flow.js` currently fakes with
 * deterministic generators (markets, leaderboard, game stats, activity).
 * Point `baseUrl` at a local indexer now (e.g. http://127.0.0.1:8080) and the
 * deployed indexer later — nothing else changes.
 *
 * Response shapes mirror services/indexer/src/routes/public.ts exactly. The
 * indexer's `stripForbidden` guarantees no private keys/balances leak here.
 */

export interface GameStats {
  active_markets: string;
  active_agents: string;
  total_trades: string;
  total_volume_usdc: string;
  positions_opened: string;
  positions_closed: string;
}

export interface MarketRow {
  market_id: string;
  game_id: string;
  question: string;
  metadata_uri: string;
  close_time: string;
  resolve_by: string;
  resolver_type: string;
  status: string;
  resolved_outcome: string | null;
  created_at_ts: string;
}

export interface MarketDetail extends MarketRow {
  resolution_hash: string | null;
}

export interface LeaderboardEntry {
  agentId: string;
  ensName: string;
  rank: number;
  pnl: string;
  pnlPct: string;
  equity: string;
  netDeposits: string;
}

export interface ActivityStats {
  total_deposits_count: string;
  total_withdrawals_count: string;
  total_trades: string;
  total_volume_usdc: string;
  active_markets: string;
  active_agents: string;
}

export interface IndexerClientConfig {
  /** Public indexer base URL, e.g. http://127.0.0.1:8080 (no trailing slash needed). */
  baseUrl: string;
  /** Injectable fetch (defaults to global fetch); handy for tests. */
  fetchImpl?: typeof fetch;
}

export class IndexerError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`indexer ${status}`);
    this.name = "IndexerError";
  }
}

export function createIndexerClient(config: IndexerClientConfig) {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/$/, "");

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${base}/public${path}`, { cache: "no-store" });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new IndexerError(res.status, parsed);
    return parsed as T;
  }

  return {
    game: () => get<GameStats>("/game"),
    markets: () => get<MarketRow[]>("/markets"),
    market: (marketId: string) =>
      get<MarketDetail>(`/markets/${encodeURIComponent(marketId)}`),
    leaderboard: () => get<LeaderboardEntry[]>("/leaderboard"),
    activity: () => get<ActivityStats>("/activity"),
  };
}

export type IndexerClient = ReturnType<typeof createIndexerClient>;
