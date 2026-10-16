import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { q, q1, run, tx } from '../db/client';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import {
  createUser,
  deactivateUser,
  findIdentityUser,
  linkIdentity,
  randomHex,
  requireRecentMfa,
} from './session';
import type { AppEnv, AppVariables } from './principal';
import { recordAudit, type AuditActor } from '../audit/record';
import { getOrgBySlug, SLUG_RE } from '../api/orgs';

/**
 * SCIM 2.0 provisioning (issue #27, RFC 7643/7644 subset). Users: create,
 * read, filter by `userName eq`, PATCH `active`, and DELETE. Deactivation
 * revokes every session and API token in the same request. Groups are teams
 * (#26) in the org the token is bound to: create, read, filter by
 * `displayName eq`, PATCH members and displayName, and DELETE. A member added
 * to a group joins the org as a `member` first, as teams require.
 *
 * Auth is `Authorization: Bearer yscim_…`, hashed in `scim_tokens`, minted by
 * users listed in `SCIM_ADMIN_USER_IDS` who passed MFA in the last 12 hours.
 */

type ScimEnv = {
  Bindings: AppEnv['Bindings'];
  Variables: AppVariables & { scimTokenId?: string; scimOrgId?: string | null };
};
export const scimRoutes = new Hono<ScimEnv>();

/** SCIM calls carry no user principal: the acting party is the SCIM token. */
function scimActor(c: Context<ScimEnv>): AuditActor {
  return { kind: 'system', id: `scim:${c.get('scimTokenId') ?? 'unknown'}` };
}

const SCIM_TOKEN_PREFIX = 'yscim_';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' },
  });
}

function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson(
    {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType && { scimType }),
    },
    status,
  );
}

function scimFailure(err: unknown): Response {
  if (err instanceof ApiError) return scimError(err.status, err.message);
  console.error(err);
  return scimError(500, 'internal error');
}

const tokenHash = (raw: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(raw));

scimRoutes.use('/scim/v2/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = raw.startsWith(SCIM_TOKEN_PREFIX)
    ? await q1<{ id: string; org_id: string | null }>(
        c.env,
        'SELECT id, org_id FROM scim_tokens WHERE token_hash = ?',
        [await tokenHash(raw)],
      )
    : null;
  if (!token) return scimError(401, 'a valid SCIM bearer token is required');
  await run(c.env, 'UPDATE scim_tokens SET last_used_at = ? WHERE id = ?', [
    Date.now(),
    token.id,
  ]);
  c.set('scimTokenId', token.id);
  c.set('scimOrgId', token.org_id);
  await next();
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const SELECT_SCIM_USERS = `SELECT u.id, u.login, u.active, u.created_at, i.subject AS user_name, i.email
  FROM users u JOIN user_identities i ON i.user_id = u.id AND i.provider = 'scim'`;

const scimUserRowSchema = z.object({
  id: z.string(),
  login: z.string(),
  active: z.number(),
  created_at: z.number(),
  user_name: z.string(),
  email: z.string().nullable(),
});
type ScimUserRow = z.infer<typeof scimUserRowSchema>;

function toResource(row: ScimUserRow, origin: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    userName: row.user_name,
    displayName: row.login,
    active: row.active !== 0,
    emails: row.email ? [{ value: row.email, primary: true }] : [],
    meta: {
      resourceType: 'User',
      created: new Date(row.created_at).toISOString(),
      location: `${origin}/scim/v2/Users/${row.id}`,
    },
  };
}

async function loadScimUser(env: Env, id: string): Promise<ScimUserRow | null> {
  const row = await q1(env, `${SELECT_SCIM_USERS} WHERE u.id = ?`, [id]);
  return row ? scimUserRowSchema.parse(row) : null;
}

const origin = (c: Context): string => new URL(c.req.url).origin;

