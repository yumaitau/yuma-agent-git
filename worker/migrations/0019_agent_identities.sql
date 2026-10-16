-- Agent identities (issue #57): agents are principals owned by a user or an
-- org. They hold no long-lived secret: a human delegates through the token
-- exchange (POST /oauth/token), which issues short-lived agent tokens.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,               -- agt_<ulid>; owns refs/agents/<id>/
  owner_kind TEXT NOT NULL,          -- 'user' | 'org'
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'factory' | 'claude_code' | 'codex' | 'grok' | 'builtin'
  max_scopes TEXT NOT NULL,          -- JSON array of agent scopes
  allowed_repos TEXT,                -- JSON array of repo ids; NULL = any the human can read
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agents_owner ON agents(owner_kind, owner_id);

-- Issued agent tokens: SHA-256 at rest, one hour at most, never refreshed.
CREATE TABLE agent_tokens (
  jti TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  on_behalf_of TEXT NOT NULL,        -- user id of the delegating human
  task_id TEXT,
  scopes TEXT NOT NULL,              -- JSON array
  repos TEXT NOT NULL,               -- JSON array of repo ids
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id);

-- Who wrote a changeset through an agent token. Kept outside the hashed
-- changeset so pushed Git commits still round-trip byte for byte.
CREATE TABLE changeset_agents (
  repo_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  on_behalf_of TEXT NOT NULL,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, changeset_id)
);
