import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, getRepo, setRef } from '../src/db/repos';
import { recordUsage } from '../src/usage/record';
import { commitChanges } from '../src/core/commit';
import { createApiToken } from '../src/auth/tokens';
import { AGENT_SCOPES } from '../src/auth/agents';
import { q, q1 } from '../src/db/client';
import { app as honoApp } from '../src/app';
import { mcpTools } from '../src/mcp/tools';
import mcpDoc from '../../docs/mcp.md?raw';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const fetchApp = makeApp(testEnv);
const app = async (request: Request): Promise<Response> => fetchApp(request);

const ORIGIN = 'https://x';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const author = { name: 'Ada', email: 'ada@example.com' };

type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let mainCs = '';

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(digest) };
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function form(fields: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of [value].flat()) body.append(key, v);
  }
  return body;
}

async function register(): Promise<string> {
  const res = await app(
    new Request(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:33418/callback', REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    }),
  );
  expect(res.status).toBe(201);
  const body = await json<{ client_id: string; token_endpoint_auth_method: string }>(res);
  expect(body.token_endpoint_auth_method).toBe('none');
  return body.client_id;
}

function authorizeQuery(clientId: string, challenge: string, scope?: string) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: `${ORIGIN}/mcp`,
    ...(scope ? { scope } : {}),
  };
}

/** Consent through the form as the signed-in owner; returns the code. */
async function consent(
  clientId: string,
  challenge: string,
  scopes: string[],
  repos = 'acme/app',
): Promise<string> {
  const query = authorizeQuery(clientId, challenge);
  const page = await app(
    new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams(query)}`, {
      headers: owner.headers,
    }),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  const res = await app(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { ...owner.headers, origin: ORIGIN },
      body: form({
        ...query,
        csrf: csrf as string,
        agent: 'new',
        kind: 'claude_code',
        repos,
        scope: scopes,
        decision: 'approve',
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(302);
  const location = new URL(res.headers.get('location') as string);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('st-1');
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
  return location.searchParams.get('code') as string;
}

function token(fields: Record<string, string>): Promise<Response> {
  return app(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(fields),
    }),
  );
}

/** Register, consent and redeem: an OAuth access token for the MCP server. */
async function oauthToken(
  scopes: string[],
): Promise<{ access: string; refresh: string; clientId: string }> {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const code = await consent(clientId, challenge, scopes);
  const res = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  });
  expect(res.status).toBe(200);
  const body = await json<{ access_token: string; refresh_token: string; scope: string }>(
    res,
  );
  expect(body.access_token.startsWith('yagat_')).toBe(true);
  expect(body.scope.split(' ').sort()).toEqual([...scopes].sort());
  return { access: body.access_token, refresh: body.refresh_token, clientId };
}

interface Mcp {
  session: string;
  rpc: (
    method: string,
    params?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError: boolean; text: string; structured?: Record<string, unknown> }>;
}

function post(
  bearer: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

/** initialize + notifications/initialized, then a client bound to the session. */
async function connect(bearer: string, version = '2025-06-18'): Promise<Mcp> {
  const init = await post(bearer, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  expect(init.status).toBe(200);
  const session = init.headers.get('mcp-session-id') as string;
  expect(session).toMatch(/^[0-9a-f]{64}$/);
  const result = (await json<{ result: { protocolVersion: string } }>(init)).result;
  expect(result.protocolVersion).toBe(version);
  const headers = { 'mcp-session-id': session, 'mcp-protocol-version': version };
  const ack = await post(
    bearer,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    headers,
  );
  expect(ack.status).toBe(202);
  let id = 1;
  const rpc = (method: string, params?: unknown, extra: Record<string, string> = {}) =>
    post(bearer, { jsonrpc: '2.0', id: id++, method, params }, { ...headers, ...extra });
  return {
    session,
    rpc,
    call: async (name, args) => {
      const res = await rpc(
        'tools/call',
        { name, arguments: args },
        {
          accept: 'application/json',
        },
      );
      expect(res.status).toBe(200);
      const body = await json<{
        result: {
          isError: boolean;
          content: { text: string }[];
          structuredContent?: Record<string, unknown>;
        };
      }>(res);
      return {
        isError: body.result.isError,
        text: body.result.content[0]?.text ?? '',
        structured: body.result.structuredContent,
      };
    },
  };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 1, 'ada');
  const repo = await createRepo(dbEnv, {
    slug: 'acme/app',
    visibility: 'private',
    createdBy: owner.userId,
  });
  const seeded = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: [{ path: 'README.md', op: 'add', content_b64: btoa('hello mcp\n') }],
  });
  mainCs = seeded.changeset.id;
  await setRef(dbEnv, repo.id, 'main', mainCs);
});

describe('tool catalogue (#56)', () => {
  it('every tool has a JSON schema, a description, annotations and a live route', () => {
    const live = new Set(
      honoApp.routes.map(
        (r) =>
          `${r.method} ${r.path.replace(/\{[^}]*\}/g, '').replace('/repos/:owner/:name', '/repos/:repo')}`,
      ),
    );
    const tools = [...mcpTools().values()];
    expect(tools.length).toBeGreaterThanOrEqual(30);
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^[a-z]+_[a-z_]+$/);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf('object');
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(tool.annotations[hint], `${tool.name}.${hint}`).toBeTypeOf('boolean');
      }
      if (tool.annotations.readOnlyHint) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
      expect(AGENT_SCOPES, tool.name).toContain(tool.scope);
      expect(live.has(`${tool.method} ${tool.path}`), `${tool.name} route`).toBe(true);
    }
    // docs/mcp.md lists every tool
    const missing = tools.filter((t) => !mcpDoc.includes(`\`${t.name}\``));
    expect(missing.map((t) => t.name)).toEqual([]);
    for (const name of [
      'repo_list',
      'code_read',
      'changeset_create',
      'branch_update',
      'pr_create',
      'review_create',
      'issue_create',
      'ci_run',
      'ci_logs',
      'pipeline_artifacts',
    ]) {
      expect(mcpTools().has(name), name).toBe(true);
    }
  });
});

