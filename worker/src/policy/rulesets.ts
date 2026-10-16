import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q, run } from '../db/client';
import type { Principal } from '../auth/principal';
import { roleOf, USER_TEAMS_CTE, type Role } from '../auth/rbac';
import { appendAudit, type AuditActor } from '../audit/record';
import { ApiError } from '../core/errors';
import type { CiPolicy } from '../ci/config';
import type { Change } from '../core/commit';
import { statBlob } from '../core/blobs';
import { MERGE_METHODS, type MergeMethod } from '../../shared/collaboration';

/**
 * Rulesets (issue #41): named rules on branches, tags and pushes, owned by a
 * repo or by an org (then filtered by repository name). Every ref-moving path
 * asks `evaluate` the same question, so the API, Git push, pull request
 * merges and agent lands refuse the same moves with the same names:
 *
 * - `RefLockDO.moveRef` for every direct ref move (API, push, land, import)
 * - `pullGate` / `mergePullLocked` for pull request merges
 * - pre-receive (`git/pre-receive.ts`) for early, named refusals and push rules
 * - the commit RPC and the agent `commit` tool for push rules
 *
 * `evaluate` is pure: callers load rulesets and actor facts first and record
 * the outcome (`recordOutcome`) after the change lands. `evaluate` rulesets
 * never block; their violations go to `ruleset_evaluations`. Bypass actors
 * pass active rules and each bypass is audited (`ruleset.bypass`).
 */

export const TARGETS = ['branch', 'tag', 'push'] as const;
export type Target = (typeof TARGETS)[number];
export type Enforcement = 'active' | 'evaluate' | 'disabled';

const approvalsRule = z.object({
  type: z.literal('pull_request'),
  required_approvals: z.number().int().min(0).max(10),
});
const refRules = [
  z.object({ type: z.literal('deletion') }),
  z.object({ type: z.literal('non_fast_forward') }),
  z.object({ type: z.literal('update') }),
] as const;
const branchRuleSchema = z.discriminatedUnion('type', [
  ...refRules,
  approvalsRule,
  z.object({ type: z.literal('required_status_checks') }),
  // pull request merge methods allowed into the branch (#42)
  z.object({
    type: z.literal('merge_methods'),
    allowed: z.array(z.enum(MERGE_METHODS)).min(1),
  }),
  // every line-level review thread (#39) on the pull request is resolved
  z.object({ type: z.literal('required_review_thread_resolution') }),
  // an owner of each changed file (CODEOWNERS, #40) approved the revision
  z.object({ type: z.literal('require_code_owner_review') }),
]);
const tagRuleSchema = z.discriminatedUnion('type', [...refRules]);
const globSchema = z.string().min(1).max(256);
const pushRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('max_file_size'), max_bytes: z.number().int().min(1) }),
  z.object({
    type: z.literal('file_path_restriction'),
    paths: z.array(globSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal('file_extension_restriction'),
    extensions: z
      .array(z.string().regex(/^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/))
      .min(1)
      .max(100),
  }),
]);
export type Rule = z.infer<typeof branchRuleSchema> | z.infer<typeof pushRuleSchema>;

const patternsSchema = z.object({
  include: z.array(globSchema).max(100).default([]),
  exclude: z.array(globSchema).max(100).default([]),
});
const conditionsSchema = z.object({
  ref_name: patternsSchema.optional(),
  repository_name: patternsSchema.optional(),
});

/**
 * role:admin|write (that role or higher), team:<slug>, agent:<token id or
 * agent identity id>, user:<id>.
 */
const BYPASS_RE =
  /^(role:(admin|write)|team:[a-z0-9-]+|agent:[A-Za-z0-9_-]+|user:[A-Za-z0-9_-]+)$/;

