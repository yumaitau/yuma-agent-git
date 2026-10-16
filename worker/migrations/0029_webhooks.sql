-- Outbound webhooks, apps and OAuth apps (issue #75).

-- scope 'repo': owner_id = repos.id; 'org': orgs.id; 'app': apps.id (the
-- app's own hook, sent for every repository the app is installed on).
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('repo','org','app')),
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,     -- #50 envelope encryption; never returned
  key_owner TEXT NOT NULL,             -- secret_data_keys.owner
  key_version INTEGER NOT NULL,        -- secret_data_keys.version
  events TEXT NOT NULL,                -- JSON array of event names
  format TEXT NOT NULL DEFAULT 'yag' CHECK (format IN ('yag','github')),
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX webhooks_owner ON webhooks(scope, owner_id);

-- One row per attempt series. The body is kept so a redelivery sends the
-- same bytes; rows older than 30 days are swept by the cron.
CREATE TABLE webhook_deliveries_out (
  id TEXT PRIMARY KEY,                 -- also the X-Yag-Delivery header
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  repo_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','retrying','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error TEXT,
  next_attempt_at INTEGER,             -- lease or retry time; NULL once final
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  redelivery_of TEXT
);
CREATE INDEX webhook_deliveries_out_hook ON webhook_deliveries_out(webhook_id, created_at DESC);
CREATE INDEX webhook_deliveries_out_due ON webhook_deliveries_out(status, next_attempt_at);

-- Apps sign a short JWT with their private key, shown once at creation, and
-- exchange it for an installation token. Only the public key is stored.
CREATE TABLE apps (
  id TEXT PRIMARY KEY,                 -- app_<ulid>; the JWT `iss`
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','org')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL,           -- JSON array of agent scopes (#57)
  public_key TEXT NOT NULL,            -- RSA public JWK
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX apps_owner ON apps(owner_kind, owner_id);

-- An installation grants an app the named repositories, within the
-- installer's own access. auth_method carries the installer's sign-in for org SSO.
CREATE TABLE app_installations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  installed_by TEXT NOT NULL,
  auth_method TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX app_installations_app ON app_installations(app_id);

CREATE TABLE app_installation_repos (
  installation_id TEXT NOT NULL REFERENCES app_installations(id),
  repo_id TEXT NOT NULL,
  PRIMARY KEY (installation_id, repo_id)
);
CREATE INDEX app_installation_repos_repo ON app_installation_repos(repo_id);

-- Installation tokens: SHA-256 at rest, one hour.
CREATE TABLE app_tokens (
  token_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  scopes TEXT NOT NULL,                -- JSON array, a subset of the app's permissions
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX app_tokens_installation ON app_tokens(installation_id);

-- OAuth apps (authorization code + PKCE). The client secret is verify-only,
-- so it is stored as SHA-256 like API tokens.
CREATE TABLE oauth_apps (
  id TEXT PRIMARY KEY,                 -- the client_id
  client_secret_hash TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','org')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,         -- JSON array, matched exactly
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,        -- PKCE S256
  scopes TEXT NOT NULL,
  auth_method TEXT,
  expires_at INTEGER NOT NULL
);

-- Access tokens an OAuth app holds are API tokens the user can see and revoke.
ALTER TABLE api_tokens ADD COLUMN oauth_app_id TEXT;
