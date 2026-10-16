-- Work queue (issue #59): structured work fields on issues instead of
-- `yuma:ready` / `yuma:risk:*` labels. Claims are a conditional UPDATE on
-- `work_items`, so two agents never hold the same item; a lease that is not
-- renewed returns the item to `ready` with `attempts + 1`.
CREATE TABLE work_items (
  issue_id INTEGER PRIMARY KEY REFERENCES issues(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  readiness TEXT NOT NULL DEFAULT 'draft' CHECK (readiness IN
    ('draft','needs-prep','ready','claimed','in-review','blocked','done')),
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  size TEXT CHECK (size IN ('xs','s','m','l','xl')),
  agent_kind TEXT,                     -- required agent kind; NULL = any
  priority INTEGER NOT NULL DEFAULT 0, -- higher is claimed first
  plan INTEGER NOT NULL DEFAULT 0,     -- 1 = a planner should split this epic
  ready_at INTEGER,
  claimed_by TEXT,                     -- 'user:<id>' | 'agent:<agent id>' | 'agent:<token id>'
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX work_items_queue ON work_items(repo_id, readiness, priority DESC, ready_at);
CREATE INDEX work_items_lease ON work_items(lease_expires_at) WHERE readiness = 'claimed';

-- `waits-on`: an item is not claimable while any of these is open.
CREATE TABLE work_dependencies (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  depends_on_issue_id INTEGER NOT NULL REFERENCES issues(id),
  PRIMARY KEY (issue_id, depends_on_issue_id)
);
CREATE INDEX work_dependencies_on ON work_dependencies(depends_on_issue_id);

-- Readiness history with actor and reason (claims, releases, expiries, edits).
CREATE TABLE work_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_readiness TEXT,
  to_readiness TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX work_events_issue ON work_events(issue_id, id);

-- The highest risk an agent may claim; owners raise it deliberately.
ALTER TABLE agents ADD COLUMN max_risk TEXT NOT NULL DEFAULT 'low'
  CHECK (max_risk IN ('low','medium','high'));
