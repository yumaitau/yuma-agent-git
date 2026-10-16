-- MCP server (issue #56). The OAuth 2.1 authorization server that MCP clients
-- sign in through, and Streamable HTTP sessions with replayable SSE events.

-- Dynamically registered public clients (RFC 7591). No secrets: PKCE only.
CREATE TABLE mcp_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,       -- JSON array
  created_at INTEGER NOT NULL
);

-- A person's consent for a client to act as one of their agents (#57). The
-- backing API token is the delegating subject of every agent token the grant
-- issues, so revoking it in Settings revokes the grant and its tokens.
CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  subject_token_id TEXT NOT NULL,
  scopes TEXT NOT NULL,              -- JSON array of agent scopes
  repos TEXT NOT NULL,               -- JSON array of repo ids
  refresh_token_hash TEXT UNIQUE,    -- SHA-256; rotated on every use
  refresh_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Single-use authorization codes (SHA-256 at rest), ten minutes.
CREATE TABLE mcp_auth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,      -- PKCE S256
  expires_at INTEGER NOT NULL
);

-- Streamable HTTP sessions, bound to the credential holder that opened them.
CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,              -- 'agent:<agent id>:<user id>' or 'token:<token id>'
  protocol_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- SSE events kept for an hour so a dropped stream can resume (Last-Event-ID).
CREATE TABLE mcp_events (
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, stream_id, seq)
);
CREATE INDEX idx_mcp_events_created ON mcp_events(created_at);
