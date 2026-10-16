import { z } from 'zod';
import type { Env } from '../env';
import { timePhase } from '../observability/phase';

/**
 * Thin typed helpers over `D1Database` plus zod row parsers — zod at every
 * boundary, including D1 rows (CONTRIBUTING).
 */

/** Fetch all rows of a query. */
export async function q<T = Record<string, unknown>>(
  env: Env,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return timePhase('d1', async () => {
    const stmt = env.DB.prepare(sql).bind(...(params as unknown[]));
    const res = await stmt.all<T>();
    return res.results;
  });
}

/** Fetch the first row of a query, or null. */
export async function q1<T = Record<string, unknown>>(
  env: Env,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  return timePhase('d1', async () => {
    const stmt = env.DB.prepare(sql).bind(...(params as unknown[]));
    return stmt.first<T>();
  });
}

/** Run a single statement with no rows of interest. */
export async function run(
  env: Env,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  await timePhase('d1', async () => {
    const stmt = env.DB.prepare(sql).bind(...(params as unknown[]));
    await stmt.run();
  });
}

/** A statement queue flushed as a single `env.DB.batch()`. */
export interface Tx {
  q(sql: string, params?: readonly unknown[]): void;
}

/**
 * Run statements in one D1 batch (a transaction under the hood).
 * Returns the per-statement results in order.
 */
export async function tx(
  env: Env,
  fn: (t: Tx) => void,
): Promise<D1Result<Record<string, unknown>>[]> {
  return timePhase('d1', async () => {
    const stmts: D1PreparedStatement[] = [];
    const t: Tx = {
      q(sql, params = []) {
        stmts.push(env.DB.prepare(sql).bind(...(params as unknown[])));
      },
    };
    fn(t);
    return env.DB.batch(stmts);
  });
}

// ---------------------------------------------------------------------------
// Shared row fragments
// ---------------------------------------------------------------------------

export const fileChangeSchema = z.object({
  path: z.string(),
  op: z.enum(['add', 'mod', 'del']),
  hash: z.string().optional(),
  size: z.number().optional(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const authorSchema = z.union([
  z.object({ name: z.string(), email: z.string() }),
  z.object({ agent: z.string() }),
]);
export type Author = z.infer<typeof authorSchema>;

/**
 * Optional Git commit metadata (issue #30) so a pushed commit round-trips
 * byte for byte. Absent fields keep the old changeset ID and Git defaults:
 * committer = author at `created_at`, time zones `+0000`.
 */
export const committerSchema = z.object({
  name: z.string(),
  email: z.string(),
  /** Commit time, epoch ms (Git keeps whole seconds). */
  at: z.number().int(),
});
export type Committer = z.infer<typeof committerSchema>;

const tzSchema = z.string().regex(/^[+-]\d{4}$/);

/** Header keys the commit encoder writes itself. */
const RESERVED_HEADERS = new Set(['tree', 'parent', 'author', 'committer', 'gpgsig']);

export const gitMetaShape = {
  committer: committerSchema.optional(),
  author_tz: tzSchema.optional(),
  committer_tz: tzSchema.optional(),
  /** Raw signature block, without the `gpgsig ` prefix or continuation spaces. */
  gpgsig: z.string().min(1).optional(),
  /** Extra headers in order (`encoding`, `mergetag`, …), written before gpgsig. */
  git_extra_headers: z
    .array(
      z.tuple([
        z
          .string()
          .regex(/^[^\s]+$/)
          .refine((key) => !RESERVED_HEADERS.has(key), 'reserved header'),
        z.string(),
      ]),
    )
    .optional(),
};
export type GitCommitMeta = z.infer<z.ZodObject<typeof gitMetaShape>>;

/** Validate a JSON-encoded D1 column against a schema. */
function jsonOf<T extends z.ZodType>(schema: T) {
  return z.string().transform((text, ctx): z.infer<T> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      return schema.parse(parsed);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : 'invalid JSON column',
      });
      return z.NEVER;
    }
  });
}

