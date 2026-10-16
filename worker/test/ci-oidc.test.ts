import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q1, run } from '../src/db/client';
import { commitIdsFor } from '../src/git/mapping';
import { b64urlDecode } from '../src/auth/encoding';
import { claimsFor, createRequestToken } from '../src/ci/oidc';
import { prepareJob, AWS_TOKEN_FILE } from '../src/ci/inject';
import { parsePolicy, type CiRun } from '../src/ci/config';
import type { RunContext } from '../src/ci/context';

const testEnv = env as unknown as TestEnv;
let owner: Awaited<ReturnType<typeof loginAs>>;
let writer: Awaited<ReturnType<typeof loginAs>>;
let repo: Awaited<ReturnType<typeof createRepo>>;
let head: string;
let keyA: JsonWebKey;
let keyB: JsonWebKey;

/** A fresh RSA signing key, generated in-test only (never committed). */
async function newKey(kid: string): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    ...((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey),
    kid,
  } as JsonWebKey;
}

function bindings(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    CI_ENABLED: 'true',
    CI_QUEUE: { send: async () => {} },
    CI_RUNNER: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [keyA] }),
    ...overrides,
  };
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in values) return values[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

async function api(
  path: string,
  init: RequestInit & { as?: { headers: Record<string, string> } } = {},
  env: Env = bindings(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(init.as?.headers ?? {})) headers.set(k, v);
  if (init.body) headers.set('content-type', 'application/json');
  return makeApp(env)(new Request(`https://forge.test${path}`, { ...init, headers }));
}

async function configure(extra: Record<string, unknown> = {}): Promise<void> {
  const res = await api('/api/v1/repos/team/project/ci', {
    method: 'PUT',
    as: owner,
    body: JSON.stringify({
      commands: ['npm test'],
      timeout_seconds: 60,
      permissions: { id_token: 'write' },
      ...extra,
    }),
  });
  expect(res.status).toBe(200);
}

/** Start a run through the API and mark it running, as the runner would. */
async function runningJob(head_rev?: string, as = owner): Promise<CiRun> {
  const res = await api('/api/v1/repos/team/project/ci/runs', {
    method: 'POST',
    as,
    body: JSON.stringify(head_rev ? { head: head_rev } : {}),
  });
  expect(res.status).toBe(202);
  const { run: job } = (await res.json()) as { run: CiRun };
  await run(testEnv, "UPDATE ci_runs SET state = 'running', deadline = ? WHERE id = ?", [
    Date.now() + 60_000,
    job.id,
  ]);
  return (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id = ?', [job.id]))!;
}

async function requestToken(job: CiRun): Promise<string> {
  return createRequestToken(testEnv, job.id, Date.now() + 60_000);
}

async function idToken(
  token: string,
  query = 'audience=sts.amazonaws.com',
  env: Env = bindings(),
): Promise<Response> {
  return api(
    `/ci/oidc/token?${query}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    env,
  );
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as Record<
    string,
    unknown
  >;
}

/** Verify a JWT with WebCrypto against the published JWKS, as a cloud IAM would. */
async function verify(
  jwt: string,
  env: Env = bindings(),
): Promise<{
  ok: boolean;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}> {
  const [h = '', p = '', s = ''] = jwt.split('.');
  const header = decodePart(h);
  const jwks = (await (await api('/ci/oidc/jwks', {}, env)).json()) as {
    keys: (JsonWebKey & { kid: string })[];
  };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, header, claims: decodePart(p) };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(s) as BufferSource,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return { ok, header, claims: decodePart(p) };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  keyA ??= await newKey('key-a');
  keyB ??= await newKey('key-b');
  owner = await loginAs(testEnv, 801, 'owner');
  writer = await loginAs(testEnv, 802, 'writer');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repo.id, writer.userId],
  );
  head = (
    await commitChanges(testEnv, repo.id, {
      first_parent: null,
      message: 'init',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('hello') }],
    })
  ).changeset.id;
  await setRef(testEnv, repo.id, 'main', head);
});

describe('discovery and JWKS', () => {
  it('are public and describe the issuer and its public keys', async () => {
    const discovery = await api('/ci/oidc/.well-known/openid-configuration');
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get('cache-control')).toContain('public');
    const doc = (await discovery.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      issuer: 'https://forge.test/ci/oidc',
      jwks_uri: 'https://forge.test/ci/oidc/jwks',
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['id_token'],
    });
    const jwks = (await (await api('/ci/oidc/jwks')).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'RSA',
      kid: 'key-a',
      alg: 'RS256',
      use: 'sig',
    });
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(jwks.keys[0]).not.toHaveProperty(field);
    }
  });

  it('uses CI_OIDC_ISSUER for a custom domain', async () => {
    const custom = bindings({ CI_OIDC_ISSUER: 'https://git.example.com/ci/oidc/' });
    const doc = (await (
      await api('/ci/oidc/.well-known/openid-configuration', {}, custom)
    ).json()) as { issuer: string; jwks_uri: string };
    expect(doc.issuer).toBe('https://git.example.com/ci/oidc');
    expect(doc.jwks_uri).toBe('https://git.example.com/ci/oidc/jwks');
  });

  it('reports 503 without signing keys and never 404s to the dashboard', async () => {
    const res = await api(
      '/ci/oidc/jwks',
      {},
      bindings({ CI_OIDC_SIGNING_KEYS: undefined }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'oidc_not_configured' } });
    const missing = await api('/ci/oidc/nope');
    expect(missing.status).toBe(404);
  });
});

describe('ID tokens', () => {
  it('signs GitHub-shaped claims that verify against the JWKS and audits them', async () => {
    await configure();
    const job = await runningJob();
    const res = await idToken(await requestToken(job));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { value } = (await res.json()) as { value: string };
    const { ok, header, claims } = await verify(value);
    expect(ok).toBe(true);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'key-a' });
    const sha = (await commitIdsFor(testEnv, repo.id, head))?.sha1;
    expect(claims).toMatchObject({
      iss: 'https://forge.test/ci/oidc',
      aud: 'sts.amazonaws.com',
      sub: 'repo:team/project:ref:refs/heads/main',
      repository: 'team/project',
      repository_owner: 'team',
      ref: 'refs/heads/main',
      ref_type: 'branch',
      run_id: job.id,
      event_name: 'workflow_dispatch',
      actor: 'owner',
      actor_kind: 'human',
      job_workflow_ref: 'team/project/.yag/pipeline@refs/heads/main',
      changeset: head,
    });
    expect(claims.sha).toBe(sha);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
    expect(claims.nbf).toBe(claims.iat);
    expect(typeof claims.jti).toBe('string');

    const custom = await idToken(
      await requestToken(job),
      'audience=api://vault&lifetime=3600',
    );
    const second = await verify(((await custom.json()) as { value: string }).value);
    expect(second.claims.aud).toBe('api://vault');
    expect(Number(second.claims.exp) - Number(second.claims.iat)).toBe(3600);
    expect((await idToken(await requestToken(job), 'lifetime=7200')).status).toBe(400);

    const event = await q1<{ target: string; actor_id: string }>(
      testEnv,
      "SELECT target, actor_id FROM audit_events WHERE action = 'ci.oidc.token' ORDER BY id LIMIT 1",
    );
    expect(event?.actor_id).toBe(`ci-run:${job.id}`);
    expect(JSON.parse(event!.target)).toMatchObject({ sub: claims.sub, jti: claims.jti });
    expect(event!.target).not.toContain(value.split('.')[2]);
  });

  it('accepts GET with the GitHub-style request URL', async () => {
    await configure();
    const job = await runningJob();
    const res = await api(`/ci/oidc/token?run_id=${job.id}&audience=sts.amazonaws.com`, {
      headers: { authorization: `Bearer ${await requestToken(job)}` },
    });
    expect(res.status).toBe(200);
  });

  it('shapes sub for tags, environments and pull requests', async () => {
    const policy = parsePolicy({ commands: ['x'], permissions: { id_token: 'write' } });
    const job = {
      id: 'run-1',
      repo_id: repo.id,
      head_cs: head,
      requested_by: writer.userId,
    } as CiRun;
    const base: RunContext = {
      event: 'workflow_dispatch',
      ref: 'refs/tags/v1.0.0',
      pull_id: null,
      fork: false,
      actor_kind: 'agent',
      origin: 'https://forge.test',
      approval_id: null,
    };
    const tag = await claimsFor(testEnv, job, policy, base, 'sts.amazonaws.com', 600);
    expect(tag).toMatchObject({
      sub: 'repo:team/project:ref:refs/tags/v1.0.0',
      ref_type: 'tag',
      actor: 'writer',
      actor_kind: 'agent',
    });
    const environment = await claimsFor(
      testEnv,
      job,
      { ...policy, environment: 'production' },
      { ...base, ref: 'refs/heads/main' },
      'sts.amazonaws.com',
      600,
    );
    expect(environment).toMatchObject({
      sub: 'repo:team/project:environment:production',
      environment: 'production',
      ref: 'refs/heads/main',
    });
    const pull = await claimsFor(
      testEnv,
      job,
      policy,
      { ...base, event: 'pull_request', ref: 'refs/pull/7/merge', pull_id: 7 },
      'sts.amazonaws.com',
      600,
    );
    expect(pull).toMatchObject({ sub: 'repo:team/project:pull_request', ref_type: '' });
    await expect(
      claimsFor(testEnv, job, policy, { ...base, ref: null }, 'sts.amazonaws.com', 600),
    ).rejects.toMatchObject({ code: 'oidc_subject_unavailable' });
  });

  it('records tag refs on runs started from a tag', async () => {
    await setRef(testEnv, repo.id, 'refs/tags/v1.0.0', head);
    await configure();
    const job = await runningJob('ref:refs/tags/v1.0.0');
    const { value } = (await (await idToken(await requestToken(job))).json()) as {
      value: string;
    };
    expect((await verify(value)).claims.sub).toBe(
      'repo:team/project:ref:refs/tags/v1.0.0',
    );
  });
});

describe('request tokens', () => {
  it('are refused after the run ends, when expired, and for other runs', async () => {
    await configure();
    const job = await runningJob();
    const token = await requestToken(job);
    expect((await idToken(token, `run_id=other-run`)).status).toBe(401);
    expect((await idToken('yagjob_forged')).status).toBe(401);
    expect((await idToken('not-a-token')).status).toBe(401);
    const expired = await createRequestToken(testEnv, job.id, Date.now() - 1);
    expect((await idToken(expired)).status).toBe(401);

    // a second running run does not make the first run's token valid for it
    await setRef(testEnv, repo.id, 'refs/tags/v2', head);
    await run(testEnv, "UPDATE ci_runs SET state = 'passed' WHERE id = ?", [job.id]);
    const other = await runningJob('ref:refs/tags/v2');
    const ended = await idToken(token);
    expect(ended.status).toBe(401);
    expect(await ended.json()).toMatchObject({ error: { code: 'run_not_active' } });
    expect((await idToken(token, `run_id=${other.id}`)).status).toBe(401);
    expect((await idToken(await requestToken(other))).status).toBe(200);
  });

  it('are refused for pipelines without permissions.id_token', async () => {
    await configure({ permissions: { id_token: 'none' } });
    const job = await runningJob();
    const res = await idToken(await requestToken(job));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'id_token_not_permitted' } });
  });

  it('are refused for fork pull requests and authors without write', async () => {
    await configure();
    const job = await runningJob();
    const context = JSON.parse(job.context!) as RunContext;
    await run(testEnv, 'UPDATE ci_runs SET context = ? WHERE id = ?', [
      JSON.stringify({ ...context, event: 'pull_request', pull_id: 1, fork: true }),
      job.id,
    ]);
    const fork = await idToken(await requestToken(job));
    expect(fork.status).toBe(403);
    expect(await fork.json()).toMatchObject({ error: { code: 'credentials_withheld' } });

    const pull = await testEnv.DB.prepare(
      `INSERT INTO pull_requests (repo_id,title,author_id,base_ref,base_cs,head_cs,state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'open',?,?)`,
    )
      .bind(repo.id, 'x', writer.userId, 'main', head, head, Date.now(), Date.now())
      .run();
    const pullId = pull.meta.last_row_id;
    await run(testEnv, 'UPDATE ci_runs SET context = ? WHERE id = ?', [
      JSON.stringify({ ...context, event: 'pull_request', pull_id: pullId, fork: false }),
      job.id,
    ]);
    expect((await idToken(await requestToken(job))).status).toBe(200);
    // the author loses write: no more tokens for that pull request's runs
    await run(testEnv, "UPDATE repo_members SET role = 'read' WHERE user_id = ?", [
      writer.userId,
    ]);
    expect((await idToken(await requestToken(job))).status).toBe(403);
  });
});

describe('key rotation', () => {
  it('keeps verifying tokens from the previous key while the new key signs', async () => {
    await configure();
    const job = await runningJob();
    const before = (
      (await (await idToken(await requestToken(job))).json()) as {
        value: string;
      }
    ).value;
    const rotated = bindings({
      CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [keyB, keyA] }),
    });
    const after = (
      (await (await idToken(await requestToken(job), undefined, rotated)).json()) as {
        value: string;
      }
    ).value;
    const old = await verify(before, rotated);
    const fresh = await verify(after, rotated);
    expect(old.ok && old.header.kid === 'key-a').toBe(true);
    expect(fresh.ok && fresh.header.kid === 'key-b').toBe(true);
    // once key-a is retired its tokens no longer verify
    const retired = bindings({ CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [keyB] }) });
    expect((await verify(before, retired)).ok).toBe(false);
  });
});

describe('package registry login (#53)', () => {
  it('signs a packages: write job in to the registry without OIDC, for its own repo', async () => {
    const noOidc = bindings({ CI_OIDC_SIGNING_KEYS: undefined });
    await configure({ permissions: { packages: 'write' } });
    const job = await runningJob();
    const access = await prepareJob(
      noOidc,
      job,
      parsePolicy(JSON.parse(job.config)),
      job.deadline!,
    );
    expect(access.env).toMatchObject({
      YAG_REGISTRY: 'forge.test',
      YAG_REGISTRY_USERNAME: 'ci',
    });
    const password = access.env.YAG_REGISTRY_PASSWORD!;
    expect(password).toMatch(/^yagjob_/);
    expect(access.mask).toContain(password);
    expect(access.env.YAG_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    // what `helm registry login` then `helm push` do: token exchange, then upload
    const basic = { authorization: `Basic ${btoa(`ci:${password}`)}` };
    const exchanged = await api(
      '/v2/token?service=forge.test&scope=repository:team/project/charts/app:pull,push',
      { headers: basic },
      noOidc,
    );
    expect(exchanged.status).toBe(200);
    const { token } = (await exchanged.json()) as { token: string };
    const upload = await api(
      '/v2/team/project/charts/app/blobs/uploads/',
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      noOidc,
    );
    expect(upload.status).toBe(202);
    // the same token mints no ID tokens: the pipeline did not ask for them
    expect((await idToken(password)).status).toBe(403);
  });
});

describe('AWS web identity', () => {
  it('writes a token file and AWS_* variables for opted-in jobs', async () => {
    await configure({
      aws: {
        role_arn: 'arn:aws:iam::123456789012:role/deploy',
        region: 'ap-southeast-2',
      },
    });
    const job = await runningJob();
    const access = await prepareJob(
      bindings(),
      job,
      parsePolicy(JSON.parse(job.config)),
      job.deadline!,
    );
    expect(access.env).toMatchObject({
      AWS_WEB_IDENTITY_TOKEN_FILE: AWS_TOKEN_FILE,
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/deploy',
      AWS_REGION: 'ap-southeast-2',
      AWS_DEFAULT_REGION: 'ap-southeast-2',
      AWS_ROLE_SESSION_NAME: `yag-${job.id}`,
    });
    expect(access.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(
      `https://forge.test/ci/oidc/token?run_id=${job.id}`,
    );
    expect(access.env.YAG_ID_TOKEN_REQUEST_TOKEN).toBe(
      access.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    );
    const file = access.files.find((f) => f.path === AWS_TOKEN_FILE)!;
    const { ok, claims } = await verify(file.content);
    expect(ok).toBe(true);
    expect(claims.aud).toBe('sts.amazonaws.com');
    expect(Number(claims.exp)).toBeGreaterThan(job.deadline! / 1000);
    expect(access.mask).toContain(file.content);
    expect(access.mask).toContain(access.env.YAG_ID_TOKEN_REQUEST_TOKEN);
    // the request token in the environment works against the token endpoint
    expect((await idToken(access.env.YAG_ID_TOKEN_REQUEST_TOKEN!)).status).toBe(200);
  });

  it('rejects an aws block without id_token permission', async () => {
    const res = await api('/api/v1/repos/team/project/ci', {
      method: 'PUT',
      as: owner,
      body: JSON.stringify({
        commands: ['x'],
        aws: { role_arn: 'arn:aws:iam::123456789012:role/deploy', region: 'us-east-1' },
      }),
    });
    expect(res.status).toBe(400);
  });
});
