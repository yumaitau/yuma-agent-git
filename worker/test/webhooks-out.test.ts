import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { blockedHost } from '../src/webhooks/deliver';
import { webhooksQueue } from '../src/queues/webhooks';
import { emitCiRun } from '../src/ci/runs';
import { blob, commit, packOf, pushBody, tree, ZERO } from './git-helpers';

/**
 * Outbound webhooks (issue #75): SSRF refusal, signed deliveries in the yag
 * and GitHub formats, retries with backoff, the delivery log and manual
 * redelivery, and events from pushes, pull requests, issues and CI. Outbound
 * fetches (receivers and DNS-over-HTTPS) are stubbed; nothing leaves the test.
 */

const testEnv = env as unknown as TestEnv;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let writer: Login;
let stranger: Login;
let repo: Awaited<ReturnType<typeof createRepo>>;
let head: string;

const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
let sends: { body: unknown; opts?: { delaySeconds?: number } }[] = [];

function bindings(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    SECRETS_KEK: kek,
    EVENTS_QUEUE: {
      send: async (body: unknown, opts?: { delaySeconds?: number }) => {
        sends.push({ body, opts });
      },
    },
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
  e: Env = bindings(),
): Promise<Response> {
  return makeApp(e)(
    new Request(`https://forge.test/api/v1${path}`, {
      method,
      headers: { ...as.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

// --- outbound fetch stub ------------------------------------------------------

const realFetch = globalThis.fetch;
let received: Request[] = [];
let respond: (req: Request) => Response | Promise<Response> = () => new Response('ok');
/** Hostname → A records the DNS-over-HTTPS stub answers. */
let dns: Record<string, string[]> = {};

beforeEach(() => {
  received = [];
  respond = () => new Response('ok');
  dns = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com') {
      const type = url.searchParams.get('type');
      const answers =
        type === 'A' ? (dns[url.searchParams.get('name')!] ?? ['93.184.216.34']) : [];
      return Response.json({
        Status: 0,
        Answer: answers.map((data) => ({ type: 1, data })),
      });
    }
    received.push(req.clone());
    return respond(req);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Run the queue consumer over everything sent so far. */
async function drain(e: Env = bindings()): Promise<void> {
  const batch = sends;
  sends = [];
  const messages = batch.map((s, i) => ({
    id: String(i),
    timestamp: new Date(),
    body: s.body,
    attempts: 1,
    ack: () => undefined,
    retry: () => undefined,
  }));
  await webhooksQueue(
    {
      queue: 'forge-events',
      messages,
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch,
    e,
  );
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const repoPath = '/repos/team/project';

async function createHook(body: Record<string, unknown>, path = repoPath) {
  const res = await api(`${path}/hooks`, 'POST', body);
  expect(res.status).toBe(201);
  return (await res.json()) as { hook: { id: string }; secret?: string };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sends = [];
  owner = await loginAs(testEnv, 1101, 'owner');
  writer = await loginAs(testEnv, 1102, 'writer');
  stranger = await loginAs(testEnv, 1103, 'stranger');
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

describe('SSRF protection', () => {
  it('refuses private, loopback, link-local, metadata and non-https URLs', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://10.0.0.5/x',
      'https://127.0.0.1/x',
      'https://2130706433/x', // 127.0.0.1 written as a number
      'https://169.254.169.254/latest/meta-data',
      'https://172.20.1.1/x',
      'https://192.168.1.10/x',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[fd00:ec2::254]/x',
      'https://[fe80::1]/x',
      'https://localhost/x',
      'https://hooks.localhost/x',
      'https://metadata.google.internal/x',
      'https://intranet/x',
      'https://user:pass@hooks.example.com/x',
      'not a url',
    ]) {
      const res = await api(`${repoPath}/hooks`, 'POST', { url, events: ['push'] });
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_webhook_url',
      );
    }
    expect(blockedHost('hooks.example.com')).toBe(false);
    expect(blockedHost('8.8.8.8')).toBe(false);
    expect(blockedHost('[2606:4700::1111]')).toBe(false);
    expect(await q(testEnv, 'SELECT id FROM webhooks')).toEqual([]);
  });

  it('allows http only when WEBHOOKS_ALLOW_HTTP is set, and never for private hosts', async () => {
    const e = bindings({ WEBHOOKS_ALLOW_HTTP: 'true' });
    const ok = await api(
      `${repoPath}/hooks`,
      'POST',
      { url: 'http://hooks.example.com/x', events: ['push'] },
      owner,
      e,
    );
    expect(ok.status).toBe(201);
    const local = await api(
      `${repoPath}/hooks`,
      'POST',
      { url: 'http://127.0.0.1:8080/x', events: ['push'] },
      owner,
      e,
    );
    expect(local.status).toBe(400);
  });

  it('refuses a delivery when the host resolves to a private address', async () => {
    dns['rebind.example.com'] = ['10.1.2.3'];
    await createHook({ url: 'https://rebind.example.com/hook', events: ['issues'] });
    expect((await api(`${repoPath}/issues`, 'POST', { title: 'Bug' })).status).toBe(201);
    await drain();
    expect(received).toEqual([]);
    const delivery = await q1<{ status: string; error: string }>(
      testEnv,
      'SELECT status, error FROM webhook_deliveries_out',
    );
    expect(delivery).toEqual({ status: 'failed', error: 'blocked_address' });
  });
});

describe('repository webhooks', () => {
  it('manages hooks with a write-only secret; admins only, sessions only', async () => {
    const created = await createHook({
      url: 'https://hooks.example.com/a',
      events: ['push', 'issues'],
    });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const own = await createHook({
      url: 'https://hooks.example.com/b',
      events: ['push'],
      secret: 'a-secret-of-sixteen+',
    });
    expect(own.secret).toBeUndefined();
    const stored = await q1<{ secret_ciphertext: string }>(
      testEnv,
      'SELECT secret_ciphertext FROM webhooks WHERE id = ?',
      [own.hook.id],
    );
    expect(stored!.secret_ciphertext).not.toContain('a-secret');

    const list = (await (await api(`${repoPath}/hooks`)).json()) as { hooks: unknown[] };
    expect(list.hooks).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('secret');

    const patched = await api(`/hooks/${own.hook.id}`, 'PATCH', {
      active: false,
      events: ['ref'],
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      hook: { active: false, events: ['ref'] },
    });
    expect(
      (await api(`/hooks/${own.hook.id}`, 'PATCH', { url: 'https://10.0.0.1/' })).status,
    ).toBe(400);

    // writers see the repo but cannot manage hooks; strangers cannot tell it exists
    expect((await api(`${repoPath}/hooks`, 'GET', undefined, writer)).status).toBe(403);
    expect((await api(`/hooks/${own.hook.id}`, 'GET', undefined, writer)).status).toBe(
      403,
    );
    expect((await api(`${repoPath}/hooks`, 'GET', undefined, stranger)).status).toBe(404);
    expect((await api(`/hooks/${own.hook.id}`, 'GET', undefined, stranger)).status).toBe(
      404,
    );
    // API tokens never read or redirect hooks
    const token = await createApiToken(testEnv, owner.userId, { label: 't' });
    const bearer = { headers: { authorization: `Bearer ${token.raw}` } };
    expect((await api(`${repoPath}/hooks`, 'GET', undefined, bearer)).status).toBe(401);
    expect((await api(`/hooks/${own.hook.id}`, 'DELETE', undefined, bearer)).status).toBe(
      401,
    );

    expect((await api(`/hooks/${own.hook.id}`, 'DELETE')).status).toBe(200);
    expect((await api(`/hooks/${own.hook.id}`)).status).toBe(404);
    const actions = await q<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'webhook.%' ORDER BY id",
    );
    expect(actions.map((a) => a.action)).toEqual([
      'webhook.create',
      'webhook.create',
      'webhook.update',
      'webhook.delete',
    ]);
  });

  it('signs yag deliveries with X-Yag-Signature-256', async () => {
    const { hook, secret } = await createHook({
      url: 'https://hooks.example.com/yag',
      events: ['issues'],
    });
    expect(
      (await api(`${repoPath}/issues`, 'POST', { title: 'Broken build' })).status,
    ).toBe(201);
    expect(sends).toHaveLength(1);
    await drain();
    expect(received).toHaveLength(1);
    const req = received[0]!;
    const body = await req.text();
    expect(req.url).toBe('https://hooks.example.com/yag');
    expect(req.headers.get('x-yag-event')).toBe('issues');
    expect(req.headers.get('x-yag-hook-id')).toBe(hook.id);
    expect(req.headers.get('x-yag-signature-256')).toBe(await hmac(secret!, body));
    expect(req.headers.get('x-hub-signature-256')).toBeNull();
    expect(JSON.parse(body)).toMatchObject({
      event: 'issues',
      action: 'opened',
      repository: { id: repo.id, full_name: 'team/project', private: true },
      sender: { kind: 'user', login: 'owner' },
      issue: { number: 1, title: 'Broken build', state: 'open' },
    });
    const delivery = await q1<{
      id: string;
      status: string;
      attempts: number;
      response_code: number;
    }>(testEnv, 'SELECT id, status, attempts, response_code FROM webhook_deliveries_out');
    expect(delivery).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      response_code: 200,
    });
    expect(req.headers.get('x-yag-delivery')).toBe(delivery!.id);
  });

  it('a queue redelivery of an event creates no second delivery', async () => {
    await createHook({ url: 'https://hooks.example.com/yag', events: ['issues'] });
    expect((await api(`${repoPath}/issues`, 'POST', { title: 'Twice' })).status).toBe(
      201,
    );
    const message = sends[0]!;
    await drain();
    sends = [message]; // at-least-once: the consumer sees the same message again
    await drain();
    expect(received).toHaveLength(1);
    expect(await q(testEnv, 'SELECT id FROM webhook_deliveries_out')).toHaveLength(1);
  });

  it('retries with backoff, fails after 24 hours and redelivers by hand', async () => {
    const { hook } = await createHook({
      url: 'https://hooks.example.com/flaky',
      events: ['issues'],
    });
    respond = () => new Response('down', { status: 503 });
    await api(`${repoPath}/issues`, 'POST', { title: 'One' });
    await drain();
    let row = await q1<{
      id: string;
      status: string;
      attempts: number;
      next_attempt_at: number;
      error: string;
    }>(testEnv, 'SELECT * FROM webhook_deliveries_out');
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, error: 'http_503' });
    expect(sends).toEqual([
      { body: { type: 'delivery', id: row!.id }, opts: { delaySeconds: 30 } },
    ]);
    // the retry message arrives early: nothing is sent before it is due
    await drain();
    expect(received).toHaveLength(1);

    // due now: the second failure doubles the delay
    await run(testEnv, 'UPDATE webhook_deliveries_out SET next_attempt_at = ?', [
      Date.now(),
    ]);
    sends.push({ body: { type: 'delivery', id: row!.id } });
    await drain();
    expect(sends[0]?.opts).toEqual({ delaySeconds: 60 });
    sends = [];

    // past the 24 hour window: failed for good
    await run(
      testEnv,
      'UPDATE webhook_deliveries_out SET next_attempt_at = ?, created_at = ?',
      [Date.now(), Date.now() - 24 * 3600_000],
    );
    sends.push({ body: { type: 'delivery', id: row!.id } });
    await drain();
    row = await q1(testEnv, 'SELECT * FROM webhook_deliveries_out WHERE id = ?', [
      row!.id,
    ]);
    expect(row).toMatchObject({ status: 'failed', attempts: 3, next_attempt_at: null });
    expect(sends).toEqual([]);

    // the log shows it (without bodies), and a manual redelivery succeeds
    const log = (await (await api(`/hooks/${hook.id}/deliveries`)).json()) as {
      deliveries: Record<string, unknown>[];
    };
    expect(log.deliveries).toHaveLength(1);
    expect(log.deliveries[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      event: 'issues',
    });
    expect(log.deliveries[0]).not.toHaveProperty('payload');
    respond = () => new Response('ok');
    const again = await api(`/hooks/${hook.id}/deliveries/${row!.id}/redeliver`, 'POST');
    expect(again.status).toBe(202);
    const { delivery } = (await again.json()) as {
      delivery: { id: string; redelivery_of: string };
    };
    expect(delivery.redelivery_of).toBe(row!.id);
    await drain();
    const redelivered = await q1(
      testEnv,
      'SELECT * FROM webhook_deliveries_out WHERE id = ?',
      [delivery.id],
    );
    expect(redelivered).toMatchObject({ status: 'succeeded', attempts: 1 });
    // the same body went out again
    expect(await received.at(-1)!.text()).toBe(await received[0]!.text());
    expect(
      (await api(`/hooks/${hook.id}/deliveries/nope/redeliver`, 'POST')).status,
    ).toBe(404);
  });

  it('sends only subscribed events and nothing when no hook listens', async () => {
    await api(`${repoPath}/issues`, 'POST', { title: 'Quiet' });
    expect(sends).toEqual([]);
    await createHook({ url: 'https://hooks.example.com/push-only', events: ['push'] });
    await api(`${repoPath}/issues`, 'POST', { title: 'Still quiet' });
    expect(sends).toEqual([]);
  });

  it('a git push sends push and ref events', async () => {
    await createHook({ url: 'https://hooks.example.com/git', events: ['push', 'ref'] });
    const file = await blob('pushed\n');
    const root = await tree([{ name: 'p.txt', sha: file.sha }]);
    const pushed = await commit(root.sha, [], 'pushed\n');
    const token = await createApiToken(testEnv, owner.userId, { label: 'git' });
    const res = await makeApp(bindings())(
      new Request('https://forge.test/team/project.git/git-receive-pack', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token.raw}`)}`,
        },
        body: pushBody(
          [[ZERO, pushed.sha, 'refs/heads/feature']],
          await packOf([pushed, root, file]),
        ),
      }),
    );
    expect(res.status).toBe(200);
    await drain();
    const bodies = await Promise.all(
      received.map(async (r) => JSON.parse(await r.text())),
    );
    expect(bodies.map((b: { event: string }) => b.event).sort()).toEqual(['push', 'ref']);
    const push = bodies.find((b: { event: string }) => b.event === 'push');
    expect(push).toMatchObject({
      ref: 'refs/heads/feature',
      before: ZERO,
      after: pushed.sha,
      created: true,
      deleted: false,
      commits: [{ id: pushed.sha, message: 'pushed\n', added: ['p.txt'] }],
    });
    expect(bodies.find((b: { event: string }) => b.event === 'ref')).toMatchObject({
      action: 'created',
      ref: 'refs/heads/feature',
      ref_type: 'branch',
    });
  });

  it('pull request, review, merge and issue events', async () => {
    await createHook({
      url: 'https://hooks.example.com/all',
      events: ['push', 'pull_request', 'pull_request_review', 'issues'],
    });
    const feature = (
      await commitChanges(testEnv, repo.id, {
        first_parent: head,
        message: 'feature',
        author: { name: 'Ada', email: 'ada@example.com' },
        changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
      })
    ).changeset.id;
    const opened = await api(`${repoPath}/pulls`, 'POST', {
      title: 'Add b',
      head_cs: feature,
    });
    const { pull } = (await opened.json()) as { pull: { id: number; revision: number } };
    const at = { head_cs: feature, revision: pull.revision };
    const review = { ...at, decision: 'approve', body: 'Looks good' };
    expect(
      (await api(`${repoPath}/pulls/${pull.id}/review`, 'POST', review, writer)).status,
    ).toBe(200);
    const merged = await api(`${repoPath}/pulls/${pull.id}/merge`, 'POST', at);
    expect(merged.status).toBe(200);
    // a merge commit (#42), not the head itself, lands on main
    const mergedCs = ((await merged.json()) as { pull: { merged_cs: string } }).pull
      .merged_cs;
    expect(mergedCs).not.toBe(feature);
    await api(`${repoPath}/issues`, 'POST', { title: 'Done' });
    await api(`${repoPath}/issues/2`, 'PATCH', { state: 'closed' });
    await drain();
    const bodies = await Promise.all(
      received.map(async (r) => JSON.parse(await r.text()) as Record<string, unknown>),
    );
    expect(bodies.map((b) => `${String(b['event'])}:${String(b['action'])}`)).toEqual([
      'pull_request:opened',
      'pull_request_review:submitted',
      'pull_request:closed',
      'push:null',
      'issues:opened',
      'issues:closed',
    ]);
    expect(bodies[2]!['pull_request']).toMatchObject({
      state: 'merged',
      merged_at: expect.any(Number),
    });
    expect(bodies[1]!['review']).toMatchObject({
      decision: 'approve',
      body: 'Looks good',
    });
    expect(bodies[1]!['sender']).toMatchObject({ login: 'writer' });
    expect(bodies[3]!).toMatchObject({
      ref: 'refs/heads/main',
      after_changeset: mergedCs,
    });
  });

  it('labelling an issue sends one labeled or unlabeled event per label (#63)', async () => {
    await createHook({ url: 'https://hooks.example.com/yag', events: ['issues'] });
    await createHook({
      url: 'https://hooks.example.com/github',
      events: ['issues'],
      format: 'github',
    });
    for (const name of ['yuma:ready', 'yuma:risk:low'])
      expect(
        (await api(`${repoPath}/labels`, 'POST', { name, color: '0e8a16' })).status,
      ).toBe(201);
    await api(`${repoPath}/issues`, 'POST', { title: 'Ticket' });
    const label = (labels: string[]) =>
      api(`${repoPath}/issues/1/labels`, 'PUT', { labels });
    expect((await label(['yuma:ready', 'yuma:risk:low'])).status).toBe(200);
    expect((await label(['yuma:risk:low'])).status).toBe(200);
    expect((await label(['yuma:risk:low'])).status).toBe(200); // no change, no event
    await drain();
    const bodies = await Promise.all(
      received.map(async (r) => ({
        url: r.url,
        body: JSON.parse(await r.text()) as {
          action: string;
          label?: { name: string };
          issue: { labels: { name: string }[] };
        },
      })),
    );
    for (const url of [
      'https://hooks.example.com/yag',
      'https://hooks.example.com/github',
    ])
      expect(
        bodies
          .filter((b) => b.url === url)
          .map((b) => `${b.body.action}:${b.body.label?.name ?? ''}`),
      ).toEqual([
        'opened:',
        'labeled:yuma:ready',
        'labeled:yuma:risk:low',
        'unlabeled:yuma:ready',
      ]);
    expect(bodies.at(-1)!.body.issue.labels.map((l) => l.name)).toEqual([
      'yuma:risk:low',
    ]);
  });

  it('a closing keyword that lands sends issues closed (#63)', async () => {
    await createHook({ url: 'https://hooks.example.com/yag', events: ['issues'] });
    await api(`${repoPath}/issues`, 'POST', { title: 'Ticket' });
    const fix = (
      await commitChanges(testEnv, repo.id, {
        first_parent: head,
        message: 'fix\n\nCloses #1',
        author: { name: 'Ada', email: 'ada@example.com' },
        changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
      })
    ).changeset.id;
    expect(
      (await api(`${repoPath}/refs/main`, 'PUT', { from: head, to: fix })).status,
    ).toBe(200);
    await drain();
    const bodies = await Promise.all(
      received.map(
        async (r) =>
          JSON.parse(await r.text()) as {
            action: string;
            issue: { state: string };
            source?: unknown;
          },
      ),
    );
    expect(bodies.map((b) => b.action)).toEqual(['opened', 'closed']);
    expect(bodies[1]).toMatchObject({
      issue: { state: 'closed' },
      source: { kind: 'changeset', ref: fix },
    });
  });

  it('queues a ci_run event for a run', async () => {
    await createHook({ url: 'https://hooks.example.com/ci', events: ['ci_run'] });
    await run(
      testEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state, month,
                            reserved_micros, created_at, finished_at)
       VALUES ('run-1', ?, ?, 1, '{}', ?, 'passed', '2026-10', 0, ?, ?)`,
      [repo.id, head, owner.userId, Date.now(), Date.now()],
    );
    await emitCiRun(bindings(), 'run-1', 'completed');
    await drain();
    expect(JSON.parse(await received[0]!.text())).toMatchObject({
      event: 'ci_run',
      action: 'completed',
      ci_run: { id: 'run-1', state: 'passed', head_cs: head },
    });
  });
});

describe('org webhooks', () => {
  it('org owners receive events from every org repository', async () => {
    const created = await api('/orgs', 'POST', { slug: 'acme' });
    const { org } = (await created.json()) as { org: { id: string } };
    const orgRepo = await createRepo(testEnv, {
      slug: 'acme/app',
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: org.id,
    });
    await api('/orgs/acme/members', 'PUT', { user_id: writer.userId, role: 'admin' });
    expect((await api('/orgs/acme/hooks', 'GET', undefined, writer)).status).toBe(403);
    expect((await api('/orgs/acme/hooks', 'GET', undefined, stranger)).status).toBe(404);
    await createHook(
      { url: 'https://hooks.example.com/org', events: ['issues'] },
      '/orgs/acme',
    );
    expect(
      (await api('/repos/acme/app/issues', 'POST', { title: 'Org issue' })).status,
    ).toBe(201);
    await drain();
    expect(JSON.parse(await received[0]!.text())).toMatchObject({
      repository: { id: orgRepo.id, full_name: 'acme/app' },
      issue: { title: 'Org issue' },
    });
  });
});

describe('GitHub format', () => {
  async function pullSetup() {
    const feature = (
      await commitChanges(testEnv, repo.id, {
        first_parent: head,
        message: 'feature',
        author: { name: 'Ada', email: 'ada@example.com' },
        changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
      })
    ).changeset.id;
    return feature;
  }

  it('push and pull_request deliveries pass an existing GitHub webhook verifier', async () => {
    const { secret } = await createHook({
      url: 'https://hooks.example.com/github',
      events: ['push', 'pull_request'],
      format: 'github',
    });
    // the forge's own GitHub receiver (api/webhooks.ts) stands in for a GitHub consumer
    const consumer = makeApp(bindings({ GITHUB_WEBHOOK_SECRET: secret }));
    const verdicts: { event: string | null; status: number; body: unknown }[] = [];
    respond = async (req) => {
      const forwarded = new Request('https://consumer.test/webhooks/github', {
        method: 'POST',
        headers: req.headers,
        body: await req.clone().arrayBuffer(),
      });
      const res = await consumer(forwarded);
      verdicts.push({
        event: req.headers.get('x-github-event'),
        status: res.status,
        body: await res.clone().json(),
      });
      return res;
    };
    const feature = await pullSetup();
    expect(
      (await api(`${repoPath}/refs/feature`, 'PUT', { from: null, to: feature })).status,
    ).toBe(200);
    expect(
      (await api(`${repoPath}/pulls`, 'POST', { title: 'Add b', head_cs: feature }))
        .status,
    ).toBe(201);
    await drain();

    expect(verdicts).toEqual([
      { event: 'push', status: 200, body: { ok: true, ignored: true } },
      { event: 'pull_request', status: 200, body: { ok: true, ignored: 'pull_request' } },
    ]);
    const [push, pull] = await Promise.all(
      received.map(async (r) => JSON.parse(await r.text())),
    );
    expect(received[0]!.headers.get('x-hub-signature-256')).toBe(
      received[0]!.headers.get('x-yag-signature-256'),
    );
    expect(received[0]!.headers.get('x-github-delivery')).toMatch(/^[0-9A-Z]{26}$/);
    expect(push).toMatchObject({
      ref: 'refs/heads/feature',
      before: ZERO,
      created: true,
      repository: {
        name: 'project',
        full_name: 'team/project',
        private: true,
        owner: { login: 'team' },
      },
      sender: { login: 'owner', type: 'User' },
      pusher: { name: 'owner' },
    });
    expect(push.after).toMatch(/^[0-9a-f]{40}$/);
    expect(push.head_commit).toMatchObject({
      id: push.after,
      message: 'feature',
      added: ['b.txt'],
    });
    expect(typeof push.repository.id).toBe('number');
    expect(pull).toMatchObject({
      action: 'opened',
      number: 1,
      pull_request: {
        number: 1,
        state: 'open',
        merged: false,
        title: 'Add b',
        base: { ref: 'main' },
        head: { sha: push.after },
      },
    });
  });

  it('has no GitHub shape for ci_run', async () => {
    const res = await api(`${repoPath}/hooks`, 'POST', {
      url: 'https://hooks.example.com/gh',
      events: ['ci_run'],
      format: 'github',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_event',
    );
  });
});
