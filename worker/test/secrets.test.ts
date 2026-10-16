import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { decryptSecrets, encryptSecret, rewrapDataKeys } from '../src/secrets/crypto';
import {
  orgScope,
  putSecret,
  putVariable,
  repoScope,
  resolveForJob,
} from '../src/secrets/store';
import { createMasker, MASK } from '../src/ci/mask';
import { jobTrust, refAllowed } from '../src/ci/environments';
import { prepareJob } from '../src/ci/inject';
import { enqueueRun } from '../src/ci/runs';
import { CiRunnerDO } from '../src/ci/runner';
import { parsePolicy, type CiRun } from '../src/ci/config';
import { parseContext, type RunContext } from '../src/ci/context';

const testEnv = env as unknown as TestEnv;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reviewer: Login;
let outsider: Login;
let repo: Awaited<ReturnType<typeof createRepo>>;
let head: string;

/** A random 32-byte key, base64: generated in-test only. */
function newKek(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
const kekV1 = newKek();
const kekV2 = newKek();

function bindings(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    CI_ENABLED: 'true',
    CI_QUEUE: { send: async () => {} },
    CI_RUNNER: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    SECRETS_KEK: kekV1,
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
  method = 'GET',
  body?: unknown,
  as: { headers: Record<string, string> } = owner,
  env: Env = bindings(),
): Promise<Response> {
  return makeApp(env)(
    new Request(`https://forge.test/api/v1${path}`, {
      method,
      headers: { ...as.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const repoPath = '/repos/team/project';

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 901, 'owner');
  reviewer = await loginAs(testEnv, 902, 'reviewer');
  outsider = await loginAs(testEnv, 903, 'outsider');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repo.id, reviewer.userId],
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

describe('envelope encryption', () => {
  it('round-trips, binds ciphertext to its row and never stores plaintext', async () => {
    const e = bindings();
    const sealed = await encryptSecret(e, 'user:team', 'repo|r1||TOKEN', 'hunter2-value');
    expect(sealed.ciphertext).not.toContain('hunter2');
    const item = {
      owner: 'user:team',
      keyVersion: sealed.keyVersion,
      ciphertext: sealed.ciphertext,
    };
    expect(await decryptSecrets(e, [{ ...item, aad: 'repo|r1||TOKEN' }])).toEqual([
      'hunter2-value',
    ]);
    await expect(
      decryptSecrets(e, [{ ...item, aad: 'repo|r2||TOKEN' }]),
    ).rejects.toThrow();
    const key = await q1<{ wrapped: string; kek_id: string }>(
      testEnv,
      'SELECT wrapped, kek_id FROM secret_data_keys WHERE owner = ?',
      ['user:team'],
    );
    expect(key?.kek_id).toBe('v1');
    const missing = await encryptSecret(
      bindings({ SECRETS_KEK: undefined }),
      'user:team',
      'x',
      'value',
    )
      .then(() => null)
      .catch((err: unknown) => err);
    expect(missing).toMatchObject({ code: 'secrets_not_configured' });
  });

  it('re-wraps data keys on KEK rotation without touching secrets', async () => {
    const scope = repoScope(repo, null);
    await putSecret(bindings(), scope, 'DEPLOY_KEY', 'super-secret-1', owner.userId);
    const before = await q1<{ ciphertext: string }>(
      testEnv,
      'SELECT ciphertext FROM secrets',
    );
    const ring = (current: string, keys: Record<string, string>) =>
      bindings({ SECRETS_KEK: JSON.stringify({ current, keys }) });
    // both keys configured: old data keys still open, new ones use v2
    const both = ring('v2', { v1: kekV1, v2: kekV2 });
    expect(
      (await resolveForJob(both, repo, null, ['DEPLOY_KEY'])).secrets.DEPLOY_KEY,
    ).toBe('super-secret-1');
    expect(await rewrapDataKeys(both)).toEqual({
      current: 'v2',
      rewrapped: 1,
      remaining: 0,
    });
    const after = await q1<{ ciphertext: string }>(
      testEnv,
      'SELECT ciphertext FROM secrets',
    );
    expect(after?.ciphertext).toBe(before?.ciphertext);
    // the old KEK can now be removed
    const only = ring('v2', { v2: kekV2 });
    expect(
      (await resolveForJob(only, repo, null, ['DEPLOY_KEY'])).secrets.DEPLOY_KEY,
    ).toBe('super-secret-1');
    await expect(resolveForJob(bindings(), repo, null, ['DEPLOY_KEY'])).rejects.toThrow();
  });

  it('exposes the re-wrap only to secrets admins', async () => {
    expect((await api('/admin/secrets/rewrap', 'POST')).status).toBe(403);
    const admin = bindings({ SECRETS_ADMIN_USER_IDS: owner.userId });
    // strict step-up: an admin with no factor enrolled must enrol first
    const res = await api('/admin/secrets/rewrap', 'POST', undefined, owner, admin);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'mfa_required' } });
  });
});

describe('secrets API', () => {
  it('is write-only and audited', async () => {
    const put = await api(`${repoPath}/secrets/npm_token`, 'PUT', {
      value: 'npm-secret-123',
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain('npm-secret-123');
    expect(JSON.parse(text)).toMatchObject({ secret: { name: 'NPM_TOKEN' } });
    const list = await api(`${repoPath}/secrets`);
    const body = (await list.json()) as { secrets: Record<string, unknown>[] };
    expect(body.secrets).toEqual([
      { name: 'NPM_TOKEN', created_by: owner.userId, updated_at: expect.any(Number) },
    ]);
    const row = await q1<{ ciphertext: string }>(
      testEnv,
      'SELECT ciphertext FROM secrets',
    );
    expect(row?.ciphertext).not.toContain('npm-secret-123');
    const events = await q<{ action: string; target: string }>(
      testEnv,
      "SELECT action, target FROM audit_events WHERE action LIKE 'secret.%'",
    );
    expect(events.map((e) => e.action)).toEqual(['secret.set']);
    expect(events[0]!.target).not.toContain('npm-secret-123');
    expect((await api(`${repoPath}/secrets/NPM_TOKEN`, 'DELETE')).status).toBe(200);
    expect((await api(`${repoPath}/secrets/NPM_TOKEN`, 'DELETE')).status).toBe(404);
  });

  it('validates names and values', async () => {
    expect(
      (await api(`${repoPath}/secrets/GITHUB_TOKEN`, 'PUT', { value: 'abcdef' })).status,
    ).toBe(400);
    expect(
      (await api(`${repoPath}/secrets/9BAD`, 'PUT', { value: 'abcdef' })).status,
    ).toBe(400);
    expect((await api(`${repoPath}/secrets/SHORT`, 'PUT', { value: 'abc' })).status).toBe(
      400,
    );
    expect(
      (await api(`${repoPath}/secrets/X?environment=missing`, 'PUT', { value: 'abcdef' }))
        .status,
    ).toBe(404);
  });

  it('requires admin, a session, and a recent MFA step-up when enrolled', async () => {
    expect(
      (await api(`${repoPath}/secrets/A_B`, 'PUT', { value: 'abcdef' }, reviewer)).status,
    ).toBe(403);
    expect((await api(`${repoPath}/secrets`, 'GET', undefined, outsider)).status).toBe(
      404,
    );
    const anonymous = await api(`${repoPath}/secrets`, 'GET', undefined, { headers: {} });
    expect(anonymous.status).toBe(401);
    const token = await createApiToken(testEnv, owner.userId, { label: 't' });
    const bearer = { headers: { authorization: `Bearer ${token.raw}` } };
    expect(
      (await api(`${repoPath}/secrets/A_B`, 'PUT', { value: 'abcdef' }, bearer)).status,
    ).toBe(401);
    await run(
      testEnv,
      'INSERT INTO totp_secrets (user_id, secret_enc, confirmed_at, created_at) VALUES (?, ?, ?, ?)',
      [owner.userId, 'x.y', Date.now(), Date.now()],
    );
    const stale = await api(`${repoPath}/secrets/A_B`, 'PUT', { value: 'abcdef' });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: 'mfa_required' } });
    await run(testEnv, 'UPDATE sessions SET mfa_at = ?', [Date.now()]);
    expect(
      (await api(`${repoPath}/secrets/A_B`, 'PUT', { value: 'abcdef' })).status,
    ).toBe(200);
  });

  it('resolves environment over repo over org', async () => {
    const orgId = 'org-1';
    await run(
      testEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES (?, 'acme', 'Acme', ?)",
      [orgId, Date.now()],
    );
    const orgRepo = await createRepo(testEnv, {
      slug: 'acme/app',
      createdBy: owner.userId,
    });
    await run(testEnv, "UPDATE repos SET owner_kind = 'org', owner_id = ? WHERE id = ?", [
      orgId,
      orgRepo.id,
    ]);
    const loaded = { ...orgRepo, owner_kind: 'org' as const, owner_id: orgId };
    const e = bindings();
    const set = async (
      scope: ReturnType<typeof repoScope>,
      name: string,
      value: string,
    ) => {
      await putSecret(e, scope, name, value, owner.userId);
      await putVariable(e, scope, name, value, owner.userId);
    };
    await set(orgScope(orgId), 'SHARED', 'from-org');
    await set(orgScope(orgId), 'ORG_ONLY', 'org-only');
    await set(repoScope(loaded, null), 'SHARED', 'from-repo');
    await set(repoScope(loaded, 'production'), 'SHARED', 'from-env');
    // another repo's secrets never leak in
    await set(repoScope(repo, null), 'OTHER', 'other-repo');
    const names = ['SHARED', 'ORG_ONLY', 'OTHER'];
    const plain = await resolveForJob(e, loaded, null, names);
    expect(plain.secrets).toEqual({ SHARED: 'from-repo', ORG_ONLY: 'org-only' });
    expect(plain.variables).toEqual({ SHARED: 'from-repo', ORG_ONLY: 'org-only' });
    const production = await resolveForJob(e, loaded, 'production', names);
    expect(production.secrets).toEqual({ SHARED: 'from-env', ORG_ONLY: 'org-only' });
    // only the secrets a pipeline names are decrypted
    expect((await resolveForJob(e, loaded, null, ['ORG_ONLY'])).secrets).toEqual({
      ORG_ONLY: 'org-only',
    });
  });
});

