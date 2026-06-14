-- Append-only log of engine mutations. Replayed in seq order on boot to
-- reconstruct the in-memory engine state (balances, positions, orders, PnL).
-- This is what makes real PnL durable across restarts.

CREATE TABLE IF NOT EXISTS engine_event (
  seq        bigserial   PRIMARY KEY,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
