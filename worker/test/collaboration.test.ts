import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createApiToken } from '../src/auth/tokens';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q1, run } from '../src/db/client';
import { enqueueRun, ciQueue } from '../src/ci/runs';
import { CiRunnerDO } from '../src/ci/runner';
import { storeArtifact } from '../src/ci/artifacts';
import { parsePolicy, policySchema, reservation } from '../src/ci/config';
import type { CiRun, Pull } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
let owner: Awaited<ReturnType<typeof loginAs>>;
let reviewer: Awaited<ReturnType<typeof loginAs>>;
let repo: Awaited<ReturnType<typeof createRepo>>;
let base: string;
let head: string;
const author = { name: 'Ada', email: 'ada@example.com' };
const policy = {
  commands: ['npm ci', 'npm run build'],
  timeout_seconds: 60,
  required_approvals: 1,
};
async function commit(parent: string | null, name: string): Promise<string> {
  return (
    await commitChanges(testEnv, repo.id, {
      first_parent: parent,
      message: name,
      author,
      changes: [{ path: name, op: 'add', content_b64: btoa('hello') }],
    })
  ).changeset.id;
}
async function request(
  tail: string,
  method = 'GET',
  body?: unknown,
  actor = owner,
  bindings: Env = testEnv,
): Promise<Response> {
  if (/\/(review|merge)$/.test(tail) && body && typeof body === 'object')
    body = { revision: 1, ...body };
  return makeApp(bindings)(
    new Request(`https://x/api/v1/repos/team/project${tail}`, {
      method,
      headers: { ...actor.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
async function openPull(): Promise<Pull> {
  const res = await request('/pulls', 'POST', {
    title: 'Proposed change',
    head_cs: head,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { pull: Pull }).pull;
}
async function configure(extra = {}): Promise<void> {
  expect((await request('/ci', 'PUT', { ...policy, ...extra })).status).toBe(200);
}
function runnable(budget = '5'): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_MONTHLY_BUDGET_USD') return budget;
      if (key === 'CI_QUEUE') return { send: async () => {} };
      if (key === 'CI_RUNNER')
        return {
          idFromName: (id: string) => id,
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 701, 'owner');
  reviewer = await loginAs(testEnv, 702, 'reviewer');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repo.id, reviewer.userId],
  );
  base = await commit(null, 'base.txt');
  await setRef(testEnv, repo.id, 'main', base);
  head = await commit(base, 'change.txt');
});
describe('pull requests', () => {
  it('merges only the reviewed head and atomically records the resulting ref', async () => {
    const pull = await openPull();
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
    expect(
      (
        await request(`/pulls/${pull.id}/review`, 'POST', {
          head_cs: head,
          decision: 'approve',
          body: '',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/pulls/${pull.id}/review`,
          'POST',
          { head_cs: head, decision: 'approve', body: 'Looks good' },
          reviewer,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(200);
    // the default method records a merge commit of the reviewed head (#42)
    const merged = await q1<Pull>(testEnv, 'SELECT * FROM pull_requests WHERE id=?', [
      pull.id,
    ]);
    expect(merged).toMatchObject({ state: 'merged', merge_method: 'merge' });
    expect((await getRef(testEnv, repo.id, 'main'))?.head).toBe(merged?.merged_cs);
    const tip = await q1<{ parents: string }>(
      testEnv,
      'SELECT parents FROM changesets WHERE id = ?',
      [merged?.merged_cs],
    );
    expect(JSON.parse(tip?.parents ?? '[]')).toEqual([base, head]);
  });
  it('invalidates approvals after a head update and rejects stale review submissions', async () => {
    const pull = await openPull();
    await request(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head, decision: 'approve', body: '' },
      reviewer,
    );
    const newer = await commit(head, 'new.txt');
    expect(
      (await request(`/pulls/${pull.id}/update`, 'POST', { head_cs: newer })).status,
    ).toBe(200);
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: newer })).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/pulls/${pull.id}/review`,
          'POST',
          { head_cs: head, decision: 'approve', body: '' },
          reviewer,
        )
      ).status,
    ).toBe(409);
    await request(`/pulls/${pull.id}/update`, 'POST', { head_cs: head });
    expect(
      (
        await request(
          `/pulls/${pull.id}/review`,
          'POST',
          { head_cs: head, revision: 1, decision: 'approve', body: '' },
          reviewer,
        )
      ).status,
    ).toBe(409);
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
  });
  it('blocks draft and requested changes, but not a moved base', async () => {
    const pull = await openPull();
    await request(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head, decision: 'request_changes', body: 'Fix this' },
      reviewer,
    );
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
    await request(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head, decision: 'approve', body: '' },
      reviewer,
    );
    await request(`/pulls/${pull.id}/update`, 'POST', { state: 'draft' });
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
    await request(`/pulls/${pull.id}/update`, 'POST', { state: 'open' });
    // the server merges onto the moved target (#42)
    await setRef(testEnv, repo.id, 'main', await commit(base, 'other.txt'));
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(200);
  });
  it('requires a successful current pipeline and blocks direct protected ref moves', async () => {
    await configure({ required_approvals: 0 });
    const pull = await openPull();
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
    const job = await enqueueRun(runnable(), repo.id, head, owner.userId);
    await run(testEnv, "UPDATE ci_runs SET state='passed' WHERE id=?", [job.id]);
    await configure({ required_approvals: 0 });
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(409);
    expect(
      (await request('/refs/main', 'PUT', { from: base, to: head, force: true })).status,
    ).toBe(403);
    await run(testEnv, 'UPDATE ci_runs SET settings_version=2 WHERE id=?', [job.id]);
    expect(
      (await request(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head })).status,
    ).toBe(200);
  });
  it('does not expose private pull requests to strangers', async () => {
    const pull = await openPull();
    const stranger = await loginAs(testEnv, 703, 'stranger');
    expect((await request(`/pulls/${pull.id}`, 'GET', undefined, stranger)).status).toBe(
      404,
    );
  });
});
describe('bounded CI admission', () => {
  it('defaults to disabled and only admins can configure paid execution', async () => {
    await configure();
    expect((await request('/ci/runs', 'POST', {})).status).toBe(503);
    expect((await request('/ci', 'PUT', policy, reviewer)).status).toBe(403);
  });
  it('serializes a monthly budget race without overspending', async () => {
    await configure();
    const second = await commit(base, 'second.txt');
    const cost = reservation(parsePolicy(policy));
    const limited = runnable(String(cost / 1e6));
    const results = await Promise.allSettled([
      enqueueRun(limited, repo.id, head, owner.userId),
      enqueueRun(limited, repo.id, second, owner.userId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const sum = await q1<{ n: number }>(
      testEnv,
      'SELECT SUM(reserved_micros) AS n FROM ci_runs',
    );
    expect(sum?.n).toBe(cost);
  });
  it('deduplicates concurrent requests and limits outstanding jobs', async () => {
    await configure();
    const results = await Promise.allSettled([
      enqueueRun(runnable(), repo.id, head, owner.userId),
      enqueueRun(runnable(), repo.id, head, owner.userId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await enqueueRun(runnable(), repo.id, base, owner.userId);
    await expect(
      enqueueRun(runnable(), repo.id, await commit(base, 'third.txt'), owner.userId),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('keeps failed reservations and never silently retries jobs', async () => {
    await configure();
    const job = await enqueueRun(runnable(), repo.id, head, owner.userId);
    let acknowledgements = 0;
    const failing = new Proxy(runnable(), {
      get(target, key) {
        if (key === 'CI_RUNNER')
          return {
            idFromName: (id: string) => id,
            get: () => ({
              fetch: async () => {
                throw new Error('network failure');
              },
            }),
          };
        return Reflect.get(target, key);
      },
    });
    await ciQueue(
      {
        messages: [
          {
            body: { run_id: job.id },
            ack: () => {
              acknowledgements++;
            },
          },
        ],
      } as unknown as MessageBatch<{ run_id: string }>,
      failing,
    );
    expect(acknowledgements).toBe(1);
    const after = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]);
    expect(after?.state).toBe('failed');
    expect(after?.reserved_micros).toBe(job.reserved_micros);
  });
  it('denies publishing without configured credentials and rejects unsafe paths', async () => {
    await configure();
    await expect(
      enqueueRun(runnable(), repo.id, head, owner.userId, true),
    ).rejects.toMatchObject({ code: 'registry_not_configured' });
    expect(() => parsePolicy({ ...policy, dockerfile: '../Dockerfile' })).toThrow();
    // settings runs stay within one queue consumer; pipeline jobs may run longer (#52)
    expect(() =>
      parsePolicy({ ...policy, timeout_seconds: 601 }, policySchema),
    ).toThrow();
    expect(parsePolicy({ ...policy, timeout_seconds: 601 }).timeout_seconds).toBe(601);
  });
  it('detects project defaults and paginates history without repeating a commit', async () => {
    const detected = await request('/ci/detect');
    expect(detected.status).toBe(200);
    const first = await request('/changesets?head=' + head + '&limit=1');
    const page = (await first.json()) as {
      changesets: { id: string }[];
      next_cursor: string;
    };
    expect(page.changesets[0].id).toBe(head);
    expect(page.next_cursor).toBe(base);
    const next = await request('/changesets?cursor=' + page.next_cursor + '&limit=1');
    expect(
      ((await next.json()) as { changesets: { id: string }[] }).changesets[0].id,
    ).toBe(base);
  });
});

function mockRunner(bindings: Env, onAlarmSet?: () => Promise<void>) {
  const events: string[] = [];
  const storage = new Map<string, unknown>();
  const container = {
    running: false,
    images: { ci: 'test-image' },
    start() {
      events.push('start');
      this.running = true;
    },
    async destroy() {
      events.push('destroy');
      this.running = false;
    },
    async setInactivityTimeout() {},
    async exec(argv: string[], options: ContainerExecOptions = {}) {
      events.push(argv.join(' '));
      if (options.stdin && typeof options.stdin !== 'string')
        await new Response(options.stdin).arrayBuffer();
      return {
        stdout:
          options.stdout === 'ignore' ? null : new Blob(['command output\n']).stream(),
        exitCode: Promise.resolve(argv.at(-1) === 'false' ? 1 : 0),
      };
    },
  };
  const runner = Object.assign(Object.create(CiRunnerDO.prototype), {
    env: bindings,
    log: '',
    logBytes: 0,
    ctx: {
      container,
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
      storage: {
        async put(key: string, value: unknown) {
          storage.set(key, value);
        },
        async get(key: string) {
          return storage.get(key);
        },
        async setAlarm() {
          events.push('alarm-set');
          await onAlarmSet?.();
        },
        async deleteAlarm() {
          events.push('alarm-deleted');
        },
      },
    },
  }) as CiRunnerDO;
  return { runner, events, container };
}

async function execute(runner: CiRunnerDO, id: string) {
  return runner.fetch(
    new Request('https://runner/run', {
      method: 'POST',
      body: JSON.stringify({ run_id: id }),
    }),
  );
}

describe('runner lifecycle with a simulated container', () => {
  it('makes the active command visible before the run completes', async () => {
    await configure({ commands: ['npm run build'] });
    const bindings = runnable();
    const job = await enqueueRun(bindings, repo.id, head, owner.userId);
    const { runner, container } = mockRunner(bindings);
    const exec = container.exec.bind(container);
    let checked = false;
    container.exec = async (argv, options) => {
      if (argv.at(-1) === 'npm run build') {
        const active = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [
          job.id,
        ]);
        expect(active?.state).toBe('running');
        expect(active?.log_key).toBeTruthy();
        const log = await (await testEnv.OBJECTS.get(active!.log_key!))!.text();
        expect(log).toContain('Transferring source to runner');
        expect(log).toContain('$ npm run build');
        checked = true;
      }
      return exec(argv, options);
    };
    await execute(runner, job.id);
    expect(checked).toBe(true);
  });
  it('does not pass a run whose final command finishes after its deadline', async () => {
    await configure({ commands: ['npm run build'] });
    const bindings = runnable();
    const job = await enqueueRun(bindings, repo.id, head, owner.userId);
    const { runner, container } = mockRunner(bindings);
    const exec = container.exec.bind(container);
    const clock = vi.spyOn(Date, 'now');
    container.exec = async (argv, options) => {
      const result = await exec(argv, options);
      if (argv.at(-1) === 'npm run build') {
        const active = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [
          job.id,
        ]);
        clock.mockReturnValue(active!.deadline! + 1);
      }
      return result;
    };
    try {
      await execute(runner, job.id);
      const result = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [
        job.id,
      ]);
      expect(result?.state).toBe('timed_out');
      expect(result?.error).toBe('Run exceeded its time limit');
      expect(container.running).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['rejected', 'unavailable'])(
    'reports %s cancellation without claiming the job stopped',
    async (failure) => {
      await configure();
      const bindings = runnable();
      const job = await enqueueRun(bindings, repo.id, head, owner.userId);
      await run(testEnv, "UPDATE ci_runs SET state='running' WHERE id=?", [job.id]);
      const rejecting = new Proxy(bindings, {
        get(target, key) {
          if (key === 'CI_RUNNER') {
            if (failure === 'unavailable') return undefined;
            return {
              idFromName: (id: string) => id,
              get: () => ({
                fetch: async () => new Response('Unavailable', { status: 503 }),
              }),
            };
          }
          return Reflect.get(target, key);
        },
      });
      const response = await request(
        `/ci/runs/${job.id}/cancel`,
        'POST',
        {},
        owner,
        rejecting,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'ci_cancel_failed' },
      });
      expect(
        (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]))?.state,
      ).toBe('running');
    },
  );

  it('executes once, destroys the VM, stores bounded logs and removes its alarm', async () => {
    await configure();
    const bindings = runnable();
    const job = await enqueueRun(bindings, repo.id, head, owner.userId);
    const { runner, events, container } = mockRunner(bindings);
    expect((await execute(runner, job.id)).ok).toBe(true);
    const result = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]);
    expect(result?.state).toBe('passed');
    expect(container.running).toBe(false);
    expect(events.at(-1)).toBe('alarm-deleted');
    expect(await (await testEnv.OBJECTS.get(result!.log_key!))!.text()).toContain(
      'command output',
    );
    await execute(runner, job.id);
    expect(events.filter((e) => e === 'start')).toHaveLength(1);
  });
  it('destroys the VM on command failure and preserves its reservation', async () => {
    await configure({ commands: ['false'] });
    const bindings = runnable();
    const job = await enqueueRun(bindings, repo.id, head, owner.userId);
    const { runner, container } = mockRunner(bindings);
    await execute(runner, job.id);
    const result = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]);
    expect(result?.state).toBe('failed');
    expect(result?.reserved_micros).toBe(job.reserved_micros);
    expect(container.running).toBe(false);
  });
  it('does not start a VM when cancellation wins before startup', async () => {
    await configure();
    const bindings = runnable();
    const job = await enqueueRun(bindings, repo.id, head, owner.userId);
    const { runner, events } = mockRunner(bindings, async () => {
      await run(testEnv, "UPDATE ci_runs SET state='cancelled' WHERE id=?", [job.id]);
    });
    await execute(runner, job.id);
    expect(events).not.toContain('start');
    expect(
      (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]))?.state,
    ).toBe('cancelled');
  });
  it('multipart-stores unknown-length image output and aborts oversized output', async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 20).fill(42);
    await storeArtifact(
      testEnv.OBJECTS,
      'ci/test-image',
      new Blob([bytes]).stream(),
      bytes.length,
    );
    const object = await testEnv.OBJECTS.get('ci/test-image');
    expect(object?.size).toBe(bytes.length);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
    await expect(
      storeArtifact(testEnv.OBJECTS, 'ci/oversize', new Blob(['too big']).stream(), 2),
    ).rejects.toThrow('size limit');
    expect(await testEnv.OBJECTS.get('ci/oversize')).toBeNull();
    await testEnv.OBJECTS.delete('ci/test-image');
  });
});