/** Throw a typed error when a row fails validation. */
export class RowParseError extends Error {
  readonly code = 'row_parse_error';
  constructor(
    readonly table: string,
    message: string,
  ) {
    super(`invalid ${table} row: ${message}`);
    this.name = 'RowParseError';
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, table: string, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new RowParseError(table, JSON.stringify(result.error.issues));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

export const repoRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  github_installation_id: z.number().nullable().optional(),
  github_repo_id: z.number().nullable().optional(),
  default_branch: z.string(),
  created_at: z.number(),
  visibility: z.enum(['private', 'public']),
  /** Repo creator (migration 0006) — creators are admins. */
  created_by: z.string().nullable().optional(),
  /** Ref naming rules (migration 0011); absent means the pilot's 'scion'. */
  refs_mode: z.enum(['scion', 'git']).optional(),
  /** Owner namespace (migration 0012): slug prefix for users, orgs.id for orgs. */
  owner_kind: z.enum(['user', 'org']).optional(),
  owner_id: z.string().nullable().optional(),
});
export type RepoRecord = z.infer<typeof repoRowSchema>;

export function parseRepoRow(row: unknown): RepoRecord {
  return parseOrThrow(repoRowSchema, 'repos', row);
}

// ---------------------------------------------------------------------------
// changesets
// ---------------------------------------------------------------------------

export const changesetRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  first_parent: z.string().nullable(),
  parents: jsonOf(z.array(z.string())),
  author: jsonOf(authorSchema),
  message: z.string(),
  created_at: z.number(),
  changed_files: jsonOf(z.array(fileChangeSchema)),
  root_tree: z.string().nullable().optional(),
  committer: jsonOf(committerSchema).nullable().optional(),
  author_tz: z.string().nullable().optional(),
  committer_tz: z.string().nullable().optional(),
  gpgsig: z.string().nullable().optional(),
  git_extra_headers: jsonOf(z.array(z.tuple([z.string(), z.string()])))
    .nullable()
    .optional(),
});

export interface ChangesetRecord extends GitCommitMeta {
  id: string;
  repo_id: string;
  first_parent: string | null;
  parents: string[];
  author: Author;
  message: string;
  created_at: number;
  changed_files: FileChange[];
  root_tree: string | null;
}

export function parseChangesetRow(row: unknown): ChangesetRecord {
  const parsed = parseOrThrow(changesetRowSchema, 'changesets', row);
  const { committer, author_tz, committer_tz, gpgsig, git_extra_headers, ...rest } =
    parsed;
  // Git metadata is optional: absent columns stay absent (old rows, old JSON).
  return {
    ...rest,
    root_tree: parsed.root_tree ?? null,
    ...(committer ? { committer } : {}),
    ...(author_tz ? { author_tz } : {}),
    ...(committer_tz ? { committer_tz } : {}),
    ...(gpgsig ? { gpgsig } : {}),
    ...(git_extra_headers ? { git_extra_headers } : {}),
  };
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

export const refRowSchema = z.object({
  repo_id: z.string(),
  name: z.string(),
  head: z.string(),
  updated_at: z.number(),
});
export type RefRecord = z.infer<typeof refRowSchema>;

export function parseRefRow(row: unknown): RefRecord {
  return parseOrThrow(refRowSchema, 'refs', row);
}

// ---------------------------------------------------------------------------
// derived_data
// ---------------------------------------------------------------------------

export const derivedDataRowSchema = z.object({
  repo_id: z.string(),
  kind: z.string(),
  cs_id: z.string(),
  payload: z.string(),
  computed_at: z.number(),
});
export type DerivedDataRecord = z.infer<typeof derivedDataRowSchema>;

export function parseDerivedDataRow(row: unknown): DerivedDataRecord {
  return parseOrThrow(derivedDataRowSchema, 'derived_data', row);
}

// ---------------------------------------------------------------------------
// users / sessions
// ---------------------------------------------------------------------------

export const userRowSchema = z.object({
  id: z.string(),
  github_id: z.number().nullable(),
  login: z.string(),
  avatar_url: z.string().nullable().optional(),
  created_at: z.number(),
  active: z.number().optional(),
});
export type UserRecord = z.infer<typeof userRowSchema>;

export function parseUserRow(row: unknown): UserRecord {
  return parseOrThrow(userRowSchema, 'users', row);
}

export const sessionRowSchema = z.object({
  token_hash: z.string(),
  user_id: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  auth_method: z.string().optional(),
  mfa_at: z.number().nullable().optional(),
});
export type SessionRecord = z.infer<typeof sessionRowSchema>;

export function parseSessionRow(row: unknown): SessionRecord {
  return parseOrThrow(sessionRowSchema, 'sessions', row);
}

// ---------------------------------------------------------------------------
// rbac
// ---------------------------------------------------------------------------

export const repoMemberRowSchema = z.object({
  repo_id: z.string(),
  user_id: z.string(),
  role: z.enum(['admin', 'write', 'read']),
});
export type RepoMemberRecord = z.infer<typeof repoMemberRowSchema>;

export function parseRepoMemberRow(row: unknown): RepoMemberRecord {
  return parseOrThrow(repoMemberRowSchema, 'repo_members', row);
}

export const pathRuleRowSchema = z.object({
  id: z.number(),
  repo_id: z.string(),
  path_prefix: z.string(),
  effect: z.enum(['grant', 'deny']),
  principal: z.string(),
  perms: jsonOf(z.array(z.enum(['read', 'write', 'history']))),
});
export type PathRuleRecord = z.infer<typeof pathRuleRowSchema>;

export function parsePathRuleRow(row: unknown): PathRuleRecord {
  return parseOrThrow(pathRuleRowSchema, 'path_rules', row);
}

// ---------------------------------------------------------------------------
// orgs / teams (issue #26)
// ---------------------------------------------------------------------------

export const orgRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  created_at: z.number(),
  base_role: z.enum(['none', 'read', 'write', 'admin']),
  members_can_create_repos: z.number().transform((n) => n === 1),
});
export type OrgRecord = z.infer<typeof orgRowSchema>;

