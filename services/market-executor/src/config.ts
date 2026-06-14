import type { Address, Hex } from "viem";

/**
 * Market-executor configuration (mirrors services/bridge/src/config.ts).
 * Values come from environment/sealed secrets; `loadConfig` reads `process.env`
 * with sane defaults for everything EXCEPT secrets and chain-identifying
 * addresses, which are required.
 *
 * SECURITY: `coordinatorPrivateKey` is read from env only. It is NEVER logged,
 * echoed, or written to disk. Treat it like the bridge signer key.
 */
export interface MarketExecutorConfig {
  hiddenRpcUrl: string;
  hiddenChainId: number;
  /** DarkBoxMarketFactory address on the hidden chain. */
  marketFactoryAddress: Address;
  /** bytes32 game id all markets are created under. */
  gameId: Hex;
  /** Factory owner/coordinator + minter key. NEVER log this. */
  coordinatorPrivateKey: Hex;
  /** Indexer internal base URL, e.g. http://localhost:8080/internal (no trailing slash). */
  indexerInternalUrl: string;
  pollIntervalMs: number;
  creatorBond: bigint;
  initialLiquidity: bigint;
  /**
   * If set, every created market uses this exact close time (unix seconds).
   * Otherwise the close time is the next Sunday 17:00 America/New_York.
   */
  closeTimeOverrideUnix?: number;
}

function req(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

/**
 * Next Sunday 17:00 in America/New_York, as unix seconds.
 *
 * The demo runs in June, when New York observes EDT = UTC-4, so 17:00 ET is
 * 21:00 UTC. We compute the day-of-week in NY (not the host's local zone) via
 * Intl so the choice of "next Sunday" is correct regardless of where the CVM
 * runs, then build the UTC instant by applying the EDT offset.
 *
 * "Next Sunday" means: the upcoming Sunday whose 17:00 ET is still in the
 * future. If today is Sunday and it's already past 17:00 ET, roll to the
 * Sunday a week out.
 *
 * NOTE: this hardcodes the EDT (-4h) offset, which is correct for the demo
 * window (mid-March .. early-Nov). If this service is ever run during EST,
 * set CLOSE_TIME_OVERRIDE_UNIX instead.
 */
export function nextSundayCloseUnix(now: Date = new Date()): number {
  const ET_OFFSET_HOURS = 4; // EDT = UTC-4 (demo is June)
  const CLOSE_HOUR_ET = 17;

  // Wall-clock components of `now` as seen in New York.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayShort = get("weekday"); // Sun, Mon, ...
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some ICU builds report midnight as 24

  const dowIndex: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const todayDow = dowIndex[weekdayShort] ?? 0;

  // Days until the next Sunday whose 17:00 ET is still ahead of us.
  let daysUntilSunday = (7 - todayDow) % 7; // 0 if today is Sunday
  if (daysUntilSunday === 0 && hour >= CLOSE_HOUR_ET) {
    daysUntilSunday = 7; // already past this Sunday's close → next week
  }

  // Build the target NY wall-clock date (today's NY date + N days @ 17:00 ET),
  // then convert to a UTC instant by adding the EDT offset.
  // Date.UTC of the NY *date* at (17 + 4)=21:00 gives the correct UTC instant.
  const targetUtcMs = Date.UTC(
    year,
    month - 1,
    day + daysUntilSunday,
    CLOSE_HOUR_ET + ET_OFFSET_HOURS,
    0,
    0,
    0,
  );
  return Math.floor(targetUtcMs / 1000);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketExecutorConfig {
  const overrideRaw = env.CLOSE_TIME_OVERRIDE_UNIX;
  return {
    hiddenRpcUrl: env.HIDDEN_RPC_URL ?? "http://localhost:8545",
    hiddenChainId: Number(env.HIDDEN_CHAIN_ID ?? "88813"),
    marketFactoryAddress: req("MARKET_FACTORY_ADDRESS", env.MARKET_FACTORY_ADDRESS) as Address,
    gameId: req("GAME_ID", env.GAME_ID) as Hex,
    coordinatorPrivateKey: req("COORDINATOR_PRIVATE_KEY", env.COORDINATOR_PRIVATE_KEY) as Hex,
    indexerInternalUrl: (env.INDEXER_INTERNAL_URL ?? "http://localhost:8080/internal").replace(/\/$/, ""),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? "8000"),
    creatorBond: BigInt(env.CREATOR_BOND ?? "0"),
    initialLiquidity: BigInt(env.INITIAL_LIQUIDITY ?? "0"),
    ...(overrideRaw ? { closeTimeOverrideUnix: Number(overrideRaw) } : {}),
  };
}

/**
 * Resolves the (closeTime, resolveBy) pair for a new market.
 * resolveBy = closeTime + 24h (market spec: resolution window after close).
 */
export function marketTimes(
  cfg: Pick<MarketExecutorConfig, "closeTimeOverrideUnix">,
  now: Date = new Date(),
): { closeTime: bigint; resolveBy: bigint } {
  const closeTime = cfg.closeTimeOverrideUnix ?? nextSundayCloseUnix(now);
  const resolveBy = closeTime + 24 * 60 * 60;
  return { closeTime: BigInt(closeTime), resolveBy: BigInt(resolveBy) };
}
