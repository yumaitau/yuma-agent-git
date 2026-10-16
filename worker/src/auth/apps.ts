import { z } from 'zod';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { getRepo } from '../db/repos';
import { ulid } from '../core/ids';
import { ApiError } from '../core/errors';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { createHook, hookInputSchema } from '../api/hooks';
import { recordAudit } from '../audit/record';
import { APP_READ_SCOPES } from '../webhooks/events';
import { AGENT_SCOPES } from './agents';
import { b64urlDecode, b64urlEncode } from './encoding';
import { loadWholeRepo } from './guards';
import type { AppEnv } from './principal';
import { requireRecentMfa } from './session';
import { APP_TOKEN_PREFIX, hashAppToken, installationPaused } from './app-tokens';
import {
  canManageOwner,
  parseBody,
  requireOrgSso,
  resolveOwner,
  sessionUser,
} from './owners';

/**
 * Apps (issue #75), modelled on GitHub Apps. An app belongs to a user or an
 * org, holds fine-grained permissions from the agent scopes (#57) and may
 * have its own webhook. Creating one returns an RSA private key exactly once;
 * only the public key is kept. A repo admin installs the app on named
 * repositories. The app signs a JWT (RS256, `iss` = app id, at most 10
 * minutes) and exchanges it at `POST /oauth/token` with the JWT bearer grant
 * (RFC 7523) for an installation token: `yagis_`, one hour, SHA-256 at rest.
 *
 * An installation token is an agent principal acting for the installer, so it
 * gets the intersection of the app's permissions, the installed repos and
 * the installer's own access, with the agent rules: path rules, org SSO
 * (through the installer's sign-in method), no default branch moves and no
 * merges. Removing the installation, or the installer being deprovisioned,
 * stops its tokens on the next request.
 */

export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TTL_S = 60 * 60;
const MAX_JWT_S = 10 * 60;

// --- apps -----------------------------------------------------------------------

const appRowSchema = z.object({
  id: z.string(),
  owner_kind: z.enum(['user', 'org']),
  owner_id: z.string(),
  name: z.string(),
  permissions: z.string(),
  public_key: z.string(),
  created_by: z.string(),
  created_at: z.number(),
});
type AppRow = z.infer<typeof appRowSchema>;

function publicApp(row: AppRow) {
  return {
    id: row.id,
    owner_kind: row.owner_kind,
    owner_id: row.owner_id,
    name: row.name,
    permissions: z.array(z.string()).parse(JSON.parse(row.permissions)),
    created_at: row.created_at,
  };
}

async function getApp(env: Env, id: string): Promise<AppRow | null> {
  const row = await q1(env, 'SELECT * FROM apps WHERE id = ?', [id]);
  return row ? appRowSchema.parse(row) : null;
}

/** The app in the path when the caller manages it, else a 404. */
async function loadManagedApp(c: Context<AppEnv>) {
  const userId = sessionUser(c);
  const app = await getApp(c.env, c.req.param('id') ?? '');
  const managed = app ? await canManageOwner(c.env, app, userId) : null;
  if (!app || !managed) throw new ApiError(404, 'app_not_found', 'App not found');
  if (app.owner_kind === 'org') await requireOrgSso(c, app.owner_id);
  return { app, auditOrg: managed.auditOrg };
}

function pem(der: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export const createAppSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.enum(AGENT_SCOPES)).min(1),
  /** Org slug for an org-owned app; omitted means owned by the caller. */
  org: z.string().min(1).optional(),
  /** The app's own webhook, sent for every repository it is installed on. */
  webhook: hookInputSchema.optional(),
});
export const installAppSchema = z.object({
  /** Repo slugs (`owner/name`); the caller must administer each one. */
  repos: z.array(z.string().min(1)).min(1).max(100),
});

export const appsRoutes = new Hono<AppEnv>();
for (const path of [
  '/api/v1/apps',
  '/api/v1/apps/*',
  '/api/v1/installations',
  '/api/v1/installations/*',
]) {
  appsRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'private, no-store');
  });
}

