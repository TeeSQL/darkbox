import { runMigrations } from "./migrate.js";
import { startServer } from "./server.js";
import {
  runPollCycle,
  loadDynamicContractsFromDb,
} from "./ingestion/poller.js";
import { takeSnapshot } from "./reducers/snapshots.js";
import { config } from "./config.js";
import { closePool } from "./db.js";

async function main(): Promise<void> {
  console.log("[indexer] starting up");

  // Run DB migrations
  await runMigrations();
  console.log("[indexer] migrations complete");

  // Load previously-discovered dynamic contracts (frontier books, pm markets)
  await loadDynamicContractsFromDb();

  // Start HTTP server
  await startServer();

  // Main event-polling loop
  let snapshotTimer = Date.now();
  const poll = async () => {
    try {
      await runPollCycle();
    } catch (err) {
      console.error("[indexer] poll error:", err);
    }

    // Periodic snapshots
    if (Date.now() - snapshotTimer >= config.snapshotIntervalMs) {
      snapshotTimer = Date.now();
      try {
        await takeSnapshot();
      } catch (err) {
        console.error("[indexer] snapshot error:", err);
      }
    }

    setTimeout(poll, config.pollIntervalMs);
  };

  void poll();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[indexer] shutting down");
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[indexer] fatal:", err);
  process.exit(1);
});