export function parseOrgRow(row: unknown): OrgRecord {
  return parseOrThrow(orgRowSchema, 'orgs', row);
}

export const orgMemberRowSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  role: z.enum(['owner', 'admin', 'member', 'billing']),
});
export type OrgMemberRecord = z.infer<typeof orgMemberRowSchema>;

export function parseOrgMemberRow(row: unknown): OrgMemberRecord {
  return parseOrThrow(orgMemberRowSchema, 'org_members', row);
}

export const teamRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  parent_team_id: z.string().nullable(),
  created_at: z.number(),
});
export type TeamRecord = z.infer<typeof teamRowSchema>;

export function parseTeamRow(row: unknown): TeamRecord {
  return parseOrThrow(teamRowSchema, 'teams', row);
}

export const teamRepoRowSchema = z.object({
  team_id: z.string(),
  repo_id: z.string(),
  role: z.enum(['admin', 'write', 'read']),
});
export type TeamRepoRecord = z.infer<typeof teamRepoRowSchema>;

export function parseTeamRepoRow(row: unknown): TeamRepoRecord {
  return parseOrThrow(teamRepoRowSchema, 'team_repos', row);
}

// ---------------------------------------------------------------------------
// agent_tasks / import_jobs
// ---------------------------------------------------------------------------

export const agentTaskRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  kind: z.enum(['freeform', 'fix_issue', 'post_merge_check', 'superfan']),
  prompt: z.string(),
  status: z.enum(['queued', 'running', 'landed', 'failed', 'cancelled']),
  base_cs: z.string().nullable().optional(),
  result_cs: z.string().nullable().optional(),
  agent_state: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentTaskRecord = z.infer<typeof agentTaskRowSchema>;

export function parseAgentTaskRow(row: unknown): AgentTaskRecord {
  return parseOrThrow(agentTaskRowSchema, 'agent_tasks', row);
}

export const importJobRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  source: z.string(),
  mode: z.enum(['snapshot', 'full_history']),
  status: z.string(),
  checkpoint: z.string().nullable().optional(),
  commits_total: z.number().nullable().optional(),
  commits_done: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ImportJobRecord = z.infer<typeof importJobRowSchema>;

export function parseImportJobRow(row: unknown): ImportJobRecord {
  return parseOrThrow(importJobRowSchema, 'import_jobs', row);
}
