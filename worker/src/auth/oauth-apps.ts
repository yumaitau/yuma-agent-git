import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { q, q1 } from '../db/client';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { ApiError } from '../core/errors';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { recordAudit } from '../audit/record';
import {
  canManageOwner,
  parseBody,
  requireOrgSso,
  resolveOwner,
  sessionUser,
} from './owners';
import { appTokenGrant, JWT_BEARER_GRANT } from './apps';
import { b64urlEncode, randomB64url, sha256Bytes } from './encoding';
import type { AppEnv } from './principal';
import { requireRecentMfa } from './session';
import { createApiToken } from './tokens';

/**
 * OAuth apps (issue #75): third-party tools sign people in to the forge API
 * with the authorization code grant and PKCE (S256, required).
 *
 *   1. the tool sends the browser to `/oauth/authorize?client_id&redirect_uri
 *      &scope&state&code_challenge&code_challenge_method=S256` (a dashboard
 *      page, which reads and approves through `/api/v1/oauth/authorize`)
 *   2. the person approves; the browser returns to the registered
 *      `redirect_uri` with a single-use code that lasts 10 minutes
 *   3. the tool posts the code, its `code_verifier` and its client
 *      credentials to `POST /oauth/token` (`grant_type=authorization_code`)
 *
 * The access token is an API token in the person's token list (they can
 * revoke it there), lasting 8 hours, with scopes `repo:read` and/or
 * `repo:write`, or none for sign-in only (`GET /api/v1/user`). It carries the
 * approving session's sign-in method, so org SSO applies as for any API token.
 * Redirect URIs match exactly; codes and client secrets are SHA-256 at rest.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_S = 8 * 60 * 60;
export const OAUTH_SCOPES = ['repo:read', 'repo:write'] as const;

const hash = (raw: string): Promise<string> => sha256Hex(new TextEncoder().encode(raw));

/** https, or http on a loopback host for native apps (RFC 8252). */
function redirectUriProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw} is not a valid URL`;
  }
  if (url.hash) return 'redirect URIs cannot have a fragment';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return null;
  return 'redirect URIs must use https (or http on localhost)';
}

const oauthAppRowSchema = z.object({
  id: z.string(),
  client_secret_hash: z.string(),
  owner_kind: z.enum(['user', 'org']),
  owner_id: z.string(),
  name: z.string(),
  redirect_uris: z.string(),
  created_by: z.string(),
  created_at: z.number(),
});
type OAuthAppRow = z.infer<typeof oauthAppRowSchema>;

function publicOAuthApp(row: OAuthAppRow) {
  return {
    client_id: row.id,
    owner_kind: row.owner_kind,
    owner_id: row.owner_id,
    name: row.name,
    redirect_uris: z.array(z.string()).parse(JSON.parse(row.redirect_uris)),
    created_at: row.created_at,
  };
}

async function getOAuthApp(c: Context<AppEnv>, id: string): Promise<OAuthAppRow | null> {
  const row = await q1(c.env, 'SELECT * FROM oauth_apps WHERE id = ?', [id]);
  return row ? oauthAppRowSchema.parse(row) : null;
}

export const createOAuthAppSchema = z.object({
  name: z.string().trim().min(1).max(80),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
  org: z.string().min(1).optional(),
});

export const authorizeSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.literal('code').default('code'),
  scope: z.string().default(''),
  state: z.string().max(512).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
});
export const approveSchema = authorizeSchema.extend({ approve: z.boolean() });

export const codeGrantSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  /** Or HTTP Basic client authentication. */
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

export const oauthAppsRoutes = new Hono<AppEnv>();
for (const path of ['/api/v1/oauth-apps', '/api/v1/oauth-apps/*', '/api/v1/oauth/*']) {
  oauthAppsRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'private, no-store');
  });
}

oauthAppsRoutes.get('/api/v1/oauth-apps', async (c) => {
  try {
    const userId = sessionUser(c);
    const rows = await q(
      c.env,
      `SELECT * FROM oauth_apps
        WHERE (owner_kind = 'user' AND owner_id = ?)
           OR (owner_kind = 'org' AND owner_id IN (
                SELECT org_id FROM org_members WHERE user_id = ? AND role IN ('owner', 'admin')))
        ORDER BY created_at DESC`,
      [userId, userId],
    );
    return c.json({
      oauth_apps: rows.map((r) => publicOAuthApp(oauthAppRowSchema.parse(r))),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

oauthAppsRoutes.post('/api/v1/oauth-apps', async (c) => {
  try {
    const userId = sessionUser(c);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(createOAuthAppSchema, await readJsonBody(c));
    for (const uri of input.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new ApiError(400, 'invalid_redirect_uri', problem);
    }
    const owner = await resolveOwner(c, userId, input.org);
    const secret = `yagcs_${randomB64url(32)}`;
    const now = Date.now();
    const row: OAuthAppRow = {
      id: `oa_${ulid(now)}`,
      client_secret_hash: await hash(secret),
      owner_kind: owner.owner_kind,
      owner_id: owner.owner_id,
      name: input.name,
      redirect_uris: JSON.stringify(input.redirect_uris),
      created_by: userId,
      created_at: now,
    };
    await recordAudit(
      c,
      {
        action: 'oauth_app.create',
        orgId: owner.auditOrg,
        target: { client_id: row.id, name: row.name, redirect_uris: input.redirect_uris },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO oauth_apps (id, client_secret_hash, owner_kind, owner_id, name, redirect_uris,
                                   created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id,
          row.client_secret_hash,
          row.owner_kind,
          row.owner_id,
          row.name,
          row.redirect_uris,
          row.created_by,
          row.created_at,
        ),
      ],
    );
    // the client secret is returned exactly once
    return c.json({ oauth_app: publicOAuthApp(row), client_secret: secret }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Deleting an OAuth app revokes every token and code it holds. */
oauthAppsRoutes.delete('/api/v1/oauth-apps/:id', async (c) => {
  try {
    const userId = sessionUser(c);
    const app = await getOAuthApp(c, c.req.param('id'));
    const managed = app ? await canManageOwner(c.env, app, userId) : null;
    if (!app || !managed)
      return apiError(c, 404, 'oauth_app_not_found', 'OAuth app not found');
    if (app.owner_kind === 'org') await requireOrgSso(c, app.owner_id);
    await recordAudit(
      c,
      {
        action: 'oauth_app.delete',
        orgId: managed.auditOrg,
        target: { client_id: app.id },
      },
      [
        c.env.DB.prepare('DELETE FROM api_tokens WHERE oauth_app_id = ?').bind(app.id),
        c.env.DB.prepare('DELETE FROM oauth_codes WHERE app_id = ?').bind(app.id),
        c.env.DB.prepare('DELETE FROM oauth_apps WHERE id = ?').bind(app.id),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Validate an authorization request; never redirects to an unregistered URI. */
async function checkAuthorize(
  c: Context<AppEnv>,
  input: z.infer<typeof authorizeSchema>,
) {
  const app = await getOAuthApp(c, input.client_id);
  if (!app) throw new ApiError(400, 'invalid_client', 'unknown client_id');
  const uris = z.array(z.string()).parse(JSON.parse(app.redirect_uris));
  if (!uris.includes(input.redirect_uri))
    throw new ApiError(400, 'invalid_redirect_uri', 'redirect_uri is not registered');
  const scopes = [...new Set(input.scope.split(' ').filter((s) => s !== ''))];
  const unknown = scopes.find((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknown !== undefined)
    throw new ApiError(400, 'invalid_scope', `unknown scope ${unknown}`, {
      allowed: OAUTH_SCOPES,
    });
  return { app, scopes };
}

/** The consent screen's data. */
oauthAppsRoutes.get('/api/v1/oauth/authorize', async (c) => {
  try {
    sessionUser(c);
    const input = parseBody(authorizeSchema, c.req.query());
    const { app, scopes } = await checkAuthorize(c, input);
    return c.json({
      app: { client_id: app.id, name: app.name, owner_kind: app.owner_kind },
      scopes,
      redirect_uri: input.redirect_uri,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Approve (a code) or deny; returns where to send the browser. */
oauthAppsRoutes.post('/api/v1/oauth/authorize', async (c) => {
  try {
    const userId = sessionUser(c);
    const input = parseBody(approveSchema, await readJsonBody(c));
    const { app, scopes } = await checkAuthorize(c, input);
    const target = new URL(input.redirect_uri);
    if (input.state !== undefined) target.searchParams.set('state', input.state);
    if (!input.approve) {
      target.searchParams.set('error', 'access_denied');
      return c.json({ redirect_to: target.toString() });
    }
    const code = randomB64url(32);
    await recordAudit(
      c,
      { action: 'oauth.authorize', target: { client_id: app.id, scopes } },
      [
        c.env.DB.prepare(
          `INSERT INTO oauth_codes (code_hash, app_id, user_id, redirect_uri, code_challenge, scopes,
                                    auth_method, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          await hash(code),
          app.id,
          userId,
          input.redirect_uri,
          input.code_challenge,
          JSON.stringify(scopes),
          c.get('principal')?.authMethod ?? null,
          Date.now() + CODE_TTL_MS,
        ),
      ],
    );
    target.searchParams.set('code', code);
    return c.json({ redirect_to: target.toString() });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Who a token belongs to: the sign-in endpoint for OAuth apps. */