appsRoutes.get('/api/v1/apps', async (c) => {
  try {
    const userId = sessionUser(c);
    const rows = await q(
      c.env,
      `SELECT * FROM apps
        WHERE (owner_kind = 'user' AND owner_id = ?)
           OR (owner_kind = 'org' AND owner_id IN (
                SELECT org_id FROM org_members WHERE user_id = ? AND role IN ('owner', 'admin')))
        ORDER BY created_at DESC`,
      [userId, userId],
    );
    return c.json({ apps: rows.map((r) => publicApp(appRowSchema.parse(r))) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

appsRoutes.post('/api/v1/apps', async (c) => {
  try {
    const userId = sessionUser(c);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(createAppSchema, await readJsonBody(c));
    if (input.webhook && !input.permissions.some((p) => APP_READ_SCOPES.includes(p)))
      throw new ApiError(
        400,
        'insufficient_permissions',
        'An app webhook needs contents:read: it sends what the app could read',
      );
    const owner = await resolveOwner(c, userId, input.org);
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const privateKey = pem(
      new Uint8Array(
        (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
      ),
    );
    const now = Date.now();
    const row: AppRow = {
      id: `app_${ulid(now)}`,
      owner_kind: owner.owner_kind,
      owner_id: owner.owner_id,
      name: input.name,
      permissions: JSON.stringify([...new Set(input.permissions)]),
      public_key: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e }),
      created_by: userId,
      created_at: now,
    };
    await recordAudit(
      c,
      {
        action: 'app.create',
        orgId: owner.auditOrg,
        target: { app_id: row.id, name: row.name, permissions: input.permissions },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO apps (id, owner_kind, owner_id, name, permissions, public_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id,
          row.owner_kind,
          row.owner_id,
          row.name,
          row.permissions,
          row.public_key,
          row.created_by,
          row.created_at,
        ),
      ],
    );
    const webhook = input.webhook
      ? await createHook(
          c,
          { scope: 'app', id: row.id, keyOwner: `app:${row.id}` },
          input.webhook,
          {
            orgId: owner.auditOrg,
          },
        )
      : undefined;
    // the private key is returned exactly once and never stored
    return c.json({ app: publicApp(row), private_key: privateKey, webhook }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

appsRoutes.get('/api/v1/apps/:id', async (c) => {
  try {
    const { app } = await loadManagedApp(c);
    const [installations, hooks] = await Promise.all([
      q(
        c.env,
        `SELECT i.id, i.installed_by, i.created_at,
                (SELECT json_group_array(repo_id) FROM app_installation_repos r
                  WHERE r.installation_id = i.id) AS repo_ids
           FROM app_installations i WHERE i.app_id = ? ORDER BY i.created_at`,
        [app.id],
      ),
      q<{ id: string }>(
        c.env,
        "SELECT id FROM webhooks WHERE scope = 'app' AND owner_id = ?",
        [app.id],
      ),
    ]);
    return c.json({
      app: publicApp(app),
      installations: installations.map((i) => ({
        ...i,
        repo_ids: JSON.parse(String(i['repo_ids'])) as string[],
      })),
      hook_ids: hooks.map((h) => h.id),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

appsRoutes.delete('/api/v1/apps/:id', async (c) => {
  try {
    const { app, auditOrg } = await loadManagedApp(c);
    const db = c.env.DB;
    const installs = 'SELECT id FROM app_installations WHERE app_id = ?';
    await recordAudit(
      c,
      { action: 'app.delete', orgId: auditOrg, target: { app_id: app.id } },
      [
        db
          .prepare(`DELETE FROM app_tokens WHERE installation_id IN (${installs})`)
          .bind(app.id),
        db
          .prepare(
            `DELETE FROM app_installation_repos WHERE installation_id IN (${installs})`,
          )
          .bind(app.id),
        db.prepare('DELETE FROM app_installations WHERE app_id = ?').bind(app.id),
        db
          .prepare(
            `DELETE FROM webhook_deliveries_out WHERE webhook_id IN
             (SELECT id FROM webhooks WHERE scope = 'app' AND owner_id = ?)`,
          )
          .bind(app.id),
        db
          .prepare("DELETE FROM webhooks WHERE scope = 'app' AND owner_id = ?")
          .bind(app.id),
        db.prepare('DELETE FROM apps WHERE id = ?').bind(app.id),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Install an app on repositories the caller administers (the whole repository). */
appsRoutes.post('/api/v1/apps/:id/installations', async (c) => {
  try {
    const userId = sessionUser(c);
    const app = await getApp(c.env, c.req.param('id'));
    if (!app) return apiError(c, 404, 'app_not_found', 'App not found');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(installAppSchema, await readJsonBody(c));
    const repos = [];
    for (const slug of new Set(input.repos)) {
      const loaded = await loadWholeRepo(c, 'admin', slug);
      if (!loaded.ok) return loaded.response;
      repos.push(loaded.repo);
    }
    const now = Date.now();
    const id = `inst_${ulid(now)}`;
    const db = c.env.DB;
    const changes = [
      db
        .prepare(
          'INSERT INTO app_installations (id, app_id, installed_by, auth_method, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, app.id, userId, c.get('principal')?.authMethod ?? null, now),
      ...repos.map((r) =>
        db
          .prepare(
            'INSERT INTO app_installation_repos (installation_id, repo_id) VALUES (?, ?)',
          )
          .bind(id, r.id),
      ),
    ];
    // one event per repo so each owner's chain shows it; the first carries the change
    for (const [i, repo] of repos.entries()) {
      await recordAudit(
        c,
        {
          action: 'app.install',
          repo,
          target: {
            app_id: app.id,
            installation_id: id,
            repo_ids: repos.map((r) => r.id),
          },
        },
        i === 0 ? changes : [],
      );
    }
    return c.json(
      {
        installation: {
          id,
          app_id: app.id,
          installed_by: userId,
          repos: repos.map((r) => r.slug),
          created_at: now,
        },
      },
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

appsRoutes.get('/api/v1/installations', async (c) => {
  try {
    const userId = sessionUser(c);
    const rows = await q(
      c.env,
      `SELECT i.id, i.app_id, a.name AS app_name, i.created_at,
              (SELECT json_group_array(repo_id) FROM app_installation_repos r
                WHERE r.installation_id = i.id) AS repo_ids
         FROM app_installations i JOIN apps a ON a.id = i.app_id
        WHERE i.installed_by = ? ORDER BY i.created_at DESC`,
      [userId],
    );
    return c.json({
      installations: rows.map((i) => ({
        ...i,
        repo_ids: JSON.parse(String(i['repo_ids'])) as string[],
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** The installer or the app's managers remove an installation; its tokens stop at once. */
appsRoutes.delete('/api/v1/installations/:id', async (c) => {
  try {
    const userId = sessionUser(c);
    const install = await q1<{ id: string; app_id: string; installed_by: string }>(
      c.env,
      'SELECT id, app_id, installed_by FROM app_installations WHERE id = ?',
      [c.req.param('id')],
    );
    const app = install ? await getApp(c.env, install.app_id) : null;
    const allowed =
      install !== null &&
      (install.installed_by === userId ||
        (app !== null && (await canManageOwner(c.env, app, userId)) !== null));
    if (!install || !allowed)
      return apiError(c, 404, 'installation_not_found', 'Installation not found');
    const db = c.env.DB;
    await recordAudit(
      c,
      {
        action: 'app.uninstall',
        target: { app_id: install.app_id, installation_id: install.id },
      },
      [
        db.prepare('DELETE FROM app_tokens WHERE installation_id = ?').bind(install.id),
        db
          .prepare('DELETE FROM app_installation_repos WHERE installation_id = ?')
          .bind(install.id),
        db.prepare('DELETE FROM app_installations WHERE id = ?').bind(install.id),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- installation tokens --------------------------------------------------------

export const appTokenGrantSchema = z.object({
  grant_type: z.literal(JWT_BEARER_GRANT),
  /** The app's JWT: RS256, `iss` = app id, `exp` at most 10 minutes after `iat`. */
  assertion: z.string().min(1),
  installation_id: z.string().min(1),
  /** Space-separated subset of the app's permissions; default all of them. */
  scope: z.string().optional(),
});

const jwtClaimsSchema = z.object({ iss: z.string(), iat: z.number(), exp: z.number() });

/** The app a JWT names, when its signature and lifetime check out. */
async function verifyAppJwt(env: Env, jwt: string, now: number): Promise<AppRow | null> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  try {
    z.object({ alg: z.literal('RS256') }).parse(
      JSON.parse(new TextDecoder().decode(b64urlDecode(header))),
    );
    const claims = jwtClaimsSchema.parse(
      JSON.parse(new TextDecoder().decode(b64urlDecode(payload))),
    );
    const seconds = now / 1000;
    if (claims.exp <= seconds || claims.iat > seconds + 60) return null;
    if (claims.exp - claims.iat > MAX_JWT_S + 60) return null;
    const app = await getApp(env, claims.iss);
    if (!app) return null;
    const key = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(app.public_key) as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlDecode(signature) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return valid ? app : null;
  } catch {
    return null;
  }
}

/** `POST /oauth/token` with the JWT bearer grant: an installation token. */
export async function appTokenGrant(
  c: Context<AppEnv>,
  params: unknown,
): Promise<Response> {
  const parsed = appTokenGrantSchema.safeParse(params);
  if (!parsed.success)
    return apiError(c, 400, 'invalid_request', 'invalid installation token request');
  const input = parsed.data;
  const now = Date.now();
  const app = await verifyAppJwt(c.env, input.assertion, now);
  if (!app) return apiError(c, 401, 'invalid_client', 'app JWT is invalid or expired');
  const install = await q1<{ id: string; installed_by: string }>(
    c.env,
    `SELECT i.id, i.installed_by FROM app_installations i JOIN users u ON u.id = i.installed_by
      WHERE i.id = ? AND i.app_id = ? AND u.active = 1`,
    [input.installation_id, app.id],
  );
  if (!install)
    return apiError(c, 400, 'invalid_grant', 'installation not found for this app');
  if (await installationPaused(c.env, install.id))
    return apiError(c, 403, 'agents_paused', 'agents are paused for this installation');
  const permissions = z.array(z.string()).parse(JSON.parse(app.permissions));
  const scopes = input.scope
    ? [...new Set(input.scope.split(' ').filter((s) => s !== ''))]
    : permissions;
  const denied = scopes.find((s) => !permissions.includes(s));
  if (denied !== undefined || scopes.length === 0)
    return apiError(
      c,
      400,
      'invalid_scope',
      `scope ${denied ?? ''} is not granted to the app`,
      {
        allowed: permissions,
      },
    );
  const repoIds = (
    await q<{ repo_id: string }>(
      c.env,
      'SELECT repo_id FROM app_installation_repos WHERE installation_id = ?',
      [install.id],
    )
  ).map((r) => r.repo_id);
  const raw = `${APP_TOKEN_PREFIX}${b64urlEncode(crypto.getRandomValues(new Uint8Array(30)))}`;
  const insert = c.env.DB.prepare(
    'INSERT INTO app_tokens (token_hash, installation_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(
    await hashAppToken(raw),
    install.id,
    JSON.stringify(scopes),
    now,
    now + TOKEN_TTL_S * 1000,
  );
  const repos = [];
  for (const id of repoIds) {
    const repo = await getRepo(c.env, id);
    if (repo) repos.push(repo);
  }
  const actor = { kind: 'agent' as const, id: app.id, onBehalfOf: install.installed_by };
  const target = {
    app_id: app.id,
    installation_id: install.id,
    scopes,
    repo_ids: repoIds,
  };
  if (repos.length === 0) {
    await recordAudit(c, { action: 'app.token.issue', actor, target }, [insert]);
  }
  for (const [i, repo] of repos.entries()) {
    await recordAudit(
      c,
      { action: 'app.token.issue', repo, actor, target },
      i === 0 ? [insert] : [],
    );
  }
  return c.json(
    {
      access_token: raw,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_S,
      scope: scopes.join(' '),
      repositories: repos.map((r) => r.slug),
    },
    200,
    { 'cache-control': 'no-store' },
  );
}
