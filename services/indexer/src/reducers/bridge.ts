import type pg from "pg";
import { config } from "../config.js";
import type { NormalizedEvent } from "../adapters/types.js";
import { registerDynamicFrontierBook, registerDynamicPmMarket } from "../ingestion/poller.js";

function bigStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  return String(v);
}

export async function applyBridgeEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<void> {
  const d = event.decoded as Record<string, unknown>;

  switch (event.eventName) {
    case "AgentRegistered": {
      await client.query(
        `INSERT INTO agents
           (agent_id, game_id, owner_address, shadow_account, ens_name,
            instruction_hash, runtime_hash, reveal_salt_hash,
            registered_at_block, registered_at_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (agent_id) DO UPDATE SET
           ens_name = EXCLUDED.ens_name`,
        [
          String(d["agentId"]),
          String(d["gameId"]),
          String(d["owner"]),
          String(d["shadowAccount"]),
          String(d["ensName"] ?? ""),
          String(d["instructionHash"]),
          String(d["runtimeHash"]),
          String(d["revealSaltHash"]),
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'active_agents'`,
      );
      break;
    }

    case "DepositReceived": {
      const shadowAccount = await resolveShadowAccount(client, String(d["owner"]));
      const asset = config.usdcAddress;
      const amount = bigStr(d["amount"]);

      await upsertBalance(client, shadowAccount, asset, "deposit", amount);

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'total_deposits_count'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
         WHERE key = 'total_deposits_usdc'`,
        [amount],
      );
      break;
    }

    case "WithdrawalExecuted": {
      const shadowAccount = await resolveShadowAccount(client, String(d["owner"]));
      const asset = config.usdcAddress;
      const amount = bigStr(d["amount"]);

      await upsertBalance(client, shadowAccount, asset, "withdraw", amount);

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'total_withdrawals_count'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
         WHERE key = 'total_withdrawals_usdc'`,
        [amount],
      );
      break;
    }

    case "EmergencyWithdrawal": {
      const shadowAccount = await resolveShadowAccount(client, String(d["owner"]));
      const asset = config.usdcAddress;
      const amount = bigStr(d["amount"]);
      await upsertBalance(client, shadowAccount, asset, "withdraw", amount);
      break;
    }
  }
}

export async function applyShadowBridgeEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<void> {
  const d = event.decoded as Record<string, unknown>;

  switch (event.eventName) {
    case "ShadowMinted": {
      const shadowAccount = String(d["shadowAccount"]);
      const asset = config.usdcAddress;
      const amount = bigStr(d["amount"]);
      await upsertBalance(client, shadowAccount, asset, "credit", amount);
      break;
    }
    case "ShadowBurned": {
      const shadowAccount = String(d["shadowAccount"]);
      const asset = config.usdcAddress;
      const amount = bigStr(d["amount"]);
      await upsertBalance(client, shadowAccount, asset, "burn", amount);
      break;
    }
  }
}

async function resolveShadowAccount(
  client: pg.PoolClient,
  owner: string,
): Promise<string> {
  const row = await client.query<{ shadow_account: string }>(
    "SELECT shadow_account FROM agents WHERE owner_address = $1 LIMIT 1",
    [owner.toLowerCase()],
  );
  // Fall back to the owner address itself if not registered yet
  return row.rows[0]?.shadow_account ?? owner.toLowerCase();
}

async function upsertBalance(
  client: pg.PoolClient,
  shadowAccount: string,
  asset: string,
  kind: "deposit" | "withdraw" | "credit" | "burn",
  amount: string,
): Promise<void> {
  const colMap: Record<string, string> = {
    deposit: "total_deposited",
    withdraw: "total_withdrawn",
    credit: "total_credited",
    burn: "total_burned",
  };
  const col = colMap[kind]!;

  // Compute current_balance delta: credit/deposit → +, burn/withdraw → -
  const sign = kind === "deposit" || kind === "credit" ? "+" : "-";

  await client.query(
    `INSERT INTO balances (shadow_account, asset, ${col}, current_balance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shadow_account, asset) DO UPDATE SET
       ${col} = (balances.${col}::numeric + $3::numeric)::text,
       current_balance = GREATEST(0::numeric, (balances.current_balance::numeric ${sign} $3::numeric))::text,
       updated_at = NOW()`,
    [shadowAccount.toLowerCase(), asset.toLowerCase(), amount, kind === "deposit" || kind === "credit" ? amount : "0"],
  );
}
