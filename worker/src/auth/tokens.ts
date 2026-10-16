import { z } from 'zod';
import { Hono } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q, q1, run } from '../db/client';
import { RequestValidationError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import type { AppEnv, Principal } from './principal';
import { recordAudit } from '../audit/record';
import { requireRecentMfa } from './session';
import { AGENT_TOKEN_PREFIX, resolveAgentToken } from './agents';
import { APP_TOKEN_PREFIX, resolveAppToken } from './app-tokens';

/**
 * Machine/agent API tokens (issue #12): `yag_` + 40 hex chars, SHA-256 at
 * rest, raw value shown exactly once at creation. Bearer resolution feeds the
 * principal middleware; scopes are what RBAC (#14) checks.
 */

export const TOKEN_PREFIX = 'yag_';
export const TOKEN_SCOPES = [
  'repo:read',
  'repo:write',
  'agent:run',
  'audit:read',
] as const;
/** Scopes a token gets when none are requested; `audit:read` is opt-in. */
const DEFAULT_SCOPES = ['repo:read', 'repo:write', 'agent:run'];

const tokenRowSchema = z.object({
  id: z.string(),
  token_hash: z.string(),
  repo_id: z.string().nullable(),
  user_id: z.string(),
  label: z.string(),
  scopes: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable().optional(),
  expires_at: z.number().nullable().optional(),
  auth_method: z.string().nullable().optional(),
});

export interface ApiTokenMetadata {
  id: string;
  label: string;
  scopes: string[];
  repo_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createApiToken(
  env: Env,
  userId: string,
  opts: {
    label: string;
    scopes?: string[];
    repoId?: string | null;
    expiresAt?: number | null;
    /** How the minting session signed in (org SSO checks it). */
    authMethod?: string | null;
    /** OAuth app holding the token (#75); such a token may have no scopes (sign-in only). */
    oauthAppId?: string;
    now?: number;
  },
): Promise<{ id: string; raw: string; metadata: ApiTokenMetadata }> {
  const now = opts.now ?? Date.now();
  const scopes = (opts.scopes ?? DEFAULT_SCOPES).filter((s) =>
    (TOKEN_SCOPES as readonly string[]).includes(s),
  );
  if (scopes.length === 0 && opts.oauthAppId === undefined) {
    throw new RequestValidationError('scopes must be a subset of token scopes', {
      allowed: TOKEN_SCOPES,
    });
  }
  const raw = `${TOKEN_PREFIX}${randomHex(20)}`; // yag_ + 40 hex chars
  const id = ulid(now);
  const row = {
    id,
    token_hash: await sha256Hex(new TextEncoder().encode(raw)),
    repo_id: opts.repoId ?? null,
    user_id: userId,
    label: opts.label,
    scopes: JSON.stringify(scopes),
    created_at: now,
    last_used_at: null,
    expires_at: opts.expiresAt ?? null,
    auth_method: opts.authMethod ?? null,
    oauth_app_id: opts.oauthAppId ?? null,
  };
  await run(
    env,
    `INSERT INTO ${T.apiTokens}
       (id, token_hash, repo_id, user_id, label, scopes, created_at, last_used_at, expires_at, auth_method,
        oauth_app_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.token_hash,
      row.repo_id,
      row.user_id,
      row.label,
      row.scopes,
      row.created_at,
      row.last_used_at,
      row.expires_at,
      row.auth_method,
      row.oauth_app_id,
    ],
  );
  return {
    id,
    raw,
    metadata: {
      id,
      label: row.label,
      scopes,
      repo_id: row.repo_id,
      created_at: row.created_at,
      last_used_at: null,
      expires_at: row.expires_at,
    },
  };
}

export async function listApiTokens(
  env: Env,
  userId: string,
): Promise<ApiTokenMetadata[]> {
  const rows = await q(
    env,
    `SELECT * FROM ${T.apiTokens} WHERE ${C.apiTokens.userId} = ? ORDER BY ${C.apiTokens.createdAt} DESC`,
    [userId],
  );
  return rows.map((raw) => {
    const row = tokenRowSchema.parse(raw);
    return {
      id: row.id,
      label: row.label,
      scopes: JSON.parse(row.scopes) as string[],
      repo_id: row.repo_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? null,
      expires_at: row.expires_at ?? null,
    };
  });
}

export async function deleteApiToken(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const existing = await q1(
    env,
    `SELECT * FROM ${T.apiTokens} WHERE ${C.apiTokens.id} = ?`,
    [id],
  );
  if (!existing || (existing as { user_id: string }).user_id !== userId) return false;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${T.apiTokens} WHERE ${C.apiTokens.id} = ?`).bind(id),
    // agent tokens exchanged from it stop resolving anyway; drop them from live counts
    env.DB.prepare('DELETE FROM agent_tokens WHERE subject_token_id = ?').bind(id),
  ]);
  return true;
}

