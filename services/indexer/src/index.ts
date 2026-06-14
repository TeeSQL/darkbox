import { runMigrations } from "./migrate.js";
import { startServer } from "./server.js";
import {
  runPollCycle,
  loadDynamicContractsFromDb,
} from "./ingestion/poller.js";
import { takeSnapshot } from "./reducers/snapshots.js";
import { config } from "./config.js";
import { closePool } from "./db.js";
import { runMarketLifecycleCycle } from "./marketLifecycleWorker.js";

/**
 * Process-level safety net. A dropped geth keep-alive socket can surface an
 * 'error' as an unhandled rejection / uncaught exception that is NOT tied to any
 * awaited RPC call. Without a handler this would terminate the process (or, worse,
 * leave it half-alive). We LOG and KEEP RUNNING — the scan loop is driven by a
 * setTimeout chain that survives, so it keeps ingesting. We deliberately do NOT
 * process.exit on these: an RPC blip must never take the indexer down.
 */
function installProcessSafetyNet(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[indexer] unhandledRejection (keeping scanner alive):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[indexer] uncaughtException (keeping scanner alive):", err);
  });
}

async function main(): Promise<void> {
  console.log("[indexer] starting up");
  installProcessSafetyNet();

  // Run DB migrations
  await runMigrations();
  console.log("[indexer] migrations complete");

  // Load previously-discovered dynamic contracts (frontier books, pm markets)
  await loadDynamicContractsFromDb();

  // Start HTTP server
  await startServer();

  // Main event-polling loop. This is a self-rescheduling setTimeout chain rather
  // than a floating async task that can silently die: EVERY iteration ends by
  // scheduling the next one (in a finally), so an error anywhere inside can never
  // stop the scanner. RPC/socket errors are caught inside runPollCycle/pollContract
  // (which resume from the persisted cursor); here we add exponential backoff after
  // consecutive RPC failures so we don't hammer a geth that's mid-restart.
  let snapshotTimer = Date.now();
  let rpcFailureStreak = 0;
  const backoffFor = (streak: number) =>
    Math.min(config.pollIntervalMs * 2 ** streak, config.scanMaxBackoffMs);
  const poll = async () => {
    let backoffMs = config.pollIntervalMs;
    try {
      const ok = await runPollCycle();
      if (ok) {
        rpcFailureStreak = 0;
      } else {
        rpcFailureStreak += 1;
        backoffMs = backoffFor(rpcFailureStreak);
        console.warn(
          `[indexer] scan cycle hit RPC error (streak=${rpcFailureStreak}); backing off ${backoffMs}ms before retrying from cursor`,
        );
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

      try {
        await runMarketLifecycleCycle();
      } catch (err) {
        console.error("[indexer] market lifecycle error:", err);
      }
    } catch (err) {
      // Defensive: nothing above is expected to throw (each await is guarded), but
      // if anything ever does we still back off and reschedule below rather than
      // let the loop die.
      rpcFailureStreak += 1;
      backoffMs = backoffFor(rpcFailureStreak);
      console.error("[indexer] poll error (continuing):", err);
    } finally {
      // ALWAYS reschedule — this is what guarantees the scanner can never die.
      setTimeout(() => void poll(), backoffMs);
    }
  };

  // Supervise the loop: if the very first kick somehow rejects, log and restart
  // it so the scanner can never be left dead.
  const startPoll = () => {
    poll().catch((err) => {
      console.error("[indexer] poll loop crashed, restarting:", err);
      setTimeout(startPoll, config.pollIntervalMs);
    });
  };
  startPoll();

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
