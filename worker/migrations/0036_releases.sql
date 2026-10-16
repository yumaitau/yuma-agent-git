-- Releases (issue #54): a release names an existing tag, carries Markdown
-- notes and assets stored in R2, and may hold build provenance attestations.

CREATE TABLE releases (
  id TEXT PRIMARY KEY,                 -- ulid
  repo_id TEXT NOT NULL REFERENCES repos(id),
  tag TEXT NOT NULL,                   -- short name, e.g. 'v1.2.3'
  target_cs TEXT NOT NULL,             -- the tag's changeset when the release was made
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,            -- '<actor kind>:<id>'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,                -- null while a draft
  UNIQUE (repo_id, tag)
);
CREATE INDEX releases_repo ON releases(repo_id, id);
CREATE INDEX releases_latest ON releases(repo_id, published_at)
  WHERE draft = 0 AND prerelease = 0;

-- R2 key: releases/{repo_id}/{release_id}/{asset id}. sha256 is computed
-- while the upload streams and checked again on every download.
CREATE TABLE release_assets (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (release_id, name)
);

-- In-toto statements with an SLSA provenance predicate, in a DSSE envelope
-- signed with the CI OIDC key (verified against /ci/oidc/jwks).
CREATE TABLE release_attestations (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  repo_id TEXT NOT NULL,
  run_id TEXT NOT NULL,                -- ci_runs.id named by the ID token
  key_id TEXT NOT NULL,
  envelope TEXT NOT NULL,              -- DSSE JSON
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX release_attestations_release ON release_attestations(release_id);

-- Per-org cap on one asset's size; repos without a row use the default.
CREATE TABLE org_release_settings (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  asset_max_bytes INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
