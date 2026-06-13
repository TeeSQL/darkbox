-- Schema migrations tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Raw event storage (idempotent by chainId+blockNumber+txHash+logIndex) ───
CREATE TABLE IF NOT EXISTS raw_events (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_timestamp BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name TEXT NOT NULL,
  adapter TEXT NOT NULL,        -- 'bridge' | 'shadow_bridge' | 'frontier' | 'pm_factory' | 'pm_market'
  raw_data JSONB NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS raw_events_adapter_block ON raw_events (adapter, block_number);
CREATE INDEX IF NOT EXISTS raw_events_contract ON raw_events (contract_address);
CREATE INDEX IF NOT EXISTS raw_events_event_name ON raw_events (event_name);

-- ─── Cursor / checkpoint tracking ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cursors (
  adapter TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  last_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (adapter, chain_id, contract_address)
);

-- ─── Agents ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,            -- bytes32 agentId from contract
  game_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  shadow_account TEXT NOT NULL,
  ens_name TEXT NOT NULL DEFAULT '',
  instruction_hash TEXT NOT NULL,
  runtime_hash TEXT NOT NULL,
  reveal_salt_hash TEXT NOT NULL,
  registered_at_block BIGINT NOT NULL,
  registered_at_ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agents_owner ON agents (owner_address);
CREATE INDEX IF NOT EXISTS agents_game ON agents (game_id);

-- ─── Balances (shadow account level) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balances (
  shadow_account TEXT NOT NULL,
  asset TEXT NOT NULL,
  total_deposited TEXT NOT NULL DEFAULT '0',    -- uint256 as decimal string
  total_withdrawn TEXT NOT NULL DEFAULT '0',
  total_credited TEXT NOT NULL DEFAULT '0',     -- from shadow mints (bridge in)
  total_burned TEXT NOT NULL DEFAULT '0',       -- from shadow burns (bridge out)
  current_balance TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shadow_account, asset)
);

-- ─── Markets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markets (
  market_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  market_address TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  metadata_uri TEXT NOT NULL DEFAULT '',
  close_time BIGINT NOT NULL DEFAULT 0,
  resolve_by BIGINT NOT NULL DEFAULT 0,
  resolver_type TEXT NOT NULL DEFAULT 'AdminManual',
  status TEXT NOT NULL DEFAULT 'Active',        -- Active | Paused | Closed | Resolved | Voided
  resolved_outcome TEXT,                        -- Yes | No | Invalid
  resolution_hash TEXT,
  yes_token TEXT,
  no_token TEXT,
  yes_book TEXT,
  no_book TEXT,
  created_at_block BIGINT NOT NULL DEFAULT 0,
  created_at_ts BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS markets_game ON markets (game_id);
CREATE INDEX IF NOT EXISTS markets_status ON markets (status);

-- ─── Orders (open positions on Frontier books) ───────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  book_address TEXT NOT NULL,
  position_id TEXT NOT NULL,              -- uint256 as decimal string
  owner_address TEXT NOT NULL,
  shadow_account TEXT,
  market_id TEXT,
  side TEXT NOT NULL,                     -- 'ask' | 'bid'
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  lower_tick INTEGER NOT NULL,
  upper_tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'open',    -- open | filled | cancelled | partially_filled
  placed_at_block BIGINT NOT NULL DEFAULT 0,
  placed_at_ts BIGINT NOT NULL DEFAULT 0,
  settled_at_block BIGINT,
  settled_proceeds TEXT,
  settled_principal TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, book_address, position_id)
);

CREATE INDEX IF NOT EXISTS orders_owner ON orders (owner_address);
CREATE INDEX IF NOT EXISTS orders_market ON orders (market_id);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS orders_book ON orders (book_address);

-- ─── Fills (completed trades) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fills (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  book_address TEXT NOT NULL,
  position_id TEXT,                       -- NULL for taker fills aggregated by sweep
  owner_address TEXT NOT NULL,
  shadow_account TEXT,
  market_id TEXT,
  side TEXT NOT NULL,                     -- 'maker' | 'taker'
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  amount0 TEXT NOT NULL DEFAULT '0',      -- token0 sold/bought
  amount1 TEXT NOT NULL DEFAULT '0',      -- token1 received/paid (USDC)
  fee TEXT NOT NULL DEFAULT '0',
  fill_clock BIGINT,
  block_number BIGINT NOT NULL,
  block_timestamp BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS fills_owner ON fills (owner_address);
CREATE INDEX IF NOT EXISTS fills_market ON fills (market_id);
CREATE INDEX IF NOT EXISTS fills_block ON fills (block_number);

-- ─── Positions (held outcome tokens) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id BIGSERIAL PRIMARY KEY,
  shadow_account TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL,                  -- 'Yes' | 'No'
  token_address TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '0',     -- current holding
  cost_basis TEXT NOT NULL DEFAULT '0',   -- USDC paid for current holding
  realized_pnl TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shadow_account, market_id, outcome)
);

CREATE INDEX IF NOT EXISTS positions_shadow ON positions (shadow_account);
CREATE INDEX IF NOT EXISTS positions_market ON positions (market_id);

-- ─── PnL snapshots (time series) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_account TEXT NOT NULL,
  total_deposited TEXT NOT NULL DEFAULT '0',
  total_withdrawn TEXT NOT NULL DEFAULT '0',
  net_deposits TEXT NOT NULL DEFAULT '0',
  realized_pnl TEXT NOT NULL DEFAULT '0',
  current_balance TEXT NOT NULL DEFAULT '0',
  equity TEXT NOT NULL DEFAULT '0',
  rank INTEGER
);

CREATE INDEX IF NOT EXISTS pnl_snapshots_account_time ON pnl_snapshots (shadow_account, snapshot_time);
CREATE INDEX IF NOT EXISTS pnl_snapshots_time ON pnl_snapshots (snapshot_time);

-- ─── Leaderboard snapshots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_account TEXT NOT NULL,
  agent_id TEXT,
  ens_name TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL,
  net_deposits TEXT NOT NULL DEFAULT '0',
  realized_pnl TEXT NOT NULL DEFAULT '0',
  equity TEXT NOT NULL DEFAULT '0',
  pnl_pct TEXT NOT NULL DEFAULT '0'
);

CREATE INDEX IF NOT EXISTS leaderboard_time ON leaderboard_snapshots (snapshot_time);

-- ─── Aggregate activity / cumulative datapoints ───────────────────────────────
CREATE TABLE IF NOT EXISTS activity_datapoints (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric TEXT NOT NULL,
  value TEXT NOT NULL,
  labels JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS activity_datapoints_metric_time ON activity_datapoints (metric, recorded_at);

-- ─── Aggregate totals (materialized running counters) ─────────────────────────
CREATE TABLE IF NOT EXISTS aggregate_stats (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed aggregate_stats counters
INSERT INTO aggregate_stats (key, value) VALUES
  ('total_deposits_count', '0'),
  ('total_deposits_usdc', '0'),
  ('total_withdrawals_count', '0'),
  ('total_withdrawals_usdc', '0'),
  ('total_trades', '0'),
  ('total_volume_usdc', '0'),
  ('positions_opened', '0'),
  ('positions_closed', '0'),
  ('active_agents', '0'),
  ('active_markets', '0')
ON CONFLICT (key) DO NOTHING;
