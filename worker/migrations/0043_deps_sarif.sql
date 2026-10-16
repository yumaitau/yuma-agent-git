-- Dependency alerts and code scanning (issue #67).

-- OSV advisories (https://osv.dev, CC-BY 4.0): loaded from an offline
-- snapshot by an instance admin, or by the hourly sync for packages in use.
CREATE TABLE osv_advisories (
  id TEXT PRIMARY KEY,                 -- OSV id (GHSA-…, PYSEC-…, GO-…, RUSTSEC-…)
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','unknown')),
  aliases TEXT NOT NULL,               -- JSON array (CVE ids)
  url TEXT NOT NULL,
  modified TEXT NOT NULL,              -- OSV `modified` (RFC 3339)
  withdrawn TEXT,
  loaded_at INTEGER NOT NULL
);

-- One row per affected package of an advisory: ranges and versions as OSV has them.
CREATE TABLE osv_affected (
  advisory_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  ranges TEXT NOT NULL,                -- JSON [{type, events}]
  versions TEXT NOT NULL               -- JSON array of affected versions
);
CREATE INDEX osv_affected_package ON osv_affected(ecosystem, name);
CREATE INDEX osv_affected_advisory ON osv_affected(advisory_id);

-- Packages the hourly sync has asked OSV about.
CREATE TABLE osv_packages (
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (ecosystem, name)
);

-- The default branch's dependencies, copied from the `dependencies` derived
-- data at `dependency_snapshots.cs_id`, so packages can be queried across repos.
CREATE TABLE repo_dependencies (
  repo_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,                  -- lockfile
  PRIMARY KEY (repo_id, path, ecosystem, name, version)
);
CREATE INDEX repo_dependencies_package ON repo_dependencies(ecosystem, name);

CREATE TABLE dependency_snapshots (
  repo_id TEXT PRIMARY KEY,
  cs_id TEXT,                          -- matched head, NULL asks for a rematch
  queued_cs TEXT,
  queued_at INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- An alert is one advisory against one package in one lockfile.
CREATE TABLE dependency_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,               -- vulnerable version last seen
  path TEXT NOT NULL,
  severity TEXT NOT NULL,
  fixed_version TEXT,                  -- lowest fixed version above `version`
  state TEXT NOT NULL CHECK (state IN ('open','fixed','dismissed')),
  dismissed_reason TEXT CHECK (dismissed_reason IN
    ('fix_started','inaccurate','no_bandwidth','not_used','tolerable_risk')),
  dismissed_by TEXT,
  work_number INTEGER,                 -- update work item (#59)
  cs_id TEXT NOT NULL,                 -- changeset the state was last set at
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, advisory_id, ecosystem, name, path)
);
CREATE INDEX dependency_alerts_repo_state ON dependency_alerts(repo_id, state, id);

-- SARIF 2.1.0 uploads: one analysis per run (tool and category) in an upload.
CREATE TABLE code_scanning_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  results INTEGER NOT NULL,
  created_by TEXT NOT NULL,            -- actor id
  created_at INTEGER NOT NULL
);
CREATE INDEX code_scanning_analyses_cs ON code_scanning_analyses(repo_id, cs_id, id);
CREATE INDEX code_scanning_analyses_ref ON code_scanning_analyses(repo_id, ref, tool, category, id);

-- Alerts per ref, deduplicated by fingerprint within a tool and category.
CREATE TABLE code_scanning_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  message TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  start_column INTEGER,
  end_column INTEGER,
  state TEXT NOT NULL CHECK (state IN ('open','fixed','dismissed')),
  dismissed_reason TEXT CHECK (dismissed_reason IN ('false_positive','wont_fix','used_in_tests')),
  dismissed_by TEXT,
  last_analysis_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, ref, tool, category, fingerprint)
);
CREATE INDEX code_scanning_alerts_repo ON code_scanning_alerts(repo_id, ref, state, id);

-- Which alerts each analysis found (pull request findings read these).
CREATE TABLE code_scanning_results (
  analysis_id INTEGER NOT NULL,
  alert_id INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, alert_id)
);
