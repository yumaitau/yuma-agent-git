-- Identity (issue #27): Yuma-owned sign-in. GitHub becomes one optional linked
-- identity, so users.github_id turns nullable. SQLite cannot drop NOT NULL in
-- place, so the table is rebuilt. Deferred foreign keys keep any table that
-- references users(id) valid across the swap (D1's documented rebuild recipe).
PRAGMA defer_foreign_keys = true;
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,            -- NULL for users who never used GitHub
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1    -- 0 = deprovisioned (SCIM active=false)
);
INSERT INTO users_new (id, github_id, login, avatar_url, created_at)
  SELECT id, github_id, login, avatar_url, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Every way a user can sign in. email is set only when the source verified it.
CREATE TABLE user_identities (
  provider TEXT NOT NULL,              -- 'github' | 'oidc:<provider id>' | 'scim'
  subject TEXT NOT NULL,               -- GitHub id, OIDC sub, SCIM userName
  user_id TEXT NOT NULL,
  email TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);
CREATE INDEX idx_user_identities_email ON user_identities(email);
INSERT INTO user_identities (provider, subject, user_id, email, linked_at)
  SELECT 'github', CAST(github_id AS TEXT), id, NULL, created_at FROM users;

-- Sessions remember how the user signed in and when they last passed MFA.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'github';
ALTER TABLE sessions ADD COLUMN mfa_at INTEGER;
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

-- OIDC login state: single-use, hashed, 10-minute TTL. The PKCE verifier is
-- useless without the authorisation code and dies with the row.
CREATE TABLE oidc_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  link_user_id TEXT,                   -- set when linking to a signed-in user
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Passkeys (WebAuthn). public_key is the COSE key, base64url.
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,                 -- base64url credential id
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- WebAuthn challenges: single-use, hashed, 5-minute TTL.
CREATE TABLE webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,
  user_id TEXT,                        -- NULL for passkey sign-in
  purpose TEXT NOT NULL CHECK (purpose IN ('register','mfa','login')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- TOTP seeds, AES-GCM encrypted under the TOTP_ENCRYPTION_KEY Worker secret.
CREATE TABLE totp_secrets (
  user_id TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  confirmed_at INTEGER,                -- NULL until the first code checks out
  last_step INTEGER NOT NULL DEFAULT 0, -- replay guard
  created_at INTEGER NOT NULL
);

-- SCIM provisioning bearer tokens: hashed at rest, raw value shown once.
CREATE TABLE scim_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
