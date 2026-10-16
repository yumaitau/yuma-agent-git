-- Line-level review (issue #39): threads anchored to lines of a pull request
-- revision, their comments (with optional suggested changes) and review
-- requests to people, teams and agents.

-- A thread sits on `start_line`..`end_line` of `path` as it reads at
-- `anchor_cs`: the pull's head (`side = 'head'`) or the left side of its diff
-- (`side = 'base'`, the merge base). When the pull moves to a new revision the
-- lines are re-anchored; if they changed, `outdated` is set and the anchor
-- stays on the last revision that still had them.
CREATE TABLE review_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id INTEGER NOT NULL REFERENCES pull_requests(id),
  path TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('base','head')),
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  revision INTEGER NOT NULL,           -- pull revision the anchor was last checked on
  anchor_cs TEXT NOT NULL,
  original_head_cs TEXT NOT NULL,      -- pull head when the thread was started
  outdated INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,                -- 'user:<id>' | 'agent:<agent or token id>'
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_threads_pull ON review_threads(pull_id, id);

CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES review_threads(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  suggestion_patch TEXT,               -- replacement text for the thread's lines
  review_id INTEGER REFERENCES pull_reviews(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX review_comments_thread ON review_comments(thread_id, id);

CREATE TABLE review_requests (
  pull_id INTEGER NOT NULL REFERENCES pull_requests(id),
  principal TEXT NOT NULL,             -- 'user:<id>' | 'team:<id>' | 'agent:<id>'
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reviewed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pull_id, principal)
);
