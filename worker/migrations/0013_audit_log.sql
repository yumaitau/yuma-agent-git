-- Audit log (issue #65): append-only, hash-chained per org.
-- `org_id` is the repo slug owner until orgs (#26) land; events with no repo
-- use '_instance'. UNIQUE(org_id, prev_hash) stops two writers forking a chain.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  repo_id TEXT,
  actor_kind TEXT NOT NULL,          -- 'user' | 'token' | 'agent' | 'system'
  actor_id TEXT NOT NULL,
  on_behalf_of TEXT,                 -- user id a token or agent acted for
  action TEXT NOT NULL,
  target TEXT NOT NULL,              -- JSON object; never secrets or file contents
  ip TEXT,
  user_agent TEXT,
  request_id TEXT,
  at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,           -- '' for the first event of an org
  hash TEXT NOT NULL,
  UNIQUE (org_id, prev_hash)
);
CREATE INDEX audit_org_id ON audit_events(org_id, id);
CREATE INDEX audit_org_action ON audit_events(org_id, action, id);
CREATE INDEX audit_org_actor ON audit_events(org_id, actor_id, id);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- SIEM stream delivery cursor and status, one row per sink.
CREATE TABLE audit_stream_state (
  sink TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_status TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
