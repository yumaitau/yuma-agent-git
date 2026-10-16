import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { q, q1 } from '../src/db/client';
import { oidcProviders } from '../src/auth/oidc';
import { FakeAuthenticator, FakeIdp } from './identity-fakes';

const testEnv = env as unknown as TestEnv;
const realFetch = globalThis.fetch;

const GOOGLE = 'https://accounts.google.com';
const OKTA = 'https://idp.example.test';

const oidcEnv = {
  ...testEnv,
  OIDC_PROVIDERS: JSON.stringify([
    {
      id: 'google',
      preset: 'google',
      client_id: 'google-client',
      allowed_domains: ['yuma.test'],
    },
    { id: 'okta', name: 'Okta', issuer: OKTA, client_id: 'okta-client' },
  ]),
  OIDC_GOOGLE_CLIENT_SECRET: 'google-secret',
} as unknown as Env;

async function app(path: string, init?: RequestInit): Promise<Response> {
  return makeApp(oidcEnv)(new Request(`https://x${path}`, init));
}

const googleClaims = {
  sub: 'g-123',
  email: 'ada@yuma.test',
  email_verified: true,
  hd: 'yuma.test',
};

/** Start → IdP approves → callback. Returns the callback response. */
async function signIn(
  idp: FakeIdp,
  provider: string,
  claims: Record<string, unknown>,
  headers: Record<string, string> = {},
  query = '',
): Promise<Response> {
  const start = await app(`/auth/oidc/${provider}${query}`, { headers });
  expect(start.status).toBe(302);
  return app(idp.authorize(start.headers.get('location') as string, claims), { headers });
}

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') as string).split(';')[0] as string;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

let google: FakeIdp;
let okta: FakeIdp;

beforeAll(async () => {
  google = await FakeIdp.create(GOOGLE);
  okta = await FakeIdp.create(OKTA);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  google.rogueKey = null;
});

describe('oidc providers', () => {
  it('builds Google and Entra presets and lists them on /auth/status', async () => {
    const providers = oidcProviders({
      OIDC_PROVIDERS: JSON.stringify([
        { id: 'google', preset: 'google', client_id: 'g' },
        {
          id: 'entra',
          preset: 'entra',
          tenant: '9188040d-6c67-4c5b-b112-36a304b66dad',
          client_id: 'e',
        },
        { id: 'entra-bad', preset: 'entra', client_id: 'e' },
      ]),
      OIDC_ENTRA_CLIENT_SECRET: 'entra-secret',
    } as unknown as Env);
    expect(providers.map((p) => [p.id, p.name, p.issuer, p.clientSecret])).toEqual([
      ['google', 'Google', 'https://accounts.google.com', null],
      [
        'entra',
        'Microsoft',
        'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
        'entra-secret',
      ],
    ]);
    expect(oidcProviders({ OIDC_PROVIDERS: 'not json' } as unknown as Env)).toEqual([]);

    const status = await app('/auth/status');
    expect(await status.json()).toEqual({
      github_configured: true,
      providers: [
        { id: 'google', name: 'Google' },
        { id: 'okta', name: 'Okta' },
      ],
    });
    expect(JSON.stringify(await (await app('/auth/status')).json())).not.toContain(
      'secret',
    );
  });
});

