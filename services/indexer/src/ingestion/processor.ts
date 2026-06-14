import type pg from "pg";
import type { NormalizedEvent, AdapterName } from "../adapters/types.js";
import { withTransaction, query } from "../db.js";

export interface StoredRawEvent {
  id: bigint;
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: string;
  txFrom?: string | null;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  adapter: AdapterName;
  rawData: Record<string, unknown>;
}

/**
 * Persist a normalized event idempotently. Returns the stored row id, or null
 * if the event was already stored (duplicate by chainId+txHash+logIndex).
 */
export async function storeEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<bigint | null> {
  const rawData = serializeDecoded(event.decoded);
  const result = await client.query<{ id: string }>(
    `INSERT INTO raw_events
       (chain_id, block_number, block_timestamp, tx_hash, log_index,
        contract_address, event_name, adapter, raw_data, tx_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      event.chainId,
      event.blockNumber.toString(),
      event.blockTimestamp.toString(),
      event.txHash.toLowerCase(),
      event.logIndex,
      event.contractAddress.toLowerCase(),
      event.eventName,
      event.adapter,
      JSON.stringify(rawData),
      event.txFrom?.toLowerCase() ?? null,
    ],
  );
  if (result.rows.length === 0) return null;
  return BigInt(result.rows[0]!.id);
}

function serializeDecoded(decoded: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decoded)) {
    if (typeof v === "bigint") {
      out[k] = v.toString();
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "bigint" ? item.toString() : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function updateCursor(
  client: pg.PoolClient,
  adapter: AdapterName,
  chainId: number,
  contractAddress: string,
  lastBlock: bigint,
): Promise<void> {
  await client.query(
    `INSERT INTO cursors (adapter, chain_id, contract_address, last_block, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (adapter, chain_id, contract_address)
     DO UPDATE SET last_block = $4, updated_at = NOW()`,
    [adapter, chainId, contractAddress.toLowerCase(), lastBlock.toString()],
  );
}

export async function getCursor(
  adapter: AdapterName,
  chainId: number,
  contractAddress: string,
): Promise<bigint> {
  const result = await query<{ last_block: string }>(
    "SELECT last_block FROM cursors WHERE adapter=$1 AND chain_id=$2 AND contract_address=$3",
    [adapter, chainId, contractAddress.toLowerCase()],
  );
  if (result.rows.length === 0) return 0n;
  return BigInt(result.rows[0]!.last_block);
}
