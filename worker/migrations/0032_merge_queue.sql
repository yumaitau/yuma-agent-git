-- Merge queue (issue #43). A branch ruleset with a `merge_queue` rule turns
-- the queue on for the branches it covers. `MergeQueueDO` (one per repo and
-- base ref) orders entries, builds merge groups and lands them with one
-- compare-and-swap ref move. All queue state lives here, so a restarted
-- Durable Object carries on from these rows.
CREATE TABLE merge_groups (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  base_ref TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('strict','optimistic')),
  -- the base ref head the group was built on, and the speculative merge on top
  base_cs TEXT NOT NULL,
  head_cs TEXT NOT NULL,
  -- pull request ids in landing order (JSON array)
  pulls TEXT NOT NULL,
  -- strict: testing, landing, merged. optimistic: landing, landed (post-land
  -- checks running), merged or reverting, reverted. Either: failed, cancelled.
  state TEXT NOT NULL CHECK (state IN
    ('testing','landing','landed','merged','failed','cancelled','reverting','reverted')),
  -- `merge_group` pipeline runs (JSON array)
  ci_run_ids TEXT NOT NULL DEFAULT '[]',
  revert_cs TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX merge_groups_active ON merge_groups(repo_id, base_ref, created_at)
  WHERE finished_at IS NULL;

CREATE TABLE merge_queue_entries (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  base_ref TEXT NOT NULL,
  pull_id INTEGER NOT NULL REFERENCES pull_requests(id),
  -- order within a priority: higher priority lands first, then lower position
  position INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued','testing','merged','ejected','dequeued')),
  group_id TEXT REFERENCES merge_groups(id),
  -- the revision enqueued; a new revision leaves the queue
  head_cs TEXT NOT NULL,
  revision INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('merge','squash','rebase')),
  reason TEXT,
  enqueued_by TEXT NOT NULL,
  -- the enqueuing principal (JSON), for ruleset bypass checks when the group lands
  principal TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX merge_queue_one_per_pull ON merge_queue_entries(pull_id)
  WHERE state IN ('queued','testing');
CREATE INDEX merge_queue_order ON merge_queue_entries(repo_id, base_ref, state, priority DESC, position);

-- Pipelines gain the `merge_group` event. SQLite cannot change a CHECK in
-- place, so the table is rebuilt (the documented 12-step procedure).
PRAGMA defer_foreign_keys = true;
CREATE TABLE ci_pipeline_runs_new (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  head_cs TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('push','pull_request','manual','schedule','merge_group')),
  ref TEXT,
  concurrency_group TEXT,
  errors TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  finished_at INTEGER,
  context TEXT
);
INSERT INTO ci_pipeline_runs_new (id, repo_id, head_cs, pipeline, name, event, ref,
  concurrency_group, errors, requested_by, created_at, cancelled_at, finished_at, context)
SELECT id, repo_id, head_cs, pipeline, name, event, ref, concurrency_group, errors,
  requested_by, created_at, cancelled_at, finished_at, context FROM ci_pipeline_runs;
DROP TABLE ci_pipeline_runs;
ALTER TABLE ci_pipeline_runs_new RENAME TO ci_pipeline_runs;
CREATE INDEX ci_pipeline_runs_head ON ci_pipeline_runs(repo_id, head_cs);
CREATE INDEX ci_pipeline_runs_active ON ci_pipeline_runs(created_at) WHERE finished_at IS NULL;
