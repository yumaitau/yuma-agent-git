-- Git over SSH (issue #34). Keys that sign a person in to the SSH gateway,
-- kept apart from commit signing keys (user_signing_keys, #58): adding a key
-- for one purpose must not grant the other.
CREATE TABLE ssh_keys (
  id TEXT PRIMARY KEY,                 -- ulid
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,            -- '<type> <base64>', comment dropped
  fingerprint TEXT NOT NULL UNIQUE,    -- SHA256:<b64>, as ssh-keygen -l prints it
  auth_method TEXT,                    -- the session's sign-in method when added (org SSO)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX ssh_keys_user ON ssh_keys(user_id);

-- A key bound to one repository, with no person behind it.
CREATE TABLE deploy_keys (
  id TEXT PRIMARY KEY,                 -- ulid
  repo_id TEXT NOT NULL,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,            -- the admin who added it
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX deploy_keys_repo ON deploy_keys(repo_id);

-- Tokens the gateway gets from POST /internal/ssh/authorize: 60 seconds, one
-- repository, one Git service. Each use re-reads the key, so removing a key
-- stops its tokens at once.
CREATE TABLE ssh_tokens (
  token_hash TEXT PRIMARY KEY,         -- sha256 hex of the raw token
  key_kind TEXT NOT NULL CHECK (key_kind IN ('user', 'deploy')),
  key_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('git-upload-pack', 'git-receive-pack')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX ssh_tokens_expiry ON ssh_tokens(expires_at);