scimRoutes.get('/scim/v2/Users', async (c) => {
  try {
    let where = '';
    const params: unknown[] = [];
    const filter = c.req.query('filter');
    if (filter) {
      const match = /^userName eq "([^"]*)"$/i.exec(filter.trim());
      if (!match) {
        return scimError(
          400,
          'only userName eq "…" filters are supported',
          'invalidFilter',
        );
      }
      where = ' WHERE i.subject = ?';
      params.push((match[1] ?? '').toLowerCase());
    }
    const startIndex = Math.max(
      1,
      Number.parseInt(c.req.query('startIndex') ?? '1', 10) || 1,
    );
    const count = Math.min(
      200,
      Math.max(0, Number.parseInt(c.req.query('count') ?? '100', 10) || 0),
    );
    const total = await q1<{ n: number }>(
      c.env,
      `SELECT COUNT(*) AS n FROM (${SELECT_SCIM_USERS}${where})`,
      params,
    );
    const rows = await q(
      c.env,
      `${SELECT_SCIM_USERS}${where} ORDER BY u.created_at, u.id LIMIT ? OFFSET ?`,
      [...params, count, startIndex - 1],
    );
    return scimJson({
      schemas: [LIST_SCHEMA],
      totalResults: total?.n ?? 0,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((r) => toResource(scimUserRowSchema.parse(r), origin(c))),
    });
  } catch (err) {
    return scimFailure(err);
  }
});

scimRoutes.get('/scim/v2/Users/:id', async (c) => {
  try {
    const row = await loadScimUser(c.env, c.req.param('id'));
    return row ? scimJson(toResource(row, origin(c))) : scimError(404, 'no such user');
  } catch (err) {
    return scimFailure(err);
  }
});

export const createUserSchema = z
  .object({
    userName: z.string().trim().min(1).max(256),
    active: z.boolean().optional(),
    emails: z
      .array(z.object({ value: z.string(), primary: z.boolean().optional() }).loose())
      .optional(),
  })
  .loose();

scimRoutes.post('/scim/v2/Users', async (c) => {
  try {
    const parsed = createUserSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return scimError(400, 'userName is required', 'invalidValue');
    const userName = parsed.data.userName.toLowerCase();
    if (await findIdentityUser(c.env, 'scim', userName)) {
      return scimError(409, 'userName already exists', 'uniqueness');
    }
    const emails = parsed.data.emails ?? [];
    const email =
      ((emails.find((e) => e.primary) ?? emails[0])?.value ?? null)?.toLowerCase() ??
      (userName.includes('@') ? userName : null);
    // someone who already signed in with this verified email keeps their account
    const existing = email
      ? await q1<{ user_id: string }>(
          c.env,
          `SELECT user_id FROM user_identities WHERE provider LIKE 'oidc:%' AND email = ?
             AND user_id NOT IN (SELECT user_id FROM user_identities WHERE provider = 'scim')`,
          [email],
        )
      : null;
    const userId = existing?.user_id ?? (await createUser(c.env, userName)).id;
    await linkIdentity(c.env, userId, 'scim', userName, email);
    if (parsed.data.active === false) await deactivateUser(c.env, userId);
    await recordAudit(c, {
      action: 'scim.user.create',
      actor: scimActor(c),
      target: {
        user_id: userId,
        user_name: userName,
        active: parsed.data.active ?? true,
      },
    });
    const row = await loadScimUser(c.env, userId);
    return row
      ? scimJson(toResource(row, origin(c)), 201)
      : scimError(500, 'internal error');
  } catch (err) {
    return scimFailure(err);
  }
});

export const patchSchema = z
  .object({
    Operations: z
      .array(
        // a remove carries no value
        z.object({
          op: z.string(),
          path: z.string().optional(),
          value: z.unknown().optional(),
        }),
      )
      .min(1),
  })
  .loose();

/** IdPs send booleans, and Entra also sends "True"/"False" strings. */
function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v))
    return v.toLowerCase() === 'true';
  return undefined;
}

