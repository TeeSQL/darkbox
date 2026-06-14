import type pg from "pg";
import type { NormalizedEvent } from "../adapters/types.js";

function bigStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  return String(v);
}

function tickToMicroPrice(lower: number, upper: number): bigint {
  const lowerTick = Number.isFinite(lower) ? lower : 0;
  const upperTick = Number.isFinite(upper) ? upper : lowerTick;
  const avg = Math.round((lowerTick + upperTick) / 2);
  return tickLevelToMicroPrice(avg);
}

function tickLevelToMicroPrice(tick: number): bigint {
  // Frontier's geometric book uses GeoTickMath.powX18(tick), i.e. roughly
  // 1.0001^tick. Store public marks as micro-units so frontend code can treat
  // them like decimal prices without needing Frontier math.
  const safeTick = Number.isFinite(tick) ? tick : 0;
  const price = Math.pow(1.0001, safeTick) * 1_000_000;
  return BigInt(Math.max(0, Math.round(price)));
}

function mulDivDecimalString(a: string, b: bigint, divisor: bigint): string {
  return ((BigInt(a || "0") * b) / divisor).toString();
}

async function recordLatestTradePrice(
  client: pg.PoolClient,
  marketId: string,
  outcome: string,
  priceMicro: bigint,
  blockNumber: string,
  blockTimestamp: string,
): Promise<void> {
  const normalizedOutcome = outcome === "No" ? "No" : "Yes";
  const column = normalizedOutcome === "Yes" ? "latest_yes_price" : "latest_no_price";
  await client.query(
    `UPDATE markets SET
       ${column} = $1,
       latest_trade_price = $1,
       latest_trade_outcome = $2,
       latest_trade_block = $3,
       latest_trade_ts = $4,
       updated_at = NOW()
     WHERE market_id = $5`,
    [priceMicro.toString(), normalizedOutcome, blockNumber, blockTimestamp, marketId.toLowerCase()],
  );
}

/** Called when a BooksRegistered event registers new book addresses. */
export async function registerFrontierBook(
  client: pg.PoolClient,
  marketId: string,
  yesBook: string,
  noBook: string,
  yesToken: string,
  noToken: string,
): Promise<void> {
  await client.query(
    `UPDATE markets SET yes_book=$1, no_book=$2, yes_token=$3, no_token=$4, updated_at=NOW()
     WHERE market_id=$5`,
    [
      yesBook.toLowerCase(),
      noBook.toLowerCase(),
      yesToken.toLowerCase(),
      noToken.toLowerCase(),
      marketId.toLowerCase(),
    ],
  );
}

async function resolveMarketFromBook(
  client: pg.PoolClient,
  bookAddress: string,
): Promise<string | null> {
  const r = await client.query<{ market_id: string }>(
    "SELECT market_id FROM markets WHERE yes_book=$1 OR no_book=$1 LIMIT 1",
    [bookAddress.toLowerCase()],
  );
  return r.rows[0]?.market_id ?? null;
}

async function resolveBookContext(
  client: pg.PoolClient,
  bookAddress: string,
): Promise<{ marketId: string; outcome: "Yes" | "No"; outcomeToken: string } | null> {
  const r = await client.query<{ market_id: string; yes_book: string; no_book: string; yes_token: string; no_token: string }>(
    "SELECT market_id, yes_book, no_book, yes_token, no_token FROM markets WHERE yes_book=$1 OR no_book=$1 LIMIT 1",
    [bookAddress.toLowerCase()],
  );
  const row = r.rows[0];
  if (!row) return null;
  const isYes = row.yes_book?.toLowerCase() === bookAddress.toLowerCase();
  return {
    marketId: row.market_id,
    outcome: isYes ? "Yes" : "No",
    outcomeToken: (isYes ? row.yes_token : row.no_token)?.toLowerCase() ?? "",
  };
}

async function resolveOwnerToShadowAccount(
  client: pg.PoolClient,
  owner: string,
): Promise<string | null> {
  const r = await client.query<{ shadow_account: string }>(
    "SELECT shadow_account FROM agents WHERE owner_address=$1 LIMIT 1",
    [owner.toLowerCase()],
  );
  return r.rows[0]?.shadow_account ?? null;
}

