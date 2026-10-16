import { Hono } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { apiError, errorResponse } from '../api/errors';
import { sha256Hex } from '../core/hashing';
import {
  createSession,
  githubEmailsSchema,
  githubUserSchema,
  loginStateCookie,
  loginStateMatches,
  randomHex,
  revokeSessionToken,
  sessionCookie,
  sessionTokenFrom,
  SESSION_COOKIE,
  upsertUser,
} from './session';
import { oidcProviders } from './oidc';
import type { AppEnv } from './principal';
import { recordAudit } from '../audit/record';

/**
 * GitHub OAuth web flow (issue #12) — entirely on the Worker.
 *
 * `GET /auth/github` mints a single-use state (32 random bytes, stored as a
 * SHA-256 hash with a 10-minute TTL), binds it to this browser with a cookie
 * and redirects to GitHub. The callback requires that cookie, verifies +
 * deletes the state BEFORE doing anything else, exchanges the code, upserts
 * the user, and sets an HttpOnly session cookie. The raw session token never
 * touches D1 — only its hash.
 */

export const authRoutes = new Hono<AppEnv>();

const STATE_TTL_MS = 10 * 60 * 1000;

function baseUrl(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

function requireGithubEnv(env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

authRoutes.get('/auth/status', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    github_configured: requireGithubEnv(c.env) !== null,
    providers: oidcProviders(c.env).map((p) => ({ id: p.id, name: p.name })),
  });
});

authRoutes.get('/auth/github', async (c) => {
  try {
    const creds = requireGithubEnv(c.env);
    if (!creds) {
      return apiError(c, 500, 'not_configured', 'GitHub OAuth is not configured');
    }
    const state = randomHex(32);
    const now = Date.now();
    // opportunistic purge of expired states
    await run(
      c.env,
      `DELETE FROM ${T.oauthStates} WHERE ${C.oauthStates.expiresAt} < ?`,
      [now],
    );
    await run(
      c.env,
      `INSERT INTO ${T.oauthStates} (${C.oauthStates.stateHash}, ${C.oauthStates.createdAt}, ${C.oauthStates.expiresAt}) VALUES (?, ?, ?)`,
      [await sha256Hex(new TextEncoder().encode(state)), now, now + STATE_TTL_MS],
    );

    const redirectUri = `${baseUrl(c.req.url)}/auth/github/callback`;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('allow_signup', 'true');
    c.header('set-cookie', loginStateCookie(c.req.url, state));
    return c.redirect(url.toString(), 302);
  } catch (err) {
    return errorResponse(c, err);
  }
});

authRoutes.get('/auth/github/callback', async (c) => {
  try {
    const creds = requireGithubEnv(c.env);
    if (!creds) {
      return apiError(c, 500, 'not_configured', 'GitHub OAuth is not configured');
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return apiError(c, 400, 'invalid_request', 'code and state are required');
    }
    if (!loginStateMatches(c.req.header('cookie'), state)) {
      return apiError(c, 400, 'invalid_state', 'sign-in was not started in this browser');
    }

    // single-use state: verify + delete BEFORE any token exchange
    const stateHash = await sha256Hex(new TextEncoder().encode(state));
    const stateRow = await q1(
      c.env,
      `SELECT * FROM ${T.oauthStates} WHERE ${C.oauthStates.stateHash} = ?`,
      [stateHash],
    );
    await run(
      c.env,
      `DELETE FROM ${T.oauthStates} WHERE ${C.oauthStates.stateHash} = ?`,
      [stateHash],
    );
    if (!stateRow) {
      return apiError(c, 400, 'invalid_state', 'unknown or reused oauth state');
    }
    if ((stateRow as { expires_at: number }).expires_at < Date.now()) {
      return apiError(c, 400, 'invalid_state', 'expired oauth state');
    }

    // exchange the code
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
      }),
    });
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    if (!tokenRes.ok || !tokenBody.access_token) {
      return apiError(c, 502, 'oauth_exchange_failed', 'GitHub token exchange failed');
    }

    const headers = {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'yuma-agent-git',
    };
    const userRes = await fetch('https://api.github.com/user', { headers });
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
    if (!userRes.ok || !emailsRes.ok) {
      return apiError(c, 502, 'github_api_failed', 'GitHub profile fetch failed');
    }
    const githubUser = githubUserSchema.parse(await userRes.json());
    const emails = githubEmailsSchema.parse(await emailsRes.json());
    const primary = emails.find((e) => e.primary) ?? emails[0];

    const user = await upsertUser(c.env, {
      id: githubUser.id,
      login: githubUser.login,
      avatar_url: githubUser.avatar_url,
      email: primary?.email,
    });

    if (user.active === 0) {
      return apiError(c, 403, 'account_disabled', 'this account has been deprovisioned');
    }

    const session = await createSession(c.env, user.id, Date.now(), { method: 'github' });
    await recordAudit(c, {
      action: 'auth.login',
      actor: { kind: 'user', id: user.id },
      target: { user_id: user.id, login: user.login, method: 'github' },
    });
    const response = new Headers({ location: '/' });
    response.append('set-cookie', sessionCookie(c.req.url, session.token));
    response.append('set-cookie', loginStateCookie(c.req.url, null));
    return new Response(null, { status: 302, headers: response });
  } catch (err) {
    return errorResponse(c, err);
  }
});

authRoutes.post('/auth/logout', async (c) => {
  try {
    const token = sessionTokenFrom(c.req.header('cookie'));
    if (token) await revokeSessionToken(c.env, token);
    const user = c.get('user');
    if (user)
      await recordAudit(c, { action: 'auth.logout', target: { user_id: user.id } });
    return c.json({ ok: true }, 200, {
      'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