async function configure(extra: Record<string, unknown> = {}): Promise<void> {
  const res = await api(`${repoPath}/ci`, 'PUT', {
    commands: ['./deploy.sh'],
    timeout_seconds: 60,
    ...extra,
  });
  expect(res.status).toBe(200);
}

async function protectProduction(rules: Record<string, unknown> = {}): Promise<void> {
  const res = await api(`${repoPath}/environments/production`, 'PUT', {
    reviewers: [{ type: 'user', name: 'reviewer' }],
    allowed_branches: ['main'],
    ...rules,
  });
  expect(res.status).toBe(200);
}

describe('environment protection', () => {
  it('holds a run for a required reviewer, then dispatches it and audits the approver', async () => {
    await configure({ environment: 'production', secrets: ['DEPLOY_KEY'] });
    await protectProduction();
    await api(`${repoPath}/secrets/DEPLOY_KEY?environment=production`, 'PUT', {
      value: 'prod-deploy-key',
    });
    const started = await api(`${repoPath}/ci/runs`, 'POST', {});
    expect(started.status).toBe(202);
    const { approval } = (await started.json()) as {
      approval: { id: string; state: string };
    };
    expect(approval.state).toBe('pending');
    expect(await q(testEnv, 'SELECT id FROM ci_runs')).toHaveLength(0);

    const pending = (await (
      await api(
        `${repoPath}/environment-approvals?state=pending`,
        'GET',
        undefined,
        reviewer,
      )
    ).json()) as { approvals: { id: string; ref: string }[] };
    expect(pending.approvals).toMatchObject([
      { id: approval.id, ref: 'refs/heads/main' },
    ]);

    const decide = (as: Login, decision = 'approve') =>
      api(`${repoPath}/environment-approvals/${approval.id}`, 'POST', { decision }, as);
    const self = await decide(owner);
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({ error: { code: 'self_review_forbidden' } });
    await run(
      testEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'admin')",
      [repo.id, outsider.userId],
    );
    expect((await decide(outsider)).status).toBe(403);
    const approved = await decide(reviewer);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      approval: { state: 'dispatched', decided_by: reviewer.userId },
    });
    expect((await decide(reviewer)).status).toBe(409);

    const job = (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs'))!;
    expect(parseContext(job.context)?.approval_id).toBe(approval.id);
    const policy = parsePolicy(JSON.parse(job.config));
    expect(await jobTrust(testEnv, job, policy, parseContext(job.context))).toEqual({
      ok: true,
      reason: '',
    });
    const access = await prepareJob(bindings(), job, policy, Date.now() + 60_000);
    expect(access.env.DEPLOY_KEY).toBe('prod-deploy-key');

    const event = await q1<{ actor_id: string; target: string }>(
      testEnv,
      "SELECT actor_id, target FROM audit_events WHERE action = 'environment.approval.approve'",
    );
    expect(event?.actor_id).toBe(reviewer.userId);
    expect(JSON.parse(event!.target)).toMatchObject({
      approval_id: approval.id,
      environment: 'production',
      run_id: job.id,
    });
  });

  it('gives no environment secrets to a run that skipped its gate', async () => {
    await configure({ environment: 'production', secrets: ['DEPLOY_KEY'] });
    await protectProduction();
    const job = await enqueueRun(bindings(), repo.id, head, owner.userId, false, {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      pull_id: null,
      fork: false,
      actor_kind: 'human',
      origin: 'https://forge.test',
      approval_id: null,
    });
    const policy = parsePolicy(JSON.parse(job.config));
    const access = await prepareJob(bindings(), job, policy, Date.now() + 60_000);
    expect(access.env).toEqual({});
    expect(access.summary).toContain('approval is missing');
  });

  it('enforces wait timers, allowed branches and humans-only', async () => {
    await configure({ environment: 'production' });
    await protectProduction({ reviewers: [], wait_timer_minutes: 5, humans_only: true });
    const started = (await (await api(`${repoPath}/ci/runs`, 'POST', {})).json()) as {
      approval: { state: string; not_before: number; created_at: number };
    };
    expect(started.approval.state).toBe('approved');
    expect(started.approval.not_before - started.approval.created_at).toBe(300_000);

    const raw = await api(`${repoPath}/ci/runs`, 'POST', { head });
    expect(raw.status).toBe(403);
    expect(await raw.json()).toMatchObject({
      error: { code: 'environment_branch_not_allowed' },
    });

    const token = await createApiToken(testEnv, owner.userId, { label: 'agent' });
    const agent = await api(
      `${repoPath}/ci/runs`,
      'POST',
      {},
      {
        headers: { authorization: `Bearer ${token.raw}` },
      },
    );
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({
      error: { code: 'environment_humans_only' },
    });
  });

  it('matches branch and tag patterns', () => {
    expect(refAllowed([], null)).toBe(true);
    expect(refAllowed(['main'], 'refs/heads/main')).toBe(true);
    expect(refAllowed(['release/*'], 'refs/heads/release/1.2')).toBe(true);
    expect(refAllowed(['release/*'], 'refs/heads/release/1/2')).toBe(false);
    expect(refAllowed(['release/**'], 'refs/heads/release/1/2')).toBe(true);
    expect(refAllowed(['refs/tags/v*'], 'refs/tags/v1.0.0')).toBe(true);
    expect(refAllowed(['main'], 'refs/tags/main')).toBe(false);
    expect(refAllowed(['main'], 'refs/pull/1/merge')).toBe(false);
    expect(refAllowed(['main'], null)).toBe(false);
  });

  it('only accepts reviewers that exist and records environment changes', async () => {
    const bad = await api(`${repoPath}/environments/production`, 'PUT', {
      reviewers: [{ type: 'user', name: 'nobody' }],
    });
    expect(bad.status).toBe(404);
    await protectProduction();
    const list = (await (
      await api(`${repoPath}/environments`, 'GET', undefined, reviewer)
    ).json()) as {
      environments: { name: string; rules: { reviewers: { id: string }[] } }[];
    };
    expect(list.environments[0]).toMatchObject({
      name: 'production',
      rules: { reviewers: [{ id: reviewer.userId }] },
    });
    await api(`${repoPath}/secrets/K_1?environment=production`, 'PUT', {
      value: 'abcdef',
    });
    expect((await api(`${repoPath}/environments/production`, 'DELETE')).status).toBe(200);
    expect(await q(testEnv, 'SELECT name FROM secrets')).toHaveLength(0);
    const actions = (
      await q<{ action: string }>(
        testEnv,
        "SELECT action FROM audit_events WHERE action LIKE 'environment.%' ORDER BY id",
      )
    ).map((e) => e.action);
    expect(actions).toEqual(['environment.set', 'environment.delete']);
  });
});

