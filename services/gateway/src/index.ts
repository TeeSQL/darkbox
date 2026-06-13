import { startServer } from "./server.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("[gateway] starting up");

  // Fail loud on an unsafe production posture: no bot token AND no explicit
  // opt-in to insecure dev auth means every /api/* call would 401 anyway, but we
  // refuse to *silently* run wide open.
  if (!config.telegramBotToken && !config.allowInsecureDevAuth) {
    console.warn(
      "[gateway] WARNING: TELEGRAM_BOT_TOKEN unset and ALLOW_INSECURE_DEV_AUTH!=true — all /api/* calls will 401.",
    );
  }
  if (!config.telegramBotToken && config.allowInsecureDevAuth) {
    console.warn("[gateway] WARNING: running with INSECURE dev auth. Never do this in prod.");
  }

  await startServer();

  const shutdown = () => {
    console.log("[gateway] shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