it('denies whole-source CI and logs to path-restricted members', async () => {
  await configure();
  await run(
    testEnv,
    "INSERT INTO path_rules (repo_id,path_prefix,effect,principal,perms) VALUES (?,?,'deny',?,?)",
    [repo.id, 'private/', `user:${reviewer.userId}`, JSON.stringify(['read'])],
  );
  expect((await request('/ci', 'GET', undefined, reviewer)).status).toBe(403);
  expect((await request('/ci/runs', 'POST', {}, reviewer, runnable())).status).toBe(403);
  expect((await request('/ci', 'GET')).status).toBe(200);
});

it('requires operator authorization for each repository image destination', async () => {
  await configure({ image: 'registry.example/team/project' });
  const configured = new Proxy(runnable(), {
    get(target, key) {
      if (key === 'CI_REGISTRY_HOST') return 'registry.example';
      if (key === 'CI_REGISTRY_USERNAME') return 'test-user';
      if (key === 'CI_REGISTRY_PASSWORD') return 'test-only-placeholder';
      if (key === 'CI_REGISTRY_IMAGES')
        return JSON.stringify({ 'different/repo': 'registry.example/team/project' });
      return Reflect.get(target, key);
    },
  });
  await expect(
    enqueueRun(configured, repo.id, base, owner.userId, true),
  ).rejects.toMatchObject({ code: 'publish_not_allowed' });
});

