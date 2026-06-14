-- Offchain market lifecycle / resolution operator state.
-- This is deliberately audit-first: offchain actions prepare or record operator
-- intent, but do not hold private keys or broadcast transactions.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS closed_at BIGINT,
  ADD COLUMN IF NOT EXISTS resolved_at BIGINT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS evidence TEXT,
  ADD COLUMN IF NOT EXISTS resolution_source TEXT,
  ADD COLUMN IF NOT EXISTS close_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS resolve_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS close_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS resolve_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS close_action_id TEXT,
  ADD COLUMN IF NOT EXISTS resolve_action_id TEXT;

UPDATE markets
SET
  expires_at = CASE WHEN expires_at = 0 THEN close_time ELSE expires_at END,
  lifecycle_status = CASE
    WHEN status = 'Resolved' OR status = 'Voided' THEN 'resolved'
    WHEN status = 'Closed' THEN 'closed'
    WHEN status = 'Active' THEN 'active'
    ELSE lower(status)
  END,
  outcome = COALESCE(outcome, resolved_outcome),
  resolution_source = COALESCE(resolution_source, metadata_uri)
WHERE expires_at = 0 OR lifecycle_status = 'active';

CREATE INDEX IF NOT EXISTS markets_expires_at ON markets (expires_at);
CREATE INDEX IF NOT EXISTS markets_lifecycle_status ON markets (lifecycle_status);

CREATE TABLE IF NOT EXISTS market_lifecycle_actions (
  action_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  outcome TEXT,
  evidence TEXT,
  source TEXT,
  tx_hash TEXT,
  onchain_intent JSONB NOT NULL DEFAULT '{}',
  created_at_ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_lifecycle_actions_market ON market_lifecycle_actions (market_id, created_at_ts);
CREATE INDEX IF NOT EXISTS market_lifecycle_actions_actor ON market_lifecycle_actions (actor_id, created_at_ts);
