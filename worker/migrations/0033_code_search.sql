-- Code search (issue #45, ADR 0004). Everything here is derived data: it can
-- be dropped and rebuilt from changesets, trees and blobs.

-- One row per blob indexed for content. Blob hashes are content addresses,
-- so a blob shared by repos or revisions is indexed once. `grams` is the
-- number of trigram rows the blob holds (index storage per org, #79).
CREATE TABLE search_blobs (
  blob_hash TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('indexed', 'binary', 'too_large')),
  size INTEGER NOT NULL,
  grams INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- Trigram postings: lower-cased (ASCII) three-character runs of a blob's text.
CREATE TABLE search_trigrams (
  gram TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  PRIMARY KEY (gram, blob_hash)
) WITHOUT ROWID;
CREATE INDEX search_trigrams_blob ON search_trigrams(blob_hash);

-- The file list of each repo's default branch at `cs_id`: what default
-- searches and the file finder read. Kept current from tree diffs.
CREATE TABLE search_repos (
  repo_id TEXT PRIMARY KEY,
  cs_id TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE search_files (
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  lang TEXT,
  PRIMARY KEY (repo_id, path)
) WITHOUT ROWID;
CREATE INDEX search_files_blob ON search_files(blob_hash);
CREATE INDEX search_files_lang ON search_files(repo_id, lang);
