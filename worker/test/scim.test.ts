import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { q, q1, run } from '../src/db/client';
import { createSession, readSession } from '../src/auth/session';
import { createApiToken, resolveTokenPrincipal } from '../src/auth/tokens';
import { FakeIdp } from './identity-fakes';

const testEnv = env as unknown as TestEnv;
const realFetch = globalThis.fetch;
const OKTA = 'https://idp.example.test';

let scimEnv: Env = testEnv;

async function app(path: string, init?: RequestInit): Promise<Response> {
  return makeApp(scimEnv)(new Request(`https://x${path}`, init));
}

let bearer = '';

function scim(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return app(`/scim/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/scim+json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** An admin with a fresh second factor mints the provisioning token. */
async function mintScimToken(): Promise<string> {
  const admin = await loginAs(testEnv, 1, 'admin');
  scimEnv = {
    ...testEnv,
    SCIM_ADMIN_USER_IDS: admin.userId,
    OIDC_PROVIDERS: JSON.stringify([
      { id: 'okta', issuer: OKTA, client_id: 'okta-client' },
    ]),
  } as unknown as Env;
  await run(testEnv, 'UPDATE sessions SET mfa_at = ? WHERE token_hash = ?', [
    Date.now(),
    await sha256(new TextEncoder().encode(admin.cookie.slice('yag_session='.length))),
  ]);
  const res = await app('/api/v1/scim/tokens', {
    method: 'POST',
    headers: { ...admin.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'entra' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  scimEnv = testEnv;
});

describe('scim tokens', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('only listed admins with a fresh second factor can mint; stored hashed', async () => {
    const someone = await loginAs(testEnv, 9, 'someone');
    expect((await app('/api/v1/scim/tokens')).status).toBe(401);
    const denied = await app('/api/v1/scim/tokens', {
      method: 'POST',
      headers: { ...someone.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(denied.status).toBe(403);

    // admin without MFA: strict gate even with nothing enrolled
    scimEnv = { ...testEnv, SCIM_ADMIN_USER_IDS: someone.userId } as unknown as Env;
    const noMfa = await app('/api/v1/scim/tokens', {
      method: 'POST',
      headers: { ...someone.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe(
      'mfa_required',
    );

    const raw = await mintScimToken();
    expect(raw).toMatch(/^yscim_[0-9a-f]{64}$/);
    const row = await q1<{ token_hash: string }>(testEnv, 'SELECT * FROM scim_tokens');
    expect(row?.token_hash).toBe(await sha256(new TextEncoder().encode(raw)));
  });

  it('SCIM endpoints refuse missing, wrong and session credentials', async () => {
    const user = await loginAs(testEnv, 2, 'u');
    expect((await app('/scim/v2/Users')).status).toBe(401);
    expect((await app('/scim/v2/Users', { headers: user.headers })).status).toBe(401);
    bearer = 'yscim_0000';
    const res = await scim('/Users');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/scim+json');
  });
});

describe('scim users', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    bearer = await mintScimToken();
  });

  async function provision(userName: string): Promise<{ id: string; userName: string }> {
    const res = await scim('/Users', 'POST', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName,
      name: { givenName: 'Grace' },
      emails: [{ value: userName, primary: true }],
      active: true,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; userName: string };
  }

  it('creates, finds by userName, rejects duplicates, and reads one', async () => {
    const created = await provision('Grace@Yuma.test');
    expect(created.userName).toBe('grace@yuma.test');
    const user = await q1<{ github_id: number | null; login: string }>(
      testEnv,
      'SELECT * FROM users WHERE id = ?',
      [created.id],
    );
    expect(user).toMatchObject({ github_id: null, login: 'grace' });

    const dup = await scim('/Users', 'POST', { userName: 'grace@yuma.test' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ scimType: 'uniqueness', status: '409' });

    const found = await scim(
      `/Users?filter=${encodeURIComponent('userName eq "GRACE@yuma.test"')}`,
    );
    expect(await found.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: created.id, active: true }],
    });
    const none = await scim(
      `/Users?filter=${encodeURIComponent('userName eq "nobody"')}`,
    );
    expect(await none.json()).toMatchObject({ totalResults: 0, Resources: [] });
    expect(
      (await scim(`/Users?filter=${encodeURIComponent('emails co "x"')}`)).status,
    ).toBe(400);
    expect((await scim(`/Users/${created.id}`)).status).toBe(200);
    expect((await scim('/Users/missing')).status).toBe(404);
  });

  it('PATCH active=false revokes every session and API token in that one request', async () => {
    const created = await provision('lin@yuma.test');
    const s1 = await createSession(testEnv, created.id);
    const s2 = await createSession(testEnv, created.id);
    const token = await createApiToken(testEnv, created.id, { label: 'bot' });
    expect(await resolveTokenPrincipal(testEnv, token.raw)).not.toBeNull();

    // Entra sends the value as a "False" string with a path
    const res = await scim(`/Users/${created.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ active: false });

    expect(
      await q(testEnv, 'SELECT * FROM sessions WHERE user_id = ?', [created.id]),
    ).toEqual([]);
    expect(
      await q(testEnv, 'SELECT * FROM api_tokens WHERE user_id = ?', [created.id]),
    ).toEqual([]);
    expect(await readSession(testEnv, `yag_session=${s1.token}`)).toBeNull();
    expect(await readSession(testEnv, `yag_session=${s2.token}`)).toBeNull();
    expect(await resolveTokenPrincipal(testEnv, token.raw)).toBeNull();
    const api = await app('/api/v1/tokens', {
      headers: { authorization: `Bearer ${token.raw}` },
    });
    expect(api.status).toBe(401);

    // Okta style: no path, object value; reactivates
    const back = await scim(`/Users/${created.id}`, 'PATCH', {
      Operations: [{ op: 'replace', value: { active: true } }],
    });
    expect(await back.json()).toMatchObject({ active: true });
    const bad = await scim(`/Users/${created.id}`, 'PATCH', {
      Operations: [{ op: 'replace', path: 'active', value: 'maybe' }],
    });
    expect(bad.status).toBe(400);
  });

  it('DELETE deprovisions and hides the user from SCIM', async () => {
    const created = await provision('max@yuma.test');
    const session = await createSession(testEnv, created.id);
    expect((await scim(`/Users/${created.id}`, 'DELETE')).status).toBe(204);
    expect((await scim(`/Users/${created.id}`)).status).toBe(404);
    const audit = await q<{ action: string; actor_kind: string; actor_id: string }>(
      testEnv,
      "SELECT action, actor_kind, actor_id FROM audit_events WHERE action LIKE 'scim.%' ORDER BY id",
    );
    expect(audit.map((e) => e.action)).toEqual([
      'scim.user.create',
      'scim.user.deprovision',
    ]);
    expect(audit[0]).toMatchObject({ actor_kind: 'system' });
    expect(audit[0]?.actor_id).toMatch(/^scim:/);
    expect(await readSession(testEnv, `yag_session=${session.token}`)).toBeNull();
    const user = await q1<{ active: number }>(
      testEnv,
      'SELECT active FROM users WHERE id = ?',
      [created.id],
    );
    expect(user?.active).toBe(0);
  });

  it('OIDC sign-in with the same verified email lands on the provisioned account; deactivated users are refused', async () => {
    const created = await provision('ola@yuma.test');
    const idp = await FakeIdp.create(OKTA);
    idp.install();
    const signIn = async (): Promise<Response> => {
      const start = await app('/auth/oidc/okta');
      return app(
        idp.authorize(start.headers.get('location') as string, {
          sub: 'okta-ola',
          email: 'ola@yuma.test',
          email_verified: true,
        }),
      );
    };
    expect((await signIn()).status).toBe(302);
    const session = await q1<{ user_id: string }>(
      testEnv,
      "SELECT user_id FROM sessions WHERE auth_method = 'oidc:okta'",
    );
    expect(session?.user_id).toBe(created.id);

    await scim(`/Users/${created.id}`, 'PATCH', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    const refused = await signIn();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'account_disabled',
    );
  });
});
