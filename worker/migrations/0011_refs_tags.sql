-- Arbitrary branches and tags (issue #33).
-- Existing pilot repos keep Scion's main + release/* rule; createRepo writes
-- 'git' explicitly for new repos.
ALTER TABLE repos ADD COLUMN refs_mode TEXT NOT NULL DEFAULT 'scion'
  CHECK (refs_mode IN ('scion','git'));

-- Annotated tags. The ref itself lives in `refs` as `refs/tags/<name>`
-- (lightweight tags have a ref and no row here).
CREATE TABLE tags (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,                  -- short name, e.g. 'v1.2.3'
  target_cs TEXT NOT NULL,
  tagger TEXT NOT NULL,                -- JSON {user: id} | {agent: id}
  message TEXT NOT NULL,
  signature TEXT,                      -- armoured signature, stored as given
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- Cron expiry of agent work refs scans only refs/agents/*.
CREATE INDEX idx_refs_agent_expiry ON refs(updated_at) WHERE name LIKE 'refs/agents/%';