oauthAppsRoutes.get('/api/v1/user', async (c) => {
  try {
    const principal = c.get('principal');
    // agent and app installation tokens act for someone; they get no identity
    if (!principal || principal.kind === 'agent')
      return apiError(
        c,
        403,
        'insufficient_scope',
        'a user session or user token is required',
      );
    const user = await q1<{ id: string; login: string; avatar_url: string | null }>(
      c.env,
      'SELECT id, login, avatar_url FROM users WHERE id = ? AND active = 1',
      [principal.userId],
    );
    if (!user) return apiError(c, 401, 'unauthorized', 'authentication required');
    return c.json({ user });
  } catch (err) {
    return errorResponse(c, err);
  }
});

const codeRowSchema = z.object({
  app_id: z.string(),
  user_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  scopes: z.string(),
  auth_method: z.string().nullable(),
  expires_at: z.number(),
});

/** Client credentials from HTTP Basic or the body. */
function clientCredentials(
  c: Context<AppEnv>,
  input: z.infer<typeof codeGrantSchema>,
): { id: string; secret: string } | null {
  const header = c.req.header('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const colon = decoded.indexOf(':');
      if (colon > 0)
        return {
          id: decodeURIComponent(decoded.slice(0, colon)),
          secret: decodeURIComponent(decoded.slice(colon + 1)),
        };
    } catch {
      return null;
    }
  }
  return input.client_id && input.client_secret
    ? { id: input.client_id, secret: input.client_secret }
    : null;
}

