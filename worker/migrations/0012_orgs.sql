-- Organisations, teams and org-level roles (issue #26).
-- Effective repo role = max(direct repo_members role, team grants including
-- parent teams, org base role); org owners are admins on every org repo.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,           -- lowercase GitHub-login rules, 1..39 chars
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  base_role TEXT NOT NULL DEFAULT 'none' CHECK (base_role IN ('none','read','write','admin')),
  members_can_create_repos INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','billing')),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  slug TEXT NOT NULL,
  parent_team_id TEXT REFERENCES teams(id),  -- NULL = top-level team
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE team_repos (
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  role TEXT NOT NULL CHECK (role IN ('admin','write','read')),
  PRIMARY KEY (team_id, repo_id)
);
CREATE INDEX idx_team_repos_repo ON team_repos(repo_id);

-- Every existing repo is user-owned; owner_id is the slug prefix for user
-- repos and orgs.id for org repos.
ALTER TABLE repos ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user' CHECK (owner_kind IN ('user','org'));
ALTER TABLE repos ADD COLUMN owner_id TEXT;
UPDATE repos SET owner_id = substr(slug, 1, instr(slug, '/') - 1) WHERE owner_id IS NULL;
