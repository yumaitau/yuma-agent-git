-- GitHub Actions compatibility (issue #49): a repository opts in to running
-- its translated `.github/workflows/*.yml` files as pipelines when it has no
-- `.yuma/pipelines` files. No row = off.
CREATE TABLE ci_actions_settings (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
