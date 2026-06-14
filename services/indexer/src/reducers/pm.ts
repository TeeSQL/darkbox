import type pg from "pg";
import type { NormalizedEvent } from "../adapters/types.js";
import { addPosition, reducePositionForProceeds, registerFrontierBook } from "./frontier.js";
import { registerDynamicFrontierBook, registerDynamicPmMarket } from "../ingestion/poller.js";

const RESOLVER_TYPE_NAMES: Record<number, string> = {
  0: "AdminManual",
  1: "CanonicalWinner",
  2: "DependentMarket",
  3: "ExternalAttested",
  4: "VoidOnly",
};

const OUTCOME_NAMES: Record<number, string> = {
  0: "Unset",
  1: "Yes",
  2: "No",
  3: "Invalid",
};

async function resolveOwnerToShadowAccount(
  client: pg.PoolClient,
  owner: string,
): Promise<string | null> {
  const r = await client.query<{ shadow_account: string }>(
    "SELECT shadow_account FROM agents WHERE owner_address=$1 OR shadow_account=$1 LIMIT 1",
    [owner.toLowerCase()],
  );
  return r.rows[0]?.shadow_account ?? null;
}

async function adjustUsdcBalance(
  client: pg.PoolClient,
  shadowAccount: string,
  delta: string,
): Promise<void> {
  await client.query(
    `INSERT INTO balances (shadow_account, asset, current_balance)
     VALUES ($1, 'USDC', GREATEST(0::numeric, $2::numeric)::text)
     ON CONFLICT (shadow_account, asset) DO UPDATE SET
       current_balance = GREATEST(0::numeric, balances.current_balance::numeric + $2::numeric)::text,
       updated_at = NOW()`,
    [shadowAccount.toLowerCase(), delta],
  );
}

function bigStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  return String(v);
}

