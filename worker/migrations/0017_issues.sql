-- Issues (issue #38): issues, comments, labels, milestones, assignees,
-- sub-issues and a timeline. Issues and pull requests share one per-repo
-- number sequence, like GitHub, so `#12` names exactly one of them.

CREATE TABLE repo_counters (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  last_number INTEGER NOT NULL
);

-- Existing pull requests keep their numbers (the old global id); new pulls
-- and issues take the next number from repo_counters.
ALTER TABLE pull_requests ADD COLUMN number INTEGER;
UPDATE pull_requests SET number = id;
CREATE UNIQUE INDEX pulls_repo_number ON pull_requests(repo_id, number);
INSERT INTO repo_counters (repo_id, last_number)
  SELECT repo_id, MAX(id) FROM pull_requests GROUP BY repo_id;

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, title)
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  state_reason TEXT CHECK (state_reason IN ('completed','not_planned','duplicate','reopened')),
  author_id TEXT NOT NULL,
  milestone_id INTEGER REFERENCES milestones(id),
  locked INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,                   -- NULL = not pinned; at most 3 per repo
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (repo_id, number)
);
CREATE INDEX issues_repo_state ON issues(repo_id, state, number DESC);
CREATE INDEX issues_milestone ON issues(milestone_id, number DESC);
CREATE INDEX issues_pinned ON issues(repo_id, pinned_at) WHERE pinned_at IS NOT NULL;

CREATE TABLE issue_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX issue_comments_issue ON issue_comments(issue_id, id);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,                 -- 6 hex digits, no '#'
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (repo_id, name)
);

CREATE TABLE issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_labels_label ON issue_labels(label_id, issue_id);

CREATE TABLE issue_assignees (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  principal TEXT NOT NULL,             -- 'user:<id>' | 'team:<id>' | 'agent:<token id>'
  PRIMARY KEY (issue_id, principal)
);
CREATE INDEX issue_assignees_principal ON issue_assignees(principal, issue_id);

-- Sub-issues: one parent per issue, ordered by position.
CREATE TABLE issue_links (
  parent_id INTEGER NOT NULL REFERENCES issues(id),
  child_id INTEGER NOT NULL UNIQUE REFERENCES issues(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);

-- Timeline: state changes, labels, assignees, references. The source for
-- webhooks (#75), notifications (#44) and the work queue (#59).
CREATE TABLE issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX issue_events_issue ON issue_events(issue_id, id);

-- Triage role (GitHub has it): label, assign, close and lock issues without
-- write access to code. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE repo_members_v2 (
  repo_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','write','triage','read')),
  PRIMARY KEY (repo_id, user_id)
);
INSERT INTO repo_members_v2 (repo_id, user_id, role)
  SELECT repo_id, user_id, role FROM repo_members;
DROP TABLE repo_members;
ALTER TABLE repo_members_v2 RENAME TO repo_members;