describe('oidc sign-in', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('redirects with PKCE S256, nonce and a hashed single-use state', async () => {
    google.install();
    const res = await app('/auth/oidc/google');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') as string);
    expect(url.origin + url.pathname).toBe(`${GOOGLE}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('google-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://x/auth/oidc/google/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const state = url.searchParams.get('state') as string;
    const rows = await q(testEnv, 'SELECT * FROM oidc_states');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(state);
    expect((await app('/auth/oidc/nope')).status).toBe(404);
  });

  it('signs in a user with no GitHub account, who registers a passkey and creates a repo', async () => {
    google.install();
    const res = await signIn(google, 'google', googleClaims);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') as string;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = cookieOf(res);

    // the token exchange carried the PKCE verifier and the client secret
    const exchange = google.tokenRequests.at(-1) as URLSearchParams;
    expect(exchange.get('code_verifier')).toBeTruthy();
    expect(exchange.get('client_secret')).toBe('google-secret');

    const users = await q<{ id: string; github_id: number | null; login: string }>(
      testEnv,
      'SELECT * FROM users',
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.github_id).toBeNull();
    expect(users[0]?.login).toBe('ada');
    const identity = await q1(testEnv, 'SELECT * FROM user_identities');
    expect(identity).toMatchObject({
      provider: 'oidc:google',
      subject: 'g-123',
      email: 'ada@yuma.test',
    });
    const session = await q1(testEnv, 'SELECT auth_method, mfa_at FROM sessions');
    expect(session).toEqual({ auth_method: 'oidc:google', mfa_at: null });
    const login = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'auth.login'",
    );
    expect(JSON.parse(login?.target ?? '{}')).toMatchObject({ method: 'oidc:google' });

    // register a passkey
    const options = await app('/api/v1/me/passkeys/options', {
      method: 'POST',
      headers: { cookie },
    });
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    const authenticator = await FakeAuthenticator.create();
    const registered = await app('/api/v1/me/passkeys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'laptop',
        credential: await authenticator.register(challenge, 'https://x'),
      }),
    });
    expect(registered.status).toBe(201);

    // and create a repo
    const repo = await app('/api/v1/repos', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'ada/first' }),
    });
    expect(repo.status).toBe(201);

    // signing in again reuses the same user
    const again = await signIn(google, 'google', googleClaims);
    expect(again.status).toBe(302);
    expect(await q(testEnv, 'SELECT * FROM users')).toHaveLength(1);
  });

  it('rejects reused state, a wrong nonce, audience or signature, and expired tokens', async () => {
    google.install();
    const start = await app('/auth/oidc/google');
    const callback = google.authorize(
      start.headers.get('location') as string,
      googleClaims,
    );
    expect((await app(callback)).status).toBe(302);
    const replay = await app(callback);
    expect(replay.status).toBe(400);
    expect(await errorCode(replay)).toBe('invalid_state');

    for (const claims of [
      { ...googleClaims, nonce: 'other' },
      { ...googleClaims, aud: 'someone-else' },
      { ...googleClaims, iss: 'https://evil.test' },
      { ...googleClaims, exp: Math.floor(Date.now() / 1000) - 3600 },
    ]) {
      const res = await signIn(google, 'google', claims);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_id_token');
    }

    google.rogueKey = (
      (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair
    ).privateKey;
    const forged = await signIn(google, 'google', { ...googleClaims, sub: 'forged' });
    expect(forged.status).toBe(401);
    // only the first, genuine sign-in created a user
    expect(await q(testEnv, 'SELECT * FROM users')).toHaveLength(1);
  });

  it('enforces allowed domains on verified email and the Workspace hd claim', async () => {
    google.install();
    for (const claims of [
      { ...googleClaims, email: 'ada@gmail.com', hd: undefined },
      { ...googleClaims, email_verified: false },
      { ...googleClaims, hd: undefined },
    ]) {
      const res = await signIn(google, 'google', claims);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('domain_not_allowed');
    }
    expect(await q(testEnv, 'SELECT * FROM users')).toHaveLength(0);
  });

  it('counts an IdP-asserted MFA (amr) as the session second factor', async () => {
    okta.install();
    const res = await signIn(okta, 'okta', { sub: 'o-1', amr: ['pwd', 'mfa'] });
    expect(res.status).toBe(302);
    const session = await q1<{ auth_method: string; mfa_at: number | null }>(
      testEnv,
      'SELECT auth_method, mfa_at FROM sessions',
    );
    expect(session?.auth_method).toBe('oidc:okta');
    expect(session?.mfa_at).not.toBeNull();
    // public client: no secret configured, none sent
    expect(okta.tokenRequests.at(-1)?.has('client_secret')).toBe(false);
  });

  it('lets an existing GitHub user link an OIDC identity without a duplicate account', async () => {
    const github = await loginAs(testEnv, 4242, 'octo');
    google.install();
    expect((await app('/auth/oidc/google?link=1')).status).toBe(401);

    const linked = await signIn(
      google,
      'google',
      googleClaims,
      github.headers,
      '?link=1',
    );
    expect(linked.status).toBe(302);
    expect(linked.headers.get('location')).toBe('/security');
    const identities = await q<{ provider: string; user_id: string }>(
      testEnv,
      'SELECT provider, user_id FROM user_identities ORDER BY provider',
    );
    expect(identities.map((i) => [i.provider, i.user_id])).toEqual([
      ['github', github.userId],
      ['oidc:google', github.userId],
    ]);

    // signing in with Google now lands on the GitHub-created account
    const login = await signIn(google, 'google', googleClaims);
    expect(login.status).toBe(302);
    const session = await q1<{ user_id: string }>(
      testEnv,
      "SELECT user_id FROM sessions WHERE auth_method = 'oidc:google'",
    );
    expect(session?.user_id).toBe(github.userId);
    expect(await q(testEnv, 'SELECT * FROM users')).toHaveLength(1);

    // the same identity cannot be linked to a second account
    const other = await loginAs(testEnv, 5151, 'other');
    const taken = await signIn(google, 'google', googleClaims, other.headers, '?link=1');
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe('identity_in_use');
  });
});
