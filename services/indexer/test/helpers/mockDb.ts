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
      rows.push({ id, chain_id: chainId, tx_hash: txHash, log_index: logIndex, tx_from: values[9] ?? null });
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
      const isBalanceAdjustment = normalized.includes("values ($1, 'usdc'");
      const asset = isBalanceAdjustment ? "USDC" : values[1] as string;
      const existing = rows.find(
        (r) => r["shadow_account"] === shadowAccount && r["asset"] === asset,
      );
      if (isBalanceAdjustment) {
        const delta = BigInt(String(values[1] ?? "0"));
        if (existing) {
          existing["current_balance"] = max0(BigInt(String(existing["current_balance"] ?? "0")) + delta).toString();
        } else {
          rows.push({
            shadow_account: shadowAccount,
            asset,
            total_deposited: "0",
            total_withdrawn: "0",
            total_credited: "0",
            total_burned: "0",
            current_balance: max0(delta).toString(),
          });
        }
      } else if (existing) {
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

    if (normalized.startsWith("insert into leaderboard_snapshots")) {
      const rows = this.getTable("leaderboard_snapshots");
      rows.push({
        shadow_account: values[0],
        agent_id: values[1],
        ens_name: values[2],
        rank: values[3],
        net_deposits: values[4],
        realized_pnl: values[5],
        unrealized_pnl: values[6],
        total_pnl: values[7],
        equity: values[8],
        pnl_pct: values[9],
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into pnl_snapshots")) {
      const balances = this.getTable("balances").filter((r) => r["shadow_account"] === values[0]);
      const sum = (field: string) =>
        balances.reduce((acc, r) => acc + BigInt(String(r[field] ?? "0")), 0n).toString();
      this.getTable("pnl_snapshots").push({
        shadow_account: values[0],
        total_deposited: sum("total_deposited"),
        total_withdrawn: sum("total_withdrawn"),
        net_deposits: values[1],
        realized_pnl: values[2],
        unrealized_pnl: values[3],
        total_pnl: values[4],
        current_balance: sum("current_balance"),
        equity: values[5],
        rank: values[6],
      });
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
        rows.push({
          chain_id: chainId,
          tx_hash: txHash,
          log_index: logIndex,
          book_address: values[3],
          owner_address: values[4] ?? "",
          shadow_account: values[5] ?? "",
          market_id: values[6],
          side: "taker",
          amount0: values[7] ?? "0",
          amount1: values[8] ?? "0",
          fill_clock: values[9],
          block_number: values[10],
          block_timestamp: values[11],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into markets")) {
      const rows = this.getTable("markets");
      const marketId = values[0] as string;
      const exists = rows.some((r) => r["market_id"] === marketId);
      if (!exists) {
        rows.push({
          market_id: marketId,
          game_id: values[1],
          creator_address: values[2],
          market_address: values[3],
          question: values[4],
          metadata_uri: values[5],
          close_time: values[6],
          resolve_by: values[7],
          resolver_type: values[8],
          status: "Active",
          created_at_block: values[9],
          created_at_ts: values[10],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into ethglobal_events")) {
      const rows = this.getTable("ethglobal_events");
      const eventSlug = values[0] as string;
      const existing = rows.find((r) => r["event_slug"] === eventSlug);
      const row = {
        event_slug: eventSlug,
        name: values[1],
        source_url: values[2],
        fetched_at: values[3],
      };
      if (existing) {
        Object.assign(existing, row);
      } else {
        rows.push(row);
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into ethglobal_projects")) {
      const rows = this.getTable("ethglobal_projects");
      const eventSlug = values[0] as string;
      const externalProjectSlug = values[2] as string;
      const existing = rows.find(
        (r) => r["event_slug"] === eventSlug && r["external_project_slug"] === externalProjectSlug,
      );
      const row = {
        event_slug: eventSlug,
        external_project_id: values[1],
        external_project_slug: externalProjectSlug,
        name: values[3],
        shortest_description: values[4],
        sponsors: JSON.parse(String(values[5] ?? "[]")) as unknown,
        prizes: JSON.parse(String(values[6] ?? "[]")) as unknown,
        source_url: values[7],
        raw_summary: JSON.parse(String(values[8] ?? "{}")) as unknown,
        fetched_at: values[9],
      };
      if (existing) {
        Object.assign(existing, row);
      } else {
        rows.push(row);
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into ethglobal_ingest_runs")) {
      const rows = this.getTable("ethglobal_ingest_runs");
      const id = String(rows.length + 1);
      const isFailure = normalized.includes("'error'");
      rows.push({
        id,
        event_slug: values[0],
        source_url: values[1],
        status: isFailure ? "error" : "ok",
        project_count: isFailure ? 0 : values[2],
        error: isFailure ? values[2] : null,
        fetched_at: isFailure ? values[3] : values[3],
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.startsWith("update markets set yes_book")) {
      const rows = this.getTable("markets");
      const marketId = values[4] as string;
      const row = rows.find((r) => r["market_id"] === marketId);
      if (row) {
        row["yes_book"] = values[0];
        row["no_book"] = values[1];
        row["yes_token"] = values[2];
        row["no_token"] = values[3];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("update markets set") && normalized.includes("latest_trade_price")) {
      const rows = this.getTable("markets");
      const marketId = values[4] as string;
      const row = rows.find((r) => r["market_id"] === marketId);
      if (row) {
        const outcome = values[1] as string;
        row[outcome === "No" ? "latest_no_price" : "latest_yes_price"] = values[0];
        row["latest_trade_price"] = values[0];
        row["latest_trade_outcome"] = values[1];
        row["latest_trade_block"] = values[2];
        row["latest_trade_ts"] = values[3];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("update orders")) {
      const rows = this.getTable("orders");
      const isFilled = normalized.includes("status='filled'");
      const chainId = values[isFilled ? 2 : 3] as number;
      const bookAddress = values[isFilled ? 3 : 4] as string;
      const positionId = values[isFilled ? 4 : 5] as string;
      const row = rows.find(
        (r) => r["chain_id"] === chainId && r["book_address"] === bookAddress && r["position_id"] === positionId,
      );
      if (row) {
        row["status"] = isFilled ? "filled" : "cancelled";
        row["settled_at_block"] = values[0];
        row["settled_proceeds"] = values[1];
        if (!isFilled) row["settled_principal"] = values[2];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("update aggregate_stats")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("insert into positions")) {
      const rows = this.getTable("positions");
      const shadowAccount = values[0] as string;
      const marketId = values[1] as string;
      const outcome = values[2] as string;
      const quantityDelta = BigInt(String(values[3] ?? "0"));
      const costBasisDelta = BigInt(String(values[4] ?? "0"));
      let row = rows.find(
        (r) => r["shadow_account"] === shadowAccount && r["market_id"] === marketId && r["outcome"] === outcome,
      );
      if (!row) {
        row = {
          shadow_account: shadowAccount,
          market_id: marketId,
          outcome,
          token_address: "",
          quantity: "0",
          cost_basis: "0",
          realized_pnl: "0",
          market_value: "0",
          unrealized_pnl: "0",
        };
        rows.push(row);
      }
      row["quantity"] = max0(BigInt(String(row["quantity"] ?? "0")) + quantityDelta).toString();
      row["cost_basis"] = max0(BigInt(String(row["cost_basis"] ?? "0")) + costBasisDelta).toString();
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("with current_position")) {
      const rows = this.getTable("positions");
      const shadowAccount = values[0] as string;
      const marketId = values[1] as string;
      const outcome = values[2] as string;
      const quantityRequested = BigInt(String(values[3] ?? "0"));
      const proceeds = BigInt(String(values[4] ?? "0"));
      const row = rows.find(
        (r) => r["shadow_account"] === shadowAccount && r["market_id"] === marketId && r["outcome"] === outcome,
      );
      if (!row) return { rows: [], rowCount: 0 };
      const quantity = BigInt(String(row["quantity"] ?? "0"));
      const costBasis = BigInt(String(row["cost_basis"] ?? "0"));
      const quantitySold = quantityRequested < quantity ? quantityRequested : quantity;
      const costRemoved = quantity > 0n ? (costBasis * quantitySold) / quantity : 0n;
      row["quantity"] = max0(quantity - quantitySold).toString();
      row["cost_basis"] = max0(costBasis - costRemoved).toString();
      row["realized_pnl"] = (BigInt(String(row["realized_pnl"] ?? "0")) + proceeds - costRemoved).toString();
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("update positions p set")) {
      const markets = this.getTable("markets");
      for (const row of this.getTable("positions")) {
        const market = markets.find((m) => m["market_id"] === row["market_id"]);
        const price = row["outcome"] === "No" ? market?.["latest_no_price"] : market?.["latest_yes_price"];
        if (!price) {
          row["market_value"] = "0";
          row["unrealized_pnl"] = "0";
          continue;
        }
        const marketValue = (BigInt(String(row["quantity"] ?? "0")) * BigInt(String(price))) / 1_000_000n;
        row["market_value"] = marketValue.toString();
        row["unrealized_pnl"] = (marketValue - BigInt(String(row["cost_basis"] ?? "0"))).toString();
      }
      return { rows: [], rowCount: this.getTable("positions").length };
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
              r["agent_id"] === ownerVal ||
              r["shadow_account"] === ownerVal,
          );
          return { rows: filtered, rowCount: filtered.length };
        }
      }
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("select") && normalized.includes("from balances")) {
      const rows = this.getTable("balances");
      if (normalized.includes("left join agents")) {
        const agents = this.getTable("agents");
        const grouped = new Map<string, Row>();
        for (const balance of rows) {
          const shadow = String(balance["shadow_account"]);
          const agent = agents.find((a) => a["shadow_account"] === shadow);
          const existing = grouped.get(shadow) ?? {
            shadow_account: shadow,
            agent_id: agent?.["agent_id"],
            ens_name: agent?.["ens_name"] ?? "",
            total_deposited: "0",
            total_withdrawn: "0",
            current_balance: "0",
          };
          existing["total_deposited"] = (BigInt(String(existing["total_deposited"])) + BigInt(String(balance["total_deposited"] ?? "0"))).toString();
          existing["total_withdrawn"] = (BigInt(String(existing["total_withdrawn"])) + BigInt(String(balance["total_withdrawn"] ?? "0"))).toString();
          existing["current_balance"] = (BigInt(String(existing["current_balance"])) + BigInt(String(balance["current_balance"] ?? "0"))).toString();
          grouped.set(shadow, existing);
        }
        return { rows: [...grouped.values()], rowCount: grouped.size };
      }
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
      if (normalized.includes("where yes_book=$1 or no_book=$1")) {
        const book = values[0] as string;
        const filtered = rows.filter((r) => r["yes_book"] === book || r["no_book"] === book);
        return { rows: filtered, rowCount: filtered.length };
      }
      if (normalized.includes("where market_id=$1")) {
        const marketId = values[0] as string;
        const filtered = rows.filter((r) => r["market_id"] === marketId);
        return { rows: filtered, rowCount: filtered.length };
      }
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("select shadow_account") && normalized.includes("from positions")) {
      const grouped = new Map<string, Row>();
      for (const position of this.getTable("positions")) {
        const shadow = String(position["shadow_account"]);
        const existing = grouped.get(shadow) ?? {
          shadow_account: shadow,
          realized_pnl: "0",
          unrealized_pnl: "0",
          market_value: "0",
        };
        existing["realized_pnl"] = (BigInt(String(existing["realized_pnl"])) + BigInt(String(position["realized_pnl"] ?? "0"))).toString();
        existing["unrealized_pnl"] = (BigInt(String(existing["unrealized_pnl"])) + BigInt(String(position["unrealized_pnl"] ?? "0"))).toString();
        existing["market_value"] = (BigInt(String(existing["market_value"])) + BigInt(String(position["market_value"] ?? "0"))).toString();
        grouped.set(shadow, existing);
      }
      return { rows: [...grouped.values()], rowCount: grouped.size };
    }

    if (normalized.startsWith("select key, value from aggregate_stats")) {
      const rows = this.getTable("aggregate_stats");
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("insert into activity_datapoints")) {
      this.getTable("activity_datapoints").push({ metric: values[0], value: values[1] });
      return { rows: [], rowCount: 1 };
    }

    // Default: no-op
    return { rows: [], rowCount: 0 };
  }
}

function max0(value: bigint): bigint {
  return value < 0n ? 0n : value;
}
