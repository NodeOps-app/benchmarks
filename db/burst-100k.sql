-- Schema for the 100k burst benchmark.
--
-- Applied idempotently by scripts/burst-100k-launch.sh on every run, so all
-- statements use IF NOT EXISTS. To evolve the schema later, add a follow-up
-- .sql file and apply it once by hand — a migration framework is overkill
-- for two tables.

CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,           -- e.g. 20260512T143000Z-a3f8d91-e2b
  provider              TEXT NOT NULL,
  commit_sha            TEXT NOT NULL,
  instance_id           TEXT NOT NULL,              -- Namespace instance ID
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  last_heartbeat        TIMESTAMPTZ,
  status                TEXT NOT NULL               -- running | done | failed
                        CHECK (status IN ('running', 'done', 'failed')),
  sandboxes_attempted   INTEGER,
  sandboxes_succeeded   INTEGER,
  p50_latency_ms        INTEGER,
  p99_latency_ms        INTEGER,
  error_message         TEXT,                       -- populated on status='failed'
  r2_prefix             TEXT NOT NULL               -- e.g. s3://<bucket>/<run_id>/
);

CREATE INDEX IF NOT EXISTS runs_provider_started
  ON runs (provider, started_at DESC);

-- Partial index for the stuck-run query:
--   SELECT * FROM runs WHERE status='running' AND last_heartbeat < now() - interval '5 minutes';
CREATE INDEX IF NOT EXISTS runs_stuck
  ON runs (last_heartbeat) WHERE status = 'running';


CREATE TABLE IF NOT EXISTS sandbox_results (
  run_id        TEXT NOT NULL REFERENCES runs(id),
  sandbox_idx   INTEGER NOT NULL,                   -- 0 .. concurrencyTarget-1
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  latency_ms    INTEGER,
  status        TEXT NOT NULL                       -- ok | timeout | http_error | network_error
                CHECK (status IN ('ok', 'timeout', 'http_error', 'network_error')),
  http_status   INTEGER,
  error_code    TEXT,
  PRIMARY KEY (run_id, sandbox_idx)
);

CREATE INDEX IF NOT EXISTS sandbox_results_run_status
  ON sandbox_results (run_id, status);