describe('job injection', () => {
  const context: RunContext = {
    event: 'pull_request',
    ref: 'refs/pull/1/merge',
    pull_id: 1,
    fork: true,
    actor_kind: 'human',
    origin: 'https://forge.test',
    approval_id: null,
  };

  it('gives a fork pull request no secrets or variables', async () => {
    await configure({ secrets: ['NPM_TOKEN'] });
    await putSecret(
      bindings(),
      repoScope(repo, null),
      'NPM_TOKEN',
      'npm-secret',
      owner.userId,
    );
    await putVariable(bindings(), repoScope(repo, null), 'REGION', 'syd', owner.userId);
    const job = await enqueueRun(bindings(), repo.id, head, owner.userId, false, context);
    const access = await prepareJob(
      bindings(),
      job,
      parsePolicy(JSON.parse(job.config)),
      Date.now() + 60_000,
    );
    expect(access).toMatchObject({ env: {}, mask: [], files: [] });
    expect(access.summary).toContain('fork');
  });

  it('passes secrets only to repository commands and masks them in the log', async () => {
    const secret = 'Sup3r-S3cret/Value+42';
    await configure({
      secrets: ['DEPLOY_KEY'],
      commands: ['echo "$DEPLOY_KEY"', 'echo "$DEPLOY_KEY" | base64'],
    });
    await putSecret(
      bindings(),
      repoScope(repo, null),
      'DEPLOY_KEY',
      secret,
      owner.userId,
    );
    const e = bindings();
    const job = await enqueueRun(e, repo.id, head, owner.userId, false, {
      ...context,
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      pull_id: null,
      fork: false,
    });
    const envs: { argv: string; env?: Record<string, string> }[] = [];
    const container = {
      running: false,
      images: { ci: 'test-image' },
      start() {
        this.running = true;
      },
      async destroy() {
        this.running = false;
      },
      async setInactivityTimeout() {},
      async exec(argv: string[], options: ContainerExecOptions = {}) {
        envs.push({ argv: argv.join(' '), env: options.env });
        if (options.stdin && typeof options.stdin !== 'string')
          await new Response(options.stdin).arrayBuffer();
        const value = options.env?.DEPLOY_KEY ?? '';
        // the job prints the secret plainly, base64-encoded, and split across lines
        const out = argv.at(-1)?.includes('base64')
          ? `${btoa(`${value}\n`)}\n`
          : `${value}\n${value.slice(0, 7)}\n${value.slice(7)}\n`;
        return {
          stdout: options.stdout === 'ignore' ? null : new Blob([out]).stream(),
          exitCode: Promise.resolve(0),
        };
      },
    };
    const runner = Object.assign(Object.create(CiRunnerDO.prototype), {
      env: e,
      log: '',
      logBytes: 0,
      ctx: {
        container,
        blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
        storage: {
          put: async () => {},
          get: async () => undefined,
          setAlarm: async () => {},
          deleteAlarm: async () => {},
        },
      },
    }) as CiRunnerDO;
    await runner.fetch(
      new Request('https://runner/run', {
        method: 'POST',
        body: JSON.stringify({ run_id: job.id }),
      }),
    );
    const done = (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id = ?', [
      job.id,
    ]))!;
    expect(done.state).toBe('passed');
    const log = await (await testEnv.OBJECTS.get(done.log_key!))!.text();
    expect(log).not.toContain(secret);
    expect(log).not.toContain(secret.slice(0, 7));
    expect(log).not.toContain(btoa(`${secret}\n`).slice(0, 20));
    expect(log).toContain(MASK);
    expect(log).toContain('Job access: secrets DEPLOY_KEY');
    // only the repository commands saw the secret
    const withSecret = envs
      .filter((x) => x.env?.DEPLOY_KEY === secret)
      .map((x) => x.argv);
    expect(withSecret).toEqual([
      '/bin/bash -euo pipefail -c echo "$DEPLOY_KEY"',
      '/bin/bash -euo pipefail -c echo "$DEPLOY_KEY" | base64',
    ]);
    expect(await q(testEnv, 'SELECT * FROM ci_job_tokens')).toHaveLength(0);
  });
});

