-- Metadata sharding (issue #78, ADR 0006). `DB` is the directory database:
-- users, orgs, repos and this shard map. An org with no row here keeps all of
-- its data on `DB`, so a deployment with one database behaves as before.
-- `shard` is the binding that serves the org's routed tables (`DB` or
-- `DB_SHARD_<n>`). An operator starts a move by setting `target` and
-- `state = 'copying'`; the cron copies rows online, freezes writes briefly,
-- flips `shard` and then copies stragglers (db/router.ts).
CREATE TABLE shard_directory (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  shard TEXT NOT NULL CHECK (shard = 'DB' OR shard GLOB 'DB_SHARD_[1-9]*'),
  target TEXT CHECK (target IS NULL OR target = 'DB' OR target GLOB 'DB_SHARD_[1-9]*'),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'copying', 'frozen', 'settling')),
  cursor INTEGER NOT NULL DEFAULT 0,   -- last source rowid copied
  updated_at INTEGER NOT NULL
);
CREATE INDEX shard_directory_shard ON shard_directory(shard);
