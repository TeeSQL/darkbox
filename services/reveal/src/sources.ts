/**
 * Concrete reveal sources backed by the indexer internal API + local deployment
 * artifacts. Defensive: tolerates endpoints/fields that aren't present yet
 * (returns []), so a bundle can always be built — partial is better than none,
 * and `accounting.reconciled` surfaces any gaps.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AccountingRecord,
  AgentReveal,
  FillRecord,
  LeaderboardRow,
  MarketReveal,
  OrderRecord,
  PositionRecord,
  RevealEvent,
  RevealSources,
} from "./types.js";

async function tryJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const key of ["items", "rows", "data", "markets", "agents", "events", "leaderboard"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as T[];
    }
  }
  return [];
}

export class HttpRevealSources implements RevealSources {
  constructor(
    private readonly base: string,
    private readonly deploymentsDir: string,
  ) {}

  async getDeployments(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    try {
      const files = await readdir(this.deploymentsDir);
      for (const f of files.filter((f) => f.endsWith(".json"))) {
        try {
          out[f.replace(/\.json$/, "")] = JSON.parse(await readFile(join(this.deploymentsDir, f), "utf8"));
        } catch {
          /* skip unreadable artifact */
        }
      }
    } catch {
      /* no deployments dir */
    }
    return out;
  }

  async getMarkets(): Promise<MarketReveal[]> {
    return asArray<MarketReveal>(await tryJson(`${this.base}/markets`, []));
  }
  async getOrders(): Promise<OrderRecord[]> {
    return asArray<OrderRecord>(await tryJson(`${this.base}/orders`, []));
  }
  async getFills(): Promise<FillRecord[]> {
    return asArray<FillRecord>(await tryJson(`${this.base}/fills`, []));
  }
  async getPositions(): Promise<PositionRecord[]> {
    return asArray<PositionRecord>(await tryJson(`${this.base}/positions`, []));
  }
  async getLeaderboard(): Promise<LeaderboardRow[]> {
    return asArray<LeaderboardRow>(await tryJson(`${this.base}/leaderboard/raw`, []));
  }
  async getAgents(): Promise<AgentReveal[]> {
    return asArray<AgentReveal>(await tryJson(`${this.base}/agents`, []));
  }
  async getRawEvents(): Promise<RevealEvent[]> {
    return asArray<RevealEvent>(await tryJson(`${this.base}/raw-events`, []));
  }
  async getAccounting(): Promise<Omit<AccountingRecord, "reconciled" | "discrepancyUsdc">> {
    const z = "0.000000";
    return tryJson(`${this.base}/accounting`, {
      publicDepositedUsdc: z,
      shadowMintedUsdc: z,
      promoCreditedUsdc: z,
      withdrawnUsdc: z,
      feesAccruedUsdc: z,
    });
  }
}
