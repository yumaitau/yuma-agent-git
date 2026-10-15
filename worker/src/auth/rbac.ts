import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parsePathRuleRow, parseRepoMemberRow, q, q1 } from '../db/client';
import type { PathRuleRecord, RepoRecord } from '../db/client';
import type { Principal } from './principal';

/**
 * RBAC (issue #14, architecture §3) — repo roles **plus** directory-level
 * permissions, the monorepo-security twist: sensitive paths can live in a
 * shared repo (deny `history` on `secrets/` while granting `read` elsewhere).
 *
 * Resolution order — first deciding match wins:
 *   1. anonymous: `read` on **public** repos only, and only when no deny rule
 *      covers the path
 *   2. path rules matching the path (longest prefix first; principal-specific
 *      before role-based before `*`; deny beats grant at equal specificity) —
 *      a matching rule decides the perms it lists; other perms fall through
 *   3. repo membership roles: admin → everything, write → read/write/history,
 *      read → read/history
 *   4. repo creator → admin
 *   5. default deny
 */

export type Perm = 'read' | 'write' | 'history' | 'admin';
export type Role = 'admin' | 'write' | 'read';

export type RepoWithCreator = RepoRecord & { created_by?: string | null };

const pathRuleInputSchema = z.object({
  path_prefix: z.string().min(1).max(512),
  effect: z.enum(['grant', 'deny']),
  principal: z.string().min(1),
  perms: z.array(z.enum(['read', 'write', 'history'])).min(1),
});

const PRINCIPAL_RE =
  /^(\*|role:(admin|write|read)|user:[A-Za-z0-9_-]+|agent:[A-Za-z0-9_-]+)$/;

/** Normalize a rule prefix: NFC, no traversal, always slash-terminated. */
export function normalizePathPrefix(raw: string): string {
  let prefix = raw.normalize('NFC');
  if (prefix.includes('..') || prefix.startsWith('/')) {
    throw new Error(`invalid path prefix: ${raw}`);
  }
  if (!prefix.endsWith('/')) prefix = `${prefix}/`;
  return prefix;
}

export async function listPathRules(env: Env, repoId: string): Promise<PathRuleRecord[]> {
  const rows = await q(
    env,
    `SELECT * FROM ${T.pathRules} WHERE ${C.pathRules.repoId} = ?`,
    [repoId],
  );
  return rows.map(parsePathRuleRow);
}

export function parsePathRuleInput(input: unknown): {
  path_prefix: string;
  effect: 'grant' | 'deny';
  principal: string;
  perms: ('read' | 'write' | 'history')[];
} {
  const parsed = pathRuleInputSchema.parse(input);
  if (!PRINCIPAL_RE.test(parsed.principal)) {
    throw new Error(`invalid principal: ${parsed.principal}`);
  }
  return { ...parsed, path_prefix: normalizePathPrefix(parsed.path_prefix) };
}

function ruleMatchesPrincipal(
  rulePrincipal: string,
  principal: Principal,
  role: Role | null,
): boolean {
  if (rulePrincipal === '*') return true;
  const [kind, id] = rulePrincipal.split(':') as [string, string | undefined];
  switch (kind) {
    case 'user':
      return principal.userId === id;
    case 'agent':
      return principal.kind === 'token' && principal.tokenId === id;
    case 'role':
      return role === id;
    default:
      return false;
  }
}

function principalSpecificity(rulePrincipal: string): number {
  if (rulePrincipal === '*') return 1;
  const kind = rulePrincipal.split(':')[0];
  return kind === 'role' ? 2 : 3; // user:/agent: most specific
}

