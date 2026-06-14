-- Market-executor write-back metadata for proposal deployment.
-- `status` is a free TEXT column (no CHECK constraint), so the new statuses
-- 'deployed' / 'deploy_failed' need no enum change; we only add the columns the
-- executor populates when it creates the on-chain market.
ALTER TABLE market_proposals
  ADD COLUMN IF NOT EXISTS deploy_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS market_id TEXT,
  ADD COLUMN IF NOT EXISTS deploy_error TEXT,
  ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS market_proposals_market_id ON market_proposals (market_id);
