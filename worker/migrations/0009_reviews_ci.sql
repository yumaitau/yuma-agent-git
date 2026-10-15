CREATE TABLE ci_settings (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_cs TEXT NOT NULL,
  head_cs TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('draft','open','closed','merged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  merged_at INTEGER
);
CREATE INDEX pulls_repo ON pull_requests(repo_id, updated_at DESC);
CREATE TABLE pull_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id INTEGER NOT NULL REFERENCES pull_requests(id),
  revision INTEGER NOT NULL DEFAULT 1,
  author_id TEXT NOT NULL,
  head_cs TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('comment','approve','request_changes')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reviews_pull ON pull_reviews(pull_id, id);
CREATE TABLE ci_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  head_cs TEXT NOT NULL,
  settings_version INTEGER NOT NULL,
  config TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','passed','failed','cancelled','timed_out')),
  publish INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  deadline INTEGER,
  log_key TEXT,
  image TEXT,
  error TEXT
);
CREATE INDEX ci_repo_head ON ci_runs(repo_id, head_cs, created_at DESC);
CREATE INDEX ci_budget ON ci_runs(month, state);

CREATE INDEX ci_deadlines ON ci_runs(state, deadline);
CREATE INDEX ci_log_cleanup ON ci_runs(finished_at) WHERE log_key IS NOT NULL;
