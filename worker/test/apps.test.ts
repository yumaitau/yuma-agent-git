import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1 } from '../src/db/client';
import { b64urlEncode, sha256Bytes } from '../src/auth/encoding';
import { pemToDer } from '../src/bridge/github';

/**
 * Apps and OAuth apps (issue #75): installation tokens are limited to the
 * app's permissions, the installed repositories and the installer's access;
 * OAuth apps sign people in with the authorization code grant and PKCE.
 */

const testEnv = env as unknown as TestEnv;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let outsider: Login;
let head: string;
let feature: string;

const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function bindings(): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'SECRETS_KEK') return kek;
      return Reflect.get(target, key, receiver);
    },
  });
}

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = owner.headers,
): Promise<Response> {
  return makeApp(bindings())(
    new Request(`https://forge.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response | Promise<Response>, status: number): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const enc = (o: unknown): string =>
  b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));

/** An app JWT signed with the PEM key returned at creation. */
async function appJwt(
  pem: string,
  claims: Record<string, unknown>,
  alg = 'RS256',
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = `${enc({ alg, typ: 'JWT' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

async function newApp(permissions: string[]) {
  return json<{ app: { id: string; permissions: string[] }; private_key: string }>(
    call('/api/v1/apps', 'POST', { name: 'Deploy bot', permissions }),
    201,
  );
}

async function install(appId: string, repos = ['team/project']) {
  return (
    await json<{ installation: { id: string } }>(
      call(`/api/v1/apps/${appId}/installations`, 'POST', { repos }),
      201,
    )
  ).installation.id;
}

async function installationToken(
  app: { app: { id: string }; private_key: string },
  installationId: string,
  scope?: string,
): Promise<Response> {
  return call(
    '/oauth/token',
    'POST',
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await appJwt(app.private_key, {
        iss: app.app.id,
        iat: now() - 30,
        exp: now() + 540,
      }),
      installation_id: installationId,
      ...(scope ? { scope } : {}),
    },
    {},
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 1201, 'owner');
  outsider = await loginAs(testEnv, 1202, 'outsider');
  const repo = await createRepo(testEnv, {
    slug: 'team/project',
    createdBy: owner.userId,
  });
  await createRepo(testEnv, { slug: 'team/other', createdBy: owner.userId });
  head = (
    await commitChanges(testEnv, repo.id, {
      first_parent: null,
      message: 'init',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('a') }],
    })
  ).changeset.id;
  feature = (
    await commitChanges(testEnv, repo.id, {
      first_parent: head,
      message: 'feature',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
    })
  ).changeset.id;
  await setRef(testEnv, repo.id, 'main', head);
});

describe('apps and installation tokens', () => {
  it('returns the private key once and stores only the public key', async () => {
    const created = await newApp(['contents:read']);
    expect(created.private_key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const row = await q1<{ public_key: string }>(testEnv, 'SELECT public_key FROM apps');
    expect(Object.keys(JSON.parse(row!.public_key)).sort()).toEqual(['e', 'kty', 'n']);
    const got = await json<Record<string, unknown>>(
      call(`/api/v1/apps/${created.app.id}`),
      200,
    );
    expect(JSON.stringify(got)).not.toContain('PRIVATE');
    expect(
      (await call(`/api/v1/apps/${created.app.id}`, 'GET', undefined, outsider.headers))
        .status,
    ).toBe(404);
    expect(
      (await call('/api/v1/apps', 'POST', { name: 'x', permissions: ['admin:all'] }))
        .status,
    ).toBe(400);
  });

  it('only repo admins install an app', async () => {
    const created = await newApp(['contents:read']);
    const res = await call(
      `/api/v1/apps/${created.app.id}/installations`,
      'POST',
      { repos: ['team/project'] },
      outsider.headers,
    );
    expect(res.status).toBe(404);
    expect(await q(testEnv, 'SELECT id FROM app_installations')).toEqual([]);
  });

  it('an installation token can only do what the app permissions allow', async () => {
    const reader = await newApp(['contents:read']);
    const installation = await install(reader.app.id);
    const issued = await json<{
      access_token: string;
      expires_in: number;
      scope: string;
      repositories: string[];
    }>(installationToken(reader, installation), 200);
    expect(issued.access_token).toMatch(/^yagis_/);
    expect(issued).toMatchObject({
      expires_in: 3600,
      scope: 'contents:read',
      repositories: ['team/project'],
    });
    const bearer = { authorization: `Bearer ${issued.access_token}` };

    // read on the installed repository
    expect(
      (await call('/api/v1/repos/team/project/refs', 'GET', undefined, bearer)).status,
    ).toBe(200);
    // never another repository, even one the installer administers
    expect(
      (await call('/api/v1/repos/team/other/refs', 'GET', undefined, bearer)).status,
    ).toBe(404);
    // no write without contents:write, no pull requests without pulls:write
    const move = await call(
      '/api/v1/repos/team/project/refs/feature',
      'PUT',
      { from: null, to: feature },
      bearer,
    );
    expect(move.status).toBe(403);
    const pull = await call(
      '/api/v1/repos/team/project/pulls',
      'POST',
      { title: 'x', head_cs: feature },
      bearer,
    );
    expect(pull.status).toBe(403);
    // not a person: no identity, and session-only routes refuse it
    expect((await call('/api/v1/user', 'GET', undefined, bearer)).status).toBe(403);
    expect(
      (await call('/api/v1/repos/team/project/hooks', 'GET', undefined, bearer)).status,
    ).toBe(401);

    // a writer app moves a branch but cannot open pull requests without pulls:write
    const writer = await newApp(['contents:read', 'contents:write']);
    const writerInstall = await install(writer.app.id);
    const writeToken = (
      await json<{ access_token: string }>(installationToken(writer, writerInstall), 200)
    ).access_token;
    const writeBearer = { authorization: `Bearer ${writeToken}` };
    expect(
      (
        await call(
          '/api/v1/repos/team/project/refs/feature',
          'PUT',
          { from: null, to: feature },
          writeBearer,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          '/api/v1/repos/team/project/pulls',
          'POST',
          { title: 'x', head_cs: feature },
          writeBearer,
        )
      ).status,
    ).toBe(403);
    // like agents, apps never move the default branch
    expect(
      (
        await call(
          '/api/v1/repos/team/project/refs/main',
          'PUT',
          { from: head, to: feature },
          writeBearer,
        )
      ).status,
    ).toBe(403);

    // a narrower token on request; never wider than the app
    const narrow = await json<{ access_token: string; scope: string }>(
      installationToken(writer, writerInstall, 'contents:read'),
      200,
    );
    expect(narrow.scope).toBe('contents:read');
    const wider = await installationToken(reader, installation, 'contents:write');
    expect(wider.status).toBe(400);
    expect(((await wider.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_scope',
    );
  });

  it('refuses bad JWTs and other apps’ installations', async () => {
    const app = await newApp(['contents:read']);
    const other = await newApp(['contents:read']);
    const installation = await install(app.app.id);
    const grant = async (assertion: string, id = installation) =>
      call(
        '/oauth/token',
        'POST',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
          installation_id: id,
        },
        {},
      );
    const claims = { iss: app.app.id, iat: now() - 30, exp: now() + 540 };
    const codes = async (res: Response) => [
      res.status,
      ((await res.json()) as { error: { code: string } }).error.code,
    ];
    // signed by another app's key
    expect(await codes(await grant(await appJwt(other.private_key, claims)))).toEqual([
      401,
      'invalid_client',
    ]);
    // expired, or living longer than 10 minutes
    expect(
      await codes(
        await grant(
          await appJwt(app.private_key, { ...claims, iat: now() - 700, exp: now() - 60 }),
        ),
      ),
    ).toEqual([401, 'invalid_client']);
    expect(
      await codes(
        await grant(await appJwt(app.private_key, { ...claims, exp: now() + 3600 })),
      ),
    ).toEqual([401, 'invalid_client']);
    // the right app, someone else's installation
    const foreign = await install(other.app.id);
    expect(
      await codes(await grant(await appJwt(app.private_key, claims), foreign)),
    ).toEqual([400, 'invalid_grant']);
    // tampered payload
    const good = await appJwt(app.private_key, claims);
    const [h, , s] = good.split('.');
    const forged = `${h}.${enc({ ...claims, iss: other.app.id })}.${s}`;
    expect(await codes(await grant(forged))).toEqual([401, 'invalid_client']);
  });

  it('removing the installation stops its tokens at once', async () => {
    const app = await newApp(['contents:read']);
    const installation = await install(app.app.id);
    const { access_token } = await json<{ access_token: string }>(
      installationToken(app, installation),
      200,
    );
    const bearer = { authorization: `Bearer ${access_token}` };
    expect(
      (await call('/api/v1/repos/team/project/refs', 'GET', undefined, bearer)).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/api/v1/installations/${installation}`,
          'DELETE',
          undefined,
          outsider.headers,
        )
      ).status,
    ).toBe(404);
    expect((await call(`/api/v1/installations/${installation}`, 'DELETE')).status).toBe(
      200,
    );
    expect(
      (await call('/api/v1/repos/team/project/refs', 'GET', undefined, bearer)).status,
    ).toBe(401);
    const actions = await q<{ action: string; actor_kind: string }>(
      testEnv,
      "SELECT action, actor_kind FROM audit_events WHERE action LIKE 'app.%' ORDER BY id",
    );
    expect(actions).toEqual([
      { action: 'app.create', actor_kind: 'user' },
      { action: 'app.install', actor_kind: 'user' },
      { action: 'app.token.issue', actor_kind: 'agent' },
      { action: 'app.uninstall', actor_kind: 'user' },
    ]);
  });

  it("an app's webhook receives events for the repositories it is installed on", async () => {
    const created = await json<{
      app: { id: string };
      webhook: { hook: { id: string; scope: string } };
    }>(
      call('/api/v1/apps', 'POST', {
        name: 'Tracker',
        permissions: ['contents:read'],
        webhook: { url: 'https://tracker.example.com/hook', events: ['issues'] },
      }),
      201,
    );
    expect(created.webhook.hook.scope).toBe('app');
    const sends: unknown[] = [];
    const e = new Proxy(bindings(), {
      get(target, key, receiver) {
        if (key === 'EVENTS_QUEUE')
          return { send: async (b: unknown) => void sends.push(b) };
        return Reflect.get(target, key, receiver);
      },
    });
    const issue = (slug: string) =>
      makeApp(e)(
        new Request(`https://forge.test/api/v1/repos/${slug}/issues`, {
          method: 'POST',
          headers: { ...owner.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 't' }),
        }),
      );
    await issue('team/project');
    expect(sends).toEqual([]); // not installed yet
    await install(created.app.id);
    await issue('team/project');
    await issue('team/other');
    expect(sends).toHaveLength(1);
    // the app owner manages its hook
    expect((await call(`/api/v1/hooks/${created.webhook.hook.id}`)).status).toBe(200);
    expect(
      (
        await call(
          `/api/v1/hooks/${created.webhook.hook.id}`,
          'GET',
          undefined,
          outsider.headers,
        )
      ).status,
    ).toBe(404);
  });
});

describe('OAuth apps', () => {
  const redirect = 'https://tool.example.com/callback';
  const verifier = 'v'.repeat(43) + crypto.randomUUID().replace(/-/g, '');

  async function challenge(v: string): Promise<string> {
    return b64urlEncode(await sha256Bytes(new TextEncoder().encode(v)));
  }

  async function register() {
    return json<{ oauth_app: { client_id: string }; client_secret: string }>(
      call('/api/v1/oauth-apps', 'POST', { name: 'Tool', redirect_uris: [redirect] }),
      201,
    );
  }

  async function authorize(clientId: string, scope: string, approve = true) {
    const params = {
      client_id: clientId,
      redirect_uri: redirect,
      scope,
      state: 'xyz',
      code_challenge: await challenge(verifier),
      code_challenge_method: 'S256',
    };
    const consent = await json<{ app: { name: string }; scopes: string[] }>(
      call(`/api/v1/oauth/authorize?${new URLSearchParams(params)}`),
      200,
    );
    expect(consent.app.name).toBe('Tool');
    const { redirect_to } = await json<{ redirect_to: string }>(
      call('/api/v1/oauth/authorize', 'POST', { ...params, approve }),
      200,
    );
    return new URL(redirect_to);
  }

  function exchange(form: Record<string, string>, headers: Record<string, string> = {}) {
    return makeApp(bindings())(
      new Request('https://forge.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(form),
      }),
    );
  }

  it('signs a person in with the authorization code grant and PKCE', async () => {
    const { oauth_app, client_secret } = await register();
    const back = await authorize(oauth_app.client_id, 'repo:read');
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
    };
    // client authentication is required, by Basic or in the body
    expect((await exchange(form)).status).toBe(401);
    const basic = {
      authorization: `Basic ${btoa(`${oauth_app.client_id}:${client_secret}`)}`,
    };
    const token = await json<{ access_token: string; expires_in: number; scope: string }>(
      exchange(form, basic),
      200,
    );
    expect(token).toMatchObject({ expires_in: 28800, scope: 'repo:read' });
    // single use
    expect((await exchange(form, basic)).status).toBe(400);

    const bearer = { authorization: `Bearer ${token.access_token}` };
    expect(await json(call('/api/v1/user', 'GET', undefined, bearer), 200)).toMatchObject(
      {
        user: { id: owner.userId, login: 'owner' },
      },
    );
    expect(
      (await call('/api/v1/repos/team/project/refs', 'GET', undefined, bearer)).status,
    ).toBe(200);
    expect(
      (
        await call(
          '/api/v1/repos/team/project/refs/feature',
          'PUT',
          { from: null, to: feature },
          bearer,
        )
      ).status,
    ).toBe(403);
    // visible and revocable in the person's token list
    const { tokens } = await json<{ tokens: { label: string; scopes: string[] }[] }>(
      call('/api/v1/tokens'),
      200,
    );
    expect(tokens).toEqual([
      expect.objectContaining({ label: 'OAuth: Tool', scopes: ['repo:read'] }),
    ]);

    // deleting the app revokes the token
    expect(
      (
        await call(
          `/api/v1/oauth-apps/${oauth_app.client_id}`,
          'DELETE',
          undefined,
          outsider.headers,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(`/api/v1/oauth-apps/${oauth_app.client_id}`, 'DELETE')).status,
    ).toBe(200);
    expect((await call('/api/v1/user', 'GET', undefined, bearer)).status).toBe(401);
  });

  it('sign-in only tokens see no repositories', async () => {
    const { oauth_app, client_secret } = await register();
    const code = (await authorize(oauth_app.client_id, '')).searchParams.get('code')!;
    const token = await json<{ access_token: string; scope: string }>(
      exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        client_id: oauth_app.client_id,
        client_secret,
      }),
      200,
    );
    expect(token.scope).toBe('');
    const bearer = { authorization: `Bearer ${token.access_token}` };
    expect((await call('/api/v1/user', 'GET', undefined, bearer)).status).toBe(200);
    expect(
      (await call('/api/v1/repos/team/project/refs', 'GET', undefined, bearer)).status,
    ).toBe(404);
  });

  it('refuses unregistered redirects, wrong verifiers, wrong secrets and denials', async () => {
    const { oauth_app, client_secret } = await register();
    const params = {
      client_id: oauth_app.client_id,
      redirect_uri: 'https://evil.example.com/cb',
      code_challenge: await challenge(verifier),
      code_challenge_method: 'S256',
    };
    const bad = await call(`/api/v1/oauth/authorize?${new URLSearchParams(params)}`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_redirect_uri',
    );
    // PKCE is required
    const plain = await call(
      `/api/v1/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: redirect, code_challenge_method: 'plain' })}`,
    );
    expect(plain.status).toBe(400);
    expect(
      (
        await call('/api/v1/oauth-apps', 'POST', {
          name: 'x',
          redirect_uris: ['http://tool.example.com/cb'],
        })
      ).status,
    ).toBe(400);

    const denied = await authorize(oauth_app.client_id, 'repo:read', false);
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('code')).toBeNull();

    const code = (await authorize(oauth_app.client_id, 'repo:read')).searchParams.get(
      'code',
    )!;
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: oauth_app.client_id,
    };
    expect(
      (await exchange({ ...form, client_secret: 'wrong', code_verifier: verifier }))
        .status,
    ).toBe(401);
    const wrong = await exchange({
      ...form,
      client_secret,
      code_verifier: 'w'.repeat(43),
    });
    expect(wrong.status).toBe(400);
    // a failed redemption burns the code
    expect(
      (await exchange({ ...form, client_secret, code_verifier: verifier })).status,
    ).toBe(400);
    expect(await q(testEnv, 'SELECT code_hash FROM oauth_codes')).toEqual([]);
  });

  it('keeps the agent token exchange working on the shared endpoint', async () => {
    const res = await exchange({ grant_type: 'client_credentials' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    );
  });
});
