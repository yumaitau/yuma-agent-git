-- Pipeline spec v2 (issue #47): YAML pipelines read from `.yuma/pipelines/*.yml`.
-- One pipeline run holds a DAG of jobs; each started job is one `ci_runs` row,
-- so the existing runner, budget ledger and concurrency limit apply per job.
CREATE TABLE ci_pipeline_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  head_cs TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('push','pull_request','manual','schedule')),
  ref TEXT,
  concurrency_group TEXT,
  errors TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX ci_pipeline_runs_head ON ci_pipeline_runs(repo_id, head_cs);
CREATE INDEX ci_pipeline_runs_active ON ci_pipeline_runs(created_at) WHERE finished_at IS NULL;

CREATE TABLE ci_jobs (
  pipeline_run_id TEXT NOT NULL REFERENCES ci_pipeline_runs(id),
  key TEXT NOT NULL,
  job TEXT NOT NULL,
  needs TEXT NOT NULL,
  config TEXT NOT NULL,
  position INTEGER NOT NULL,
  skipped TEXT,
  PRIMARY KEY (pipeline_run_id, key)
);

ALTER TABLE ci_runs ADD COLUMN pipeline_run_id TEXT REFERENCES ci_pipeline_runs(id);
ALTER TABLE ci_runs ADD COLUMN job_key TEXT;
CREATE UNIQUE INDEX ci_runs_job ON ci_runs(pipeline_run_id, job_key)
  WHERE pipeline_run_id IS NOT NULL;

-- Schedules come from the default branch; a scan row records the revision read.
CREATE TABLE ci_schedules (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  pipeline TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pipeline, cron, timezone)
);
CREATE INDEX ci_schedules_due ON ci_schedules(next_at);
CREATE TABLE ci_schedule_scans (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  head_cs TEXT NOT NULL
);
