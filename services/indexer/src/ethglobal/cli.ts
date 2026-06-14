import { runMigrations } from "../migrate.js";
import { closePool } from "../db.js";
import { ethGlobalShowcaseUrl, fetchEthGlobalShowcase } from "./parser.js";
import { storeEthGlobalFetch, storeEthGlobalIngestFailure } from "./store.js";

const DEFAULT_EVENT = "ethnyc2026";

function parseEventSlug(argv: string[]): string {
  const eventIndex = argv.findIndex((arg) => arg === "--event");
  if (eventIndex >= 0) return argv[eventIndex + 1] ?? DEFAULT_EVENT;
  const positional = argv.find((arg) => !arg.startsWith("--"));
  return positional ?? process.env["ETHGLOBAL_EVENT"] ?? DEFAULT_EVENT;
}

async function main(): Promise<void> {
  const eventSlug = parseEventSlug(process.argv.slice(2));
  const sourceUrl = ethGlobalShowcaseUrl(eventSlug);

  try {
    await runMigrations();
    const fetched = await fetchEthGlobalShowcase(eventSlug);
    const result = await storeEthGlobalFetch(fetched);
    console.log(JSON.stringify({
      status: "ok",
      eventSlug: result.eventSlug,
      runId: result.runId,
      projectCount: result.projectCount,
      fetchedAt: result.fetchedAt.toISOString(),
      sourceUrl,
    }));
  } catch (error) {
    await storeEthGlobalIngestFailure(eventSlug, sourceUrl, error).catch(() => undefined);
    throw error;
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error("[ethglobal-ingest] fatal:", err);
  process.exit(1);
});
