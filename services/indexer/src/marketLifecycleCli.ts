import { runMigrations } from "./migrate.js";
import { closeExpiredMarkets, closeMarket, completeResolution, defaultMarketExpiry, prepareResolution, type ActorRole, type MarketOutcome } from "./marketLifecycle.js";
import { closePool, withTransaction } from "./db.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name}=... is required`);
  return value;
}

function actorRole(): ActorRole {
  const value = requireArg("actor-role");
  if (value !== "admin" && value !== "ocean_operator") throw new Error("--actor-role must be admin or ocean_operator");
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help") {
    console.log("usage: pnpm --filter @darkbox/indexer lifecycle <default-expiry|close-expired|close|prepare-resolution|complete-resolution> [--key=value]");
    return;
  }

  if (command === "default-expiry") {
    const from = arg("from") ? new Date(requireArg("from")) : new Date();
    console.log(defaultMarketExpiry(from).toISOString());
    return;
  }

  await runMigrations();
  try {
    const result = await withTransaction(async (client) => {
      if (command === "close-expired") {
        return closeExpiredMarkets(client);
      }
      if (command === "close") {
        return closeMarket(client, requireArg("market-id"), {
          actorId: requireArg("actor-id"),
          actorRole: actorRole(),
          reason: arg("reason"),
          actionId: arg("action-id"),
        });
      }
      if (command === "prepare-resolution") {
        return prepareResolution(client, requireArg("market-id"), {
          actorId: requireArg("actor-id"),
          actorRole: actorRole(),
          outcome: requireArg("outcome") as MarketOutcome,
          evidence: requireArg("evidence"),
          source: requireArg("source"),
          confirmed: arg("confirmed") === "true",
          reason: arg("reason"),
          actionId: arg("action-id"),
        });
      }
      if (command === "complete-resolution") {
        return completeResolution(client, requireArg("market-id"), {
          actorId: requireArg("actor-id"),
          actorRole: actorRole(),
          txHash: requireArg("tx-hash"),
          reason: arg("reason"),
          actionId: arg("action-id"),
        });
      }
      throw new Error(`unknown command: ${command}`);
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
