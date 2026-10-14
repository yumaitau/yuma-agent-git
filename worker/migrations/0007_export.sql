-- Export/sync bookkeeping (issue #16): what we last pushed to GitHub.
CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  direction TEXT NOT NULL,           -- 'to_github' | 'from_github'
  target TEXT NOT NULL,              -- e.g. 'yag-sync' branch
  head_cs TEXT,                      -- yag changeset last synced
  github_sha TEXT,                   -- GitHub commit sha last synced
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
