-- OAuth login state (issue #12): single-use, hashed, 10-minute TTL.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