function coversPath(prefix: string, path: string): boolean {
  return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

export async function roleOf(
  env: Env,
  repoId: string,
  principal: Principal | null,
): Promise<Role | null> {
  if (principal === null) return null;
  const row = await q1(
    env,
    `SELECT * FROM ${T.repoMembers} WHERE ${C.repoMembers.repoId} = ? AND ${C.repoMembers.userId} = ?`,
    [repoId, principal.userId],
  );
  return row ? parseRepoMemberRow(row).role : null;
}

export interface Decision {
  allowed: boolean;
  /** The path rule that denied — surfaced in 403 bodies as `denied_by`. */
  deniedBy?: { id: number; path_prefix: string; effect: string; principal: string };
}

/** Everything a decision reads from D1, loaded once per (repo, principal). */
interface DecisionContext {
  repo: RepoWithCreator;
  principal: Principal | null;
  rules: PathRuleRecord[];
  role: Role | null;
}

async function loadContext(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal | null,
  withRules: boolean,
): Promise<DecisionContext> {
  const [rules, role] = await Promise.all([
    withRules ? listPathRules(env, repo.id) : Promise.resolve([]),
    roleOf(env, repo.id, principal),
  ]);
  return { repo, principal, rules, role };
}

/**
 * The authorization decision with provenance. `path` engages path rules;
 * omitting it checks repo-level access only.
 */
export async function decide(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal | null,
  perm: Perm,
  path?: string,
): Promise<Decision> {
  return evaluate(
    await loadContext(env, repo, principal, path !== undefined),
    perm,
    path,
  );
}

/** Batched `decide`: rules and membership load once, then any number of paths. */
export interface PathDecider {
  readonly rules: readonly PathRuleRecord[];
  decide(perm: Perm, path?: string): Decision;
}

export async function pathDecider(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal | null,
): Promise<PathDecider> {
  const ctx = await loadContext(env, repo, principal, true);
  return { rules: ctx.rules, decide: (perm, path) => evaluate(ctx, perm, path) };
}

/**
 * The first path rule that restricts `perm` for this principal anywhere in
 * the repo (checked at every rule prefix), or null when access is whole.
 */
export function restrictingDecision(
  d: PathDecider,
  perms: readonly Perm[],
): Decision | null {
  for (const rule of d.rules) {
    for (const perm of perms) {
      const decision = d.decide(perm, rule.path_prefix);
      if (!decision.allowed) return decision;
    }
  }
  return null;
}

function evaluate(ctx: DecisionContext, perm: Perm, path?: string): Decision {
  const { repo, principal, rules } = ctx;
  // Token limits constrain every role and path grant, including repo creators.
  if (principal?.kind === 'token') {
    if (principal.repoId !== null && principal.repoId !== repo.id)
      return { allowed: false };
    const writes = principal.scopes.includes('repo:write');
    if (perm === 'write' || perm === 'admin') {
      if (!writes) return { allowed: false };
    } else if (!writes && !principal.scopes.includes('repo:read')) {
      return { allowed: false };
    }
  }

  // 1. anonymous: public read only, never past a deny rule
  if (principal === null) {
    if (perm !== 'read') return { allowed: false };
    if (repo.visibility !== 'public') return { allowed: false };
    const blocking =
      path === undefined
        ? undefined
        : rules.find((r) => r.effect === 'deny' && coversPath(r.path_prefix, path));
    return blocking
      ? { allowed: false, deniedBy: describe(blocking) }
      : { allowed: true };
  }

  // 2. path rules — longest prefix first, principal-specific first, deny ties
  if (path !== undefined) {
    const matching = rules
      .filter((r) => coversPath(r.path_prefix, path))
      .sort((a, b) => {
        const len = b.path_prefix.length - a.path_prefix.length;
        if (len !== 0) return len;
        const spec =
          principalSpecificity(b.principal) - principalSpecificity(a.principal);
        if (spec !== 0) return spec;
        return a.effect === 'deny' ? -1 : 1;
      });
    for (const rule of matching) {
      if (!(rule.perms as string[]).includes(perm)) continue; // rules decide only their listed perms
      if (!ruleMatchesPrincipal(rule.principal, principal, ctx.role)) continue;
      return rule.effect === 'grant'
        ? { allowed: true }
        : { allowed: false, deniedBy: describe(rule) };
    }
  }

  // 3. membership roles
  const memberRole = ctx.role;
  if (memberRole === 'admin') return { allowed: true };
  if (memberRole === 'write') return { allowed: perm !== 'admin' };
  if (memberRole === 'read') return { allowed: perm === 'read' || perm === 'history' };

  // 4. repo creator is admin
  if (repo.created_by != null && principal.userId === repo.created_by) {
    return { allowed: true };
  }

  // 5. public repos are readable by every principal. Path-rule denies already
  // returned above, so a logged-in non-member can browse a public repo the
  // same way an anonymous client can. Write and admin stay membership-only.
  if (repo.visibility === 'public' && (perm === 'read' || perm === 'history')) {
    return { allowed: true };
  }

  // 6. default deny
  return { allowed: false };
}

function describe(rule: PathRuleRecord): Decision['deniedBy'] {
  return {
    id: rule.id,
    path_prefix: rule.path_prefix,
    effect: rule.effect,
    principal: rule.principal,
  };
}

/** Boolean shorthand for `decide`. */
export async function can(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal | null,
  perm: Perm,
  path?: string,
): Promise<boolean> {
  return (await decide(env, repo, principal, perm, path)).allowed;
}
