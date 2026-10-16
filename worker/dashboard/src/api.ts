import { z } from 'zod';
import { MERGE_METHODS, type MergeMethod } from '../../shared/collaboration';

/**
 * Typed client for the yuma-agent-git `/api/v1` API (session-cookie auth).
 *
 * - Every response is modeled with a zod schema; in dev builds the payload is
 *   parsed through it (failures warn + pass through so the UI stays alive).
 * - Errors always arrive as `{ error: { code, message, ...extra } }` and are
 *   surfaced as `ApiError` (401/403/409 carry extra data the UI renders).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface DeniedBy {
  id: number;
  path_prefix: string;
  effect: string;
  principal: string;
}

const deniedBySchema = z.object({
  id: z.number(),
  path_prefix: z.string(),
  effect: z.string(),
  principal: z.string(),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 403 bodies may name the path rule that denied the call. */
  get deniedBy(): DeniedBy | null {
    const parsed = deniedBySchema.safeParse(this.details['denied_by']);
    return parsed.success ? parsed.data : null;
  }

  /** 409 `ref_stale`: the head the caller expected. */
  get expected(): string | null {
    const value = this.details['expected'];
    return typeof value === 'string' ? value : null;
  }

  /** 409 `ref_stale`: the head the ref actually has. */
  get actual(): string | null {
    const value = this.details['actual'];
    return typeof value === 'string' ? value : null;
  }
}

export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(
    0,
    'network_error',
    err instanceof Error ? err.message : 'request failed',
  );
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered once by the app shell: 401 responses redirect to /login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

// ---------------------------------------------------------------------------
// Core request plumbing
// ---------------------------------------------------------------------------

export type QueryParams = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
}

/** Raw fetch with the envelope conventions applied (no body parsing). */
export async function apiFetch(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { method = 'GET', body, query } = options;
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs !== '') url = `${path}?${qs}`;
  }
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

function toApiError(status: number, payload: unknown): ApiError {
  const envelope = z
    .object({ error: z.object({ code: z.string(), message: z.string() }).loose() })
    .safeParse(payload);
  if (envelope.success) {
    const { code, message, ...extra } = envelope.data.error;
    return new ApiError(status, code, message, extra as Record<string, unknown>);
  }
  return new ApiError(status, `http_${status}`, `request failed with status ${status}`);
}

function devParse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  if (!import.meta.env.DEV) return data as z.infer<S>;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.warn('api response failed schema validation', parsed.error.issues, data);
    return data as z.infer<S>;
  }
  return parsed.data;
}

async function requestJson<S extends z.ZodType>(
  path: string,
  options: RequestOptions,
  schema: S,
): Promise<z.infer<S>> {
  const res = await apiFetch(path, options);
  const text = await res.text();
  let payload: unknown = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err = toApiError(res.status, payload);
    if (res.status === 401) unauthorizedHandler?.();
    throw err;
  }
  return devParse(schema, payload);
}

// ---------------------------------------------------------------------------
// Schemas + types
// ---------------------------------------------------------------------------

export const authorSchema = z.union([
  z.object({ name: z.string(), email: z.string() }),
  z.object({ agent: z.string() }),
]);
export type Author = z.infer<typeof authorSchema>;

export function authorName(author: Author): string {
  return 'agent' in author ? author.agent : author.name;
}

const fileChangeSchema = z.object({
  path: z.string(),
  op: z.enum(['add', 'mod', 'del']),
  hash: z.string().optional(),
  size: z.number().optional(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const repoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  visibility: z.enum(['private', 'public']),
  default_branch: z.string(),
  created_at: z.number(),
  created_by: z.string().nullable().optional(),
  github_installation_id: z.number().nullable().optional(),
  github_repo_id: z.number().nullable().optional(),
  refs_mode: z.enum(['scion', 'git']).optional(),
  owner_kind: z.enum(['user', 'org']).optional(),
  owner_id: z.string().nullable().optional(),
  merge_methods: z.array(z.enum(MERGE_METHODS)).optional(),
  default_merge_method: z.enum(MERGE_METHODS).optional(),
});
export type Repo = z.infer<typeof repoSchema>;

export const changesetSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  first_parent: z.string().nullable(),
  parents: z.array(z.string()),
  author: authorSchema,
  message: z.string(),
  created_at: z.number(),
  changed_files: z.array(fileChangeSchema),
  root_tree: z.string().nullable().optional(),
});
export type Changeset = z.infer<typeof changesetSchema>;

