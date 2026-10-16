-- Forks (issue #36): a fork is a repo row whose id starts with its network
-- root's id (core/network.ts), so it reads and writes the same changesets,
-- trees and blobs. `fork_of` is the repo it was forked from.
ALTER TABLE repos ADD COLUMN fork_of TEXT REFERENCES repos(id);
CREATE INDEX idx_repos_fork_of ON repos(fork_of);

-- A pull request whose head comes from a fork. NULL: the base repo itself.
ALTER TABLE pull_requests ADD COLUMN head_repo_id TEXT REFERENCES repos(id);

-- Git LFS file locks (issue #35). Objects reuse `lfs_objects` (0030).
CREATE TABLE lfs_locks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  ref TEXT,                            -- refspec the lock was taken on, if any
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, path)
);

-- Scheduled backups (issue #70): D1 rows and R2 manifests copied to the
-- backup bucket under `backups/<id>/`, one step per cron tick.
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed','expired')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  created_by TEXT,
  cursor TEXT NOT NULL,                -- JSON: phase, table, rowid, R2 cursor
  rows INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_backups_started ON backups(started_at);
