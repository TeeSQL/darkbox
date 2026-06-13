import { startServer } from "./server.js";
import { store } from "./store.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("[transcriber] starting up");
  if (config.sttMode === "http" && !config.sttUrl) {
    console.warn("[transcriber] STT_MODE=http but STT_URL unset — transcriptions will 502.");
  }

  await startServer();

  // Periodic retention sweep so raw audio / drafts never outlive the window.
  const sweep = setInterval(() => store.sweep(), Math.min(config.retentionMs, 60_000));
  sweep.unref?.();

  const shutdown = () => {
    console.log("[transcriber] shutting down");
    clearInterval(sweep);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[transcriber] fatal:", err);
  process.exit(1);
});