scimRoutes.patch('/scim/v2/Users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!(await loadScimUser(c.env, id))) return scimError(404, 'no such user');
    const parsed = patchSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return scimError(400, 'Operations are required', 'invalidSyntax');
    let active: boolean | undefined;
    for (const op of parsed.data.Operations) {
      if (!['replace', 'add'].includes(op.op.toLowerCase())) continue;
      const value =
        op.path === undefined
          ? typeof op.value === 'object' && op.value !== null && 'active' in op.value
            ? (op.value as Record<string, unknown>)['active']
            : undefined
          : op.path.toLowerCase() === 'active'
            ? op.value
            : undefined;
      if (value === undefined) continue; // Yuma keeps no other profile fields
      active = asBool(value);
      if (active === undefined)
        return scimError(400, 'active must be a boolean', 'invalidValue');
    }
    if (active === false) await deactivateUser(c.env, id);
    if (active === true)
      await run(c.env, 'UPDATE users SET active = 1 WHERE id = ?', [id]);
    if (active !== undefined) {
      await recordAudit(c, {
        action: 'scim.user.update',
        actor: scimActor(c),
        target: { user_id: id, active },
      });
    }
    const row = await loadScimUser(c.env, id);
    return row ? scimJson(toResource(row, origin(c))) : scimError(404, 'no such user');
  } catch (err) {
    return scimFailure(err);
  }
});

/** DELETE deprovisions: the account stays (it owns history) but is inactive. */
scimRoutes.delete('/scim/v2/Users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!(await loadScimUser(c.env, id))) return scimError(404, 'no such user');
    await deactivateUser(c.env, id);
    await run(
      c.env,
      "DELETE FROM user_identities WHERE provider = 'scim' AND user_id = ?",
      [id],
    );
    await recordAudit(c, {
      action: 'scim.user.deprovision',
      actor: scimActor(c),
      target: { user_id: id },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return scimFailure(err);
  }
});

// ---------------------------------------------------------------------------
// Groups (teams)
// ---------------------------------------------------------------------------

const SELECT_SCIM_GROUPS = `SELECT g.team_id AS id, g.org_id, g.display_name, g.external_id, g.created_at,
    o.slug AS org_slug, t.slug AS team_slug
  FROM scim_groups g JOIN teams t ON t.id = g.team_id JOIN orgs o ON o.id = g.org_id`;

const scimGroupRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  display_name: z.string(),
  external_id: z.string().nullable(),
  created_at: z.number(),
  org_slug: z.string(),
  team_slug: z.string(),
});
type ScimGroupRow = z.infer<typeof scimGroupRowSchema>;

/** The org this token provisions groups into; groups need one. */
function scimOrg(c: Context<ScimEnv>): string {
  const orgId = c.get('scimOrgId');
  if (!orgId) {
    throw new ApiError(
      403,
      'forbidden',
      'this SCIM token is not bound to an organisation',
    );
  }
  return orgId;
}

async function loadScimGroup(
  env: Env,
  orgId: string,
  id: string,
): Promise<ScimGroupRow | null> {
  const row = await q1(
    env,
    `${SELECT_SCIM_GROUPS} WHERE g.team_id = ? AND g.org_id = ?`,
    [id, orgId],
  );
  return row ? scimGroupRowSchema.parse(row) : null;
}

async function toGroupResource(
  env: Env,
  row: ScimGroupRow,
  origin: string,
  withMembers = true,
): Promise<Record<string, unknown>> {
  const members = withMembers
    ? await q<{ user_id: string; login: string }>(
        env,
        `SELECT tm.user_id, u.login FROM team_members tm JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = ? ORDER BY u.login`,
        [row.id],
      )
    : [];
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    displayName: row.display_name,
    ...(row.external_id !== null && { externalId: row.external_id }),
    ...(withMembers && {
      members: members.map((m) => ({
        value: m.user_id,
        display: m.login,
        $ref: `${origin}/scim/v2/Users/${m.user_id}`,
      })),
    }),
    meta: {
      resourceType: 'Group',
      created: new Date(row.created_at).toISOString(),
      location: `${origin}/scim/v2/Groups/${row.id}`,
    },
  };
}

/** Team slug for a group name: lowercase words joined by single hyphens. */
function teamSlug(displayName: string): string | null {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
  return SLUG_RE.test(slug) ? slug : null;
}

const memberRefsSchema = z.array(z.object({ value: z.string().min(1) }).loose());

