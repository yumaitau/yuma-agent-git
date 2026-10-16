import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { can } from '../auth/rbac';
import { C, T } from '../db/schema';
import {
  parseOrgMemberRow,
  parseOrgRow,
  parseRepoRow,
  parseTeamRepoRow,
  parseTeamRow,
  parseUserRow,
  q,
  q1,
  run,
  tx,
  type OrgMemberRecord,
  type OrgRecord,
  type TeamRecord,
} from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { ulid } from '../core/ids';
import { ApiError } from '../core/errors';
import { errorResponse, readJsonBody } from './errors';
import { recordAudit } from '../audit/record';

/**
 * Organisations, teams and org-level roles (issue #26). Session-only, like
 * repo administration. Org owners and admins manage members, teams and team
 * grants; only owners change owners or org settings. Non-members get 404 so
 * org membership is never leaked.
 *
 *   POST   /api/v1/orgs                              create (caller becomes owner)
 *   GET    /api/v1/orgs                              orgs the caller belongs to
 *   GET    /api/v1/orgs/:org                         read
 *   PATCH  /api/v1/orgs/:org                         settings (owners)
 *   GET    /api/v1/orgs/:org/members                 list members
 *   PUT    /api/v1/orgs/:org/members                 add or change a member
 *   DELETE /api/v1/orgs/:org/members/:userId         remove (also from teams)
 *   GET    /api/v1/orgs/:org/teams                   list teams
 *   POST   /api/v1/orgs/:org/teams                   create (optional parent)
 *   GET    /api/v1/orgs/:org/teams/:team             team, members, repo grants
 *   PUT    /api/v1/orgs/:org/teams/:team/members     add a member
 *   DELETE /api/v1/orgs/:org/teams/:team/members/:userId
 *   PUT    /api/v1/orgs/:org/teams/:team/repos       grant a repo role
 *   DELETE /api/v1/orgs/:org/teams/:team/repos/:repo
 *   GET    /api/v1/orgs/:org/repos                   org repos the caller can read
 */
export const orgsRoutes = new Hono<AppEnv>();

for (const path of ['/orgs', '/orgs/*']) {
  orgsRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'private, no-store');
  });
}

/** GitHub login rules: lowercase, 1 to 39 chars, single inner hyphens (#72). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const slugSchema = z
  .string()
  .regex(SLUG_RE, 'slug must be a lowercase GitHub-style login');

/** Deepest allowed team (0 = top level); matches the depth cap in rbac.ts. */
const MAX_TEAM_DEPTH = 5;

const baseRoleSchema = z.enum(['none', 'read', 'write', 'admin']);
const orgRoleSchema = z.enum(['owner', 'admin', 'member', 'billing']);
const repoRoleSchema = z.enum(['admin', 'write', 'read']);

const createOrgSchema = z.object({
  slug: slugSchema,
  display_name: z.string().min(1).max(100).optional(),
  base_role: baseRoleSchema.optional(),
  members_can_create_repos: z.boolean().optional(),
});
const patchOrgSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  base_role: baseRoleSchema.optional(),
  members_can_create_repos: z.boolean().optional(),
});
const userRefSchema = z.object({
  user_id: z.string().min(1).optional(),
  user_login: z.string().min(1).optional(),
});
const putMemberSchema = userRefSchema.extend({ role: orgRoleSchema });
const createTeamSchema = z.object({ slug: slugSchema, parent: slugSchema.optional() });
const grantSchema = z.object({ repo: z.string().min(3), role: repoRoleSchema });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

function sessionUserId(c: Context<AppEnv>): string {
  const user = c.get('user');
  if (!user) throw new ApiError(401, 'unauthorized', 'session required');
  return user.id;
}

