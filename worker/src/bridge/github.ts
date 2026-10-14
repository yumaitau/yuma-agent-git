import { Hono } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseRepoRow, q1, run, type RepoRecord } from '../db/client';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { RequestValidationError } from '../core/errors';
import { ulid } from '../core/ids';
import type { AppEnv } from '../auth/principal';
import { z } from 'zod';

/**
 * GitHub App bridge (issue #13): app JWT + installation tokens minted
 * server-side with pure WebCrypto (no node deps), installation lifecycle in
 * D1, and the repo-connect handshake.
 */

const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'yuma-agent-git';

// ---------------------------------------------------------------------------
// App JWT (RS256, pure WebCrypto)
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PEM import is expensive — cache per isolate, keyed on the key material.
let importedKey: CryptoKey | null = null;
let importedKeySource = '';

async function importAppKey(pem: string): Promise<CryptoKey> {
  if (importedKey && importedKeySource === pem) return importedKey;
  const der = pemToDer(pem);
  importedKey = await crypto.subtle.importKey(
    'pkcs8',
    der as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  importedKeySource = pem;
  return importedKey;
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** GitHub App JWT: `iat` backdated 60s for clock skew, `exp` ≤ 10 minutes. */
export async function appJwt(env: Env, now: number = Date.now()): Promise<string> {
  const key = env.GITHUB_APP_PRIVATE_KEY;
  const appId = env.GITHUB_APP_ID;
  if (!key || !appId) {
    throw new RequestValidationError(
      'GitHub App is not configured',
      {},
      'not_configured',
    );
  }
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
  );
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: appId,
        iat: Math.floor(now / 1000) - 60,
        exp: Math.floor(now / 1000) + 540,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importAppKey(key),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Installation tokens (best-effort per-isolate cache)
// ---------------------------------------------------------------------------

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

export function clearInstallationToken(installationId: number): void {
  tokenCache.delete(installationId);
}

export async function installationToken(
  env: Env,
  installationId: number,
  permissions?: Record<string, string>,
  now: number = Date.now(),
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token;

  const jwt = await appJwt(env, now);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': USER_AGENT,
      },
      body: permissions ? JSON.stringify({ permissions }) : undefined,
    },
  );
  if (!res.ok) {
    throw new Error(`installation token mint failed: ${res.status}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  });
  return body.token;
}

/** Authenticated GitHub API call as the app installation (re-auths on 401). */
export async function githubApi(
  env: Env,
  installationId: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const call = async (token: string): Promise<Response> =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': USER_AGENT,
      },
    });

  let res = await call(await installationToken(env, installationId));
  if (res.status === 401) {
    // stale cache entry — always re-fetch on 401
    clearInstallationToken(installationId);
    res = await call(await installationToken(env, installationId));
  }
  return res;
}

// ---------------------------------------------------------------------------
// Installation lifecycle (webhook side)
// ---------------------------------------------------------------------------

export interface GithubRepoRef {
  id: number;
  full_name: string;
  private?: boolean;
}

/**
 * Upsert/remove installation rows from webhook payloads. `deleted` also
 * disconnects every repo tied to the installation.
 */
export async function handleInstallationEvent(
  env: Env,
  payload: unknown,
  now: number = Date.now(),
): Promise<void> {
  const parsed = z
    .object({
      action: z.string(),
      installation: z.object({
        id: z.number(),
        account: z.object({ login: z.string(), id: z.number() }),
      }),
      repositories: z
        .array(
          z.object({
            id: z.number(),
            full_name: z.string(),
            private: z.boolean().optional(),
          }),
        )
        .optional(),
      repositories_added: z
        .array(
          z.object({
            id: z.number(),
            full_name: z.string(),
            private: z.boolean().optional(),
          }),
        )
        .optional(),
      repositories_removed: z
        .array(
          z.object({
            id: z.number(),
            full_name: z.string(),
            private: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .safeParse(payload);
  if (!parsed.success) return; // not an installation payload — inert
  const event = parsed.data;

  if (event.action === 'deleted') {
    await run(env, `DELETE FROM ${T.installations} WHERE installation_id = ?`, [
      event.installation.id,
    ]);
    await run(
      env,
      `UPDATE ${T.repos} SET ${C.repos.githubInstallationId} = NULL, ${C.repos.githubRepoId} = NULL
        WHERE ${C.repos.githubInstallationId} = ?`,
      [event.installation.id],
    );
    return;
  }

  const existing = await q1(
    env,
    `SELECT * FROM ${T.installations} WHERE installation_id = ?`,
    [event.installation.id],
  );
  let repos: GithubRepoRef[] = existing
    ? (JSON.parse((existing as { repos: string }).repos) as GithubRepoRef[])
    : [];
  if (event.action === 'repositories_added') {
    repos = [...repos, ...(event.repositories_added ?? [])];
  } else if (event.action === 'repositories_removed') {
    const removed = new Set((event.repositories_removed ?? []).map((r) => r.id));
    repos = repos.filter((r) => !removed.has(r.id));
  } else if (event.repositories) {
    repos = event.repositories;
  }

  await run(
    env,
    `INSERT INTO ${T.installations} (installation_id, account_login, account_id, repos, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (installation_id) DO UPDATE SET
       account_login = excluded.account_login,
       account_id = excluded.account_id,
       repos = excluded.repos,
       updated_at = excluded.updated_at`,
    [
      event.installation.id,
      event.installation.account.login,
      event.installation.account.id,
      JSON.stringify(repos),
      now,
    ],
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const githubRoutes = new Hono<AppEnv>();

/** Session-authed: send the human to the GitHub App install flow. */
githubRoutes.get('/api/v1/github/install-url', (c) => {
  if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
  const slug = c.env.GITHUB_APP_SLUG ?? 'yuma-agent-git';
  const csrf = ulid();
  return c.redirect(
    `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(csrf)}`,
    302,
  );
});

/** GitHub redirects here after installation — records pending install intent. */
githubRoutes.get('/auth/github/install-callback', (c) => {
  // The installation itself arrives via webhook; the callback just confirms.
  return c.json({ ok: true, state: c.req.query('state') ?? null });
});

const connectSchema = z.object({
  installation_id: z.number().int(),
  github_repo_id: z.number().int(),
});

/**
 * Connect a yag repo to a GitHub repo through the App installation: verify the
 * installation exists and that the requester's installation holds admin on the
 * GitHub repo before recording the link.
 */
githubRoutes.post('/api/v1/repos/:repo{.+}/connect', async (c) => {
  try {
    if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
    // repo admin required on the yag side too (issue #14)
    const { loadAdminRepo } = await import('../auth/guards');
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const body = await readJsonBody(c);
    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid connect request');
    }
    const { installation_id: installationId, github_repo_id: githubRepoId } = parsed.data;

    // 1. the installation must exist
    const installationRes = await githubApi(c.env, installationId, '/installation');
    if (!installationRes.ok) {
      return apiError(c, 400, 'unknown_installation', 'GitHub installation not found');
    }

    // 2. the installation must hold admin on the target repo
    const repoRes = await githubApi(
      c.env,
      installationId,
      `/repositories/${githubRepoId}`,
    );
    if (!repoRes.ok) {
      return apiError(c, 400, 'unknown_github_repo', 'GitHub repository not reachable');
    }
    const repoInfo = (await repoRes.json()) as {
      full_name: string;
      permissions?: { admin?: boolean };
    };
    const permsRes = await githubApi(
      c.env,
      installationId,
      `/repos/${repoInfo.full_name}`,
    );
    const perms = permsRes.ok
      ? ((await permsRes.json()) as { permissions?: { admin?: boolean } })
      : repoInfo;
    if (!perms.permissions?.admin) {
      return apiError(
        c,
        403,
        'not_admin',
        'admin permission on the GitHub repo required',
      );
    }

    await run(
      c.env,
      `UPDATE ${T.repos}
         SET ${C.repos.githubInstallationId} = ?, ${C.repos.githubRepoId} = ?
         WHERE ${C.repos.id} = ?`,
      [installationId, githubRepoId, repo.id],
    );
    const updated = await q1(c.env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
      repo.id,
    ]);
    return c.json({ ok: true, repo: updated ? parseRepoRow(updated) : repo });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export type { RepoRecord };