function memberIds(value: unknown): string[] {
  const parsed = memberRefsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'members must be [{ "value": id }]');
  }
  return parsed.data.map((m) => m.value);
}

/** Add users to a group's team, joining them to the org first. */
async function addMembers(env: Env, group: ScimGroupRow, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const known = await q<{ id: string }>(
    env,
    `SELECT id FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  if (known.length !== unique.length) {
    throw new ApiError(400, 'invalid_request', 'unknown member id');
  }
  await tx(env, (t) => {
    for (const id of unique) {
      t.q(
        `INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [group.org_id, id],
      );
      t.q(
        `INSERT INTO team_members (team_id, user_id) VALUES (?, ?)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [group.id, id],
      );
    }
  });
}

/** Remove users (or everyone) from a group's team; org membership stays. */
async function removeMembers(
  env: Env,
  group: ScimGroupRow,
  ids: string[] | 'all',
): Promise<void> {
  if (ids === 'all') {
    await run(env, 'DELETE FROM team_members WHERE team_id = ?', [group.id]);
  } else if (ids.length > 0) {
    await run(
      env,
      `DELETE FROM team_members WHERE team_id = ? AND user_id IN (${ids.map(() => '?').join(', ')})`,
      [group.id, ...ids],
    );
  }
}

scimRoutes.get('/scim/v2/Groups', async (c) => {
  try {
    const orgId = scimOrg(c);
    let where = ' WHERE g.org_id = ?';
    const params: unknown[] = [orgId];
    const filter = c.req.query('filter');
    if (filter) {
      const match = /^displayName eq "([^"]*)"$/i.exec(filter.trim());
      if (!match) {
        return scimError(
          400,
          'only displayName eq "…" filters are supported',
          'invalidFilter',
        );
      }
      where += ' AND g.display_name = ?';
      params.push(match[1] ?? '');
    }
    const startIndex = Math.max(
      1,
      Number.parseInt(c.req.query('startIndex') ?? '1', 10) || 1,
    );
    const count = Math.min(
      200,
      Math.max(0, Number.parseInt(c.req.query('count') ?? '100', 10) || 0),
    );
    const withMembers = !/\bmembers\b/.test(c.req.query('excludedAttributes') ?? '');
    const total = await q1<{ n: number }>(
      c.env,
      `SELECT COUNT(*) AS n FROM (${SELECT_SCIM_GROUPS}${where})`,
      params,
    );
    const rows = await q(
      c.env,
      `${SELECT_SCIM_GROUPS}${where} ORDER BY g.created_at, g.team_id LIMIT ? OFFSET ?`,
      [...params, count, startIndex - 1],
    );
    const resources = [];
    for (const r of rows) {
      resources.push(
        await toGroupResource(c.env, scimGroupRowSchema.parse(r), origin(c), withMembers),
      );
    }
    return scimJson({
      schemas: [LIST_SCHEMA],
      totalResults: total?.n ?? 0,
      startIndex,
      itemsPerPage: rows.length,
      Resources: resources,
    });
  } catch (err) {
    return scimFailure(err);
  }
});

scimRoutes.get('/scim/v2/Groups/:id', async (c) => {
  try {
    const row = await loadScimGroup(c.env, scimOrg(c), c.req.param('id'));
    return row
      ? scimJson(await toGroupResource(c.env, row, origin(c)))
      : scimError(404, 'no such group');
  } catch (err) {
    return scimFailure(err);
  }
});

const createGroupSchema = z
  .object({
    displayName: z.string().trim().min(1).max(256),
    externalId: z.string().max(256).optional(),
    members: z.unknown().optional(),
  })
  .loose();

scimRoutes.post('/scim/v2/Groups', async (c) => {
  try {
    const orgId = scimOrg(c);
    const parsed = createGroupSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return scimError(400, 'displayName is required', 'invalidValue');
    const slug = teamSlug(parsed.data.displayName);
    if (!slug) {
      return scimError(400, 'displayName needs letters or digits', 'invalidValue');
    }
    const ids = parsed.data.members === undefined ? [] : memberIds(parsed.data.members);
    const clash = await q1(
      c.env,
      `SELECT 1 FROM teams WHERE org_id = ? AND slug = ?
       UNION ALL SELECT 1 FROM scim_groups WHERE org_id = ? AND display_name = ?`,
      [orgId, slug, orgId, parsed.data.displayName],
    );
    if (clash)
      return scimError(409, 'a team with that name already exists', 'uniqueness');
    const id = ulid();
    const now = Date.now();
    await tx(c.env, (t) => {
      t.q(
        'INSERT INTO teams (id, org_id, slug, parent_team_id, created_at) VALUES (?, ?, ?, NULL, ?)',
        [id, orgId, slug, now],
      );
      t.q(
        `INSERT INTO scim_groups (team_id, org_id, display_name, external_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, orgId, parsed.data.displayName, parsed.data.externalId ?? null, now],
      );
    });
    const group = await loadScimGroup(c.env, orgId, id);
    if (!group) return scimError(500, 'internal error');
    await addMembers(c.env, group, ids);
    await recordAudit(c, {
      action: 'scim.group.create',
      actor: scimActor(c),
      orgId: group.org_slug,
      target: { org: group.org_slug, team: slug, added: ids },
    });
    return scimJson(await toGroupResource(c.env, group, origin(c)), 201);
  } catch (err) {
    return scimFailure(err);
  }
});

