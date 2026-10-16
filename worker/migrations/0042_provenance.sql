-- Signed provenance (issue #58). One record per move of a protected ref: an
-- in-toto statement in a DSSE envelope signed with the forge key (the CI OIDC
-- key set, published at /.well-known/yag-provenance-keys and /ci/oidc/jwks).
CREATE TABLE provenance (
  id TEXT PRIMARY KEY,                 -- ulid
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,                   -- forge ref name
  old_cs TEXT,                         -- null: the ref was created
  new_cs TEXT,                         -- null: the ref was deleted
  via TEXT NOT NULL,                   -- git-push, api, merge, merge_queue, ...
  bypass INTEGER NOT NULL DEFAULT 0,   -- an active rule was bypassed
  statement TEXT NOT NULL,             -- the in-toto statement JSON
  envelope TEXT NOT NULL,              -- DSSE JSON (signature inside)
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX provenance_new_cs ON provenance(repo_id, new_cs);
CREATE INDEX provenance_ref ON provenance(repo_id, ref, id);

-- Agent sessions: who ran, with which model and harness, and a redacted
-- transcript in R2 (sessions/<repo_id>/<id>.jsonl) readable by repo writers.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- ulid
  repo_id TEXT NOT NULL,
  agent_id TEXT,
  on_behalf_of TEXT NOT NULL,          -- the human the session ran for
  task_id TEXT,
  model TEXT,
  harness TEXT,
  tools TEXT NOT NULL DEFAULT '[]',    -- JSON array of tool names
  transcript_key TEXT,
  transcript_sha256 TEXT,              -- of the stored (redacted) bytes
  transcript_size INTEGER,
  redactions INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_by TEXT NOT NULL,            -- '<actor kind>:<id>'
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_repo ON sessions(repo_id, id);

CREATE TABLE changeset_sessions (
  repo_id TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, cs_id, session_id)
);
CREATE INDEX changeset_sessions_session ON changeset_sessions(session_id);

-- Keys a person signs commits with: SSH public keys and OpenPGP public keys.
CREATE TABLE user_signing_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ssh', 'gpg')),
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,           -- SHA256:<b64> (ssh) or hex v4 fingerprint (gpg)
  key_ids TEXT NOT NULL,               -- ' '-joined ids a signature names (gpg: key and subkey ids)
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, fingerprint)
);
CREATE INDEX user_signing_keys_user ON user_signing_keys(user_id);

-- The signature check of each commit pushed over Git. Changesets the forge
-- wrote itself (API commits, merges, agent tools) have no row.
CREATE TABLE commit_signatures (
  repo_id TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'unverified', 'unsigned')),
  format TEXT CHECK (format IN ('ssh', 'gpg', 'x509')),
  key_id TEXT,                         -- key fingerprint or certificate serial
  signer TEXT,                         -- email or identity the signature names
  user_id TEXT,                        -- the forge user the signer maps to
  reason TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, cs_id)
);

-- #54: a release asset uploaded from inside a CI job records that job, and
-- an attestation covers only the assets its own run uploaded.
ALTER TABLE release_assets ADD COLUMN run_id TEXT;
