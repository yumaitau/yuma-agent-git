-- Machine/agent API tokens (issue #12): hashed at rest; raw token shown once.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  repo_id TEXT,                      -- NULL = all repos the user can access
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL,              -- JSON: ["repo:read","repo:write","agent:run"]
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER                 -- NULL = never expires
);