/** `members[value eq "id"]`, the filtered path IdPs use to remove one member. */
const MEMBER_FILTER_RE = /^members\[value eq "([^"]+)"\]$/i;

scimRoutes.patch('/scim/v2/Groups/:id', async (c) => {
  try {
    const group = await loadScimGroup(c.env, scimOrg(c), c.req.param('id'));
    if (!group) return scimError(404, 'no such group');
    const parsed = patchSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return scimError(400, 'Operations are required', 'invalidSyntax');
    const added: string[] = [];
    const removed: string[] = [];
    let displayName: string | undefined;
    let externalId: string | undefined;
    for (const op of parsed.data.Operations) {
      const kind = op.op.toLowerCase();
      const path = op.path ?? '';
      const filtered = MEMBER_FILTER_RE.exec(path);
      if (filtered && kind === 'remove') {
        const id = filtered[1] ?? '';
        await removeMembers(c.env, group, [id]);
        removed.push(id);
      } else if (path.toLowerCase() === 'members') {
        if (kind === 'replace') {
          const ids = memberIds(op.value);
          await removeMembers(c.env, group, 'all');
          await addMembers(c.env, group, ids);
          removed.push('*');
          added.push(...ids);
        } else if (kind === 'add') {
          const ids = memberIds(op.value);
          await addMembers(c.env, group, ids);
          added.push(...ids);
        } else if (kind === 'remove') {
          const ids = op.value === undefined ? 'all' : memberIds(op.value);
          await removeMembers(c.env, group, ids);
          removed.push(...(ids === 'all' ? ['*'] : ids));
        } else {
          return scimError(400, `unsupported op ${op.op}`, 'invalidSyntax');
        }
      } else if (kind === 'replace' || kind === 'add') {
        // displayName / externalId by path, or both in a pathless value
        const value: Record<string, unknown> =
          path === ''
            ? typeof op.value === 'object' && op.value !== null
              ? (op.value as Record<string, unknown>)
              : {}
            : { [path]: op.value };
        for (const [key, v] of Object.entries(value)) {
          if (typeof v !== 'string') continue;
          if (key.toLowerCase() === 'displayname') displayName = v.trim();
          if (key.toLowerCase() === 'externalid') externalId = v;
        }
      }
    }
    if (displayName === '') return scimError(400, 'displayName is empty', 'invalidValue');
    if (displayName !== undefined || externalId !== undefined) {
      await run(
        c.env,
        `UPDATE scim_groups SET display_name = COALESCE(?, display_name),
           external_id = COALESCE(?, external_id) WHERE team_id = ?`,
        [displayName ?? null, externalId ?? null, group.id],
      );
    }
    await recordAudit(c, {
      action: 'scim.group.update',
      actor: scimActor(c),
      orgId: group.org_slug,
      target: {
        org: group.org_slug,
        team: group.team_slug,
        added,
        removed,
        ...(displayName !== undefined && { display_name: displayName }),
      },
    });
    const row = await loadScimGroup(c.env, group.org_id, group.id);
    return row
      ? scimJson(await toGroupResource(c.env, row, origin(c)))
      : scimError(404, 'no such group');
  } catch (err) {
    return scimFailure(err);
  }
});

