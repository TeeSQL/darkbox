-- Canonical ETHGlobal ingest mirror for agent/internal context.
CREATE TABLE IF NOT EXISTS ethglobal_events (
  event_slug TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ethglobal_ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES ethglobal_events(event_slug) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  project_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ethglobal_ingest_runs_event_time
  ON ethglobal_ingest_runs (event_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS ethglobal_projects (
  event_slug TEXT NOT NULL REFERENCES ethglobal_events(event_slug) ON DELETE CASCADE,
  external_project_id TEXT,
  external_project_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  shortest_description TEXT NOT NULL DEFAULT '',
  sponsors JSONB NOT NULL DEFAULT '[]',
  prizes JSONB NOT NULL DEFAULT '[]',
  source_url TEXT NOT NULL,
  raw_summary JSONB NOT NULL DEFAULT '{}',
  fetched_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_slug, external_project_slug)
);

CREATE INDEX IF NOT EXISTS ethglobal_projects_event_name
  ON ethglobal_projects (event_slug, name);

CREATE INDEX IF NOT EXISTS ethglobal_projects_sponsors_gin
  ON ethglobal_projects USING GIN (sponsors);
