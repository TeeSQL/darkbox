-- Latest-trade mark-to-market fields for public leaderboard PnL.
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS latest_yes_price TEXT,
  ADD COLUMN IF NOT EXISTS latest_no_price TEXT,
  ADD COLUMN IF NOT EXISTS latest_trade_price TEXT,
  ADD COLUMN IF NOT EXISTS latest_trade_outcome TEXT,
  ADD COLUMN IF NOT EXISTS latest_trade_block BIGINT,
  ADD COLUMN IF NOT EXISTS latest_trade_ts BIGINT;

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS market_value TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS unrealized_pnl TEXT NOT NULL DEFAULT '0';

ALTER TABLE pnl_snapshots
  ADD COLUMN IF NOT EXISTS unrealized_pnl TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS total_pnl TEXT NOT NULL DEFAULT '0';

ALTER TABLE leaderboard_snapshots
  ADD COLUMN IF NOT EXISTS unrealized_pnl TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS total_pnl TEXT NOT NULL DEFAULT '0';

CREATE INDEX IF NOT EXISTS markets_latest_trade ON markets (latest_trade_ts DESC);
