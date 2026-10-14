import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, q1, run } from '../src/db/client';
import {
  createSession,
  readSession,
  revokeSessionToken,
  upsertUser,
} from '../src/auth/session';
import { listApiTokens, resolveTokenPrincipal } from '../src/auth/tokens';

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

async function completeLogin(): Promise<string> {
  const start = await app('/auth/github');
  const location = start.headers.get('location') as string;
  const state = new URL(location).searchParams.get('state') as string;
  mockGithub();
  const callback = await app(`/auth/github/callback?code=abc&state=${state}`);
  const cookie = (callback.headers.get('set-cookie') as string).split(';')[0] as string;
  return cookie;
}

describe('oauth login', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
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
    const callback = await app(`/auth/github/callback?code=abc&state=${state}`);
    const setCookie = callback.headers.get('set-cookie') as string;
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
    const first = await app(`/auth/github/callback?code=abc&state=${state}`);
    expect(first.status).toBe(302);
    const replay = await app(`/auth/github/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);

    // expired states are rejected and purged opportunistically
    await run(
      dbEnv,
      `INSERT INTO ${T.oauthStates} (${C.oauthStates.stateHash}, ${C.oauthStates.createdAt}, ${C.oauthStates.expiresAt}) VALUES (?, ?, ?)`,
      [await sha256(new TextEncoder().encode('old-state')), 1, 2],
    );
    const expired = await app('/auth/github/callback?code=abc&state=old-state');
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
});