/** DELETE removes the team, its members and repo grants; child teams move up. */
scimRoutes.delete('/scim/v2/Groups/:id', async (c) => {
  try {
    const group = await loadScimGroup(c.env, scimOrg(c), c.req.param('id'));
    if (!group) return scimError(404, 'no such group');
    await tx(c.env, (t) => {
      t.q('DELETE FROM team_members WHERE team_id = ?', [group.id]);
      t.q('DELETE FROM team_repos WHERE team_id = ?', [group.id]);
      t.q('UPDATE teams SET parent_team_id = NULL WHERE parent_team_id = ?', [group.id]);
      t.q('DELETE FROM scim_groups WHERE team_id = ?', [group.id]);
      t.q('DELETE FROM teams WHERE id = ?', [group.id]);
    });
    await recordAudit(c, {
      action: 'scim.group.delete',
      actor: scimActor(c),
      orgId: group.org_slug,
      target: { org: group.org_slug, team: group.team_slug },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return scimFailure(err);
  }
});

// ---------------------------------------------------------------------------
// SCIM token management (session only)
// ---------------------------------------------------------------------------

function isScimAdmin(env: Env, userId: string): boolean {
  return (env.SCIM_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(userId);
}

const scimTokenRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  created_by: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});

export const createScimTokenSchema = z.object({
  label: z.string().trim().min(1).max(120),
  /** Org slug: Groups provision teams there. */
  org: z.string().min(1).max(39).optional(),
});

scimRoutes.post('/api/v1/scim/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isScimAdmin(c.env, user.id)) {
      return apiError(c, 403, 'forbidden', 'SCIM administrators only');
    }
    const mfa = await requireRecentMfa(c, { strict: true });
    if (mfa) return mfa;
    const parsed = createScimTokenSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'label is required');
    const org = parsed.data.org ? await getOrgBySlug(c.env, parsed.data.org) : null;
    if (parsed.data.org && !org) {
      return apiError(c, 404, 'org_not_found', `no org ${parsed.data.org}`);
    }
    const now = Date.now();
    const raw = `${SCIM_TOKEN_PREFIX}${randomHex(32)}`;
    const id = ulid(now);
    await run(
      c.env,
      `INSERT INTO scim_tokens (id, token_hash, label, created_by, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, await tokenHash(raw), parsed.data.label, user.id, now, org?.id ?? null],
    );
    await recordAudit(c, {
      action: 'scim_token.create',
      target: { token_id: id, label: parsed.data.label, org: org?.slug ?? null },
    });
    // raw token is returned exactly once
    const body = {
      id,
      label: parsed.data.label,
      org: org?.slug ?? null,
      created_at: now,
      token: raw,
    };
    return c.json(body, 201, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

scimRoutes.get('/api/v1/scim/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isScimAdmin(c.env, user.id)) {
      return apiError(c, 403, 'forbidden', 'SCIM administrators only');
    }
    const rows = await q(
      c.env,
      'SELECT id, label, created_by, created_at, last_used_at FROM scim_tokens ORDER BY created_at DESC',
    );
    return c.json({ tokens: rows.map((r) => scimTokenRowSchema.parse(r)) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

scimRoutes.delete('/api/v1/scim/tokens/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isScimAdmin(c.env, user.id)) {
      return apiError(c, 403, 'forbidden', 'SCIM administrators only');
    }
    const removed = await q1(c.env, 'DELETE FROM scim_tokens WHERE id = ? RETURNING id', [
      c.req.param('id'),
    ]);
    if (!removed) return apiError(c, 404, 'token_not_found', 'no such SCIM token');
    await recordAudit(c, {
      action: 'scim_token.revoke',
      target: { token_id: c.req.param('id') },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
