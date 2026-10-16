-- Agent guardrails (issue #62): org policies, human approvals and the agent
-- kill switch. Policies are versioned rows (the newest is in force); an org
-- without one runs the default pack (policies/default.json).
CREATE TABLE agent_policies (
  org_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  document TEXT NOT NULL,              -- JSON, policySchema in worker/src/policy/engine.ts
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, version)
);

-- One row per (agent, action, exact payload): a held action waits here for a
-- human, and the same payload proceeds once the row is approved.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  action TEXT NOT NULL,
  principal TEXT NOT NULL,             -- agent:<id> or token:<id>
  on_behalf_of TEXT NOT NULL,
  payload_hash TEXT NOT NULL,          -- sha256 of the canonical payload
  payload TEXT NOT NULL,               -- JSON summary for the approver, never contents
  reasons TEXT NOT NULL,               -- JSON [{rule, effect, message}]
  requested_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected')),
  UNIQUE (repo_id, principal, action, payload_hash)
);
CREATE INDEX idx_approvals_repo ON approvals(repo_id, decision, requested_at);

-- Kill switch: an org id, or '_instance' for every agent on the forge.
CREATE TABLE agent_pauses (
  scope_id TEXT PRIMARY KEY,
  paused_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  paused_at INTEGER NOT NULL
);