export async function applyPmFactoryEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<void> {
  const d = event.decoded as Record<string, unknown>;

  switch (event.eventName) {
    case "MarketCreated": {
      const marketId = String(d["marketId"]).toLowerCase();
      const resolverTypeNum = Number(d["resolverType"] ?? 0);
      const resolverType = RESOLVER_TYPE_NAMES[resolverTypeNum] ?? "AdminManual";
      const marketAddress = String(d["market"]).toLowerCase();

      await client.query(
        `INSERT INTO markets
           (market_id, game_id, creator_address, market_address, question,
            metadata_uri, close_time, resolve_by, resolver_type,
            status, created_at_block, created_at_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Active',$10,$11)
         ON CONFLICT (market_id) DO UPDATE SET
           question = EXCLUDED.question,
           metadata_uri = EXCLUDED.metadata_uri`,
        [
          marketId,
          String(d["gameId"]).toLowerCase(),
          String(d["creator"]).toLowerCase(),
          marketAddress,
          String(d["question"] ?? ""),
          String(d["metadataURI"] ?? ""),
          bigStr(d["closeTime"]),
          bigStr(d["resolveBy"]),
          resolverType,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );

      // Register this market address for dynamic polling
      registerDynamicPmMarket(marketAddress);

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'active_markets'`,
      );
      break;
    }

    case "BooksRegistered": {
      const marketId = String(d["marketId"]).toLowerCase();
      const yesBook = String(d["yesBook"]).toLowerCase();
      const noBook = String(d["noBook"]).toLowerCase();
      const yesToken = String(d["yesToken"]).toLowerCase();
      const noToken = String(d["noToken"]).toLowerCase();

      await registerFrontierBook(client, marketId, yesBook, noBook, yesToken, noToken);

      // Register books for dynamic polling
      registerDynamicFrontierBook(yesBook);
      registerDynamicFrontierBook(noBook);
      break;
    }
  }
}

export async function applyPmMarketEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<void> {
  const d = event.decoded as Record<string, unknown>;

  switch (event.eventName) {
    case "MarketActivated": {
      await client.query(
        "UPDATE markets SET status='Active', updated_at=NOW() WHERE market_id=$1",
        [String(d["marketId"]).toLowerCase()],
      );
      break;
    }
    case "MarketPaused": {
      await client.query(
        "UPDATE markets SET status='Paused', updated_at=NOW() WHERE market_id=$1",
        [String(d["marketId"]).toLowerCase()],
      );
      break;
    }
    case "MarketResumed": {
      await client.query(
        "UPDATE markets SET status='Active', updated_at=NOW() WHERE market_id=$1",
        [String(d["marketId"]).toLowerCase()],
      );
      break;
    }
    case "MarketClosed": {
      await client.query(
        "UPDATE markets SET status='Closed', updated_at=NOW() WHERE market_id=$1",
        [String(d["marketId"]).toLowerCase()],
      );
      await client.query(
        `UPDATE aggregate_stats SET value = GREATEST('0', (value::bigint - 1))::text, updated_at = NOW()
         WHERE key = 'active_markets'`,
      );
      break;
    }
    case "MarketResolved": {
      const outcomeNum = Number(d["outcome"] ?? 0);
      const outcome = OUTCOME_NAMES[outcomeNum] ?? "Unset";
      await client.query(
        `UPDATE markets SET status='Resolved', resolved_outcome=$1, resolution_hash=$2, updated_at=NOW()
         WHERE market_id=$3`,
        [
          outcome,
          String(d["resolutionHash"]),
          String(d["marketId"]).toLowerCase(),
        ],
      );
      await client.query(
        `UPDATE aggregate_stats SET value = GREATEST('0', (value::bigint - 1))::text, updated_at = NOW()
         WHERE key = 'active_markets'`,
      );
      break;
    }
    case "MarketVoided": {
      await client.query(
        `UPDATE markets SET status='Voided', resolved_outcome='Invalid', updated_at=NOW()
         WHERE market_id=$1`,
        [String(d["marketId"]).toLowerCase()],
      );
      await client.query(
        `UPDATE aggregate_stats SET value = GREATEST('0', (value::bigint - 1))::text, updated_at = NOW()
         WHERE key = 'active_markets'`,
      );
      break;
    }
    case "Split": {
      const marketId = String(d["marketId"]).toLowerCase();
      const receiver = String(d["receiver"] ?? d["caller"]).toLowerCase();
      const amount = bigStr(d["amount"]);
      const shadowAccount = await resolveOwnerToShadowAccount(client, receiver);
      if (shadowAccount) {
        const halfCost = (BigInt(amount || "0") / 2n).toString();
        await addPosition(client, shadowAccount, marketId, "Yes", amount, halfCost);
        await addPosition(client, shadowAccount, marketId, "No", amount, halfCost);
        await adjustUsdcBalance(client, shadowAccount, `-${amount}`);
      }
      break;
    }
    case "Joined": {
      const marketId = String(d["marketId"]).toLowerCase();
      const caller = String(d["caller"]).toLowerCase();
      const amount = bigStr(d["amount"]);
      const shadowAccount = await resolveOwnerToShadowAccount(client, caller);
      if (shadowAccount) {
        const halfProceeds = (BigInt(amount || "0") / 2n).toString();
        await reducePositionForProceeds(client, shadowAccount, marketId, "Yes", amount, halfProceeds);
        await reducePositionForProceeds(client, shadowAccount, marketId, "No", amount, halfProceeds);
        await adjustUsdcBalance(client, shadowAccount, amount);
      }
      break;
    }
    case "Redeemed": {
      const marketId = String(d["marketId"]).toLowerCase();
      const receiver = String(d["receiver"] ?? d["caller"]).toLowerCase();
      const outcome = OUTCOME_NAMES[Number(d["outcome"] ?? 0)] ?? "Unset";
      const amount = bigStr(d["amount"]);
      const shadowAccount = await resolveOwnerToShadowAccount(client, receiver);
      if (shadowAccount && (outcome === "Yes" || outcome === "No")) {
        await reducePositionForProceeds(client, shadowAccount, marketId, outcome, amount, amount);
        await adjustUsdcBalance(client, shadowAccount, amount);
      }
      break;
    }
  }
}
