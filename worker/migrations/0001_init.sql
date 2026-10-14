-- yuma-agent-git initial schema (architecture §1).
-- Table/column names are a contract: later migrations and code depend on them.

-- repositories
CREATE TABLE repos (
  id TEXT PRIMARY KEY,                 -- ulid or sha256-based
  slug TEXT NOT NULL UNIQUE,           -- "owner/name"
  github_installation_id INTEGER,      -- GitHub App installation, nullable until connected
  github_repo_id INTEGER,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'  -- 'private' | 'public'
);

-- changesets: WAL entries (architecture §1.3)
CREATE TABLE changesets (
  id TEXT PRIMARY KEY,                 -- sha256 of canonical changeset JSON (no id field)
  repo_id TEXT NOT NULL REFERENCES repos(id),
  first_parent TEXT,                   -- cs id, NULL = root
  parents TEXT NOT NULL,               -- JSON array, length >= 1 except root
  author TEXT NOT NULL,                -- JSON {name, email} | {agent: id}
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,         -- epoch ms
  changed_files TEXT NOT NULL          -- JSON [{path, op: 'add'|'mod'|'del', hash?, size?}]
);
CREATE INDEX idx_changesets_repo_parent ON changesets(repo_id, first_parent);
CREATE INDEX idx_changesets_repo_created ON changesets(repo_id, created_at);

-- refs: discouraged global state; only main/release refs (architecture §1.4)
CREATE TABLE refs (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,                  -- 'main' | 'release/…'
  head TEXT NOT NULL,                  -- changeset id
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- derived data: generic recursive framework (architecture §1.5)
CREATE TABLE derived_data (
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'skip_list'|'changed_paths'|'path_history'|'blame'
  cs_id TEXT NOT NULL,
  payload TEXT NOT NULL,               -- kind-specific JSON
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, kind, cs_id)
);

-- auth sessions (filled by OAuth issue, create now)
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,         -- sha256 of session token
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);

-- rbac (filled by RBAC issue, create now)
CREATE TABLE repo_members (
  repo_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','write','read')),
  PRIMARY KEY (repo_id, user_id)
);
CREATE TABLE path_rules (              -- directory-level permissions (Scion monorepo security)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL,           -- 'src/secret/' etc
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  principal TEXT NOT NULL,             -- 'user:<id>' | 'role:write' | 'agent:<id>' | '*'
  perms TEXT NOT NULL                  -- JSON subset of ["read","write","history"]
);

-- agent tasks (filled by agents issues, create now)
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'freeform' | 'fix_issue' | 'post_merge_check' | 'superfan'
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','landed','failed','cancelled')),
  base_cs TEXT,                        -- revision task started from
  result_cs TEXT,                      -- changeset produced
  agent_state TEXT,                    -- DO id / handle
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- git import jobs (filled by bridge issue, create now)
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source TEXT NOT NULL,                -- 'github:<owner>/<name>'
  mode TEXT NOT NULL CHECK (mode IN ('snapshot','full_history')),
  status TEXT NOT NULL DEFAULT 'queued',
  checkpoint TEXT,                     -- JSON: last imported commit sha / cursor
  commits_total INTEGER DEFAULT 0,
  commits_done INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
