-- Secrets, variables, environments and CI workload identity (issue #50).

-- Envelope encryption: one random data key per owner ('org:<id>' or
-- 'user:<login>'), AES-GCM wrapped by the SECRETS_KEK Worker secret. KEK
-- rotation re-wraps these rows only; secret ciphertexts never change.
CREATE TABLE secret_data_keys (
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  kek_id TEXT NOT NULL,                -- SECRETS_KEK entry that wraps it
  wrapped TEXT NOT NULL,               -- base64url iv.ciphertext
  created_at INTEGER NOT NULL,
  rewrapped_at INTEGER,
  PRIMARY KEY (owner, version)
);
CREATE INDEX secret_data_keys_kek ON secret_data_keys(kek_id);

-- scope 'org': owner_id = orgs.id; 'repo' and 'environment': owner_id = repos.id.
-- environment is '' unless scope = 'environment' (so the key stays unique).
CREATE TABLE secrets (
  scope TEXT NOT NULL CHECK (scope IN ('org','repo','environment')),
  owner_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,            -- never returned by the API
  key_owner TEXT NOT NULL,             -- secret_data_keys.owner
  key_version INTEGER NOT NULL,        -- secret_data_keys.version
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, owner_id, environment, name)
);

CREATE TABLE variables (
  scope TEXT NOT NULL CHECK (scope IN ('org','repo','environment')),
  owner_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, owner_id, environment, name)
);

-- Protection rules JSON: reviewers, wait_timer_minutes, allowed_branches, humans_only.
CREATE TABLE environments (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- A run waiting on an environment. The ci_runs row is created only on dispatch.
CREATE TABLE environment_approvals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  environment TEXT NOT NULL,
  head_cs TEXT NOT NULL,
  publish INTEGER NOT NULL DEFAULT 0,
  context TEXT NOT NULL,               -- run trigger context JSON
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','dispatched','expired','failed')),
  not_before INTEGER NOT NULL,         -- wait timer
  expires_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  comment TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX environment_approvals_repo ON environment_approvals(repo_id, state, created_at DESC);
CREATE INDEX environment_approvals_due ON environment_approvals(state, not_before);

-- Per-run OIDC request tokens: SHA-256 at rest, valid until the run deadline.
CREATE TABLE ci_job_tokens (
  token_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ci_job_tokens_run ON ci_job_tokens(run_id);

-- Trigger context (event, ref, pull, actor kind, origin, approval) for secrets and OIDC claims.
ALTER TABLE ci_runs ADD COLUMN context TEXT;
