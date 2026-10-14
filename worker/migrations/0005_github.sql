-- GitHub App installations (issue #13) + webhook delivery dedupe.
CREATE TABLE installations (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  repos TEXT NOT NULL,               -- JSON [{id, full_name, private}]
  updated_at INTEGER NOT NULL
);
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