export const rulesetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    target: z.enum(TARGETS),
    enforcement: z.enum(['active', 'evaluate', 'disabled']).default('active'),
    conditions: conditionsSchema.default({}),
    rules: z.array(z.unknown()).min(1).max(20),
    bypass: z
      .array(z.string().regex(BYPASS_RE, 'unknown bypass actor'))
      .max(50)
      .default([]),
  })
  .transform((input, ctx) => {
    const schema =
      input.target === 'branch'
        ? branchRuleSchema
        : input.target === 'tag'
          ? tagRuleSchema
          : pushRuleSchema;
    const rules: Rule[] = [];
    for (const [i, raw] of input.rules.entries()) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i],
          message: `not a ${input.target} rule`,
        });
        return z.NEVER;
      }
      rules.push(parsed.data);
    }
    if (
      input.target !== 'push' &&
      (input.conditions.ref_name?.include.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions', 'ref_name', 'include'],
        message: 'name at least one ref pattern',
      });
      return z.NEVER;
    }
    return { ...input, rules };
  });
export type RulesetInput = z.infer<typeof rulesetInputSchema>;

export interface Ruleset extends RulesetInput {
  id: string;
  scope: 'org' | 'repo';
  owner_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const rowSchema = z.object({
  id: z.string(),
  scope: z.enum(['org', 'repo']),
  owner_id: z.string(),
  name: z.string(),
  target: z.enum(TARGETS),
  enforcement: z.enum(['active', 'evaluate', 'disabled']),
  conditions: z.string(),
  rules: z.string(),
  bypass: z.string(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export function parseRulesetRow(row: unknown): Ruleset {
  const r = rowSchema.parse(row);
  const input = rulesetInputSchema.parse({
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    conditions: JSON.parse(r.conditions) as unknown,
    rules: JSON.parse(r.rules) as unknown,
    bypass: JSON.parse(r.bypass) as unknown,
  });
  return { ...r, ...input };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * fnmatch-style: `*` and `?` stay inside one path segment, `**` crosses them.
 * Matched by stepping the set of reachable positions through the pattern, so
 * time is O(pattern × value) whatever the pattern (no regex backtracking).
 */
export function globMatch(pattern: string, value: string): boolean {
  const n = value.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = new Uint8Array(n + 1);
    if (ch === '*') {
      const any = pattern[i + 1] === '*';
      if (any) i++;
      for (let k = 0; k <= n; k++)
        next[k] =
          at[k] || (k > 0 && next[k - 1] && (any || value[k - 1] !== '/')) ? 1 : 0;
    } else {
      for (let k = 1; k <= n; k++)
        next[k] =
          at[k - 1] && (ch === '?' ? value[k - 1] !== '/' : value[k - 1] === ch) ? 1 : 0;
    }
    at = next;
  }
  return at[n] === 1;
}

function matchesAny(
  patterns: readonly string[],
  value: string,
  special: ReadonlyMap<string, boolean>,
): boolean {
  return patterns.some((p) => special.get(p) ?? globMatch(p, value));
}

const AGENT_REFS = 'refs/agents/';

/** The name a ruleset's ref patterns see, or null when the target does not cover the ref. */
function refKey(target: Target, ref: string): string | null {
  if (target === 'branch')
    return ref.startsWith('refs/') && !ref.startsWith(AGENT_REFS) ? null : ref;
  if (target === 'tag') return ref.startsWith('refs/tags/') ? ref.slice(10) : null;
  return null;
}

const ALL: ReadonlyMap<string, boolean> = new Map([['~ALL', true]]);

/** An org ruleset's repository_name condition (repo rulesets cover their repo). */
export function appliesToRepo(ruleset: Ruleset, slug: string): boolean {
  const repos = ruleset.conditions.repository_name;
  if (ruleset.scope !== 'org' || !repos) return true;
  const name = slug.split('/')[1] ?? slug;
  const include = repos.include.length ? repos.include : ['~ALL'];
  return matchesAny(include, name, ALL) && !matchesAny(repos.exclude, name, ALL);
}

/** Does `ruleset` cover this repo (and ref, for branch and tag rulesets)? */
export function applies(
  ruleset: Ruleset,
  repo: Pick<RepoRecord, 'slug' | 'default_branch'>,
  ref?: string,
): boolean {
  if (ruleset.enforcement === 'disabled' || !appliesToRepo(ruleset, repo.slug))
    return false;
  if (ruleset.target === 'push') return ref === undefined;
  if (ref === undefined) return false;
  const key = refKey(ruleset.target, ref);
  if (key === null) return false;
  const strip = (p: string): string =>
    p.replace(ruleset.target === 'branch' ? /^refs\/heads\// : /^refs\/tags\//, '');
  const special = new Map([
    ['~ALL', true],
    ['~DEFAULT_BRANCH', ruleset.target === 'branch' && key === repo.default_branch],
  ]);
  // Agent refs (#57) match by full name, only patterns that spell `refs/agents/`.
  const own = (p: string): boolean =>
    !key.startsWith(AGENT_REFS) || p.startsWith(AGENT_REFS);
  const names = ruleset.conditions.ref_name;
  return (
    matchesAny((names?.include ?? []).map(strip).filter(own), key, special) &&
    !matchesAny((names?.exclude ?? []).map(strip).filter(own), key, special)
  );
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

/** A `Principal` as it crosses into a Durable Object. */
export const principalSchema = z.union([
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({
    kind: z.literal('token'),
    userId: z.string(),
    tokenId: z.string(),
    scopes: z.array(z.string()),
    repoId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('agent'),
    userId: z.string(),
    agentId: z.string(),
    jti: z.string(),
    taskId: z.string().nullable(),
    scopes: z.array(z.string()),
    repoIds: z.array(z.string()),
  }),
]);

export interface Actor {
  principal: Principal | null;
  role: Role | null;
  /** Team slugs in the repo's org, parent teams included. */
  teams: readonly string[];
}

export interface RefFacts {
  /** Forge ref name (`main`, `refs/tags/v1`). */
  name: string;
  kind: 'create' | 'update' | 'delete';
  /** For updates: the new head descends from the old one. */
  fastForward: boolean;
  /** Present for pull request merges. */
  merge?: {
    approvals: number;
    checksPassed: boolean;
    method: MergeMethod;
    unresolvedThreads: number;
    /**
     * Changed files no code owner approved (#40), and whether the diff was
     * too large to list them all. Absent when no ruleset asks for owners.
     */
    codeOwners?: { unapproved: readonly string[]; truncated: boolean };
  };
}

export interface FileFacts {
  path: string;
  op: 'add' | 'mod' | 'del';
  /** Bytes, when known (new content). */
  size?: number;
}

export interface EvalInput {
  repo: Pick<RepoRecord, 'slug' | 'default_branch'>;
  actor: Actor;
  /** A ref move (branch and tag rulesets) or ... */
  ref?: RefFacts;
  /** ... the files new commits change (push rulesets). */
  files?: readonly FileFacts[];
}

export interface Violation {
  ruleset_id: string;
  ruleset: string;
  enforcement: 'active' | 'evaluate';
  rule: Rule['type'];
  message: string;
}

export interface Outcome {
  allowed: boolean;
  /** Active, not bypassed: the move is refused. */
  blocking: Violation[];
  /** Active, but the actor is on the ruleset's bypass list. */
  bypassed: Violation[];
  /** From `evaluate` rulesets: logged, never enforced. */
  evaluated: Violation[];
  /** Highest `pull_request` approval count among active rulesets, or null. */
  requiredApprovals: number | null;
  /** An active `required_status_checks` rule binds this actor. */
  requireChecks: boolean;
  /** An active `required_review_thread_resolution` rule binds this actor. */
  requireResolvedThreads: boolean;
}

const ROLE_RANK: Record<Role, number> = { read: 1, triage: 2, write: 3, admin: 4 };

export function canBypass(ruleset: Ruleset, actor: Actor): boolean {
  const p = actor.principal;
  if (p === null) return false;
  // An agent identity (#57) bypasses only when named, and only when the human
  // it acts for may bypass too: any delegating human can use the agent.
  if (p.kind === 'agent')
    return (
      ruleset.bypass.includes(`agent:${p.agentId}`) &&
      canBypass(ruleset, { ...actor, principal: { kind: 'user', userId: p.userId } })
    );
  return ruleset.bypass.some((entry) => {
    const [kind, id] = entry.split(':') as [string, string];
    if (kind === 'role')
      return actor.role !== null && ROLE_RANK[actor.role] >= ROLE_RANK[id as Role];
    if (kind === 'team') return actor.teams.includes(id);
    if (kind === 'agent') return p.kind === 'token' && p.tokenId === id;
    return p.userId === id;
  });
}

function refMessage(rule: Rule, ref: RefFacts): string | null {
  const name = ref.name.startsWith('refs/tags/') ? `tag ${ref.name.slice(10)}` : ref.name;
  switch (rule.type) {
    case 'deletion':
      return ref.kind === 'delete' ? `${name} cannot be deleted` : null;
    case 'non_fast_forward':
      return ref.kind === 'update' && !ref.fastForward
        ? `force pushes to ${name} are not allowed`
        : null;
    case 'update':
      return ref.kind === 'update' && !ref.merge
        ? `open a pull request to update ${name}`
        : null;
    case 'pull_request': {
      const n = rule.required_approvals;
      return ref.merge && ref.merge.approvals < n
        ? `${n} approval${n === 1 ? '' : 's'} required for this revision.`
        : null;
    }
    case 'required_status_checks':
      return ref.merge && !ref.merge.checksPassed
        ? 'The latest CI run must pass for this revision and current pipeline.'
        : null;
    case 'merge_methods':
      return ref.merge && !rule.allowed.includes(ref.merge.method)
        ? `${ref.merge.method} merges are not allowed into ${name}; use ${rule.allowed.join(' or ')}.`
        : null;
    case 'required_review_thread_resolution': {
      const n = ref.merge?.unresolvedThreads ?? 0;
      return n > 0
        ? `Resolve ${n} review thread${n === 1 ? '' : 's'} before merging.`
        : null;
    }
    case 'require_code_owner_review': {
      if (!ref.merge) return null;
      const owners = ref.merge.codeOwners;
      if (!owners || owners.truncated)
        return 'Code owner review could not be checked for this revision.';
      const files = owners.unapproved;
      if (files.length === 0) return null;
      const shown = files.slice(0, 3).join(', ');
      const more = files.length > 3 ? ` and ${files.length - 3} more` : '';
      return `Code owner approval required for ${shown}${more}.`;
    }
    default:
      return null;
  }
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.indexOf('.', 1);
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

function fileMessage(rule: Rule, files: readonly FileFacts[]): string | null {
  for (const f of files) {
    if (rule.type === 'max_file_size' && f.op !== 'del' && (f.size ?? 0) > rule.max_bytes)
      return `${f.path} is ${f.size} bytes; the limit is ${rule.max_bytes}`;
    if (
      rule.type === 'file_path_restriction' &&
      rule.paths.some((p) => globMatch(p, f.path))
    )
      return `${f.path} is a restricted path`;
    if (rule.type === 'file_extension_restriction' && f.op !== 'del') {
      const ext = extensionOf(f.path);
      const banned = rule.extensions.map((e) => `.${e.replace(/^\./, '').toLowerCase()}`);
      // `.tar.gz` bans `x.tar.gz`; `.gz` bans it too
      if (ext !== '' && banned.some((b) => ext === b || ext.endsWith(b)))
        return `${f.path} has a restricted file extension`;
    }
  }
  return null;
}

/** Deterministic and side-effect free: the same rulesets and facts give the same outcome. */
export function evaluate(rulesets: readonly Ruleset[], input: EvalInput): Outcome {
  const out: Outcome = {
    allowed: true,
    blocking: [],
    bypassed: [],
    evaluated: [],
    requiredApprovals: null,
    requireChecks: false,
    requireResolvedThreads: false,
  };
  for (const ruleset of rulesets) {
    if (!applies(ruleset, input.repo, input.ref?.name)) continue;
    const enforcement = ruleset.enforcement as 'active' | 'evaluate';
    const bypass = enforcement === 'active' && canBypass(ruleset, input.actor);
    for (const rule of ruleset.rules) {
      if (enforcement === 'active' && rule.type === 'pull_request')
        out.requiredApprovals = Math.max(
          out.requiredApprovals ?? 0,
          rule.required_approvals,
        );
      if (enforcement === 'active' && rule.type === 'required_status_checks' && !bypass)
        out.requireChecks = true;
      if (
        enforcement === 'active' &&
        rule.type === 'required_review_thread_resolution' &&
        !bypass
      )
        out.requireResolvedThreads = true;
      const message = input.ref
        ? refMessage(rule, input.ref)
        : fileMessage(rule, input.files ?? []);
      if (message === null) continue;
      const v: Violation = {
        ruleset_id: ruleset.id,
        ruleset: ruleset.name,
        enforcement,
        rule: rule.type,
        message,
      };
      if (enforcement === 'evaluate') out.evaluated.push(v);
      else if (bypass) out.bypassed.push(v);
      else out.blocking.push(v);
    }
  }
  out.allowed = out.blocking.length === 0;
  return out;
}

/** `ruleset "<name>": <message>` — the form `git push` and API errors show. */
export function describeViolation(v: Violation): string {
  return `ruleset "${v.ruleset}": ${v.message}`;
}

export function violationError(blocking: readonly Violation[]): ApiError {
  const first = blocking[0] as Violation;
  return new ApiError(403, 'ruleset_violation', describeViolation(first), {
    ruleset: first.ruleset,
    rule: first.rule,
    violations: blocking.map((v) => ({
      ruleset: v.ruleset,
      rule: v.rule,
      message: v.message,
    })),
  });
}

// ---------------------------------------------------------------------------
// Loading and recording
// ---------------------------------------------------------------------------

/** Every non-disabled ruleset the repo or its org owns (conditions not yet applied). */
export async function rulesetsFor(env: Env, repo: RepoRecord): Promise<Ruleset[]> {
  const rows = await q(
    env,
    `SELECT * FROM rulesets WHERE enforcement != 'disabled'
       AND ((scope = 'repo' AND owner_id = ?) OR (scope = 'org' AND owner_id = ?))
     ORDER BY scope DESC, name`,
    [repo.id, repo.owner_kind === 'org' ? (repo.owner_id ?? '') : ''],
  );
  return rows.map(parseRulesetRow);
}

/**
 * Bypass facts for `principal`: the effective repo role (the creator is
 * admin, as in rbac.ts) and team slugs in the repo's org. Skips D1 when no
 * ruleset names a bypass actor.
 */
export async function actorFor(
  env: Env,
  repo: RepoRecord & { created_by?: string | null },
  principal: Principal | null,
  rulesets: readonly Ruleset[],
): Promise<Actor> {
  const actor: Actor = { principal, role: null, teams: [] };
  if (principal === null || rulesets.every((r) => r.bypass.length === 0)) return actor;
  actor.role =
    (await roleOf(env, repo.id, principal)) ??
    (repo.created_by != null && repo.created_by === principal.userId ? 'admin' : null);
  if (
    repo.owner_kind === 'org' &&
    rulesets.some((r) => r.bypass.some((b) => b.startsWith('team:')))
  ) {
    const rows = await q<{ slug: string }>(
      env,
      `WITH RECURSIVE ${USER_TEAMS_CTE}
       SELECT t.slug FROM teams t WHERE t.org_id = ? AND t.id IN (SELECT team_id FROM user_teams)`,
      [principal.userId, repo.owner_id],
    );
    actor.teams = rows.map((r) => r.slug);
  }
  return actor;
}

export interface OutcomeContext {
  repo: RepoRecord;
  actor: AuditActor;
  ref: string | null;
  via: string;
  /** The reason a bypass actor gave (merges). */
  reason?: string | null;
}

/** Log evaluate-mode violations and audit bypasses, after the change landed. */
export async function recordOutcome(
  env: Env,
  outcome: Outcome,
  at: OutcomeContext,
): Promise<void> {
  const byRuleset = new Map<string, Violation[]>();
  for (const v of outcome.evaluated) {
    byRuleset.set(v.ruleset_id, [...(byRuleset.get(v.ruleset_id) ?? []), v]);
  }
  for (const [rulesetId, list] of byRuleset) {
    await run(
      env,
      `INSERT INTO ruleset_evaluations (ruleset_id, repo_id, ref, via, actor_kind, actor_id, violations, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rulesetId,
        at.repo.id,
        at.ref,
        at.via,
        at.actor.kind,
        at.actor.id,
        JSON.stringify(list.map((v) => ({ rule: v.rule, message: v.message }))),
        Date.now(),
      ],
    );
  }
  if (outcome.bypassed.length > 0) {
    await appendAudit(env, {
      action: 'ruleset.bypass',
      repo: at.repo,
      actor: at.actor,
      target: {
        ref: at.ref,
        via: at.via,
        reason: at.reason ?? null,
        violations: outcome.bypassed.map((v) => ({
          ruleset_id: v.ruleset_id,
          ruleset: v.ruleset,
          rule: v.rule,
        })),
      },
    });
  }
}

/** Bytes of a commit request change: inline content decoded, uploads from R2 metadata. */
async function changeSize(
  env: Env,
  repoId: string,
  change: Change,
): Promise<number | undefined> {
  if (change.op === 'del') return undefined;
  if ('content_b64' in change) {
    try {
      return atob(change.content_b64).length;
    } catch {
      return undefined; // commitChanges refuses it as invalid base64
    }
  }
  return (await statBlob(env, repoId, change.blob_sha256)) ?? undefined;
}

/**
 * Push rules for new file content outside `git push` (the commit RPC and the
 * agent `commit` tool). Throws `ruleset_violation`; records evaluate-mode
 * hits and bypasses.
 */
export async function enforcePushRules(
  env: Env,
  repo: RepoRecord,
  principal: Principal | null,
  actor: AuditActor,
  changes: readonly Change[],
  via: string,
): Promise<void> {
  const rulesets = (await rulesetsFor(env, repo)).filter((r) => r.target === 'push');
  if (rulesets.length === 0) return;
  const sized = rulesets.some((r) =>
    r.rules.some((rule) => rule.type === 'max_file_size'),
  );
  const files: FileFacts[] = [];
  for (const change of changes) {
    files.push({
      path: change.path,
      op: change.op,
      size: sized ? await changeSize(env, repo.id, change) : undefined,
    });
  }
  const outcome = evaluate(rulesets, {
    repo,
    actor: await actorFor(env, repo, principal, rulesets),
    files,
  });
  if (!outcome.allowed) throw violationError(outcome.blocking);
  await recordOutcome(env, outcome, { repo, actor, ref: null, via });
}

// ---------------------------------------------------------------------------
// CI policy fields (kept readable for one release)
// ---------------------------------------------------------------------------

/** Name of the repo ruleset that `PUT /ci` writes (see migration 0016). */
export const CI_POLICY_RULESET = 'CI policy (default branch)';

/**
 * The ruleset statement for a CI policy's protection fields: protect_default
 * → `update`, required_approvals → `pull_request`, require_checks →
 * `required_status_checks`. Same mapping as migration 0016.
 */
export function ciPolicyRulesetStatement(
  env: Env,
  repoId: string,
  policy: Pick<CiPolicy, 'protect_default' | 'required_approvals' | 'require_checks'>,
  now: number,
): D1PreparedStatement {
  const rules: Rule[] = [
    ...(policy.protect_default ? [{ type: 'update' as const }] : []),
    { type: 'pull_request', required_approvals: policy.required_approvals },
    ...(policy.require_checks ? [{ type: 'required_status_checks' as const }] : []),
  ];
  return env.DB.prepare(
    `INSERT INTO rulesets (id, scope, owner_id, name, target, enforcement, conditions, rules, bypass, created_by, created_at, updated_at)
     VALUES (?, 'repo', ?, ?, 'branch', 'active', ?, ?, '[]', 'ci_policy', ?, ?)
     ON CONFLICT(scope, owner_id, name) DO UPDATE SET target = excluded.target,
       conditions = excluded.conditions, rules = excluded.rules, updated_at = excluded.updated_at`,
  ).bind(
    crypto.randomUUID().replace(/-/g, ''),
    repoId,
    CI_POLICY_RULESET,
    JSON.stringify({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }),
    JSON.stringify(rules),
    now,
    now,
  );
}
