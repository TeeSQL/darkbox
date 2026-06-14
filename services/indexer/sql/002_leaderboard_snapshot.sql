-- Latest leaderboard datapoint per agent, produced by PnL accounting.
-- Names are NOT stored here; the leaderboard query joins identity on
-- shadow_account so the displayed daemon_name stays the single source of truth.

CREATE TABLE IF NOT EXISTS leaderboard_snapshot (
  shadow_account   text        PRIMARY KEY REFERENCES identity (shadow_account),
  agent_id         text        NOT NULL,
  starting_balance numeric     NOT NULL,
  current_equity   numeric     NOT NULL,
  pnl              numeric     NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leaderboard_snapshot_pnl_idx
  ON leaderboard_snapshot (pnl DESC);