/** Caller's membership row in an org, or null. */
export async function orgMembership(
  env: AppEnv['Bindings'],
  orgId: string,
  userId: string,
): Promise<OrgMemberRecord | null> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.orgMembers} WHERE ${C.orgMembers.orgId} = ? AND ${C.orgMembers.userId} = ?`,
    [orgId, userId],
  );
  return row ? parseOrgMemberRow(row) : null;
}

export async function getOrgBySlug(
  env: AppEnv['Bindings'],
  slug: string,
): Promise<OrgRecord | null> {
  const row = await q1(env, `SELECT * FROM ${T.orgs} WHERE ${C.orgs.slug} = ?`, [slug]);
  return row ? parseOrgRow(row) : null;
}

type Need = 'member' | 'manage' | 'owner';

/** Load the org named in the path and check the caller's org role. */
export async function loadOrg(
  c: Context<AppEnv>,
  need: Need,
): Promise<{ org: OrgRecord; me: OrgMemberRecord }> {
  const userId = sessionUserId(c);
  const slug = c.req.param('org') ?? '';
  const org = await getOrgBySlug(c.env, slug);
  const me = org ? await orgMembership(c.env, org.id, userId) : null;
  if (!org || !me) throw new ApiError(404, 'org_not_found', `no org ${slug}`);
  const allowed =
    need === 'member' ||
    me.role === 'owner' ||
    (need === 'manage' && me.role === 'admin');
  if (!allowed) {
    throw new ApiError(
      403,
      'forbidden',
      need === 'owner' ? 'org owner role required' : 'org owner or admin role required',
    );
  }
  return { org, me };
}

async function resolveUserId(
  env: AppEnv['Bindings'],
  ref: z.infer<typeof userRefSchema>,
): Promise<string> {
  if (ref.user_id) return ref.user_id;
  if (!ref.user_login) {
    throw new ApiError(400, 'invalid_request', 'user_id or user_login is required');
  }
  const row = await q1(env, `SELECT * FROM ${T.users} WHERE ${C.users.login} = ?`, [
    ref.user_login,
  ]);
  if (!row) throw new ApiError(404, 'user_not_found', `no user ${ref.user_login}`);
  return parseUserRow(row).id;
}

async function loadTeam(
  env: AppEnv['Bindings'],
  org: OrgRecord,
  slug: string,
): Promise<TeamRecord> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.teams} WHERE ${C.teams.orgId} = ? AND ${C.teams.slug} = ?`,
    [org.id, slug],
  );
  if (!row) throw new ApiError(404, 'team_not_found', `no team ${org.slug}/${slug}`);
  return parseTeamRow(row);
}

