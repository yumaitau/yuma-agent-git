-- Rulesets (issue #41): branch, tag and push rules at org and repo level,
-- evaluated in one place (worker/src/policy/rulesets.ts) for API ref moves,
-- Git push, pull request merges and agent lands.
CREATE TABLE rulesets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org','repo')),
  owner_id TEXT NOT NULL,              -- orgs.id for 'org', repos.id for 'repo'
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('branch','tag','push')),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('active','evaluate','disabled')),
  conditions TEXT NOT NULL,            -- JSON {ref_name?, repository_name?}
  rules TEXT NOT NULL,                 -- JSON array of {type, ...params}
  bypass TEXT NOT NULL DEFAULT '[]',   -- JSON array of role:/team:/agent:/user: actors
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, owner_id, name)
);
CREATE INDEX idx_rulesets_owner ON rulesets(owner_id, scope);

-- Evaluate-mode log: what an `evaluate` ruleset would have refused.
CREATE TABLE ruleset_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ruleset_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  ref TEXT,                            -- NULL for push rules on a commit
  via TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  violations TEXT NOT NULL,            -- JSON [{rule, message}]
  at INTEGER NOT NULL
);
CREATE INDEX idx_ruleset_evaluations_ruleset ON ruleset_evaluations(ruleset_id, id);
CREATE INDEX idx_ruleset_evaluations_repo ON ruleset_evaluations(repo_id, id);

-- The CI policy protection fields become one repo ruleset on the default
-- branch, so existing repos keep identical behaviour: protect_default →
-- `update`, required_approvals → `pull_request`, require_checks →
-- `required_status_checks` (missing fields take the policySchema defaults).
INSERT INTO rulesets
  (id, scope, owner_id, name, target, enforcement, conditions, rules, bypass,
   created_by, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))), 'repo', repo_id, 'CI policy (default branch)', 'branch',
  'active', '{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}',
  '[' ||
    CASE WHEN coalesce(json_extract(config, '$.protect_default'), 1)
      THEN '{"type":"update"},' ELSE '' END ||
    '{"type":"pull_request","required_approvals":' ||
      coalesce(json_extract(config, '$.required_approvals'), 1) || '}' ||
    CASE WHEN coalesce(json_extract(config, '$.require_checks'), 1)
      THEN ',{"type":"required_status_checks"}' ELSE '' END ||
  ']',
  '[]', 'migration', updated_at, updated_at
FROM ci_settings;