export const refSchema = z.object({
  name: z.string(),
  head: z.string(),
  updated_at: z.number(),
});
export type Ref = z.infer<typeof refSchema>;

export const moveRefResultSchema = z.object({
  ok: z.literal(true),
  from: z.string().nullable(),
  to: z.string(),
});
export type MoveRefResult = z.infer<typeof moveRefResultSchema>;

export const treeEntrySchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  kind: z.enum(['tree', 'blob']),
  hash: z.string(),
  size: z.number().optional(),
  mode: z.string().optional(),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const fileContentSchema = z.object({
  path: z.string(),
  size: z.number(),
  blob_sha256: z.string(),
  cs: z.string(),
  content_b64: z.string(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const blameRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
  cs: z.string(),
  message: z.string().optional(),
  author: authorSchema.optional(),
});
export type BlameRange = z.infer<typeof blameRangeSchema>;

export const blameSchema = z.object({
  status: z.literal('computing').optional(),
  path: z.string(),
  cs: z.string(),
  ranges: z.array(blameRangeSchema),
  complete: z.boolean(),
});
export type BlameResult = z.infer<typeof blameSchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['add', 'del', 'mod']),
  old_hash: z.string().optional(),
  new_hash: z.string().optional(),
  old_size: z.number().optional(),
  new_size: z.number().optional(),
  size_delta: z.number().optional(),
  side: z.enum(['from', 'to']).optional(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const textDiffSchema = z.object({
  path: z.string(),
  unified: z.string(),
  side: z.enum(['from', 'to']).optional(),
});
export type TextDiff = z.infer<typeof textDiffSchema>;

export const diffSchema = z.object({
  from: z.string(),
  to: z.string(),
  merge_base: z.string().nullable(),
  files: z.array(diffFileSchema),
  truncated: z.boolean(),
  texts: z.array(textDiffSchema).optional(),
  texts_truncated: z.boolean().optional(),
  texts_hint: z.string().optional(),
});
export type DiffResult = z.infer<typeof diffSchema>;

export const historySchema = z.object({
  path: z.string().optional(),
  changesets: z.array(changesetSchema),
  next: z.unknown().optional(),
  complete: z.boolean().optional(),
});
export type HistoryResult = z.infer<typeof historySchema>;

export const changedPathsSchema = z.object({
  cs: z.string(),
  changed_files: z.array(fileChangeSchema),
});
export type ChangedPaths = z.infer<typeof changedPathsSchema>;

export const taskKindSchema = z.enum([
  'freeform',
  'fix_issue',
  'post_merge_check',
  'superfan',
]);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const agentTaskSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  kind: taskKindSchema,
  prompt: z.string(),
  status: z.enum(['queued', 'running', 'landed', 'failed', 'cancelled']),
  base_cs: z.string().nullable().optional(),
  result_cs: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const transcriptEntrySchema = z.object({
  t: z.number(),
  kind: z.enum(['tool_call', 'tool_result', 'llm', 'note']),
  name: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  text: z.string().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export const agentStateSchema = z.object({
  task_id: z.string().optional(),
  repo_id: z.string().optional(),
  status: z.enum(['thinking', 'acting', 'waiting', 'done', 'failed']),
  base_cs: z.string().optional(),
  head_cs: z.string().optional(),
  steps: z.number().optional(),
  transcript: z.array(transcriptEntrySchema).optional(),
  error: z.string().optional(),
  cancelled: z.boolean().optional(),
  summary: z.string().optional(),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const tokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
  repo_id: z.string().nullable(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
  expires_at: z.number().nullable(),
});
export type ApiToken = z.infer<typeof tokenSchema>;

export const createdTokenSchema = tokenSchema.extend({ token: z.string() });
export type CreatedToken = z.infer<typeof createdTokenSchema>;

export const AGENT_KINDS = [
  'factory',
  'claude_code',
  'codex',
  'grok',
  'builtin',
] as const;
export const AGENT_SCOPES = [
  'contents:read',
  'contents:write',
  'pulls:write',
  'ci:run',
  'releases:write',
] as const;

export const agentIdentitySchema = z.object({
  id: z.string(),
  owner_kind: z.enum(['user', 'org']),
  owner_id: z.string(),
  name: z.string(),
  kind: z.enum(AGENT_KINDS),
  max_scopes: z.array(z.string()),
  allowed_repos: z.array(z.string()).nullable(),
  created_at: z.number(),
  disabled: z.boolean(),
  live_tokens: z.number().optional(),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

/** Which agent wrote a changeset, for whom and for which task (#57). */
export const provenanceSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string().nullable(),
  agent_kind: z.string().nullable(),
  on_behalf_of: z.string(),
  on_behalf_of_login: z.string().nullable(),
  task_id: z.string().nullable(),
});
export type AgentProvenance = z.infer<typeof provenanceSchema>;

export const memberSchema = z.object({
  user_id: z.string(),
  role: z.enum(['admin', 'write', 'triage', 'read']),
});
export type Member = z.infer<typeof memberSchema>;

export const pathRuleSchema = z.object({
  id: z.number(),
  repo_id: z.string(),
  path_prefix: z.string(),
  effect: z.enum(['grant', 'deny']),
  principal: z.string(),
  perms: z.array(z.enum(['read', 'write', 'history'])),
});
export type PathRule = z.infer<typeof pathRuleSchema>;

const patternsSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});
export const rulesetSchema = z.object({
  id: z.string(),
  scope: z.enum(['org', 'repo']),
  name: z.string(),
  target: z.enum(['branch', 'tag', 'push']),
  enforcement: z.enum(['active', 'evaluate', 'disabled']),
  conditions: z.object({
    ref_name: patternsSchema.optional(),
    repository_name: patternsSchema.optional(),
  }),
  rules: z.array(z.looseObject({ type: z.string() })),
  bypass: z.array(z.string()),
  updated_at: z.number(),
});
export type Ruleset = z.infer<typeof rulesetSchema>;
export type RulesetInput = Pick<
  Ruleset,
  'name' | 'target' | 'enforcement' | 'conditions' | 'rules' | 'bypass'
>;

export const rulesetEvaluationSchema = z.object({
  id: z.number(),
  ruleset: z.string(),
  ref: z.string().nullable(),
  via: z.string(),
  actor_id: z.string(),
  violations: z.array(z.object({ rule: z.string(), message: z.string() })),
  at: z.number(),
});
export type RulesetEvaluation = z.infer<typeof rulesetEvaluationSchema>;

// Agent guardrails (issue #62)
export const agentPauseSchema = z.object({
  paused_by: z.string(),
  paused_by_login: z.string().nullable(),
  reason: z.string(),
  paused_at: z.number(),
});
export type AgentPause = z.infer<typeof agentPauseSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  action: z.string(),
  principal: z.string(),
  on_behalf_of_login: z.string().nullable(),
  payload_hash: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reasons: z.array(z.object({ rule: z.string(), message: z.string() })),
  requested_at: z.number(),
  decision: z.enum(['pending', 'approved', 'rejected']),
  decided_by_login: z.string().nullable(),
  decided_at: z.number().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const importJobSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  mode: z.string(),
  commits_total: z.number().nullable().optional(),
  commits_done: z.number().nullable().optional(),
  checkpoint: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const orgRoleSchema = z.enum(['owner', 'admin', 'member', 'billing']);
export type OrgRole = z.infer<typeof orgRoleSchema>;
export const orgBaseRoleSchema = z.enum(['none', 'read', 'write', 'admin']);
export type OrgBaseRole = z.infer<typeof orgBaseRoleSchema>;

export const orgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  created_at: z.number(),
  base_role: orgBaseRoleSchema,
  members_can_create_repos: z.boolean(),
});
export type Org = z.infer<typeof orgSchema>;

