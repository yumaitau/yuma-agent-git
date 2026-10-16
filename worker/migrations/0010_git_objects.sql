-- Git object mapping (issue #30): every changeset, tree and blob gets a stable
-- Git ID. SHA-1 is what clients speak; SHA-256 is kept for Git's hash transition.
-- These are indexes, not copies: object bytes stay in R2 under our own hashes.
CREATE TABLE git_commits (
  repo_id TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (repo_id, cs_id)
);
CREATE UNIQUE INDEX idx_git_commits_sha1 ON git_commits(repo_id, sha1);

CREATE TABLE git_trees (
  repo_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL,             -- our SHA-256 tree address
  sha1 TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (repo_id, tree_hash)
);
CREATE INDEX idx_git_trees_sha1 ON git_trees(repo_id, sha1);

-- global: a blob's Git ID depends only on its content
CREATE TABLE git_blobs (
  blob_hash TEXT PRIMARY KEY,          -- our SHA-256 content address
  sha1 TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX idx_git_blobs_sha1 ON git_blobs(sha1);

-- Optional Git commit metadata; NULL keeps the Git defaults and the old changeset ID.
ALTER TABLE changesets ADD COLUMN committer TEXT;          -- JSON {name, email, at}
ALTER TABLE changesets ADD COLUMN author_tz TEXT;          -- '+1000'
ALTER TABLE changesets ADD COLUMN committer_tz TEXT;
ALTER TABLE changesets ADD COLUMN gpgsig TEXT;             -- raw signature block
ALTER TABLE changesets ADD COLUMN git_extra_headers TEXT;  -- JSON [[key, value], …]
