/**
 * DDL + table/column name constants.
 *
 * Source of truth for the DDL is `worker/migrations/0001_init.sql` (applied by
 * `wrangler d1 migrations apply` in deploys and by `seedSchema()` in tests).
 * `INITIAL_SCHEMA_SQL` mirrors it and `test/db.test.ts` asserts the two never
 * drift.
 */
export const INITIAL_SCHEMA_SQL = `
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  github_installation_id INTEGER,
  github_repo_id INTEGER,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
);

CREATE TABLE changesets (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  first_parent TEXT,
  parents TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  changed_files TEXT NOT NULL
);
CREATE INDEX idx_changesets_repo_parent ON changesets(repo_id, first_parent);
CREATE INDEX idx_changesets_repo_created ON changesets(repo_id, created_at);

CREATE TABLE refs (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE derived_data (
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cs_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, kind, cs_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE repo_members (
  repo_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','write','read')),
  PRIMARY KEY (repo_id, user_id)
);
CREATE TABLE path_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  principal TEXT NOT NULL,
  perms TEXT NOT NULL
);

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','landed','failed','cancelled')),
  base_cs TEXT,
  result_cs TEXT,
  agent_state TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot','full_history')),
  status TEXT NOT NULL DEFAULT 'queued',
  checkpoint TEXT,
  commits_total INTEGER DEFAULT 0,
  commits_done INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Table names. */
export const T = {
  repos: 'repos',
  changesets: 'changesets',
  refs: 'refs',
  derivedData: 'derived_data',
  sessions: 'sessions',
  users: 'users',
  repoMembers: 'repo_members',
  pathRules: 'path_rules',
  agentTasks: 'agent_tasks',
  importJobs: 'import_jobs',
  oauthStates: 'oauth_states',
  apiTokens: 'api_tokens',
  installations: 'installations',
  webhookDeliveries: 'webhook_deliveries',
} as const;

/** Column names, per table. */
export const C = {
  repos: {
    id: 'id',
    slug: 'slug',
    githubInstallationId: 'github_installation_id',
    githubRepoId: 'github_repo_id',
    defaultBranch: 'default_branch',
    createdAt: 'created_at',
    visibility: 'visibility',
  },
  changesets: {
    id: 'id',
    repoId: 'repo_id',
    firstParent: 'first_parent',
    parents: 'parents',
    author: 'author',
    message: 'message',
    createdAt: 'created_at',
    changedFiles: 'changed_files',
    rootTree: 'root_tree',
  },
  refs: {
    repoId: 'repo_id',
    name: 'name',
    head: 'head',
    updatedAt: 'updated_at',
  },
  derivedData: {
    repoId: 'repo_id',
    kind: 'kind',
    csId: 'cs_id',
    payload: 'payload',
    computedAt: 'computed_at',
  },
  sessions: {
    tokenHash: 'token_hash',
    userId: 'user_id',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
  },
  users: {
    id: 'id',
    githubId: 'github_id',
    login: 'login',
    avatarUrl: 'avatar_url',
    createdAt: 'created_at',
  },
  repoMembers: {
    repoId: 'repo_id',
    userId: 'user_id',
    role: 'role',
  },
  pathRules: {
    id: 'id',
    repoId: 'repo_id',
    pathPrefix: 'path_prefix',
    effect: 'effect',
    principal: 'principal',
    perms: 'perms',
  },
  agentTasks: {
    id: 'id',
    repoId: 'repo_id',
    kind: 'kind',
    prompt: 'prompt',
    status: 'status',
    baseCs: 'base_cs',
    resultCs: 'result_cs',
    agentState: 'agent_state',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  installations: {
    installationId: 'installation_id',
    accountLogin: 'account_login',
    accountId: 'account_id',
    repos: 'repos',
    updatedAt: 'updated_at',
  },
  webhookDeliveries: {
    deliveryId: 'delivery_id',
    event: 'event',
    receivedAt: 'received_at',
    status: 'status',
  },
  oauthStates: {
    stateHash: 'state_hash',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
  },
  apiTokens: {
    id: 'id',
    tokenHash: 'token_hash',
    repoId: 'repo_id',
    userId: 'user_id',
    label: 'label',
    scopes: 'scopes',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
    expiresAt: 'expires_at',
  },
  importJobs: {
    id: 'id',
    repoId: 'repo_id',
    source: 'source',
    mode: 'mode',
    status: 'status',
    checkpoint: 'checkpoint',
    commitsTotal: 'commits_total',
    commitsDone: 'commits_done',
    error: 'error',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
} as const;

/** Derived-data kinds (architecture §1.5). */
export const DERIVED_KINDS = [
  'skip_list',
  'changed_paths',
  'path_history',
  'blame',
] as const;
export type DerivedKindName = (typeof DERIVED_KINDS)[number];