it('enforces bearer scope and repository binding on paid CI routes', async () => {
  await configure();
  const readonly = await createApiToken(testEnv, owner.userId, {
    label: 'read-only',
    scopes: ['repo:read'],
    repoId: repo.id,
  });
  const response = await makeApp(runnable())(
    new Request('https://x/api/v1/repos/team/project/ci/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${readonly.raw}`,
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  expect(response.status).toBe(403);
  const elsewhere = await createApiToken(testEnv, owner.userId, {
    label: 'elsewhere',
    scopes: ['repo:read', 'repo:write'],
    repoId: 'different-repo',
  });
  const hidden = await makeApp(runnable())(
    new Request('https://x/api/v1/repos/team/project/ci', {
      headers: { authorization: `Bearer ${elsewhere.raw}` },
    }),
  );
  expect(hidden.status).toBe(404);
});

it('recovers an overdue claimed job even when alarm setup was interrupted', async () => {
  await configure();
  const bindings = runnable();
  const job = await enqueueRun(bindings, repo.id, head, owner.userId);
  await run(testEnv, "UPDATE ci_runs SET state='running', deadline=? WHERE id=?", [
    Date.now() - 1,
    job.id,
  ]);
  const { runner, events, container } = mockRunner(bindings);
  container.running = true;
  await runner.fetch(
    new Request('https://runner/expire', {
      method: 'POST',
      body: JSON.stringify({ run_id: job.id }),
    }),
  );
  expect(container.running).toBe(false);
  expect(events).not.toContain('start');
  expect(
    (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id=?', [job.id]))?.state,
  ).toBe('timed_out');
});