describe('log masker', () => {
  const secret = 'correct-horse-battery-staple';
  const mask = (text: string, values = [secret]) => createMasker(values).mask(text);

  it('masks the exact value', () => {
    expect(mask(`token=${secret};`)).toBe(`token=${MASK};`);
  });

  it('masks base64 at every alignment, wrapped or not', () => {
    for (const prefix of ['', 'a', 'ab', 'abc']) {
      const encoded = btoa(`${prefix}${secret}\n`);
      const out = mask(encoded);
      expect(out).toContain(MASK);
      expect(out.length).toBeLessThan(encoded.length / 2);
    }
    const url = btoa(secret).replace(/\+/g, '-').replace(/\//g, '_');
    expect(mask(url)).not.toContain(url.slice(4, 20));
    const long = 'x'.repeat(70) + secret;
    const wrapped = btoa(long).replace(/(.{76})/g, '$1\n');
    expect(mask(wrapped)).not.toContain(btoa(long).slice(96, 120));
  });

  it('masks the URL-encoded form', () => {
    const value = 'p@ss word/with?chars';
    expect(mask(`q=${encodeURIComponent(value)}&x=1`, [value])).toBe(`q=${MASK}&x=1`);
  });

  it('masks values split across lines and lines of multi-line values', () => {
    expect(mask(`${secret.slice(0, 10)}\n${secret.slice(10)}\n`)).toBe(`${MASK}\n`);
    expect(mask(`${secret.slice(0, 10)}\r\n${secret.slice(10)}`)).toBe(MASK);
    const pem = '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END KEY-----';
    expect(mask('line: MIIBOgIBAAJBAKj34GkxFhD9', [pem])).toBe(`line: ${MASK}`);
  });

  it('masks values split across stream chunks', () => {
    const masker = createMasker([secret]);
    const text = `start ${secret} middle ${secret} end`;
    let out = '';
    for (let i = 0; i < text.length; i += 5) out += masker.push(text.slice(i, i + 5));
    out += masker.flush();
    expect(out).toBe(`start ${MASK} middle ${MASK} end`);
  });

  it('leaves logs alone without values and ignores very short values', () => {
    expect(createMasker([]).push('hello')).toBe('hello');
    expect(mask('abc abc', ['abc'])).toBe('abc abc');
  });
});
