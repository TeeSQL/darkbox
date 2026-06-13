-- Admin-gated market proposal review metadata.
ALTER TABLE market_proposals
  ADD COLUMN IF NOT EXISTS metadata_uri TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_chat_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_thread_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_message_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS market_proposals_review_message
  ON market_proposals (review_chat_id, review_message_id);
