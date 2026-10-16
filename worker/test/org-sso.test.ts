import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { q } from '../src/db/client';
import { can } from '../src/auth/rbac';
import { getRepoBySlug } from '../src/db/repos';
import { FakeIdp } from './identity-fakes';

const testEnv = env as unknown as TestEnv;
const realFetch = globalThis.fetch;
const OKTA = 'https://idp.example.test';

const ssoEnv = {
  ...testEnv,
  OIDC_PROVIDERS: JSON.stringify([
    { id: 'okta', name: 'Okta', issuer: OKTA, client_id: 'okta-client' },
  ]),
} as unknown as Env;

const OKTA_SSO = {
  protocol: 'oidc',
  issuer: OKTA,
  client_id: 'okta-client',
  enforced: true,
};

function app(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(makeApp(ssoEnv)(new Request(`https://x${path}`, init)));
}

function call(cookie: string, method: string, path: string, body?: unknown) {
  return app(path, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') as string).split(';')[0] as string;
}

let okta: FakeIdp;

/** Link an Okta identity to a GitHub session, then sign in with Okta. */
async function oktaSession(githubCookie: string, sub: string, email: string) {
  const claims = { sub, email, email_verified: true };
  for (const query of ['?link=1', '']) {
    const headers: Record<string, string> = query ? { cookie: githubCookie } : {};
    const start = await app(`/auth/oidc/okta${query}`, { headers });
    expect(start.status).toBe(302);
    const cookie = [headers.cookie, cookieOf(start)].filter(Boolean).join('; ');
    const done = await app(
      okta.authorize(start.headers.get('location') as string, claims),
      {
        headers: { cookie },
      },
    );
    expect(done.status).toBe(302);
    if (!query) return done.headers.getSetCookie()[0]?.split(';')[0] as string;
  }
  throw new Error('unreachable');
}

async function mintToken(cookie: string): Promise<string> {
  const res = await call(cookie, 'POST', '/api/v1/tokens', { label: 'git' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function gitRefs(token: string): Promise<string> {
  const res = await app('/yuma/core.git/info/refs?service=git-upload-pack', {
    headers: {
      authorization: `Basic ${btoa(`git:${token}`)}`,
      'git-protocol': 'version=2',
    },
  });
  expect(res.status).toBe(200);
  return new TextDecoder().decode(await res.arrayBuffer());
}

beforeAll(async () => {
  okta = await FakeIdp.create(OKTA);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('org SSO enforcement', () => {
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let member: Awaited<ReturnType<typeof loginAs>>;
  let ownerOkta = '';

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    okta.install();
    owner = await loginAs(testEnv, 1, 'olive');
    member = await loginAs(testEnv, 2, 'max');
    expect(
      (
        await call(owner.cookie, 'POST', '/api/v1/orgs', {
          slug: 'yuma',
          base_role: 'read',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(owner.cookie, 'PUT', '/api/v1/orgs/yuma/members', {
          user_login: 'max',
          role: 'member',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(owner.cookie, 'POST', '/api/v1/repos', {
          slug: 'yuma/core',
          org: 'yuma',
        })
      ).status,
    ).toBe(201);
    ownerOkta = await oktaSession(owner.cookie, 'o-olive', 'olive@yuma.test');
  });

  it('validates settings and only enforces from a session that meets them', async () => {
    const put = (cookie: string, body: unknown) =>
      call(cookie, 'PUT', '/api/v1/orgs/yuma/sso', body);
    expect(
      (await errorOf(await put(ownerOkta, { ...OKTA_SSO, protocol: 'saml' }))).code,
    ).toBe('saml_unsupported');
    expect(
      (await errorOf(await put(ownerOkta, { ...OKTA_SSO, client_id: 'x' }))).code,
    ).toBe('unknown_identity_provider');
    // the GitHub session would lock its owner out
    const locked = await put(owner.cookie, OKTA_SSO);
    expect(locked.status).toBe(409);
    expect((await errorOf(locked)).code).toBe('sso_not_verified');
    expect((await put(member.cookie, OKTA_SSO)).status).toBe(403);

    const set = await put(ownerOkta, { ...OKTA_SSO, allowed_domains: ['Yuma.test'] });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      sso: { enforced: true, provider: 'okta', allowed_domains: ['yuma.test'] },
    });
    const read = await call(member.cookie, 'GET', '/api/v1/orgs/yuma/sso');
    expect(await read.json()).toMatchObject({
      sso: { provider: 'okta' },
      satisfied: false,
    });
    const audited = await q<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'org.sso.%'",
    );
    expect(audited.map((a) => a.action)).toEqual(['org.sso.set']);

    // once enforced, only a session that meets it can relax or remove it
    for (const res of [
      await put(owner.cookie, { ...OKTA_SSO, enforced: false }),
      await call(owner.cookie, 'DELETE', '/api/v1/orgs/yuma/sso'),
    ]) {
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('sso_required');
    }
    expect((await call(ownerOkta, 'DELETE', '/api/v1/orgs/yuma/sso')).status).toBe(200);
    expect((await call(ownerOkta, 'DELETE', '/api/v1/orgs/yuma/sso')).status).toBe(404);
  });

  it('refuses members with sso_required on the API and Git until they sign in through the IdP', async () => {
    const githubToken = await mintToken(member.cookie);
    expect((await call(member.cookie, 'GET', '/api/v1/repos/yuma/core')).status).toBe(
      200,
    );
    expect((await call(ownerOkta, 'PUT', '/api/v1/orgs/yuma/sso', OKTA_SSO)).status).toBe(
      200,
    );

    // GitHub session: refused, told where to sign in
    const refused = await call(member.cookie, 'GET', '/api/v1/repos/yuma/core');
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      code: 'sso_required',
      org: 'yuma',
      sign_in: '/auth/oidc/okta',
    });
    const log = await call(member.cookie, 'GET', '/api/v1/repos/yuma/core/changesets');
    expect(log.status).toBe(403);
    expect((await errorOf(log)).code).toBe('sso_required');
    const listed = await call(member.cookie, 'GET', '/api/v1/repos');
    expect(
      ((await listed.json()) as { repos: { slug: string }[] }).repos.map((r) => r.slug),
    ).not.toContain('yuma/core');
    // a token minted from that session is refused over Git
    expect(await gitRefs(githubToken)).toMatch(/ERR sso_required: org yuma requires/);
    // non-members still get 404, never the SSO hint
    const otto = await loginAs(testEnv, 3, 'otto');
    expect((await call(otto.cookie, 'GET', '/api/v1/repos/yuma/core')).status).toBe(404);

    // Okta session: allowed, and so is a token minted from it
    const memberOkta = await oktaSession(member.cookie, 'o-max', 'max@yuma.test');
    expect((await call(memberOkta, 'GET', '/api/v1/repos/yuma/core')).status).toBe(200);
    expect(await gitRefs(await mintToken(memberOkta))).toContain('version 2');
    // the old token stays refused: it was minted without SSO
    expect(await gitRefs(githubToken)).toContain('sso_required');

    // internal principals (agent runs, review checks) are not gated
    const repo = await getRepoBySlug(testEnv, 'yuma/core');
    expect(
      repo && (await can(testEnv, repo, { kind: 'user', userId: member.userId }, 'read')),
    ).toBe(true);
  });

  it('checks allowed domains on the IdP identity, and leaves public repos readable', async () => {
    expect(
      (
        await call(ownerOkta, 'PUT', '/api/v1/orgs/yuma/sso', {
          ...OKTA_SSO,
          allowed_domains: ['yuma.test'],
        })
      ).status,
    ).toBe(200);
    const contractor = await oktaSession(member.cookie, 'o-max', 'max@contractor.test');
    expect(
      (await errorOf(await call(contractor, 'GET', '/api/v1/repos/yuma/core'))).code,
    ).toBe('sso_required');

    expect(
      (
        await call(ownerOkta, 'POST', '/api/v1/repos', {
          slug: 'yuma/docs',
          org: 'yuma',
          visibility: 'public',
        })
      ).status,
    ).toBe(201);
    expect((await call(member.cookie, 'GET', '/api/v1/repos/yuma/docs')).status).toBe(
      200,
    );
  });

  it('covers issue, pipeline and ruleset routes and agent token exchange', async () => {
    const delegate = async (cookie: string) => {
      const res = await call(cookie, 'POST', '/api/v1/tokens', {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    const githubToken = await delegate(owner.cookie);
    const agent = await call(ownerOkta, 'POST', '/api/v1/agents', {
      name: 'Codex',
      kind: 'codex',
    });
    expect(agent.status).toBe(201);
    const agentId = ((await agent.json()) as { id: string }).id;
    const exchange = (token: string) =>
      app('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          agent_id: agentId,
          resource: 'yuma/core',
        }),
      });
    expect((await call(ownerOkta, 'PUT', '/api/v1/orgs/yuma/sso', OKTA_SSO)).status).toBe(
      200,
    );

    const routes = [
      '/api/v1/repos/yuma/core/issues',
      '/api/v1/repos/yuma/core/labels',
      '/api/v1/repos/yuma/core/ci/pipelines',
      '/api/v1/repos/yuma/core/rulesets',
      '/api/v1/orgs/yuma/rulesets',
    ];
    for (const path of routes) {
      const refused = await call(owner.cookie, 'GET', path);
      expect(refused.status, path).toBe(403);
      expect((await errorOf(refused)).code, path).toBe('sso_required');
      expect((await call(ownerOkta, 'GET', path)).status, path).toBe(200);
    }
    // a delegation minted without SSO cannot hand an agent the org's repo
    const refused = await exchange(githubToken);
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).code).toBe('invalid_target');
    expect((await exchange(await delegate(ownerOkta))).status).toBe(200);
  });

  it('gates agent tokens on SSO: public repos at exchange, older tokens on use', async () => {
    const res = await call(member.cookie, 'POST', '/api/v1/tokens', {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const githubToken = ((await res.json()) as { token: string }).token;
    const agent = await call(member.cookie, 'POST', '/api/v1/agents', {
      name: 'Codex',
      kind: 'codex',
    });
    const agentId = ((await agent.json()) as { id: string }).id;
    expect(
      (
        await call(ownerOkta, 'POST', '/api/v1/repos', {
          slug: 'yuma/lib',
          org: 'yuma',
          visibility: 'public',
        })
      ).status,
    ).toBe(201);
    const exchange = (resource: string) =>
      app('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: githubToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          agent_id: agentId,
          resource,
        }),
      });
    const before = await exchange('yuma/core');
    expect(before.status).toBe(200);
    const agentToken = ((await before.json()) as { access_token: string }).access_token;
    const bearer = { authorization: `Bearer ${agentToken}` };
    expect((await app('/api/v1/repos/yuma/core', { headers: bearer })).status).toBe(200);
    expect((await call(ownerOkta, 'PUT', '/api/v1/orgs/yuma/sso', OKTA_SSO)).status).toBe(
      200,
    );

    // the token issued before enforcement carries its delegation's sign-in
    const refused = await app('/api/v1/repos/yuma/core', { headers: bearer });
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe('sso_required');
    // a public org repo passes the read check but not the org's SSO
    const lib = await exchange('yuma/lib');
    expect(lib.status).toBe(403);
    expect((await errorOf(lib)).code).toBe('sso_required');
  });

  it('does nothing while SSO is configured but not enforced', async () => {
    expect(
      (
        await call(ownerOkta, 'PUT', '/api/v1/orgs/yuma/sso', {
          ...OKTA_SSO,
          enforced: false,
        })
      ).status,
    ).toBe(200);
    expect((await call(member.cookie, 'GET', '/api/v1/repos/yuma/core')).status).toBe(
      200,
    );
  });
});
