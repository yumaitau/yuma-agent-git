-- Secret scanning (issue #66). An alert is one secret at one path. The value
-- itself is never stored: secret_hash is its SHA-256, plus where it was found.
CREATE TABLE secret_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  detector TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  changeset_id TEXT,                   -- where it was found, when known
  source TEXT NOT NULL CHECK (source IN ('push','commit','history')),
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  resolution TEXT CHECK (resolution IN ('revoked','false_positive','test_data','wont_fix')),
  bypass_reason TEXT CHECK (bypass_reason IN ('false_positive','test_data','will_fix')),
  bypass_comment TEXT,
  created_by TEXT NOT NULL,            -- actor id
  created_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER,
  UNIQUE (repo_id, secret_hash, path)
);
CREATE INDEX secret_alerts_repo_state ON secret_alerts(repo_id, state, id);

-- History scans: a background job walks every changeset oldest first and
-- keeps its place in (cursor_at, cursor_id), so a retry resumes.
CREATE TABLE secret_scans (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
  cursor_at INTEGER,
  cursor_id TEXT,
  changesets INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  alerts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX secret_scans_repo ON secret_scans(repo_id, created_at);
