-- Package registry (issue #53): OCI images at /v2/ and npm packages at /npm/.
-- Bytes live in R2 under registry/blobs/sha256/<hex>; this is the metadata.

-- A package is linked to one repo when it is first pushed and inherits that
-- repo's roles. OCI names start with the repo slug (`owner/repo[/more]`); npm
-- packages are `@owner/name`. `owner` is the slug's first segment (quotas).
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oci','npm')),
  name TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  keep_untagged INTEGER,               -- retention: newest N untagged manifests kept; NULL keeps all
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, name)
);
CREATE INDEX packages_repo ON packages(repo_id);
CREATE INDEX packages_owner ON packages(owner);

-- OCI: one row per manifest (version = digest). npm: one row per version.
CREATE TABLE package_versions (
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,                -- sha256:<hex> of the manifest or tarball
  media_type TEXT NOT NULL,
  artifact_type TEXT,                  -- OCI referrers filter
  subject TEXT,                        -- OCI: digest of the manifest this one refers to
  size INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', -- OCI: {blobs, children, annotations}; npm: the version manifest
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, version)
);
CREATE INDEX package_versions_subject ON package_versions(package_id, subject);

-- OCI tags (value = manifest digest) and npm dist-tags (value = version).
CREATE TABLE package_tags (
  package_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, tag)
);
CREATE INDEX package_tags_version ON package_tags(package_id, version);

-- Blobs a package may serve: OCI layers, configs and manifests, npm tarballs.
-- Storage is shared by digest; a link is made only after the bytes were
-- verified in a push to that package (or mounted from a readable one).
CREATE TABLE package_files (
  package_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, digest)
);
CREATE INDEX package_files_digest ON package_files(digest);

-- OCI chunked uploads. Full parts go to an R2 multipart upload; the
-- remainder below one part waits in registry/uploads/<id>/tail.
CREATE TABLE registry_uploads (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  r2_upload_id TEXT,
  parts TEXT NOT NULL DEFAULT '[]',    -- JSON [{partNumber, etag}]
  size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX registry_uploads_updated ON registry_uploads(updated_at);

-- Short-lived bearer tokens from GET /v2/token, stored hashed.
CREATE TABLE registry_tokens (
  token_hash TEXT PRIMARY KEY,
  principal TEXT NOT NULL,             -- JSON principal resolved from the forge credential
  access TEXT NOT NULL,                -- JSON [{name, actions}] granted
  expires_at INTEGER NOT NULL
);
CREATE INDEX registry_tokens_expiry ON registry_tokens(expires_at);