export const orgMemberSchema = z.object({
  user_id: z.string(),
  login: z.string().nullable(),
  role: orgRoleSchema,
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

export const teamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  parent: z.string().nullable(),
  created_at: z.number(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamDetailSchema = z.object({
  team: teamSchema,
  members: z.array(z.object({ user_id: z.string(), login: z.string().nullable() })),
  repos: z.array(
    z.object({ repo: z.string(), role: z.enum(['admin', 'write', 'read']) }),
  ),
});
export type TeamDetail = z.infer<typeof teamDetailSchema>;

const okSchema = z.object({ ok: z.literal(true) });

const providerSchema = z.object({ id: z.string(), name: z.string() });

export const authStatusSchema = z.object({
  github_configured: z.boolean(),
  providers: z.array(providerSchema).optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const passkeySchema = z.object({
  id: z.string(),
  label: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

export const securitySchema = z.object({
  user: z.object({ id: z.string(), login: z.string() }),
  session: z.object({
    auth_method: z.string(),
    mfa_at: z.number().nullable(),
    mfa_fresh: z.boolean(),
  }),
  identities: z.array(
    z.object({
      provider: z.string(),
      email: z.string().nullable(),
      linked_at: z.number(),
    }),
  ),
  passkeys: z.array(passkeySchema),
  totp: z.object({ enrolled: z.boolean() }),
  providers: z.array(providerSchema),
});
export type Security = z.infer<typeof securitySchema>;

/** WebAuthn options as the Worker sends them (binary fields base64url). */
const webauthnOptionsSchema = z.object({ challenge: z.string() }).loose();
export type WebauthnOptions = z.infer<typeof webauthnOptionsSchema>;

export const totpSetupSchema = z.object({ secret: z.string(), otpauth_uri: z.string() });
export type TotpSetup = z.infer<typeof totpSetupSchema>;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  async authStatus(): Promise<AuthStatus> {
    return requestJson('/auth/status', {}, authStatusSchema);
  },
  /** Session probe — true when the cookie yields a principal. */
  async checkSession(): Promise<boolean> {
    const res = await apiFetch('/api/v1/tokens');
    return res.status !== 401;
  },

  async logout(): Promise<void> {
    await requestJson('/auth/logout', { method: 'POST' }, okSchema);
  },

  // -- repos ---------------------------------------------------------------
  async listRepos(): Promise<Repo[]> {
    const pageSchema = z.object({
      repos: z.array(repoSchema),
      next_cursor: z.string().nullable().optional(),
    });
    const repos: Repo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const body = await requestJson(
        '/api/v1/repos',
        { query: { limit: 50, cursor } },
        pageSchema,
      );
      repos.push(...body.repos);
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return repos;
  },

  async createRepo(input: {
    slug: string;
    visibility?: 'public' | 'private';
    default_branch?: string;
  }): Promise<Repo> {
    const body = await requestJson(
      '/api/v1/repos',
      { method: 'POST', body: input },
      z.object({ repo: repoSchema }),
    );
    return body.repo;
  },

  async getRepo(slug: string): Promise<{ repo: Repo; can_admin: boolean }> {
    return requestJson(
      `/api/v1/repos/${slug}`,
      {},
      z.object({ repo: repoSchema, can_admin: z.boolean() }),
    );
  },

  async updateRepo(
    slug: string,
    input: {
      default_branch?: string;
      refs_mode?: 'scion' | 'git';
      merge_methods?: MergeMethod[];
      default_merge_method?: MergeMethod;
    },
  ): Promise<Repo> {
    const body = await requestJson(
      `/api/v1/repos/${slug}`,
      { method: 'PUT', body: input },
      z.object({ repo: repoSchema }),
    );
    return body.repo;
  },

  async initializeRepo(slug: string): Promise<void> {
    await requestJson(
      `/api/v1/repos/${slug}/initialize`,
      { method: 'POST', body: {} },
      z.object({ changeset: changesetSchema }),
    );
  },

  // -- GitHub bridge ---------------------------------------------------------
  async connectRepo(
    slug: string,
    input: { installation_id: number; github_repo_id: number },
  ): Promise<Repo> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/connect`,
      { method: 'POST', body: input },
      z.object({ ok: z.boolean(), repo: repoSchema }),
    );
    return body.repo;
  },

  async startImport(
    slug: string,
    input: { source: string; mode: 'snapshot' | 'full_history'; ref?: string },
  ): Promise<{ job_id: string; status: string }> {
    return requestJson(
      `/api/v1/repos/${slug}/import`,
      { method: 'POST', body: input },
      z.object({ job_id: z.string(), status: z.string() }),
    );
  },

  async getImportJob(slug: string, jobId: string): Promise<ImportJob> {
    return requestJson(`/api/v1/repos/${slug}/import/${jobId}`, {}, importJobSchema);
  },

  // -- refs -----------------------------------------------------------------
  async listRefs(slug: string): Promise<Ref[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/refs`,
      {},
      z.object({ refs: z.array(refSchema) }),
    );
    return body.refs;
  },

  async moveRef(
    slug: string,
    name: string,
    input: { from: string | null; to: string; force?: boolean },
  ): Promise<MoveRefResult> {
    return requestJson(
      `/api/v1/repos/${slug}/refs/${encodeURIComponent(name)}`,
      { method: 'PUT', body: input },
      moveRefResultSchema,
    );
  },

  // -- changesets ------------------------------------------------------------
  async listChangesets(
    slug: string,
    query: { head?: string; limit?: number } = {},
  ): Promise<Changeset[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/changesets`,
      { query },
      z.object({ changesets: z.array(changesetSchema) }),
    );
    return body.changesets;
  },

  async getChangeset(
    slug: string,
    id: string,
  ): Promise<Changeset & { provenance: AgentProvenance | null }> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/changesets/${id}`,
      {},
      z.object({ changeset: changesetSchema, provenance: provenanceSchema.nullish() }),
    );
    return { ...body.changeset, provenance: body.provenance ?? null };
  },

  // -- diff -----------------------------------------------------------------
  async getDiff(
    slug: string,
    query: {
      from: string;
      to: string;
      text?: boolean;
      mode?: 'merge-base' | 'direct';
      max_files?: number;
    },
  ): Promise<DiffResult> {
    return requestJson(
      `/api/v1/repos/${slug}/diff`,
      { query: { ...query, text: query.text ? 1 : undefined } },
      diffSchema,
    );
  },

  // -- read RPCs --------------------------------------------------------------
  async getTree(
    slug: string,
    query: { cs: string; path?: string; recursive?: boolean },
  ): Promise<{ path: string; entries: TreeEntry[] }> {
    return requestJson(
      `/api/v1/repos/${slug}/tree`,
      {
        query: {
          cs: query.cs,
          path: query.path,
          recursive: query.recursive ? 1 : undefined,
        },
      },
      z.object({ path: z.string(), entries: z.array(treeEntrySchema) }),
    );
  },

  async getFile(slug: string, query: { cs: string; path: string }): Promise<FileContent> {
    return requestJson(`/api/v1/repos/${slug}/file`, { query }, fileContentSchema);
  },

  async getBlame(
    slug: string,
    query: { cs: string; path: string; annotate?: boolean },
  ): Promise<BlameResult> {
    return requestJson(
      `/api/v1/repos/${slug}/blame`,
      { query: { ...query, annotate: query.annotate ? 1 : undefined } },
      blameSchema,
    );
  },

  async getHistory(
    slug: string,
    query: { cs?: string; path?: string; limit?: number } = {},
  ): Promise<HistoryResult> {
    return requestJson(`/api/v1/repos/${slug}/history`, { query }, historySchema);
  },

  async getChangedPaths(slug: string, cs: string): Promise<ChangedPaths> {
    return requestJson(
      `/api/v1/repos/${slug}/changed-paths`,
      { query: { cs } },
      changedPathsSchema,
    );
  },

  // -- agents ----------------------------------------------------------------
  async listTasks(
    slug: string,
    query: { status?: string; limit?: number } = {},
  ): Promise<AgentTask[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/agents/tasks`,
      { query },
      z.object({ tasks: z.array(agentTaskSchema) }),
    );
    return body.tasks;
  },

  async createTask(
    slug: string,
    input: { kind: TaskKind; prompt: string; base_cs?: string },
  ): Promise<{ task_id: string; status: string }> {
    return requestJson(
      `/api/v1/repos/${slug}/agents/tasks`,
      { method: 'POST', body: input },
      z.object({ task_id: z.string(), status: z.string() }),
    );
  },

  async getTask(id: string): Promise<{ task: AgentTask; state: AgentState }> {
    return requestJson(
      `/api/v1/agents/tasks/${id}`,
      {},
      z.object({ task: agentTaskSchema, state: agentStateSchema }),
    );
  },

  async getTranscript(id: string, since: number): Promise<TranscriptEntry[]> {
    const body = await requestJson(
      `/api/v1/agents/tasks/${id}/transcript`,
      { query: { since } },
      z.object({ entries: z.array(transcriptEntrySchema) }),
    );
    return body.entries;
  },

  async cancelTask(id: string): Promise<{ ok: boolean; status: string }> {
    return requestJson(
      `/api/v1/agents/tasks/${id}/cancel`,
      { method: 'POST' },
      z.object({ ok: z.boolean(), status: z.string() }),
    );
  },

  async createSuperfan(
    slug: string,
    input: {
      component: 'commit-path' | 'import-pipeline' | 'queues' | 'refs' | 'agents' | 'ai';
      interval_min: number;
    },
  ): Promise<{ ok: boolean; component: string }> {
    return requestJson(
      `/api/v1/repos/${slug}/agents/superfans`,
      { method: 'POST', body: input },
      z.object({ ok: z.boolean(), component: z.string() }),
    );
  },

  // -- settings ---------------------------------------------------------------
  async listTokens(): Promise<ApiToken[]> {
    const body = await requestJson(
      '/api/v1/tokens',
      {},
      z.object({ tokens: z.array(tokenSchema) }),
    );
    return body.tokens;
  },

  /** The raw token is returned exactly once — store/display it immediately. */
  async createToken(input: {
    label: string;
    scopes?: ('repo:read' | 'repo:write' | 'agent:run')[];
  }): Promise<CreatedToken> {
    return requestJson(
      '/api/v1/tokens',
      { method: 'POST', body: input },
      createdTokenSchema,
    );
  },

  async deleteToken(id: string): Promise<void> {
    await requestJson(`/api/v1/tokens/${id}`, { method: 'DELETE' }, okSchema);
  },

  // -- agent identities (#57) -------------------------------------------------
  async listAgents(): Promise<AgentIdentity[]> {
    const body = await requestJson(
      '/api/v1/agents',
      {},
      z.object({ agents: z.array(agentIdentitySchema) }),
    );
    return body.agents;
  },

  async createAgent(input: {
    name: string;
    kind: AgentIdentity['kind'];
    max_scopes?: string[];
    org?: string;
  }): Promise<AgentIdentity> {
    return requestJson(
      '/api/v1/agents',
      { method: 'POST', body: input },
      agentIdentitySchema,
    );
  },

  /** Kill switch: disabling also revokes every live token of the agent. */
  async setAgentDisabled(id: string, disabled: boolean): Promise<AgentIdentity> {
    return requestJson(
      `/api/v1/agents/${id}`,
      { method: 'PATCH', body: { disabled } },
      agentIdentitySchema,
    );
  },

  // -- account security (passkeys, TOTP, linked identities) -------------------
  async getSecurity(): Promise<Security> {
    return requestJson('/api/v1/me/security', {}, securitySchema);
  },

  async passkeyRegistrationOptions(): Promise<WebauthnOptions> {
    return requestJson(
      '/api/v1/me/passkeys/options',
      { method: 'POST', body: {} },
      webauthnOptionsSchema,
    );
  },

  async registerPasskey(label: string, credential: unknown): Promise<Passkey> {
    const body = await requestJson(
      '/api/v1/me/passkeys',
      { method: 'POST', body: { label, credential } },
      z.object({ passkey: passkeySchema }),
    );
    return body.passkey;
  },

  async deletePasskey(id: string): Promise<void> {
    await requestJson(
      `/api/v1/me/passkeys/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async startTotp(): Promise<TotpSetup> {
    return requestJson('/api/v1/me/totp', { method: 'POST', body: {} }, totpSetupSchema);
  },

  async confirmTotp(code: string): Promise<void> {
    await requestJson(
      '/api/v1/me/totp/confirm',
      { method: 'POST', body: { code } },
      okSchema,
    );
  },

  async deleteTotp(): Promise<void> {
    await requestJson('/api/v1/me/totp', { method: 'DELETE' }, okSchema);
  },

  async mfaPasskeyOptions(): Promise<WebauthnOptions> {
    return requestJson(
      '/auth/mfa/passkey/options',
      { method: 'POST', body: {} },
      webauthnOptionsSchema,
    );
  },

  async verifyMfaPasskey(credential: unknown): Promise<void> {
    await requestJson(
      '/auth/mfa/passkey',
      { method: 'POST', body: { credential } },
      okSchema,
    );
  },

  async verifyMfaTotp(code: string): Promise<void> {
    await requestJson('/auth/mfa/totp', { method: 'POST', body: { code } }, okSchema);
  },

  async passkeySignInOptions(): Promise<WebauthnOptions> {
    return requestJson(
      '/auth/passkey/options',
      { method: 'POST', body: {} },
      webauthnOptionsSchema,
    );
  },

  async signInWithPasskey(credential: unknown): Promise<void> {
    await requestJson(
      '/auth/passkey',
      { method: 'POST', body: { credential } },
      okSchema,
    );
  },

  async listMembers(slug: string): Promise<Member[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/members`,
      {},
      z.object({ members: z.array(memberSchema) }),
    );
    return body.members;
  },

  async putMember(
    slug: string,
    input: {
      user_login?: string;
      user_id?: string;
      role: 'admin' | 'write' | 'triage' | 'read';
    },
  ): Promise<{ ok: boolean; user_id: string; role: string }> {
    return requestJson(
      `/api/v1/repos/${slug}/members`,
      { method: 'PUT', body: input },
      z.object({ ok: z.boolean(), user_id: z.string(), role: z.string() }),
    );
  },

  async deleteMember(slug: string, userId: string): Promise<void> {
    await requestJson(
      `/api/v1/repos/${slug}/members/${userId}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async listPathRules(slug: string): Promise<PathRule[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/path-rules`,
      {},
      z.object({ path_rules: z.array(pathRuleSchema) }),
    );
    return body.path_rules;
  },

  async createPathRule(
    slug: string,
    input: {
      path_prefix: string;
      effect: 'grant' | 'deny';
      principal: string;
      perms: ('read' | 'write' | 'history')[];
    },
  ): Promise<{ ok: boolean; id: number }> {
    return requestJson(
      `/api/v1/repos/${slug}/path-rules`,
      { method: 'POST', body: input },
      z.object({ ok: z.boolean(), id: z.number() }),
    );
  },

  async deletePathRule(slug: string, id: number): Promise<void> {
    await requestJson(
      `/api/v1/repos/${slug}/path-rules/${id}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  // -- rulesets (issue #41) --------------------------------------------------
  async listRulesets(
    slug: string,
  ): Promise<{ rulesets: Ruleset[]; inherited: Ruleset[] }> {
    return requestJson(
      `/api/v1/repos/${slug}/rulesets`,
      {},
      z.object({ rulesets: z.array(rulesetSchema), inherited: z.array(rulesetSchema) }),
    );
  },

  async createRuleset(slug: string, input: RulesetInput): Promise<Ruleset> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/rulesets`,
      { method: 'POST', body: input },
      z.object({ ruleset: rulesetSchema }),
    );
    return body.ruleset;
  },

  async updateRuleset(slug: string, id: string, input: RulesetInput): Promise<Ruleset> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/rulesets/${id}`,
      { method: 'PUT', body: input },
      z.object({ ruleset: rulesetSchema }),
    );
    return body.ruleset;
  },

  async deleteRuleset(slug: string, id: string): Promise<void> {
    await requestJson(
      `/api/v1/repos/${slug}/rulesets/${id}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async listRulesetEvaluations(slug: string): Promise<RulesetEvaluation[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/rulesets/evaluations`,
      {},
      z.object({ evaluations: z.array(rulesetEvaluationSchema) }),
    );
    return body.evaluations;
  },

  // -- agent guardrails (issue #62) ------------------------------------------
  async getAgentPause(
    org: string,
  ): Promise<{ paused: AgentPause | null; instance: AgentPause | null }> {
    return requestJson(
      `/api/v1/orgs/${org}/agents/pause`,
      {},
      z.object({
        paused: agentPauseSchema.nullable(),
        instance: agentPauseSchema.nullable(),
      }),
    );
  },

  async pauseAgents(org: string, reason: string): Promise<AgentPause | null> {
    const body = await requestJson(
      `/api/v1/orgs/${org}/agents/pause`,
      { method: 'POST', body: { reason } },
      z.object({ paused: agentPauseSchema.nullable() }),
    );
    return body.paused;
  },

  async resumeAgents(org: string): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${org}/agents/pause`,
      { method: 'DELETE' },
      z.object({ paused: z.null() }),
    );
  },

  async listApprovals(slug: string): Promise<Approval[]> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/approvals`,
      {},
      z.object({ approvals: z.array(approvalSchema) }),
    );
    return body.approvals;
  },

  async decideApproval(
    slug: string,
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<Approval> {
    const body = await requestJson(
      `/api/v1/repos/${slug}/approvals/${id}`,
      { method: 'POST', body: { decision } },
      z.object({ approval: approvalSchema }),
    );
    return body.approval;
  },

  // -- orgs (issue #26) ------------------------------------------------------
  async listOrgs(): Promise<(Org & { role: OrgRole })[]> {
    const body = await requestJson(
      '/api/v1/orgs',
      {},
      z.object({ orgs: z.array(orgSchema.extend({ role: orgRoleSchema })) }),
    );
    return body.orgs;
  },

  async createOrg(input: { slug: string; display_name?: string }): Promise<Org> {
    const body = await requestJson(
      '/api/v1/orgs',
      { method: 'POST', body: input },
      z.object({ org: orgSchema }),
    );
    return body.org;
  },

  async getOrg(slug: string): Promise<{ org: Org; role: OrgRole }> {
    return requestJson(
      `/api/v1/orgs/${slug}`,
      {},
      z.object({ org: orgSchema, role: orgRoleSchema }),
    );
  },

  async updateOrg(
    slug: string,
    input: { base_role?: OrgBaseRole; members_can_create_repos?: boolean },
  ): Promise<Org> {
    const body = await requestJson(
      `/api/v1/orgs/${slug}`,
      { method: 'PATCH', body: input },
      z.object({ org: orgSchema }),
    );
    return body.org;
  },

  async listOrgMembers(slug: string): Promise<OrgMember[]> {
    const body = await requestJson(
      `/api/v1/orgs/${slug}/members`,
      {},
      z.object({ members: z.array(orgMemberSchema) }),
    );
    return body.members;
  },

  async putOrgMember(
    slug: string,
    input: { user_login: string; role: OrgRole },
  ): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/members`,
      { method: 'PUT', body: input },
      z.object({ ok: z.boolean() }),
    );
  },

  async deleteOrgMember(slug: string, userId: string): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/members/${userId}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async listTeams(slug: string): Promise<Team[]> {
    const body = await requestJson(
      `/api/v1/orgs/${slug}/teams`,
      {},
      z.object({ teams: z.array(teamSchema) }),
    );
    return body.teams;
  },

  async createTeam(
    slug: string,
    input: { slug: string; parent?: string },
  ): Promise<Team> {
    const body = await requestJson(
      `/api/v1/orgs/${slug}/teams`,
      { method: 'POST', body: input },
      z.object({ team: teamSchema }),
    );
    return body.team;
  },

  async getTeam(slug: string, team: string): Promise<TeamDetail> {
    return requestJson(`/api/v1/orgs/${slug}/teams/${team}`, {}, teamDetailSchema);
  },

  async putTeamMember(slug: string, team: string, userLogin: string): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/teams/${team}/members`,
      { method: 'PUT', body: { user_login: userLogin } },
      z.object({ ok: z.boolean() }),
    );
  },

  async deleteTeamMember(slug: string, team: string, userId: string): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/teams/${team}/members/${userId}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async putTeamRepo(
    slug: string,
    team: string,
    input: { repo: string; role: 'admin' | 'write' | 'read' },
  ): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/teams/${team}/repos`,
      { method: 'PUT', body: input },
      z.object({ ok: z.boolean() }),
    );
  },

  async deleteTeamRepo(slug: string, team: string, repo: string): Promise<void> {
    await requestJson(
      `/api/v1/orgs/${slug}/teams/${team}/repos/${repo}`,
      { method: 'DELETE' },
      okSchema,
    );
  },

  async listOrgRepos(slug: string): Promise<Repo[]> {
    const body = await requestJson(
      `/api/v1/orgs/${slug}/repos`,
      {},
      z.object({ repos: z.array(repoSchema) }),
    );
    return body.repos;
  },

  // -- export -----------------------------------------------------------------
  async exportToGithub(
    slug: string,
    input: { target_branch: string; head?: string },
  ): Promise<{ job_id: string; status: string }> {
    return requestJson(
      `/api/v1/repos/${slug}/export/github`,
      { method: 'POST', body: input },
      z.object({ job_id: z.string(), status: z.string() }),
    );
  },
};

// ---------------------------------------------------------------------------
// URL builders (plain links the browser follows — downloads, OAuth, install)
// ---------------------------------------------------------------------------

export function tarballUrl(slug: string, rev: string): string {
  return `/api/v1/repos/${slug}/export/tarball?cs=${encodeURIComponent(rev)}`;
}

export function fastImportUrl(slug: string, head: string, mode = 'snapshot'): string {
  return (
    `/api/v1/repos/${slug}/export/fast-import?head=${encodeURIComponent(head)}` +
    `&mode=${encodeURIComponent(mode)}`
  );
}

export function rawFileUrl(slug: string, cs: string, path: string): string {
  return (
    `/api/v1/repos/${slug}/file?cs=${encodeURIComponent(cs)}` +
    `&path=${encodeURIComponent(path)}&format=raw`
  );
}

export const GITHUB_INSTALL_URL = '/api/v1/github/install-url';
export const GITHUB_LOGIN_URL = '/auth/github';