async function ownerCount(env: AppEnv['Bindings'], orgId: string): Promise<number> {
  const row = await q1<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM ${T.orgMembers} WHERE ${C.orgMembers.orgId} = ? AND ${C.orgMembers.role} = 'owner'`,
    [orgId],
  );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

orgsRoutes.post('/orgs', async (c) => {
  try {
    const userId = sessionUserId(c);
    const input = parse(createOrgSchema, await readJsonBody(c));
    if (await getOrgBySlug(c.env, input.slug)) {
      throw new ApiError(409, 'org_exists', `org ${input.slug} already exists`);
    }
    // A user's namespace is not up for grabs: an org over it would own that
    // user's repo prefix and its audit chain (keyed by the prefix).
    const taken = await q1(
      c.env,
      `SELECT 1 FROM ${T.users} WHERE lower(${C.users.login}) = ?
       UNION ALL SELECT 1 FROM ${T.repos} WHERE ${C.repos.slug} LIKE ?
       LIMIT 1`,
      [input.slug, `${input.slug}/%`],
    );
    if (taken) {
      throw new ApiError(409, 'namespace_taken', `${input.slug} is a user namespace`);
    }
    const org: OrgRecord = {
      id: ulid(),
      slug: input.slug,
      display_name: input.display_name ?? input.slug,
      created_at: Date.now(),
      base_role: input.base_role ?? 'none',
      members_can_create_repos: input.members_can_create_repos ?? false,
    };
    await tx(c.env, (t) => {
      t.q(
        `INSERT INTO ${T.orgs} (${C.orgs.id}, ${C.orgs.slug}, ${C.orgs.displayName}, ${C.orgs.createdAt}, ${C.orgs.baseRole}, ${C.orgs.membersCanCreateRepos})
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          org.id,
          org.slug,
          org.display_name,
          org.created_at,
          org.base_role,
          org.members_can_create_repos ? 1 : 0,
        ],
      );
      t.q(
        `INSERT INTO ${T.orgMembers} (${C.orgMembers.orgId}, ${C.orgMembers.userId}, ${C.orgMembers.role}) VALUES (?, ?, 'owner')`,
        [org.id, userId],
      );
    });
    await recordAudit(c, {
      action: 'org.create',
      orgId: org.slug,
      target: { org: org.slug, base_role: org.base_role },
    });
    return c.json({ org, role: 'owner' }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.get('/orgs', async (c) => {
  try {
    const userId = sessionUserId(c);
    const rows = await q<Record<string, unknown> & { member_role: unknown }>(
      c.env,
      `SELECT o.*, m.${C.orgMembers.role} AS member_role FROM ${T.orgs} o
         JOIN ${T.orgMembers} m ON m.${C.orgMembers.orgId} = o.${C.orgs.id}
        WHERE m.${C.orgMembers.userId} = ?
        ORDER BY o.${C.orgs.slug}`,
      [userId],
    );
    return c.json({
      orgs: rows.map((r) => ({
        ...parseOrgRow(r),
        role: orgRoleSchema.parse(r.member_role),
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.get('/orgs/:org', async (c) => {
  try {
    const { org, me } = await loadOrg(c, 'member');
    return c.json({ org, role: me.role });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.patch('/orgs/:org', async (c) => {
  try {
    const { org } = await loadOrg(c, 'owner');
    const input = parse(patchOrgSchema, await readJsonBody(c));
    const next: OrgRecord = {
      ...org,
      display_name: input.display_name ?? org.display_name,
      base_role: input.base_role ?? org.base_role,
      members_can_create_repos:
        input.members_can_create_repos ?? org.members_can_create_repos,
    };
    await run(
      c.env,
      `UPDATE ${T.orgs} SET ${C.orgs.displayName} = ?, ${C.orgs.baseRole} = ?, ${C.orgs.membersCanCreateRepos} = ?
        WHERE ${C.orgs.id} = ?`,
      [next.display_name, next.base_role, next.members_can_create_repos ? 1 : 0, org.id],
    );
    await recordAudit(c, {
      action: 'org.update',
      orgId: org.slug,
      target: {
        org: org.slug,
        base_role: next.base_role,
        members_can_create_repos: next.members_can_create_repos,
      },
    });
    return c.json({ org: next });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

orgsRoutes.get('/orgs/:org/members', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const rows = await q<Record<string, unknown> & { login: unknown }>(
      c.env,
      `SELECT m.*, u.${C.users.login} AS login FROM ${T.orgMembers} m
         LEFT JOIN ${T.users} u ON u.${C.users.id} = m.${C.orgMembers.userId}
        WHERE m.${C.orgMembers.orgId} = ? ORDER BY u.${C.users.login}`,
      [org.id],
    );
    return c.json({
      members: rows.map((r) => {
        const m = parseOrgMemberRow(r);
        return {
          user_id: m.user_id,
          login: typeof r.login === 'string' ? r.login : null,
          role: m.role,
        };
      }),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.put('/orgs/:org/members', async (c) => {
  try {
    const { org, me } = await loadOrg(c, 'manage');
    const input = parse(putMemberSchema, await readJsonBody(c));
    const userId = await resolveUserId(c.env, input);
    const current = await orgMembership(c.env, org.id, userId);
    if ((input.role === 'owner' || current?.role === 'owner') && me.role !== 'owner') {
      throw new ApiError(403, 'forbidden', 'only org owners can change owners');
    }
    if (
      current?.role === 'owner' &&
      input.role !== 'owner' &&
      (await ownerCount(c.env, org.id)) <= 1
    ) {
      throw new ApiError(409, 'last_owner', 'an org needs at least one owner');
    }
    await run(
      c.env,
      `INSERT INTO ${T.orgMembers} (${C.orgMembers.orgId}, ${C.orgMembers.userId}, ${C.orgMembers.role})
       VALUES (?, ?, ?)
       ON CONFLICT (${C.orgMembers.orgId}, ${C.orgMembers.userId})
       DO UPDATE SET ${C.orgMembers.role} = excluded.${C.orgMembers.role}`,
      [org.id, userId, input.role],
    );
    await recordAudit(c, {
      action: 'org.member.set',
      orgId: org.slug,
      target: {
        org: org.slug,
        user_id: userId,
        role: input.role,
        was: current?.role ?? null,
      },
    });
    return c.json({ ok: true, user_id: userId, role: input.role });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.delete('/orgs/:org/members/:userId', async (c) => {
  try {
    const { org, me } = await loadOrg(c, 'manage');
    const userId = c.req.param('userId');
    const current = await orgMembership(c.env, org.id, userId);
    if (!current) throw new ApiError(404, 'member_not_found', `no member ${userId}`);
    if (current.role === 'owner') {
      if (me.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'only org owners can remove owners');
      }
      if ((await ownerCount(c.env, org.id)) <= 1) {
        throw new ApiError(409, 'last_owner', 'an org needs at least one owner');
      }
    }
    // Leaving the org also leaves its teams, in the same batch.
    await tx(c.env, (t) => {
      t.q(
        `DELETE FROM ${T.teamMembers} WHERE ${C.teamMembers.userId} = ?
           AND ${C.teamMembers.teamId} IN (SELECT ${C.teams.id} FROM ${T.teams} WHERE ${C.teams.orgId} = ?)`,
        [userId, org.id],
      );
      t.q(
        `DELETE FROM ${T.orgMembers} WHERE ${C.orgMembers.orgId} = ? AND ${C.orgMembers.userId} = ?`,
        [org.id, userId],
      );
    });
    await recordAudit(c, {
      action: 'org.member.remove',
      orgId: org.slug,
      target: { org: org.slug, user_id: userId, was: current.role },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

orgsRoutes.get('/orgs/:org/teams', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const rows = await q(
      c.env,
      `SELECT * FROM ${T.teams} WHERE ${C.teams.orgId} = ? ORDER BY ${C.teams.slug}`,
      [org.id],
    );
    const teams = rows.map(parseTeamRow);
    const slugById = new Map(teams.map((t) => [t.id, t.slug]));
    return c.json({
      teams: teams.map((t) => ({
        id: t.id,
        slug: t.slug,
        parent: t.parent_team_id ? (slugById.get(t.parent_team_id) ?? null) : null,
        created_at: t.created_at,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.post('/orgs/:org/teams', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const input = parse(createTeamSchema, await readJsonBody(c));
    const existing = await q1(
      c.env,
      `SELECT 1 FROM ${T.teams} WHERE ${C.teams.orgId} = ? AND ${C.teams.slug} = ?`,
      [org.id, input.slug],
    );
    if (existing)
      throw new ApiError(409, 'team_exists', `team ${input.slug} already exists`);
    let parent: TeamRecord | null = null;
    if (input.parent !== undefined) {
      parent = await loadTeam(c.env, org, input.parent);
      const depth = await q1<{ depth: number }>(
        c.env,
        `WITH RECURSIVE up(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT t.${C.teams.parentTeamId}, up.depth + 1 FROM up
             JOIN ${T.teams} t ON t.${C.teams.id} = up.id
            WHERE t.${C.teams.parentTeamId} IS NOT NULL AND up.depth < ${MAX_TEAM_DEPTH}
         )
         SELECT MAX(depth) AS depth FROM up`,
        [parent.id],
      );
      if ((depth?.depth ?? 0) + 1 > MAX_TEAM_DEPTH) {
        throw new ApiError(
          400,
          'team_too_deep',
          `teams nest at most ${MAX_TEAM_DEPTH} levels below a top-level team`,
        );
      }
    }
    const team: TeamRecord = {
      id: ulid(),
      org_id: org.id,
      slug: input.slug,
      parent_team_id: parent?.id ?? null,
      created_at: Date.now(),
    };
    await run(
      c.env,
      `INSERT INTO ${T.teams} (${C.teams.id}, ${C.teams.orgId}, ${C.teams.slug}, ${C.teams.parentTeamId}, ${C.teams.createdAt})
       VALUES (?, ?, ?, ?, ?)`,
      [team.id, team.org_id, team.slug, team.parent_team_id, team.created_at],
    );
    await recordAudit(c, {
      action: 'team.create',
      orgId: org.slug,
      target: { org: org.slug, team: team.slug, parent: parent?.slug ?? null },
    });
    return c.json(
      {
        team: {
          id: team.id,
          slug: team.slug,
          parent: parent?.slug ?? null,
          created_at: team.created_at,
        },
      },
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.get('/orgs/:org/teams/:team', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const team = await loadTeam(c.env, org, c.req.param('team'));
    const parent = team.parent_team_id
      ? await q1<{ slug: string }>(
          c.env,
          `SELECT ${C.teams.slug} AS slug FROM ${T.teams} WHERE ${C.teams.id} = ?`,
          [team.parent_team_id],
        )
      : null;
    const members = await q<{ user_id: string; login: string | null }>(
      c.env,
      `SELECT tm.${C.teamMembers.userId} AS user_id, u.${C.users.login} AS login
         FROM ${T.teamMembers} tm
         LEFT JOIN ${T.users} u ON u.${C.users.id} = tm.${C.teamMembers.userId}
        WHERE tm.${C.teamMembers.teamId} = ? ORDER BY u.${C.users.login}`,
      [team.id],
    );
    const grants = await q<Record<string, unknown> & { slug: unknown }>(
      c.env,
      `SELECT tr.*, r.${C.repos.slug} AS slug FROM ${T.teamRepos} tr
         JOIN ${T.repos} r ON r.${C.repos.id} = tr.${C.teamRepos.repoId}
        WHERE tr.${C.teamRepos.teamId} = ? ORDER BY r.${C.repos.slug}`,
      [team.id],
    );
    return c.json({
      team: {
        id: team.id,
        slug: team.slug,
        parent: parent?.slug ?? null,
        created_at: team.created_at,
      },
      members: members.map((m) => ({ user_id: m.user_id, login: m.login ?? null })),
      repos: grants.map((g) => ({
        repo: z.string().parse(g.slug),
        role: parseTeamRepoRow(g).role,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.put('/orgs/:org/teams/:team/members', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const team = await loadTeam(c.env, org, c.req.param('team'));
    const userId = await resolveUserId(
      c.env,
      parse(userRefSchema, await readJsonBody(c)),
    );
    if (!(await orgMembership(c.env, org.id, userId))) {
      throw new ApiError(400, 'not_org_member', 'add the user to the org first');
    }
    await run(
      c.env,
      `INSERT INTO ${T.teamMembers} (${C.teamMembers.teamId}, ${C.teamMembers.userId}) VALUES (?, ?)
       ON CONFLICT (${C.teamMembers.teamId}, ${C.teamMembers.userId}) DO NOTHING`,
      [team.id, userId],
    );
    await recordAudit(c, {
      action: 'team.member.set',
      orgId: org.slug,
      target: { org: org.slug, team: team.slug, user_id: userId },
    });
    return c.json({ ok: true, user_id: userId });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.delete('/orgs/:org/teams/:team/members/:userId', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const team = await loadTeam(c.env, org, c.req.param('team'));
    await run(
      c.env,
      `DELETE FROM ${T.teamMembers} WHERE ${C.teamMembers.teamId} = ? AND ${C.teamMembers.userId} = ?`,
      [team.id, c.req.param('userId')],
    );
    await recordAudit(c, {
      action: 'team.member.remove',
      orgId: org.slug,
      target: { org: org.slug, team: team.slug, user_id: c.req.param('userId') },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** A repo owned by this org, or 404 (team grants never reach other repos). */
async function loadOrgRepo(
  env: AppEnv['Bindings'],
  org: OrgRecord,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const repo = await getRepoBySlug(env, slug);
  if (!repo || repo.owner_kind !== 'org' || repo.owner_id !== org.id) {
    throw new ApiError(404, 'repo_not_found', `no repo ${slug} in org ${org.slug}`);
  }
  return repo;
}

orgsRoutes.put('/orgs/:org/teams/:team/repos', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const team = await loadTeam(c.env, org, c.req.param('team'));
    const input = parse(grantSchema, await readJsonBody(c));
    const repo = await loadOrgRepo(c.env, org, input.repo);
    await run(
      c.env,
      `INSERT INTO ${T.teamRepos} (${C.teamRepos.teamId}, ${C.teamRepos.repoId}, ${C.teamRepos.role})
       VALUES (?, ?, ?)
       ON CONFLICT (${C.teamRepos.teamId}, ${C.teamRepos.repoId})
       DO UPDATE SET ${C.teamRepos.role} = excluded.${C.teamRepos.role}`,
      [team.id, repo.id, input.role],
    );
    await recordAudit(c, {
      action: 'team.repo.set',
      repo,
      target: { org: org.slug, team: team.slug, role: input.role },
    });
    return c.json({ ok: true, repo: repo.slug, role: input.role });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgsRoutes.delete('/orgs/:org/teams/:team/repos/:repo{.+}', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const team = await loadTeam(c.env, org, c.req.param('team'));
    const repo = await loadOrgRepo(c.env, org, c.req.param('repo'));
    await run(
      c.env,
      `DELETE FROM ${T.teamRepos} WHERE ${C.teamRepos.teamId} = ? AND ${C.teamRepos.repoId} = ?`,
      [team.id, repo.id],
    );
    await recordAudit(c, {
      action: 'team.repo.remove',
      repo,
      target: { org: org.slug, team: team.slug },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

orgsRoutes.get('/orgs/:org/repos', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const rows = await q(
      c.env,
      `SELECT * FROM ${T.repos} WHERE ${C.repos.ownerKind} = 'org' AND ${C.repos.ownerId} = ?
        ORDER BY ${C.repos.slug} LIMIT 100`,
      [org.id],
    );
    const principal = c.get('principal');
    const repos = rows.map(parseRepoRow);
    const readable = await Promise.all(
      repos.map((r) => can(c.env, r, principal ?? null, 'read')),
    );
    return c.json({ repos: repos.filter((_, i) => readable[i]) });
  } catch (err) {
    return errorResponse(c, err);
  }
});