async function resolveTxFromToShadowAccount(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<{ owner: string; shadowAccount: string } | null> {
  const owner = event.txFrom?.toLowerCase();
  if (!owner) return null;
  const shadowAccount = await resolveOwnerToShadowAccount(client, owner);
  return shadowAccount ? { owner, shadowAccount } : null;
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

export async function applyFrontierEvent(
  client: pg.PoolClient,
  event: NormalizedEvent,
): Promise<void> {
  const d = event.decoded as Record<string, unknown>;
  const bookAddress = event.contractAddress.toLowerCase();

  switch (event.eventName) {
    case "Deposit": {
      // New order placed
      const positionId = bigStr(d["positionId"]);
      const owner = String(d["owner"]).toLowerCase();
      const lower = Number(d["lower"]);
      const upper = Number(d["upper"]);
      const liquidity = bigStr(d["liquidity"]);
      const marketId = await resolveMarketFromBook(client, bookAddress);
      const shadowAccount = await resolveOwnerToShadowAccount(client, owner);

      // Determine side: asks deposit above current price (lower > 0 typically)
      // In Frontier, ask = sell token0 for token1; bid = buy token0 with token1
      const side = lower >= 0 ? "ask" : "bid";

      await client.query(
        `INSERT INTO orders
           (chain_id, book_address, position_id, owner_address, shadow_account,
            market_id, side, token0, token1, lower_tick, upper_tick, liquidity,
            status, placed_at_block, placed_at_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14)
         ON CONFLICT (chain_id, book_address, position_id) DO NOTHING`,
        [
          event.chainId,
          bookAddress,
          positionId,
          owner,
          shadowAccount,
          marketId,
          side,
          "", // token0 — would need contract read; placeholder
          "", // token1 — same
          lower,
          upper,
          liquidity,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'positions_opened'`,
      );
      break;
    }

    case "Claim": {
      // Maker order filled
      const positionId = bigStr(d["positionId"]);
      const proceeds1 = bigStr(d["proceeds1"]);

      const order = await client.query<{
        owner_address: string;
        shadow_account: string;
        market_id: string;
        side: string;
        liquidity: string;
        lower_tick: number;
        upper_tick: number;
      }>(
        "SELECT owner_address, shadow_account, market_id, side, liquidity, lower_tick, upper_tick FROM orders WHERE chain_id=$1 AND book_address=$2 AND position_id=$3 LIMIT 1",
        [event.chainId, bookAddress, positionId],
      );

      if (order.rows[0]) {
        const o = order.rows[0];
        await client.query(
          `UPDATE orders SET status='filled', settled_at_block=$1, settled_proceeds=$2, updated_at=NOW()
           WHERE chain_id=$3 AND book_address=$4 AND position_id=$5`,
          [event.blockNumber.toString(), proceeds1, event.chainId, bookAddress, positionId],
        );

        await client.query(
          `INSERT INTO fills
             (chain_id, tx_hash, log_index, book_address, position_id, owner_address,
              shadow_account, market_id, side, token0, token1, amount0, amount1,
              block_number, block_timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'maker','',$9,$10,$11,$12,$13)
           ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
          [
            event.chainId,
            event.txHash,
            event.logIndex,
            bookAddress,
            positionId,
            o.owner_address,
            o.shadow_account,
            o.market_id,
            "", // token1 placeholder
            o.liquidity,
            proceeds1,
            event.blockNumber.toString(),
            event.blockTimestamp.toString(),
          ],
        );

        await client.query(
          `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
           WHERE key = 'total_trades'`,
        );
        await client.query(
          `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
           WHERE key = 'total_volume_usdc'`,
          [proceeds1],
        );
        await client.query(
          `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
           WHERE key = 'positions_closed'`,
        );

        // Update latest trade mark and inventory. Frontier Deposit only locks
        // order liquidity; it does not prove a new user holding. Ask fills sell
        // already-owned outcome tokens, while bid fills acquire outcome tokens.
        if (o.shadow_account && o.market_id) {
          const outcome = o.side === "ask" ? "Yes" : "No";
          const priceMicro = tickToMicroPrice(Number(o.lower_tick), Number(o.upper_tick));
          await recordLatestTradePrice(
            client,
            o.market_id,
            outcome,
            priceMicro,
            event.blockNumber.toString(),
            event.blockTimestamp.toString(),
          );
          if (o.side === "ask") {
            await reducePositionForProceeds(client, o.shadow_account, o.market_id, outcome, o.liquidity, proceeds1);
            await adjustUsdcBalance(client, o.shadow_account, proceeds1);
          } else {
            await addPosition(client, o.shadow_account, o.market_id, outcome, o.liquidity, proceeds1);
          }
        }
      }
      break;
    }

    case "Cancel": {
      const positionId = bigStr(d["positionId"]);
      const proceeds1 = bigStr(d["proceeds1"]);
      const principal0 = bigStr(d["principal0"]);

      await client.query(
        `UPDATE orders SET status='cancelled', settled_at_block=$1,
          settled_proceeds=$2, settled_principal=$3, updated_at=NOW()
         WHERE chain_id=$4 AND book_address=$5 AND position_id=$6`,
        [event.blockNumber.toString(), proceeds1, principal0, event.chainId, bookAddress, positionId],
      );

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'positions_closed'`,
      );
      break;
    }


    case "RunFilled": {
      const fromLevel = Number(d["fromLevel"]);
      const toBoundary = Number(d["toBoundary"]);
      const startSize = bigStr(d["startSize"]);
      const clock = bigStr(d["clock"]);
      const ctx = await resolveBookContext(client, bookAddress);
      const fillTick = Number.isFinite(toBoundary) ? toBoundary : fromLevel;
      const priceMicro = tickLevelToMicroPrice(fillTick);
      const approxNotional = mulDivDecimalString(startSize, priceMicro, 1_000_000n);
      const taker = await resolveTxFromToShadowAccount(client, event);

      if (ctx) {
        await recordLatestTradePrice(
          client,
          ctx.marketId,
          ctx.outcome,
          priceMicro,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        );
      }

      await client.query(
        `INSERT INTO fills
           (chain_id, tx_hash, log_index, book_address, owner_address,
            shadow_account, market_id, side, token0, token1, amount0, amount1, fee,
            fill_clock, block_number, block_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'taker','','',$8,$9,'0',$10,$11,$12)
         ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
           owner_address = EXCLUDED.owner_address,
           shadow_account = EXCLUDED.shadow_account,
           market_id = EXCLUDED.market_id,
           amount0 = EXCLUDED.amount0,
           amount1 = EXCLUDED.amount1,
           fill_clock = EXCLUDED.fill_clock`,
        [
          event.chainId,
          event.txHash,
          event.logIndex,
          bookAddress,
          taker?.owner ?? "",
          taker?.shadowAccount ?? "",
          ctx?.marketId ?? null,
          startSize,
          approxNotional,
          clock,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );

      if (ctx && taker && Number.isFinite(fromLevel) && Number.isFinite(toBoundary) && toBoundary !== fromLevel) {
        if (toBoundary > fromLevel) {
          await addPosition(client, taker.shadowAccount, ctx.marketId, ctx.outcome, startSize, approxNotional);
          await adjustUsdcBalance(client, taker.shadowAccount, `-${approxNotional}`);
        } else {
          await reducePositionForProceeds(client, taker.shadowAccount, ctx.marketId, ctx.outcome, startSize, approxNotional);
          await adjustUsdcBalance(client, taker.shadowAccount, approxNotional);
        }
      }

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'total_trades'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
         WHERE key = 'total_volume_usdc'`,
        [approxNotional],
      );
      break;
    }

    case "IntervalFilled": {
      const lowerTick = Number(d["lowerTick"]);
      const liquidity = bigStr(d["liquidity"]);
      const proceeds1 = bigStr(d["proceeds1"]);
      const clock = bigStr(d["clock"]);
      const ctx = await resolveBookContext(client, bookAddress);
      const priceMicro = tickLevelToMicroPrice(lowerTick);
      const taker = await resolveTxFromToShadowAccount(client, event);

      if (ctx) {
        await recordLatestTradePrice(
          client,
          ctx.marketId,
          ctx.outcome,
          priceMicro,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        );
      }

      await client.query(
        `INSERT INTO fills
           (chain_id, tx_hash, log_index, book_address, owner_address,
            shadow_account, market_id, side, token0, token1, amount0, amount1, fee,
            fill_clock, block_number, block_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'taker','','',$8,$9,'0',$10,$11,$12)
         ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
           owner_address = EXCLUDED.owner_address,
           shadow_account = EXCLUDED.shadow_account,
           market_id = EXCLUDED.market_id,
           amount0 = EXCLUDED.amount0,
           amount1 = EXCLUDED.amount1,
           fill_clock = EXCLUDED.fill_clock`,
        [
          event.chainId,
          event.txHash,
          event.logIndex,
          bookAddress,
          taker?.owner ?? "",
          taker?.shadowAccount ?? "",
          ctx?.marketId ?? null,
          liquidity,
          proceeds1,
          clock,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );

      if (ctx && taker) {
        await addPosition(client, taker.shadowAccount, ctx.marketId, ctx.outcome, liquidity, proceeds1);
        await adjustUsdcBalance(client, taker.shadowAccount, `-${proceeds1}`);
      }

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'total_trades'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
         WHERE key = 'total_volume_usdc'`,
        [proceeds1],
      );
      break;
    }

    case "TakerFee": {
      const payer = String(d["payer"]).toLowerCase();
      const token = String(d["token"]).toLowerCase();
      const grossInput = bigStr(d["grossInput"]);
      const fee = bigStr(d["fee"]);
      const totalPaid = bigStr(d["totalPaid"]);
      const shadowAccount = await resolveOwnerToShadowAccount(client, payer);
      const ctx = await resolveBookContext(client, bookAddress);

      await client.query(
        `INSERT INTO fills
           (chain_id, tx_hash, log_index, book_address, owner_address,
            shadow_account, market_id, side, token0, token1, amount1, fee,
            block_number, block_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'taker','',$8,$9,$10,$11,$12)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [
          event.chainId,
          event.txHash,
          event.logIndex,
          bookAddress,
          payer,
          shadowAccount,
          ctx?.marketId ?? null,
          token,
          totalPaid,
          fee,
          event.blockNumber.toString(),
          event.blockTimestamp.toString(),
        ],
      );

      if (shadowAccount && ctx && BigInt(fee || "0") > 0n) {
        if (token === ctx.outcomeToken) {
          await reducePositionForProceeds(client, shadowAccount, ctx.marketId, ctx.outcome, fee, "0");
        } else {
          await addPosition(client, shadowAccount, ctx.marketId, ctx.outcome, "0", fee);
          await adjustUsdcBalance(client, shadowAccount, `-${fee}`);
        }
      }

      await client.query(
        `UPDATE aggregate_stats SET value = (value::bigint + 1)::text, updated_at = NOW()
         WHERE key = 'total_trades'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (value::numeric + $1)::text, updated_at = NOW()
         WHERE key = 'total_volume_usdc'`,
        [grossInput],
      );
      break;
    }
  }
}

export async function addPosition(
  client: pg.PoolClient,
  shadowAccount: string,
  marketId: string,
  outcome: string,
  quantityDelta: string,
  costBasisDelta: string,
): Promise<void> {
  await client.query(
    `INSERT INTO positions (shadow_account, market_id, outcome, token_address, quantity, cost_basis, realized_pnl)
     VALUES ($1, $2, $3, '', $4, $5, '0')
     ON CONFLICT (shadow_account, market_id, outcome) DO UPDATE SET
       quantity = GREATEST(0::numeric, positions.quantity::numeric + $4::numeric)::text,
       cost_basis = GREATEST(0::numeric, positions.cost_basis::numeric + $5::numeric)::text,
       updated_at = NOW()`,
    [
      shadowAccount.toLowerCase(),
      marketId.toLowerCase(),
      outcome,
      quantityDelta,
      costBasisDelta,
    ],
  );
}

export async function reducePositionForProceeds(
  client: pg.PoolClient,
  shadowAccount: string,
  marketId: string,
  outcome: string,
  quantityDelta: string,
  proceeds: string,
): Promise<void> {
  await client.query(
    `WITH current_position AS (
       SELECT quantity::numeric AS quantity, cost_basis::numeric AS cost_basis
       FROM positions
       WHERE shadow_account=$1 AND market_id=$2 AND outcome=$3
     ), reduction AS (
       SELECT
         LEAST(quantity, $4::numeric) AS quantity_sold,
         CASE
           WHEN quantity > 0 THEN cost_basis * (LEAST(quantity, $4::numeric) / quantity)
           ELSE 0::numeric
         END AS cost_removed
       FROM current_position
     )
     UPDATE positions SET
       quantity = GREATEST(0::numeric, positions.quantity::numeric - (SELECT quantity_sold FROM reduction))::text,
       cost_basis = GREATEST(0::numeric, positions.cost_basis::numeric - (SELECT cost_removed FROM reduction))::text,
       realized_pnl = (positions.realized_pnl::numeric + ($5::numeric - (SELECT cost_removed FROM reduction)))::text,
       updated_at = NOW()
     WHERE shadow_account=$1 AND market_id=$2 AND outcome=$3`,
    [
      shadowAccount.toLowerCase(),
      marketId.toLowerCase(),
      outcome,
      quantityDelta,
      proceeds,
    ],
  );
}