/** `POST /oauth/token` with `grant_type=authorization_code`. */
export async function authorizationCodeGrant(
  c: Context<AppEnv>,
  params: unknown,
): Promise<Response> {
  const parsed = codeGrantSchema.safeParse(params);
  if (!parsed.success)
    return apiError(c, 400, 'invalid_request', 'invalid authorization code request');
  const input = parsed.data;
  const client = clientCredentials(c, input);
  const app = client ? await getOAuthApp(c, client.id) : null;
  if (!client || !app || (await hash(client.secret)) !== app.client_secret_hash)
    return apiError(c, 401, 'invalid_client', 'client authentication failed');
  // single use: the delete returns the row only to the first redemption
  const row = await c.env.DB.prepare(
    'DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *',
  )
    .bind(await hash(input.code))
    .first();
  const code = row ? codeRowSchema.parse(row) : null;
  const challenge = b64urlEncode(
    await sha256Bytes(new TextEncoder().encode(input.code_verifier)),
  );
  if (
    !code ||
    code.app_id !== app.id ||
    code.expires_at < Date.now() ||
    code.redirect_uri !== input.redirect_uri ||
    code.code_challenge !== challenge
  )
    return apiError(c, 400, 'invalid_grant', 'code is invalid, expired or already used');
  const active = await q1(c.env, 'SELECT 1 FROM users WHERE id = ? AND active = 1', [
    code.user_id,
  ]);
  if (!active) return apiError(c, 400, 'invalid_grant', 'the user is no longer active');
  const scopes = z.array(z.string()).parse(JSON.parse(code.scopes));
  const created = await createApiToken(c.env, code.user_id, {
    label: `OAuth: ${app.name}`,
    scopes,
    expiresAt: Date.now() + TOKEN_TTL_S * 1000,
    authMethod: code.auth_method,
    oauthAppId: app.id,
  });
  await recordAudit(c, {
    action: 'oauth.token.issue',
    actor: { kind: 'user', id: code.user_id },
    target: { client_id: app.id, token_id: created.id, scopes },
  });
  return c.json(
    {
      access_token: created.raw,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_S,
      scope: scopes.join(' '),
    },
    200,
    { 'cache-control': 'no-store' },
  );
}

/**
 * `POST /oauth/token` for apps (JWT bearer) and OAuth apps (authorization
 * code). Mounted before agents.ts, whose handler takes the token exchange.
 */
oauthAppsRoutes.post('/oauth/token', async (c, next) => {
  try {
    const params: unknown = (c.req.header('content-type') ?? '').includes(
      'application/json',
    )
      ? await readJsonBody(c)
      : await c.req.parseBody({ all: true });
    const grant = (params as { grant_type?: unknown } | null)?.grant_type;
    if (grant === JWT_BEARER_GRANT) return await appTokenGrant(c, params);
    if (grant === 'authorization_code') return await authorizationCodeGrant(c, params);
  } catch (err) {
    return errorResponse(c, err);
  }
  await next();
});
