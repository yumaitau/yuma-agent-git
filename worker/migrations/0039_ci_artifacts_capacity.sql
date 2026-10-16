-- CI capacity (issue #52). An operator gives an org its own CI pool: job
-- slots, a monthly reservation budget, the longest job and the instance types
-- it may use. Orgs without a row, and user-owned repos, share the deployment
-- pool (CI_MONTHLY_BUDGET_USD and two slots), as before.
CREATE TABLE org_ci_limits (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  max_concurrent INTEGER NOT NULL,
  monthly_budget_usd REAL NOT NULL,
  max_timeout_s INTEGER NOT NULL,
  instance_types TEXT NOT NULL,        -- JSON array, e.g. ["standard-2","standard-4"]
  cache_quota_bytes INTEGER NOT NULL,  -- per repo (issue #51)
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- pool: the admission ledger a run counts against, an org id or 'shared'.
-- instance_type: the Cloudflare container type the built-in pool starts.
ALTER TABLE ci_runs ADD COLUMN pool TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE ci_runs ADD COLUMN instance_type TEXT;
CREATE INDEX ci_runs_pool_month ON ci_runs(pool, month);
CREATE INDEX ci_runs_pool_state ON ci_runs(pool, state);

-- Budget alerts fire once per pool, month and threshold (50, 80, 100).
CREATE TABLE ci_budget_alerts (
  pool TEXT NOT NULL,
  month TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pool, month, threshold)
);

-- Artifacts (issue #51): R2 `ci/artifacts/<run>/<name>`, where <run> is the
-- pipeline run (or the settings run), so every job of a run sees them.
CREATE TABLE ci_artifacts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  run_scope TEXT NOT NULL,             -- ci_pipeline_runs.id, or ci_runs.id for settings runs
  ci_run_id TEXT NOT NULL,             -- the job that uploaded it
  job_key TEXT,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (run_scope, name)
);
CREATE INDEX ci_artifacts_repo ON ci_artifacts(repo_id, created_at);
CREATE INDEX ci_artifacts_expiry ON ci_artifacts(expires_at);

-- Dependency caches (issue #51), immutable per (repo, scope, key). scope is
-- the ref a job ran for (`refs/heads/<b>`, `refs/pull/<n>`, ...): jobs write
-- only their own scope and read it and the default branch's.
CREATE TABLE ci_caches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','ready')),
  size INTEGER NOT NULL DEFAULT 0,
  object_key TEXT NOT NULL,
  ci_run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  UNIQUE (repo_id, scope, key)
);
CREATE INDEX ci_caches_lru ON ci_caches(repo_id, last_used_at);