/** Resolve a raw API, agent or app installation token to a principal (null if unknown/expired). */
export async function resolveTokenPrincipal(
  env: Env,
  raw: string,
): Promise<Principal | null> {
  if (raw.startsWith(AGENT_TOKEN_PREFIX)) return resolveAgentToken(env, raw);
  if (raw.startsWith(APP_TOKEN_PREFIX)) return resolveAppToken(env, raw);
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(new TextEncoder().encode(raw));
  const row = await q1(
    env,
    `SELECT * FROM ${T.apiTokens} WHERE ${C.apiTokens.tokenHash} = ?`,
    [hash],
  );
  if (!row) return null;
  const token = tokenRowSchema.parse(row);
  if (token.expires_at != null && token.expires_at < Date.now()) return null;
  return {
    kind: 'token',
    userId: token.user_id,
    tokenId: token.id,
    scopes: JSON.parse(token.scopes) as string[],
    repoId: token.repo_id,
    authMethod: token.auth_method ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes — session-authenticated (humans manage their own machines' tokens)
// ---------------------------------------------------------------------------

export const tokensRoutes = new Hono<AppEnv>();

export const createTokenSchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(z.enum(TOKEN_SCOPES)).optional(),
  repo_id: z.string().min(1).nullable().optional(),
  expires_at: z.number().int().nullable().optional(),
});

tokensRoutes.post('/api/v1/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    // REQUIRE_MFA_FOR_TOKENS=true also refuses users with no factor enrolled;
    // off by default so GitHub-only users are not locked out
    const mfa = await requireRecentMfa(c, {
      strict: c.env.REQUIRE_MFA_FOR_TOKENS === 'true',
    });
    if (mfa) return mfa;
    const body = await readJsonBody(c);
    const parsed = createTokenSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid token request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const created = await createApiToken(c.env, user.id, {
      label: parsed.data.label,
      scopes: parsed.data.scopes,
      repoId: parsed.data.repo_id,
      expiresAt: parsed.data.expires_at,
      authMethod: c.get('principal')?.authMethod ?? null,
    });
    await recordAudit(c, {
      action: 'token.create',
      target: {
        token_id: created.id,
        label: created.metadata.label,
        scopes: created.metadata.scopes,
        repo_id: created.metadata.repo_id,
        expires_at: created.metadata.expires_at,
      },
    });
    // raw token is returned exactly once — never retrievable again
    return c.json({ ...created.metadata, token: created.raw }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

tokensRoutes.get('/api/v1/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    return c.json({ tokens: await listApiTokens(c.env, user.id) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

tokensRoutes.delete('/api/v1/tokens/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const removed = await deleteApiToken(c.env, user.id, c.req.param('id'));
    if (!removed) {
      return apiError(c, 404, 'token_not_found', `no token ${c.req.param('id')}`);
    }
    await recordAudit(c, {
      action: 'token.revoke',
      target: { token_id: c.req.param('id') },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
