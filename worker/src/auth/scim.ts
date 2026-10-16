import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { q, q1, run } from '../db/client';
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

/**
 * SCIM 2.0 user provisioning (issue #27, RFC 7643/7644 subset): create, read,
 * filter by `userName eq`, PATCH `active`, and DELETE. Deactivation revokes
 * every session and API token in the same request. Groups need teams (#26)
 * and are not served yet.
 *
 * Auth is `Authorization: Bearer yscim_…`, hashed in `scim_tokens`, minted by
 * users listed in `SCIM_ADMIN_USER_IDS` who passed MFA in the last 12 hours.
 */

type ScimEnv = {
  Bindings: AppEnv['Bindings'];
  Variables: AppVariables & { scimTokenId?: string };
};
export const scimRoutes = new Hono<ScimEnv>();

/** SCIM calls carry no user principal: the acting party is the SCIM token. */
function scimActor(c: Context<ScimEnv>): AuditActor {
  return { kind: 'system', id: `scim:${c.get('scimTokenId') ?? 'unknown'}` };
}

const SCIM_TOKEN_PREFIX = 'yscim_';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
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
    ? await q1<{ id: string }>(c.env, 'SELECT id FROM scim_tokens WHERE token_hash = ?', [
        await tokenHash(raw),
      ])
    : null;
  if (!token) return scimError(401, 'a valid SCIM bearer token is required');
  await run(c.env, 'UPDATE scim_tokens SET last_used_at = ? WHERE id = ?', [
    Date.now(),
    token.id,
  ]);
  c.set('scimTokenId', token.id);
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

const createUserSchema = z
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

const patchSchema = z
  .object({
    Operations: z
      .array(
        z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() }),
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

scimRoutes.post('/api/v1/scim/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isScimAdmin(c.env, user.id)) {
      return apiError(c, 403, 'forbidden', 'SCIM administrators only');
    }
    const mfa = await requireRecentMfa(c, { strict: true });
    if (mfa) return mfa;
    const parsed = z
      .object({ label: z.string().trim().min(1).max(120) })
      .safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'label is required');
    const now = Date.now();
    const raw = `${SCIM_TOKEN_PREFIX}${randomHex(32)}`;
    const id = ulid(now);
    await run(
      c.env,
      `INSERT INTO scim_tokens (id, token_hash, label, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, await tokenHash(raw), parsed.data.label, user.id, now],
    );
    await recordAudit(c, {
      action: 'scim_token.create',
      target: { token_id: id, label: parsed.data.label },
    });
    // raw token is returned exactly once
    return c.json({ id, label: parsed.data.label, created_at: now, token: raw }, 201, {
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
