-- Notifications, subscriptions and email digests (issue #44).
-- A principal is `user:<id>` or `agent:<agent id>` (#57).

-- Why a principal hears about a subject. `repo` rows are watch levels
-- (`watching`, `ignored`); `pull` and `issue` rows are threads (`author`,
-- `comment`, `mention`, `assign`, `review_requested`, `manual`, `muted`).
CREATE TABLE subscriptions (
  principal TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('repo','pull','issue')),
  subject_id TEXT NOT NULL,            -- repo id, pull_requests.id or issues.id
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal, subject_type, subject_id)
);
CREATE INDEX idx_subscriptions_subject ON subscriptions(subject_type, subject_id);

-- One row per domain event per recipient: a redelivered event finds its row.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,                 -- ulid, newest sorts last
  principal TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,          -- pull | issue | ci_run | secret_alert | security_alert | approval | budget
  subject_id TEXT NOT NULL,
  number INTEGER,                      -- issue or pull request number
  title TEXT NOT NULL,
  url TEXT NOT NULL,                   -- path on the forge, e.g. /r/acme/app/pulls/7
  origin TEXT,                         -- public origin for email links
  reason TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  actor TEXT,                          -- who caused it, as a principal
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  done_at INTEGER,
  emailed_at INTEGER,                  -- claimed for (or sent in) an email
  UNIQUE (event_id, principal)
);
CREATE INDEX idx_notifications_inbox ON notifications(principal, done_at, id);

-- Per-principal preferences; no row means the defaults.
CREATE TABLE notification_settings (
  principal TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT 'instant' CHECK (email IN ('off','instant','digest')),
  digest_hour INTEGER NOT NULL DEFAULT 7 CHECK (digest_hour BETWEEN 0 AND 23),
  skip_weekends INTEGER NOT NULL DEFAULT 0,
  disabled_reasons TEXT NOT NULL DEFAULT '[]',  -- JSON array of reasons
  digest_sent_on TEXT,                 -- Australia/Sydney date of the last digest
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notification_settings_digest ON notification_settings(email, digest_sent_on);
