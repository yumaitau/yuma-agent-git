-- Agent review loops and risk gates (issue #60).
-- An agent identity registered to review every pull request revision in a
-- repo. Built-in agents run through the agent runtime; other kinds are asked
-- through the `agent_review` webhook event and answer with the verdict API.
CREATE TABLE agent_reviewers (
  repo_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trigger_on TEXT NOT NULL CHECK (trigger_on IN ('revision','manual')),
  required INTEGER NOT NULL DEFAULT 1,
  min_confidence REAL NOT NULL DEFAULT 0.8,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, agent_id)
);

-- One verdict per reviewer per revision (a later one replaces it). `round` is
-- how many revisions of the pull request agents had reviewed, this one included.
CREATE TABLE review_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id INTEGER NOT NULL REFERENCES pull_requests(id),
  revision INTEGER NOT NULL,
  head_cs TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  confidence REAL NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '[]',
  round INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (pull_id, revision, reviewer)
);

-- The round limit was reached without a passing verdict: a person was asked
-- to review and the author agent may not push more revisions.
CREATE TABLE agent_review_escalations (
  pull_id INTEGER PRIMARY KEY REFERENCES pull_requests(id),
  round INTEGER NOT NULL,
  requested TEXT,
  at INTEGER NOT NULL
);

-- The agent identity that opened the pull request, when one did.
ALTER TABLE pull_requests ADD COLUMN author_agent_id TEXT;

-- Cost and token accounting (issue #61). Append-only: corrections are new
-- events. `quantity` is seconds for ci_seconds and bytes stored that day for
-- storage (one `meter` event per repo and day).
-- `usd_micros` is NULL when no price is known for the model or instance.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  repo_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  ticket TEXT,
  pull_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('tokens','ci_seconds','storage')),
  source TEXT NOT NULL CHECK (source IN ('workers_ai','reported','ci','meter')),
  model TEXT,
  billing TEXT NOT NULL DEFAULT 'metered' CHECK (billing IN ('metered','subscription')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  usd_micros INTEGER,
  price_version TEXT,
  correction_of TEXT,
  reported_by TEXT,
  at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_events_repo ON usage_events(repo_id, at);
CREATE INDEX usage_events_org ON usage_events(org_id, at);
CREATE INDEX usage_events_agent ON usage_events(agent_id, at);
CREATE INDEX usage_events_pull ON usage_events(pull_id);
CREATE TRIGGER usage_events_no_update BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only');
END;

-- Daily rollups, kept by a trigger in the same transaction as each event so
-- they always match the raw rows. Empty strings stand for NULL keys.
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  org_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  usd_micros INTEGER NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, org_id, repo_id, agent_id, kind, model)
);
CREATE INDEX usage_daily_org ON usage_daily(org_id, day);
CREATE INDEX usage_daily_agent ON usage_daily(agent_id, day);
CREATE INDEX usage_daily_repo ON usage_daily(repo_id, day);
CREATE TRIGGER usage_events_rollup AFTER INSERT ON usage_events
BEGIN
  INSERT OR IGNORE INTO usage_daily (day, org_id, repo_id, agent_id, kind, model)
  VALUES (strftime('%Y-%m-%d', NEW.at / 1000, 'unixepoch'), COALESCE(NEW.org_id, ''),
          COALESCE(NEW.repo_id, ''), COALESCE(NEW.agent_id, ''), NEW.kind,
          COALESCE(NEW.model, ''));
  UPDATE usage_daily SET
    events = events + 1,
    input_tokens = input_tokens + NEW.input_tokens,
    output_tokens = output_tokens + NEW.output_tokens,
    cached_tokens = cached_tokens + NEW.cached_tokens,
    quantity = quantity + NEW.quantity,
    usd_micros = usd_micros + COALESCE(NEW.usd_micros, 0),
    unpriced = unpriced + (NEW.usd_micros IS NULL)
  WHERE day = strftime('%Y-%m-%d', NEW.at / 1000, 'unixepoch')
    AND org_id = COALESCE(NEW.org_id, '') AND repo_id = COALESCE(NEW.repo_id, '')
    AND agent_id = COALESCE(NEW.agent_id, '') AND kind = NEW.kind
    AND model = COALESCE(NEW.model, '');
END;

-- Budgets per org or agent over a UTC day or month. Crossing the soft limit
-- alerts the owner; the hard limit also stops new work queue claims.
CREATE TABLE usage_budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org','agent')),
  scope_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tokens','usd_micros')),
  period TEXT NOT NULL CHECK (period IN ('day','month')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, scope_id, metric, period)
);

-- One alert per budget, period and level.
CREATE TABLE usage_alerts (
  budget_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('soft','hard')),
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  used INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  notify TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, period_start, level)
);