describe('MCP OAuth 2.1 (#56)', () => {
  it('publishes protected resource and authorization server metadata', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app(new Request(`${ORIGIN}${path}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        bearer_methods_supported: ['header'],
      });
    }
    const as = await json(
      await app(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)),
    );
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
    });
  });

  it('401 from /mcp carries WWW-Authenticate with resource_metadata', async () => {
    for (const bearer of [null, 'yagat_nope']) {
      const res = await post(bearer, { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(challenge).toContain('scope="');
      if (bearer) expect(challenge).toContain('error="invalid_token"');
    }
    // a session cookie is not a credential for /mcp
    const cookie = await post(
      null,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      owner.headers,
    );
    expect(cookie.status).toBe(401);
  });

  it('refuses unsafe redirect URIs at registration', async () => {
    for (const uri of ['http://evil.example/cb', 'https://ok.example/cb#frag', 'nope']) {
      const res = await app(
        new Request(`${ORIGIN}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [uri] }),
        }),
      );
      expect(res.status, uri).toBe(400);
      expect((await json<{ error: string }>(res)).error).toBe('invalid_redirect_uri');
    }
  });

  it('authorization requests need PKCE S256, a registered redirect and this resource', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const get = (query: Record<string, string>) =>
      app(
        new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams(query)}`, {
          headers: owner.headers,
        }),
      );
    const good = authorizeQuery(clientId, challenge);
    // unknown redirect: an error page, never a redirect
    const evil = await get({ ...good, redirect_uri: 'https://evil.example/cb' });
    expect(evil.status).toBe(400);
    expect(evil.headers.get('location')).toBeNull();
    const errorOf = async (query: Record<string, string>): Promise<string | null> => {
      const res = await get(query);
      expect(res.status).toBe(302);
      return new URL(res.headers.get('location') as string).searchParams.get('error');
    };
    expect(await errorOf({ ...good, code_challenge_method: 'plain' })).toBe(
      'invalid_request',
    );
    expect(await errorOf({ ...good, resource: 'https://other.example/mcp' })).toBe(
      'invalid_target',
    );
    expect(await errorOf({ ...good, scope: 'admin:all' })).toBe('invalid_scope');
    // loopback redirects may change port
    const otherPort = await get({
      ...good,
      redirect_uri: 'http://127.0.0.1:5555/callback',
    });
    expect(otherPort.status).toBe(200);
    // signed out: asked to sign in, no form
    const anon = await app(
      new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams(good)}`),
    );
    expect(await anon.text()).toContain('Sign in to continue');
  });

  it('the consent form refuses forged posts and honours deny', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const query = authorizeQuery(clientId, challenge);
    const submit = (fields: Record<string, string>, headers: Record<string, string>) =>
      app(
        new Request(`${ORIGIN}/oauth/authorize`, {
          method: 'POST',
          headers,
          body: form({
            ...query,
            agent: 'new',
            repos: 'acme/app',
            scope: 'contents:read',
            ...fields,
          }),
        }),
      );
    expect(
      (await submit({ csrf: 'f'.repeat(64), decision: 'approve' }, owner.headers)).status,
    ).toBe(403);
    const html = await (
      await app(
        new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams(query)}`, {
          headers: owner.headers,
        }),
      )
    ).text();
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] as string;
    expect(
      (
        await submit(
          { csrf, decision: 'approve' },
          { ...owner.headers, origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    const stranger = await loginAs(testEnv, 2, 'mallory');
    expect((await submit({ csrf, decision: 'approve' }, stranger.headers)).status).toBe(
      403,
    );
    const denied = await submit({ csrf, decision: 'deny' }, owner.headers);
    expect(denied.status).toBe(302);
    expect(
      new URL(denied.headers.get('location') as string).searchParams.get('error'),
    ).toBe('access_denied');
    // a repo the owner cannot read is refused
    const hidden = await submit(
      { csrf, decision: 'approve', repos: 'acme/missing' },
      owner.headers,
    );
    expect(hidden.status).toBe(400);
    expect(await q(dbEnv, 'SELECT id FROM mcp_grants')).toEqual([]);
  });

  it('issues agent tokens through #57: single-use codes, PKCE, rotated refresh, revocation', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const code = await consent(clientId, challenge, ['contents:read']);
    const redeem = (fields: Record<string, string>) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        ...fields,
      });
    // wrong verifier burns the code
    const wrong = await redeem({ code_verifier: 'x'.repeat(43) });
    expect(wrong.status).toBe(400);
    expect((await json<{ error: string }>(wrong)).error).toBe('invalid_grant');
    expect((await redeem({})).status).toBe(400);

    const { access, refresh, clientId: client2 } = await oauthToken(['contents:read']);
    const agent = await q1<{ kind: string; name: string; max_scopes: string }>(
      dbEnv,
      `SELECT a.kind, a.name, a.max_scopes FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
        ORDER BY t.created_at DESC LIMIT 1`,
    );
    expect(agent).toMatchObject({ kind: 'claude_code', name: 'Claude Code' });
    const repo = await app(
      new Request(`${ORIGIN}/api/v1/repos/acme/app`, {
        headers: { authorization: `Bearer ${access}` },
      }),
    );
    expect(repo.status).toBe(200);

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: client2,
    });
    expect(refreshed.status).toBe(200);
    const next = await json<{ access_token: string; refresh_token: string }>(refreshed);
    expect(next.refresh_token).not.toBe(refresh);
    // the old refresh token was rotated out
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: client2,
        })
      ).status,
    ).toBe(400);

    // revoking the backing token in Settings revokes the grant
    const grant = await q1<{ subject_token_id: string }>(
      dbEnv,
      'SELECT subject_token_id FROM mcp_grants WHERE client_id = ?',
      [client2],
    );
    const tokens = await json<{ tokens: { id: string; label: string }[] }>(
      await app(new Request(`${ORIGIN}/api/v1/tokens`, { headers: owner.headers })),
    );
    expect(tokens.tokens.find((t) => t.id === grant?.subject_token_id)?.label).toBe(
      'MCP: Claude Code',
    );
    const revoked = await app(
      new Request(`${ORIGIN}/api/v1/tokens/${grant?.subject_token_id}`, {
        method: 'DELETE',
        headers: owner.headers,
      }),
    );
    expect(revoked.status).toBe(200);
    expect(
      (await post(next.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status,
    ).toBe(401);
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: next.refresh_token,
          client_id: client2,
        })
      ).status,
    ).toBe(400);
    const actions = await q<{ action: string }>(
      dbEnv,
      `SELECT action FROM audit_events WHERE action IN
         ('mcp.client.register', 'mcp.grant.create', 'agent.create', 'agent.token.issue')`,
    );
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set([
        'mcp.client.register',
        'mcp.grant.create',
        'agent.create',
        'agent.token.issue',
      ]),
    );
  });

  it('keeps the RFC 8693 exchange working on the shared token endpoint', async () => {
    const res = await token({ grant_type: 'client_credentials' });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'invalid_request',
    );
  });
});

describe('MCP Streamable HTTP (#56)', () => {
  it('opens a pull request end to end with an OAuth agent token', async () => {
    const { access } = await oauthToken([
      'contents:read',
      'contents:write',
      'pulls:write',
    ]);
    const mcp = await connect(access);
    const list = await json<{
      result: { tools: { name: string; annotations: object }[] };
    }>(await mcp.rpc('tools/list'));
    expect(list.result.tools.map((t) => t.name)).toEqual([...mcpTools().keys()]);

    const read = await mcp.call('code_read', {
      repo: 'acme/app',
      path: 'README.md',
      cs: 'main',
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('hello mcp');

    const committed = await mcp.call('changeset_create', {
      repo: 'acme/app',
      first_parent: mainCs,
      message: 'agent change',
      author,
      changes: [{ path: 'NEW.md', op: 'add', content_b64: btoa('new\n') }],
    });
    expect(committed.isError, committed.text).toBe(false);
    const head = (committed.structured?.changeset as { id: string }).id;
    const pr = await mcp.call('pr_create', {
      repo: 'acme/app',
      title: 'Agent PR',
      head_cs: head,
    });
    expect(pr.isError, pr.text).toBe(false);
    const prs = await mcp.call('pr_list', { repo: 'acme/app' });
    expect(prs.text).toContain('Agent PR');
    // provenance: the agent identity wrote the changeset
    expect(
      await q1(dbEnv, 'SELECT agent_id FROM changeset_agents WHERE changeset_id = ?', [
        head,
      ]),
    ).toBeTruthy();
  });

  it('usage_get reads the repo usage an agent can watch its spend with (#61)', async () => {
    const repo = (await getRepo(
      dbEnv,
      (await q1<{ id: string }>(dbEnv, "SELECT id FROM repos WHERE slug = 'acme/app'"))!
        .id,
    ))!;
    await recordUsage(dbEnv, [
      {
        repo,
        kind: 'tokens',
        source: 'reported',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        input_tokens: 1_000_000,
      },
    ]);
    const { access } = await oauthToken(['contents:read']);
    const mcp = await connect(access);
    const usage = await mcp.call('usage_get', { repo: 'acme/app', group_by: 'model' });
    expect(usage.isError, usage.text).toBe(false);
    expect(usage.structured).toMatchObject({
      group_by: 'model',
      totals: { input_tokens: 1_000_000, usd_micros: 293_000 },
    });
  });

  it('code_search and file_find search as the caller (#45)', async () => {
    const { access } = await oauthToken(['contents:read']);
    const mcp = await connect(access);
    const found = await mcp.call('code_search', { q: 'hello mcp' });
    expect(found.isError, found.text).toBe(false);
    expect(found.structured?.results).toMatchObject([
      { repo: 'acme/app', path: 'README.md', matches: [{ line: 1, ranges: [[0, 9]] }] },
    ]);
    const files = await mcp.call('file_find', { q: 'readme', repo: 'acme/app' });
    expect(files.isError, files.text).toBe(false);
    expect(files.structured?.files).toMatchObject([
      { repo: 'acme/app', path: 'README.md' },
    ]);
  });

  it('release tools draft as the agent and hold publishing for approval (#54, #62)', async () => {
    const repo = await q1<{ id: string }>(
      dbEnv,
      "SELECT id FROM repos WHERE slug = 'acme/app'",
    );
    await setRef(dbEnv, repo!.id, 'refs/tags/v1.0', mainCs);
    // releases write the repo: agents need contents:write as well
    const { access } = await oauthToken([
      'contents:read',
      'contents:write',
      'releases:write',
    ]);
    const mcp = await connect(access);
    const notes = await mcp.call('release_notes', { repo: 'acme/app', tag: 'v1.0' });
    expect(notes.isError, notes.text).toBe(false);
    const draft = await mcp.call('release_create', {
      repo: 'acme/app',
      tag: 'v1.0',
      name: 'One',
      body: 'first',
      draft: true,
    });
    expect(draft.isError, draft.text).toBe(false);
    const id = (draft.structured?.release as { id: string }).id;
    const got = await mcp.call('release_get', { repo: 'acme/app', tag: 'v1.0' });
    expect(got.structured?.release).toMatchObject({ id, draft: true, name: 'One' });
    expect((await mcp.call('release_list', { repo: 'acme/app' })).text).toContain(id);
    const publish = await mcp.call('release_update', {
      repo: 'acme/app',
      id,
      draft: false,
    });
    expect(publish.isError).toBe(true);
    expect(JSON.parse(publish.text)).toMatchObject({
      error: { code: 'approval_required' },
    });
  });

  it('a token without issues:write gets a tool error, not a transport error', async () => {
    const { access } = await oauthToken(['contents:read']);
    const mcp = await connect(access);
    const res = await mcp.call('issue_create', { repo: 'acme/app', title: 'nope' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toMatchObject({
      error: { code: 'insufficient_scope', required_scope: 'issues:write' },
    });
    // RBAC, not just the tool layer: a write through any route is refused too
    const write = await mcp.call('changeset_create', {
      repo: 'acme/app',
      first_parent: mainCs,
      message: 'x',
      author,
      changes: [],
    });
    expect(write.isError).toBe(true);
    // bad arguments are tool errors the model can correct
    const bad = await mcp.call('code_read', { repo: 'not a slug' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.text).error.code).toBe('invalid_arguments');
    const unknown = await json<{ error: { code: number } }>(
      await mcp.rpc('tools/call', { name: 'no_such_tool', arguments: {} }),
    );
    expect(unknown.error.code).toBe(-32602);
  });

  it('enforces sessions, protocol version, origin and single messages', async () => {
    const raw = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'mcp',
        scopes: ['repo:read', 'agent:run'],
      })
    ).raw;
    const mcp = await connect(raw);
    const ping = { jsonrpc: '2.0', id: 9, method: 'ping' };
    expect((await post(raw, ping)).status).toBe(400); // no session
    expect((await post(raw, ping, { 'mcp-session-id': 'f'.repeat(64) })).status).toBe(
      404,
    );
    expect(
      (await mcp.rpc('ping', undefined, { 'mcp-protocol-version': '1999-01-01' })).status,
    ).toBe(400);
    expect(
      (await mcp.rpc('ping', undefined, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await post(raw, [ping, ping], { 'mcp-session-id': mcp.session })).status,
    ).toBe(400);
    expect((await post(raw, '{', { 'mcp-session-id': mcp.session })).status).toBe(400);
    expect(await json(await mcp.rpc('ping'))).toMatchObject({ result: {} });
    expect(await json(await mcp.rpc('resources/list'))).toMatchObject({
      error: { code: -32601 },
    });

    // sessions belong to the credential that opened them
    const other = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'other',
        scopes: ['repo:read', 'agent:run'],
      })
    ).raw;
    expect((await post(other, ping, { 'mcp-session-id': mcp.session })).status).toBe(404);
    // API tokens need agent:run
    const plain = (
      await createApiToken(dbEnv, owner.userId, { label: 'plain', scopes: ['repo:read'] })
    ).raw;
    const refused = await post(plain, ping);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('www-authenticate')).toContain('insufficient_scope');

    // a plain GET opens no server stream; DELETE ends the session
    const get = await app(
      new Request(`${ORIGIN}/mcp`, {
        headers: { authorization: `Bearer ${raw}`, 'mcp-session-id': mcp.session },
      }),
    );
    expect(get.status).toBe(405);
    const del = await app(
      new Request(`${ORIGIN}/mcp`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${raw}`, 'mcp-session-id': mcp.session },
      }),
    );
    expect(del.status).toBe(204);
    expect((await mcp.rpc('ping')).status).toBe(404);
  });

  it('streams tools/call over resumable SSE (2025-11-25)', async () => {
    const raw = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'mcp',
        scopes: ['repo:read', 'agent:run'],
      })
    ).raw;
    const mcp = await connect(raw, '2025-11-25');
    const res = await mcp.rpc('tools/call', {
      name: 'code_read',
      arguments: { repo: 'acme/app', path: 'README.md', cs: 'main' },
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    const events = text.split('\n\n').filter((e) => e !== '');
    expect(events[0]).toMatch(/^id: [0-9a-f]{16}\.0\ndata:$/);
    const last = events[1] as string;
    const stream = /^id: ([0-9a-f]{16})\.1\n/.exec(last)?.[1] as string;
    expect(stream).toBeTruthy();
    const data = JSON.parse(last.slice(last.indexOf('data: ') + 6)) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(data.result.isError).toBe(false);
    expect(data.result.content[0]?.text).toContain('hello mcp');

    // reconnect after the priming event: the response is replayed
    const resumed = await app(
      new Request(`${ORIGIN}/mcp`, {
        headers: {
          authorization: `Bearer ${raw}`,
          accept: 'text/event-stream',
          'mcp-session-id': mcp.session,
          'last-event-id': `${stream}.0`,
        },
      }),
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toBe(`${last}\n\n`);
  });

  it('keeps the per-repo endpoint as a deprecated alias', async () => {
    const raw = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'legacy',
        scopes: ['repo:read', 'agent:run'],
      })
    ).raw;
    const res = await app(
      new Request(`${ORIGIN}/api/v1/repos/acme/app/agents/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toMatch(/^@\d+$/);
    expect(res.headers.get('sunset')).toBeTruthy();
    expect(res.headers.get('link')).toContain('</mcp>; rel="successor-version"');
    expect((await json<{ result: { tools: unknown[] } }>(res)).result.tools.length).toBe(
      11,
    );
  });
});

describe('MCP with guardrails, threads, queue and merges (wave 2b)', () => {
  it('a tool call is judged by the agent policy: a workflow change waits for approval', async () => {
    const { access } = await oauthToken(['contents:read', 'contents:write']);
    const mcp = await connect(access);
    const held = await mcp.call('changeset_create', {
      repo: 'acme/app',
      first_parent: mainCs,
      message: 'ci',
      author,
      changes: [
        { path: '.github/workflows/ci.yml', op: 'add', content_b64: btoa('on: push\n') },
      ],
    });
    expect(held.isError).toBe(true);
    expect(JSON.parse(held.text)).toMatchObject({
      error: { code: 'approval_required' },
    });
  });

  it('exposes review thread, merge strategy, issue and queue tools', async () => {
    const names = [...mcpTools().keys()];
    for (const name of [
      'pr_conflicts',
      'pr_update_branch',
      'review_thread_list',
      'review_thread_create',
      'review_thread_reply',
      'review_thread_resolve',
      'issue_labels_set',
      'issue_assignees_set',
      'queue_list',
      'queue_claim',
      'queue_heartbeat',
      'queue_release',
    ])
      expect(names).toContain(name);
    const { access } = await oauthToken([
      'contents:read',
      'contents:write',
      'pulls:write',
    ]);
    const mcp = await connect(access);
    const committed = await mcp.call('changeset_create', {
      repo: 'acme/app',
      first_parent: mainCs,
      message: 'agent change',
      author,
      changes: [{ path: 'NEW.md', op: 'add', content_b64: btoa('new\n') }],
    });
    const head = (committed.structured?.changeset as { id: string }).id;
    const pr = await mcp.call('pr_create', {
      repo: 'acme/app',
      title: 'PR',
      head_cs: head,
    });
    expect(pr.isError, pr.text).toBe(false);
    const pull = (pr.structured?.pull as { id: number; revision: number }) ?? null;
    expect(pull).toBeTruthy();
    const conflicts = await mcp.call('pr_conflicts', { repo: 'acme/app', id: pull.id });
    expect(conflicts.isError, conflicts.text).toBe(false);
    expect(conflicts.structured).toMatchObject({ mergeable: true, conflicts: [] });
    const thread = await mcp.call('review_thread_create', {
      repo: 'acme/app',
      id: pull.id,
      // the thread schema is an intersection, so it nests under `body`
      body: {
        head_cs: head,
        revision: pull.revision,
        path: 'NEW.md',
        side: 'head',
        line: 1,
        body: 'Is this right?',
      },
    });
    expect(thread.isError, thread.text).toBe(false);
    const threadId = (thread.structured?.thread as { id: number }).id;
    const resolved = await mcp.call('review_thread_resolve', {
      repo: 'acme/app',
      id: pull.id,
      thread: threadId,
      resolved: true,
    });
    expect(resolved.isError, resolved.text).toBe(false);
    expect(resolved.structured?.thread).toMatchObject({ id: threadId });
    // queue tools need queue:claim, which this grant lacks
    const claim = await mcp.call('queue_claim', { repo: 'acme/app' });
    expect(claim.isError).toBe(true);
    expect(JSON.parse(claim.text)).toMatchObject({
      error: { code: 'insufficient_scope', required_scope: 'queue:claim' },
    });
  });

  it('the kill switch ends MCP sessions and refuses refresh grants', async () => {
    const { access, refresh, clientId } = await oauthToken(['contents:read']);
    const mcp = await connect(access);
    expect(
      await q(dbEnv, 'SELECT id FROM mcp_sessions WHERE id = ?', [mcp.session]),
    ).toHaveLength(1);
    const admin = makeApp(
      new Proxy(testEnv, {
        get: (target, key, receiver) =>
          key === 'AGENTS_ADMIN_USER_IDS'
            ? owner.userId
            : Reflect.get(target, key, receiver),
      }),
    );
    const paused = await admin(
      new Request(`${ORIGIN}/api/v1/admin/agents/pause`, {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'incident' }),
      }),
    );
    expect(paused.status).toBe(200);
    expect(await q(dbEnv, 'SELECT id FROM mcp_sessions')).toHaveLength(0);
    expect((await mcp.rpc('tools/list')).status).toBe(401);
    const refused = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ error: 'invalid_grant' });
    const resumed = await admin(
      new Request(`${ORIGIN}/api/v1/admin/agents/pause`, {
        method: 'DELETE',
        headers: owner.headers,
      }),
    );
    expect(resumed.status).toBe(200);
    const again = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(again.status).toBe(200);
  });
});

describe('shared OAuth endpoints (#56 x #75)', () => {
  it('serves the dashboard consent page for clients that are not MCP clients', async () => {
    const withAssets = makeApp(
      new Proxy(testEnv, {
        get: (target, key, receiver) =>
          key === 'ASSETS'
            ? { fetch: async () => new Response('<div id="root"></div>') }
            : Reflect.get(target, key, receiver),
      }),
    );
    const spa = await withAssets(
      new Request(`${ORIGIN}/oauth/authorize?client_id=oa_app&response_type=code`, {
        headers: owner.headers,
      }),
    );
    expect(await spa.text()).toBe('<div id="root"></div>');
    // an MCP client still gets the server-rendered MCP consent form
    const clientId = await register();
    const { challenge } = await pkce();
    const mcp = await withAssets(
      new Request(
        `${ORIGIN}/oauth/authorize?${new URLSearchParams(authorizeQuery(clientId, challenge))}`,
        { headers: owner.headers },
      ),
    );
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain('name="csrf"');
  });
});
