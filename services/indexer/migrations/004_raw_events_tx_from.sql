ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS tx_from TEXT;

CREATE INDEX IF NOT EXISTS raw_events_tx_from ON raw_events (tx_from);
