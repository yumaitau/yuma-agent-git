import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parsePathRuleRow, q } from '../db/client';
import type { PathRuleRecord, RepoRecord } from '../db/client';
import { boundRepos, hasScope, type Principal } from './principal';
import { ssoRequirement, type SsoRequirement } from './sso';

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
 *   3. effective repo role (issue #26) = max of direct membership, team
 *      grants (parent teams included) and the org base role; org owners are
 *      admin on every org repo. admin → everything, write → read/write/history/
 *      triage, triage → read/history/triage, read → read/history. Resolved
 *      from D1 on every call, never cached, so a membership change applies on
 *      the next request.
 *   4. repo creator → admin
 *   5. default deny
 *
 * Org SSO (sso.ts) then gates the result: a member of an org enforcing SSO
 * who has not signed in through its IdP keeps only what an anonymous caller
 * gets, and the denial names the requirement.
 */

/** `triage` (issue #38): label, assign, close and lock issues; never code. */
export type Perm = 'read' | 'write' | 'history' | 'triage' | 'admin';
export type Role = 'admin' | 'write' | 'triage' | 'read';

export type RepoWithCreator = RepoRecord & { created_by?: string | null };

export const pathRuleInputSchema = z.object({
  path_prefix: z.string().min(1).max(512),
  effect: z.enum(['grant', 'deny']),
  principal: z.string().min(1),
  perms: z.array(z.enum(['read', 'write', 'history'])).min(1),
});

const PRINCIPAL_RE =
  /^(\*|role:(admin|write|triage|read)|user:[A-Za-z0-9_-]+|agent:[A-Za-z0-9_-]+)$/;

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
      // API tokens match by id with or without `agent:run`, as before #57
      return principal.kind === 'agent'
        ? principal.agentId === id
        : principal.kind === 'token' && principal.tokenId === id;
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

const ROLE_RANK: Record<Role, number> = { read: 1, triage: 2, write: 3, admin: 4 };

/**
 * `user_teams(team_id, depth)`: the teams a user is in plus their ancestors
 * (nested teams inherit the parent's grants), capped at depth 5 so the walk
 * stays bounded. Binds one parameter, the user id. Use after `WITH RECURSIVE`.
 */
export const USER_TEAMS_CTE = `user_teams(team_id, depth) AS (
  SELECT ${C.teamMembers.teamId}, 0 FROM ${T.teamMembers} WHERE ${C.teamMembers.userId} = ?
  UNION
  SELECT t.${C.teams.parentTeamId}, ut.depth + 1 FROM user_teams ut
    JOIN ${T.teams} t ON t.${C.teams.id} = ut.team_id
   WHERE t.${C.teams.parentTeamId} IS NOT NULL AND ut.depth < 5
)`;

const roleRowSchema = z.object({
  role: z.enum(['admin', 'write', 'triage', 'read', 'none']),
});

export async function roleOf(
  env: Env,
  repoId: string,
  principal: Principal | null,
): Promise<Role | null> {
  if (principal === null) return null;
  const userId = principal.userId;
  // One statement: direct role, team roles, org role (owner → admin,
  // billing → none, admin/member → the org base role).
  const rows = await q(
    env,
    `WITH RECURSIVE ${USER_TEAMS_CTE}
     SELECT ${C.repoMembers.role} AS role FROM ${T.repoMembers}
      WHERE ${C.repoMembers.repoId} = ? AND ${C.repoMembers.userId} = ?
     UNION ALL
     SELECT tr.${C.teamRepos.role} FROM ${T.teamRepos} tr
      WHERE tr.${C.teamRepos.repoId} = ?
        AND tr.${C.teamRepos.teamId} IN (SELECT team_id FROM user_teams)
     UNION ALL
     SELECT CASE om.${C.orgMembers.role} WHEN 'owner' THEN 'admin' WHEN 'billing' THEN 'none'
            ELSE o.${C.orgs.baseRole} END
       FROM ${T.repos} r
       JOIN ${T.orgs} o ON o.${C.orgs.id} = r.${C.repos.ownerId}
       JOIN ${T.orgMembers} om ON om.${C.orgMembers.orgId} = o.${C.orgs.id}
        AND om.${C.orgMembers.userId} = ?
      WHERE r.${C.repos.id} = ? AND r.${C.repos.ownerKind} = 'org'`,
    [userId, repoId, userId, repoId, userId, repoId],
  );
  let best: Role | null = null;
  for (const row of rows) {
    const { role } = roleRowSchema.parse(row);
    if (role !== 'none' && (best === null || ROLE_RANK[role] > ROLE_RANK[best])) {
      best = role;
    }
  }
  return best;
}

export interface Decision {
  allowed: boolean;
  /** The path rule that denied — surfaced in 403 bodies as `denied_by`. */
  deniedBy?: { id: number; path_prefix: string; effect: string; principal: string };
  /** Access the roles grant but org SSO withholds — surfaced as `sso_required`. */
  ssoRequired?: SsoRequirement;
}

/** Everything a decision reads from D1, loaded once per (repo, principal). */
interface DecisionContext {
  repo: RepoWithCreator;
  principal: Principal | null;
  rules: PathRuleRecord[];
  role: Role | null;
  sso: SsoRequirement | null;
}

async function loadContext(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal | null,
  withRules: boolean,
): Promise<DecisionContext> {
  const [rules, role, sso] = await Promise.all([
    withRules ? listPathRules(env, repo.id) : Promise.resolve([]),
    roleOf(env, repo.id, principal),
    ssoRequirement(env, repo, principal),
  ]);
  return { repo, principal, rules, role, sso };
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
  let decision = evaluateAccess(ctx, perm, path);
  // Any delegating human can use an agent, so `agent:` grants never take it
  // past what that human gets (#57).
  const p = ctx.principal;
  if (decision.allowed && p?.kind === 'agent') {
    decision = evaluateAccess(
      { ...ctx, principal: { kind: 'user', userId: p.userId } },
      perm,
      path,
    );
  }
  if (!decision.allowed || ctx.sso === null) return decision;
  return evaluateAccess({ ...ctx, principal: null }, perm, path).allowed
    ? decision
    : { allowed: false, ssoRequired: ctx.sso };
}

function evaluateAccess(ctx: DecisionContext, perm: Perm, path?: string): Decision {
  const { repo, principal, rules } = ctx;
  // Token limits constrain every role and path grant, including repo creators.
  // An agent token also gets the human's role below: the intersection (#57).
  if (principal !== null && principal.kind !== 'user') {
    // A CI clone token reads, whole, the one repo its run was admitted for
    // (issue #48); scheduled runs have no human role to fall back on.
    if (principal.kind === 'token' && principal.ciRunId)
      return {
        allowed: principal.repoId === repo.id && (perm === 'read' || perm === 'history'),
      };
    const repos = boundRepos(principal);
    if (repos !== null && !repos.includes(repo.id)) return { allowed: false };
    if (principal.kind === 'agent' && perm === 'admin') return { allowed: false };
    const writes = hasScope(principal, 'repo:write');
    if (perm === 'write' || perm === 'triage' || perm === 'admin') {
      if (!writes) return { allowed: false };
    } else if (!writes && !hasScope(principal, 'repo:read')) {
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

  // 3. effective repo role
  if (ctx.role === 'admin') return { allowed: true };
  if (ctx.role === 'write') return { allowed: perm !== 'admin' };
  if (ctx.role === 'triage')
    return { allowed: perm === 'read' || perm === 'history' || perm === 'triage' };
  if (ctx.role === 'read') return { allowed: perm === 'read' || perm === 'history' };

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
