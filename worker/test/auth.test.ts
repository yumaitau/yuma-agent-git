import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, q1, run } from '../src/db/client';
import {
  createSession,
  createUser,
  readSession,
  revokeSessionToken,
  upsertUser,
} from '../src/auth/session';
import { createApiToken, listApiTokens, resolveTokenPrincipal } from '../src/auth/tokens';
import { createRepo } from '../src/db/repos';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

async function app(path: string, init?: RequestInit): Promise<Response> {
  return makeApp(testEnv)(new Request(`https://x${path}`, init));
}

// Outbound-fetch mocking: tests run in the same isolate as the worker, so a
// global fetch stub intercepts the GitHub calls hermetically (the plugin's
// fetchMock facility no longer exists under @cloudflare/vitest-plugin).
const realFetch = globalThis.fetch;

const githubHandlers: Record<string, { status?: number; body: unknown }> = {
  'https://github.com/login/oauth/access_token': {
    body: { access_token: 'gh-access-token' },
  },
  'https://api.github.com/user': {
    body: { id: 42, login: 'octo', avatar_url: 'https://x/a.png' },
  },
  'https://api.github.com/user/emails': {
    body: [{ email: 'octo@example.com', primary: true, verified: true }],
  },
};

function mockGithub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const key = `${new URL(req.url).origin}${new URL(req.url).pathname}`;
    const handler = githubHandlers[key];
    if (handler) {
      return new Response(JSON.stringify(handler.body), {
        status: handler.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected outbound fetch in test: ${req.url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The login-state cookie a sign-in start sets, as a request `cookie` header. */
function stateCookie(start: Response): { cookie: string } {
  return { cookie: (start.headers.get('set-cookie') as string).split(';')[0] as string };
}

async function completeLogin(): Promise<string> {
  const start = await app('/auth/github');
  const location = start.headers.get('location') as string;
  const state = new URL(location).searchParams.get('state') as string;
  mockGithub();
  const callback = await app(`/auth/github/callback?code=abc&state=${state}`, {
    headers: stateCookie(start),
  });
  const cookie = (callback.headers.get('set-cookie') as string).split(';')[0] as string;
  return cookie;
}

describe('oauth login', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('reports login availability without exposing credentials or caching the result', async () => {
    const configured = await app('/auth/status');
    expect(configured.status).toBe(200);
    expect(configured.headers.get('cache-control')).toBe('no-store');
    expect(await configured.json()).toEqual({ github_configured: true, providers: [] });
    for (const missing of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
      const response = await makeApp({ ...dbEnv, [missing]: undefined })(
        new Request('https://x/auth/status'),
      );
      expect(await response.json()).toEqual({ github_configured: false, providers: [] });
    }
  });

  it('GET /auth/github redirects with a single-use hashed state', async () => {
    const res = await app('/auth/github');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    const redirectUri = location.searchParams.get('redirect_uri') as string;
    expect(redirectUri).toBe('https://x/auth/github/callback');

    const state = location.searchParams.get('state') as string;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const rows = await q(dbEnv, `SELECT * FROM ${T.oauthStates}`);
    expect(rows).toHaveLength(1);
    // stored hashed, never plain
    expect((rows[0] as { state_hash: string }).state_hash).not.toBe(state);
    expect((rows[0] as { state_hash: string }).state_hash).toBe(
      await sha256(new TextEncoder().encode(state)),
    );
  });

  it('callback verifies state, upserts the user, sets a hardened cookie', async () => {
    const cookie = await completeLogin();
    expect(cookie).toMatch(/^yag_session=[0-9a-f]{64}$/);

    // cookie flags (https origin → Secure included)
    const start = await app('/auth/github');
    const state = new URL(start.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;
    mockGithub();
    const callback = await app(`/auth/github/callback?code=abc&state=${state}`, {
      headers: stateCookie(start),
    });
    const setCookie = callback.headers.get('set-cookie') as string;
    expect(setCookie).toContain('yag_login_state=; HttpOnly; Secure; SameSite=Lax');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(callback.status).toBe(302);

    // one user despite two logins (upsert by github id)
    const users = await q(dbEnv, `SELECT * FROM ${T.users}`);
    expect(users).toHaveLength(1);
    expect((users[0] as { login: string }).login).toBe('octo');

    // session rows store only hashes of cookie tokens
    const rawToken = cookie.slice('yag_session='.length);
    const sessions = await q(dbEnv, `SELECT * FROM ${T.sessions}`);
    expect(sessions).toHaveLength(2);
    const hashes = sessions.map((r) => (r as { token_hash: string }).token_hash);
    expect(hashes).toContain(await sha256(new TextEncoder().encode(rawToken)));
    for (const hash of hashes) expect(hash).not.toBe(rawToken);
  });

  it('rejects unknown, reused, and expired states before any token exchange', async () => {
    const bad = await app('/auth/github/callback?code=abc&state=never-issued');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_state',
    );

    // single-use: replaying a consumed state fails
    const start = await app('/auth/github');
    const state = new URL(start.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;
    mockGithub();
    const first = await app(`/auth/github/callback?code=abc&state=${state}`, {
      headers: stateCookie(start),
    });
    expect(first.status).toBe(302);
    const replay = await app(`/auth/github/callback?code=abc&state=${state}`, {
      headers: stateCookie(start),
    });
    expect(replay.status).toBe(400);

    // expired states are rejected and purged opportunistically
    await run(
      dbEnv,
      `INSERT INTO ${T.oauthStates} (${C.oauthStates.stateHash}, ${C.oauthStates.createdAt}, ${C.oauthStates.expiresAt}) VALUES (?, ?, ?)`,
      [await sha256(new TextEncoder().encode('old-state')), 1, 2],
    );
    const expired = await app('/auth/github/callback?code=abc&state=old-state', {
      headers: { cookie: 'yag_login_state=old-state' },
    });
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_state',
    );

    const purge = await app('/auth/github');
    expect(purge.status).toBe(302);
    const remaining = await q(
      dbEnv,
      `SELECT * FROM ${T.oauthStates} WHERE ${C.oauthStates.stateHash} = ?`,
      [await sha256(new TextEncoder().encode('old-state'))],
    );
    expect(remaining).toHaveLength(0);
  });

  it('refuses a callback in a browser that did not start the sign-in (login CSRF)', async () => {
    const start = await app('/auth/github');
    expect(start.headers.get('set-cookie')).toMatch(
      /^yag_login_state=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/auth; Max-Age=600$/,
    );
    const state = new URL(start.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;
    mockGithub();
    for (const cookie of ['', 'yag_login_state=other']) {
      const lured = await app(`/auth/github/callback?code=abc&state=${state}`, {
        headers: { cookie },
      });
      expect(lured.status).toBe(400);
      expect(lured.headers.get('set-cookie')).toBeNull();
    }
    expect(await q(dbEnv, `SELECT * FROM ${T.users}`)).toHaveLength(0);
    // the browser that started it still completes
    const own = await app(`/auth/github/callback?code=abc&state=${state}`, {
      headers: stateCookie(start),
    });
    expect(own.status).toBe(302);
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('reads, renews past halfway, and revokes', async () => {
    const user = await upsertUser(dbEnv, { id: 7, login: 'seven' });
    const created = await createSession(
      dbEnv,
      user.id,
      Date.now() - 20 * 24 * 60 * 60 * 1000,
    );
    const cookie = `yag_session=${created.token}`;

    const read = await readSession(dbEnv, cookie);
    expect(read?.login).toBe('seven');

    // sliding renewal: expiry pushed out past halfway
    const row = await q1(
      dbEnv,
      `SELECT * FROM ${T.sessions} WHERE ${C.sessions.tokenHash} = ?`,
      [await sha256(new TextEncoder().encode(created.token))],
    );
    expect((row as { expires_at: number }).expires_at).toBeGreaterThan(Date.now());

    await revokeSessionToken(dbEnv, created.token);
    expect(await readSession(dbEnv, cookie)).toBeNull();
    expect(await readSession(dbEnv, 'yag_session=nope')).toBeNull();
    expect(await readSession(dbEnv, undefined)).toBeNull();
  });

  it('keeps logins unique: no rename or sign-up takes over a held login', async () => {
    const early = await upsertUser(dbEnv, { id: 1, login: 'mallory' });
    const ceo = await createUser(dbEnv, 'ceo@corp.example');
    expect(ceo.login).toBe('ceo');
    // a GitHub rename into a held login keeps the old login
    expect((await upsertUser(dbEnv, { id: 1, login: 'CEO' })).login).toBe('mallory');
    // a new GitHub user with a held login gets a suffix
    expect((await upsertUser(dbEnv, { id: 2, login: 'ceo' })).login).toMatch(
      /^ceo-[0-9a-f]{6}$/,
    );
    expect((await createUser(dbEnv, 'Mallory@corp.example')).login).toMatch(
      /^mallory-[0-9a-f]{6}$/,
    );
    await expect(
      run(
        dbEnv,
        `UPDATE ${T.users} SET ${C.users.login} = 'Ceo' WHERE ${C.users.id} = ?`,
        [early.id],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe('api tokens', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  async function session(): Promise<string> {
    const user = await upsertUser(dbEnv, { id: 9, login: 'nine' });
    const created = await createSession(dbEnv, user.id);
    return `yag_session=${created.token}`;
  }

  it('shows the raw token exactly once; list returns metadata only', async () => {
    const cookie = await session();
    const created = await app('/api/v1/tokens', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ci bot', scopes: ['repo:read', 'agent:run'] }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      token: string;
      scopes: string[];
    };
    expect(body.token).toMatch(/^yag_[0-9a-f]{40}$/);
    expect(body.scopes).toEqual(['repo:read', 'agent:run']);

    // stored hashed only
    const rows = await q(dbEnv, `SELECT * FROM ${T.apiTokens}`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { token_hash: string }).token_hash).toBe(
      await sha256(new TextEncoder().encode(body.token)),
    );

    const list = await app('/api/v1/tokens', { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      tokens: { id: string; label: string; token?: string }[];
    };
    expect(listed.tokens[0]?.label).toBe('ci bot');
    expect(listed.tokens[0]?.token).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(body.token);

    const removed = await app(`/api/v1/tokens/${body.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(removed.status).toBe(200);
    expect(await listApiTokens(dbEnv, (rows[0] as { user_id: string }).user_id)).toEqual(
      [],
    );
  });

  it('requires a session (bearer tokens cannot mint tokens)', async () => {
    expect((await app('/api/v1/tokens')).status).toBe(401);
    expect(
      (
        await app('/api/v1/tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'x' }),
        })
      ).status,
    ).toBe(401);
  });

  it('bearer middleware resolves tokens and tracks last use', async () => {
    const cookie = await session();
    const created = await app('/api/v1/tokens', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'agent' }),
    });
    const raw = ((await created.json()) as { token: string }).token;

    // valid bearer → principal + last_used_at touch
    const principal = await resolveTokenPrincipal(dbEnv, raw);
    expect(principal).toMatchObject({ kind: 'token', scopes: expect.any(Array) });
    await app('/healthz', { headers: { authorization: `Bearer ${raw}` } });
    const row = await q1(dbEnv, `SELECT * FROM ${T.apiTokens}`);
    expect((row as { last_used_at: number | null }).last_used_at).not.toBeNull();

    // unknown / expired tokens resolve to anonymous (no touch, no crash)
    expect(
      await resolveTokenPrincipal(dbEnv, 'yag_0000000000000000000000000000000000000000'),
    ).toBeNull();
    expect(await resolveTokenPrincipal(dbEnv, 'not-a-token')).toBeNull();
    await run(dbEnv, `UPDATE ${T.apiTokens} SET ${C.apiTokens.expiresAt} = 1`);
    expect(await resolveTokenPrincipal(dbEnv, raw)).toBeNull();
  });

  it('a valid bearer cannot mint broader tokens or use session-only administration', async () => {
    const cookie = await session();
    const user = await readSession(dbEnv, cookie);
    const token = await createApiToken(dbEnv, user!.id, {
      label: 'limited',
      scopes: ['repo:read'],
    });
    const headers = {
      authorization: `Bearer ${token.raw}`,
      'content-type': 'application/json',
    };
    expect((await app('/api/v1/tokens', { headers })).status).toBe(401);
    expect(
      (
        await app('/api/v1/tokens', {
          method: 'POST',
          headers,
          body: JSON.stringify({ label: 'escalate' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await app(`/api/v1/tokens/${token.id}`, { method: 'DELETE', headers })).status,
    ).toBe(401);
    expect(
      (
        await app('/api/v1/repos', {
          method: 'POST',
          headers,
          body: JSON.stringify({ slug: 'smoke/escalate' }),
        })
      ).status,
    ).toBe(401);
    expect((await listApiTokens(dbEnv, user!.id)).length).toBe(1);
    expect((await app('/api/v1/tokens', { headers: { cookie } })).status).toBe(200);
  });

  it('enforces read-only and repository-bound tokens on ordinary repository routes', async () => {
    const cookie = await session();
    const user = await readSession(dbEnv, cookie);
    const repo = await createRepo(dbEnv, { slug: 'scope/allowed', createdBy: user!.id });
    await createRepo(dbEnv, { slug: 'scope/other', createdBy: user!.id });
    const token = await createApiToken(dbEnv, user!.id, {
      label: 'limited',
      scopes: ['repo:read'],
      repoId: repo.id,
    });
    const headers = {
      authorization: `Bearer ${token.raw}`,
      'content-type': 'application/json',
    };
    expect(
      (await app('/api/v1/repos/scope/allowed/changesets', { headers })).status,
    ).toBe(200);
    expect(
      (
        await app('/api/v1/repos/scope/allowed/changesets', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await app('/api/v1/repos/scope/other/changesets', { headers })).status).toBe(
      404,
    );
    const listed = await app('/api/v1/repos', { headers });
    expect(
      ((await listed.json()) as { repos: { id: string }[] }).repos.map((r) => r.id),
    ).toEqual([repo.id]);
  });
});
