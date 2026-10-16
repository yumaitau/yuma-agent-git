-- Bulk import from GitHub (issue #72): an org-level job imports many repos,
-- each through a fixed list of phases (git history, labels, milestones,
-- issues, pulls, comments, reviews, releases, LFS). Every phase keeps a
-- cursor, so a job resumes where it stopped; `seq` drops stale queue
-- messages so only one chain of steps runs per job.
CREATE TABLE bulk_imports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source_org TEXT NOT NULL,            -- GitHub org (or user) login
  installation_id INTEGER NOT NULL,    -- GitHub App installation, read-only
  options TEXT NOT NULL DEFAULT '{}',  -- JSON: {repos?: [...]}
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','rate_limited','done','partial','failed')),
  seq INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0,   -- 1 once every source repo has a row
  list_cursor TEXT,                    -- next page of the source repo listing
  resume_at INTEGER,                   -- rate limited until (epoch ms)
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bulk_imports_org ON bulk_imports(org_id, created_at DESC);

CREATE TABLE bulk_import_repos (
  job_id TEXT NOT NULL REFERENCES bulk_imports(id),
  github_repo_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  repo_id TEXT REFERENCES repos(id),   -- the yag repo this import created
  phase TEXT NOT NULL DEFAULT 'git',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','running','done','failed')),
  cursor TEXT,                         -- JSON checkpoint inside the phase
  counts TEXT NOT NULL DEFAULT '{}',   -- JSON: imported objects per kind
  warnings TEXT NOT NULL DEFAULT '[]', -- JSON, capped
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, github_repo_id)
);

-- GitHub id → local row, per repo: re-running an import never duplicates.
CREATE TABLE github_import_map (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,                  -- label, milestone, issue, pull, ...
  github_id INTEGER NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind, github_id)
);

-- GitHub accounts seen by imports: matched by linked GitHub identity or
-- verified email, else a placeholder user (GitHub identity linked, so the
-- person claims it by signing in with GitHub).
CREATE TABLE github_import_users (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  matched_by TEXT NOT NULL CHECK (matched_by IN ('identity','email','placeholder')),
  created_at INTEGER NOT NULL
);

-- Releases as GitHub had them, for the releases feature (#54) to map.
CREATE TABLE imported_releases (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  github_id INTEGER NOT NULL,
  tag_name TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  target_commitish TEXT,
  target_cs TEXT,                      -- the tag's changeset, when imported
  author_id TEXT,
  assets TEXT NOT NULL DEFAULT '[]',   -- JSON: name, size, type, R2 key
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  PRIMARY KEY (repo_id, github_id)
);

-- LFS objects named by pointer files in imported history.
CREATE TABLE lfs_objects (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  oid TEXT NOT NULL,                   -- SHA-256, hex
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','stored','missing','too_large')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX lfs_objects_pending ON lfs_objects(repo_id, status);
