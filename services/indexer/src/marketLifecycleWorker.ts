import { config } from "./config.js";
import { getPool } from "./db.js";
import { closeExpiredMarkets } from "./marketLifecycle.js";

let lastRun = 0;

export async function runMarketLifecycleCycle(now = new Date()): Promise<void> {
  if (!config.marketLifecycleEnabled) return;
  const elapsed = Date.now() - lastRun;
  if (lastRun !== 0 && elapsed < config.marketLifecycleIntervalMs) return;
  lastRun = Date.now();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const closed = await closeExpiredMarkets(client, now);
    await client.query("COMMIT");
    if (closed.length > 0) {
      console.log(`[market-lifecycle] closed ${closed.length} expired market(s)`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
