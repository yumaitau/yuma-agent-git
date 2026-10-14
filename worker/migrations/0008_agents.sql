-- Agent loop + superfan telemetry (issue #19).
ALTER TABLE agent_tasks ADD COLUMN github_issue TEXT;

CREATE TABLE component_metrics (
  component TEXT NOT NULL,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_component_metrics ON component_metrics(component, ts);

CREATE TABLE superfan_findings (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  ts INTEGER NOT NULL,
  finding TEXT NOT NULL,
  task_id TEXT
);
