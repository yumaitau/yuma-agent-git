-- Self-hosted runners (issue #48). A runner is scoped to one org or one repo
-- and pulls jobs over HTTPS (docs/runner-protocol.md). Credentials are per
-- runner, SHA-256 at rest, and revoked by deleting the row.
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org','repo')),
  owner_id TEXT NOT NULL,              -- orgs.id or repos.id
  name TEXT NOT NULL,
  labels TEXT NOT NULL,                -- JSON array of lower-case labels
  capabilities TEXT NOT NULL DEFAULT '{}', -- what the runner reported (os, arch, version)
  ephemeral INTEGER NOT NULL DEFAULT 0,
  trusted_only INTEGER NOT NULL DEFAULT 0, -- never runs public repo or fork jobs
  disabled INTEGER NOT NULL DEFAULT 0,
  credential_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX runners_owner ON runners(scope, owner_id);

-- One-time registration tokens, valid for an hour.
CREATE TABLE runner_registration_tokens (
  token_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org','repo')),
  owner_id TEXT NOT NULL,
  trusted_only INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- runs_on: JSON labels from `runs-on`; NULL means the built-in Cloudflare pool.
-- runner_id: who claimed the run ('cloudflare' for the built-in pool).
-- lease_expires_at: a self-hosted run fails when its runner stops heartbeating.
-- job_token_hash: the run's Git clone token, valid while it runs.
ALTER TABLE ci_runs ADD COLUMN runs_on TEXT;
ALTER TABLE ci_runs ADD COLUMN runner_id TEXT;
ALTER TABLE ci_runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE ci_runs ADD COLUMN job_token_hash TEXT;
CREATE INDEX ci_runs_self_hosted ON ci_runs(state, created_at) WHERE runs_on IS NOT NULL;
CREATE UNIQUE INDEX ci_runs_job_token ON ci_runs(job_token_hash) WHERE job_token_hash IS NOT NULL;

-- Step results and per-step log size reported by self-hosted runners.
CREATE TABLE ci_run_steps (
  run_id TEXT NOT NULL REFERENCES ci_runs(id),
  step INTEGER NOT NULL,
  name TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed','skipped')),
  exit_code INTEGER,
  log_bytes INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (run_id, step)
);
