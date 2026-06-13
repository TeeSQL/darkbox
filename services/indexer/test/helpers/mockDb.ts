/**
 * Minimal in-memory SQL-ish mock for unit tests that don't need real Postgres.
 * Tracks INSERT/UPDATE/SELECT calls via a simple key-value store of table rows.
 */

type Row = Record<string, unknown>;

export class MockDb {
  private tables: Map<string, Row[]> = new Map();
  public queries: Array<{ sql: string; values: unknown[] }> = [];

  getTable(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  /** Fake pg.PoolClient with just the `query` method */
  get client() {
    return {
      query: (sql: string, values?: unknown[]) => this.query(sql, values ?? []),
    };
  }

  query(sql: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    this.queries.push({ sql, values });
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("insert into raw_events")) {
      const chainId = values[0] as number;
      const txHash = values[3] as string;
      const logIndex = values[4] as number;
      const rows = this.getTable("raw_events");
      const exists = rows.some(
        (r) => r["chain_id"] === chainId && r["tx_hash"] === txHash && r["log_index"] === logIndex,
      );
      if (exists) return { rows: [], rowCount: 0 };
      const id = BigInt(rows.length + 1);
      rows.push({ id, chain_id: chainId, tx_hash: txHash, log_index: logIndex });
      return { rows: [{ id: id.toString() }], rowCount: 1 };
    }

    if (normalized.startsWith("insert into agents")) {
      const rows = this.getTable("agents");
      const agentId = values[0] as string;
      const existing = rows.findIndex((r) => r["agent_id"] === agentId);
      const row: Row = {
        agent_id: values[0],
        game_id: values[1],
        owner_address: values[2],
        shadow_account: values[3],
        ens_name: values[4],
        instruction_hash: values[5],
        runtime_hash: values[6],
        reveal_salt_hash: values[7],
        registered_at_block: values[8],
        registered_at_ts: values[9],
      };
      if (existing >= 0) {
        rows[existing] = { ...rows[existing]!, ens_name: row["ens_name"] };
      } else {
        rows.push(row);
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into balances")) {
      const rows = this.getTable("balances");
      const shadowAccount = values[0] as string;
      const asset = values[1] as string;
      const existing = rows.find(
        (r) => r["shadow_account"] === shadowAccount && r["asset"] === asset,
      );
      if (existing) {
        existing["updated_at"] = new Date().toISOString();
      } else {
        rows.push({
          shadow_account: shadowAccount,
          asset,
          total_deposited: values[2] ?? "0",
          total_withdrawn: "0",
          total_credited: "0",
          total_burned: "0",
          current_balance: values[3] ?? "0",
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into orders")) {
      const rows = this.getTable("orders");
      const chainId = values[0] as number;
      const bookAddress = values[1] as string;
      const positionId = values[2] as string;
      const exists = rows.some(
        (r) =>
          r["chain_id"] === chainId &&
          r["book_address"] === bookAddress &&
          r["position_id"] === positionId,
      );
      if (!exists) {
        rows.push({
          chain_id: chainId,
          book_address: bookAddress,
          position_id: positionId,
          owner_address: values[3],
          shadow_account: values[4],
          market_id: values[5],
          side: values[6],
          token0: values[7],
          token1: values[8],
          lower_tick: values[9],
          upper_tick: values[10],
          liquidity: values[11],
          status: values[12] ?? "open",
          placed_at_block: values[13],
          placed_at_ts: values[14],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into fills")) {
      const rows = this.getTable("fills");
      const chainId = values[0] as number;
      const txHash = values[1] as string;
      const logIndex = values[2] as number;
      const exists = rows.some(
        (r) => r["chain_id"] === chainId && r["tx_hash"] === txHash && r["log_index"] === logIndex,
      );
      if (!exists) {
        rows.push({ chain_id: chainId, tx_hash: txHash, log_index: logIndex });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into markets")) {
      const rows = this.getTable("markets");
      const marketId = values[0] as string;
      const exists = rows.some((r) => r["market_id"] === marketId);
      if (!exists) {
        rows.push({ market_id: marketId, question: values[4], resolver_type: values[8] });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("update orders")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("update aggregate_stats")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into positions")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("select") && normalized.includes("from agents")) {
      const rows = this.getTable("agents");
      if (normalized.includes("where")) {
        // Simple WHERE filter on owner_address
        const ownerIdx = values.findIndex((v) => typeof v === "string");
        const ownerVal = values[ownerIdx] as string | undefined;
        if (ownerVal) {
          const filtered = rows.filter(
            (r) =>
              r["owner_address"] === ownerVal ||
              r["agent_id"] === ownerVal,
          );
          return { rows: filtered, rowCount: filtered.length };
        }
      }
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("select") && normalized.includes("from balances")) {
      const rows = this.getTable("balances");
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("select") && normalized.includes("from orders")) {
      const rows = this.getTable("orders");
      if (normalized.includes("where") && values.length >= 3) {
        const chainId = values[0] as number;
        const bookAddress = values[1] as string;
        const positionId = values[2] as string;
        const filtered = rows.filter(
          (r) =>
            r["chain_id"] === chainId &&
            r["book_address"] === bookAddress &&
            r["position_id"] === positionId,
        );
        return { rows: filtered, rowCount: filtered.length };
      }
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("select") && normalized.includes("from markets")) {
      const rows = this.getTable("markets");
      return { rows, rowCount: rows.length };
    }

    // Default: no-op
    return { rows: [], rowCount: 0 };
  }
}
