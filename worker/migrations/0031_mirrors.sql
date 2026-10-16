-- Repository mirrors and per-repo cutover (issues #36, #73).

-- A pull mirror fetches a remote's branches and tags over Git smart HTTP and
-- lands them through the receive-pack path, keeping every SHA. A push mirror
-- sends the forge's branches and tags to the remote. Syncs run from the
-- `mirror-sync` queue: on a schedule, on demand, and (push) after a ref moves.
CREATE TABLE mirrors (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  direction TEXT NOT NULL CHECK (direction IN ('pull','push')),
  remote_url TEXT NOT NULL,            -- https, never with credentials in it
  auth TEXT NOT NULL CHECK (auth IN ('none','token','github_app')),
  username TEXT,                       -- HTTP Basic user for `token`
  credential_ciphertext TEXT,          -- #50 envelope encryption; never returned or logged
  key_owner TEXT,                      -- secret_data_keys.owner
  key_version INTEGER,                 -- secret_data_keys.version
  interval_s INTEGER NOT NULL,
  force INTEGER NOT NULL DEFAULT 0,    -- overwrite diverged refs (push: also prune)
  enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL,                -- forge origin for links and CI from a queued sync
  last_sync_at INTEGER,                -- start of the last attempt
  last_success_at INTEGER,
  last_error TEXT,
  last_refs TEXT NOT NULL DEFAULT '{}',   -- JSON {git ref: sha1} the remote had at the last sync
  last_result TEXT NOT NULL DEFAULT '[]', -- JSON [{ref, status, detail?}]
  lease_until INTEGER,                 -- a running sync holds the mirror until then
  created_by TEXT NOT NULL,            -- the sync acts with this user's access
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_mirrors_repo ON mirrors(repo_id);
CREATE INDEX idx_mirrors_due ON mirrors(enabled, last_sync_at);

-- Cutover state (#73): github -> mirror -> dual -> cutover, and back.
-- No row means 'github'.
CREATE TABLE repo_migrations (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  state TEXT NOT NULL CHECK (state IN ('github','mirror','dual','cutover')),
  pull_mirror_id TEXT,
  push_mirror_id TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
