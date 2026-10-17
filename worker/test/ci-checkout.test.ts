import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { commandBody, parseFetch } from './git-helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { MAX_CHANGED_FILES } from '../src/core/changesets';
import { q, q1, run } from '../src/db/client';
import { enqueueRun } from '../src/ci/runs';
import { CiRunnerDO } from '../src/ci/runner';
import { MAX_SOURCE_FILES } from '../src/ci/config';
import { SNAPSHOT_COLD_MS } from '../src/ci/cache';
import { readPack } from '../src/git/pack-reader';
import type { CiRun } from '../shared/collaboration';

/**
 * CI checkout over Git (issue #78): a built-in run with a request origin has
 * its VM fetch the commit over Git smart HTTP with the run's job token, so no
 * source passes through the Durable Object and the 2,000-file tar limit no
 * longer applies. The simulated container here plays `git fetch` against the
 * real upload-pack route with the header the runner gave it.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const FILES = 20_000;
const DIRS = 20;

function runnable(): Env {
  return new Proxy(dbEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
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

interface Exec {
  argv: string[];
  env?: Record<string, string>;
  objects?: number;
  blobs?: number;
}

function simulatedRunner(bindings: Env, slug: string, execs: Exec[]): CiRunnerDO {
  const app = makeApp(bindings);
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
      const exec: Exec = { argv, env: options.env };
      execs.push(exec);
      let code = 0;
      if (argv[3] === 'fetch') {
        const header = options.env?.GIT_CONFIG_VALUE_0 ?? '';
        const [url, want] = argv.slice(-2) as [string, string];
        expect(url).toBe(`https://forge.test/${slug}.git`);
        const res = await app(
          new Request(`${url}/git-upload-pack`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-git-upload-pack-request',
              'git-protocol': 'version=2',
              authorization: header.replace(/^Authorization: /, ''),
            },
            body: commandBody('fetch', [`want ${want}`, 'deepen 1', 'done']),
          }),
        );
        const fetched = parseFetch(new Uint8Array(await res.arrayBuffer()));
        if (res.status !== 200 || fetched.errors !== '') code = 128;
        else {
          const objects = await readPack(
            fetched.pack,
            { maxObjects: 100_000, maxObjectBytes: 1 << 20, maxTotalBytes: 1 << 28 },
            async () => null,
          );
          exec.objects = objects.size;
          exec.blobs = [...objects.values()].filter((o) => o.type === 'blob').length;
        }
      }
      return {
        stdout: options.stdout === 'ignore' ? null : new Blob(['ok\n']).stream(),
        exitCode: Promise.resolve(code),
      };
    },
  };
  return Object.assign(Object.create(CiRunnerDO.prototype), {
    env: bindings,
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
}

describe('CI checkout over Git (#78)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it(`checks out a repo with ${FILES} files`, { timeout: 600_000 }, async () => {
    expect(FILES).toBeGreaterThan(MAX_SOURCE_FILES);
    const owner = await loginAs(testEnv, 7802, 'owner');
    const repo = await createRepo(dbEnv, { slug: 'acme/big', createdBy: owner.userId });
    // four commits of 5,000 files: one changeset stores at most MAX_CHANGED_FILES
    let head: string | null = null;
    for (let start = 0; start < FILES; start += MAX_CHANGED_FILES) {
      const changes = Array.from({ length: MAX_CHANGED_FILES }, (_, i) => {
        const n = start + i;
        return {
          path: `d${n % DIRS}/f${n}.txt`,
          op: 'add' as const,
          content_b64: btoa(`file ${n}\n`),
        };
      });
      head = (
        await commitChanges(dbEnv, repo.id, {
          first_parent: head,
          message: `files from ${start}\n`,
          author: { name: 'Ada', email: 'ada@example.com' },
          changes,
        })
      ).changeset.id;
    }
    await setRef(dbEnv, repo.id, 'main', head as string);

    const bindings = runnable();
    expect(
      (
        await makeApp(bindings)(
          new Request('https://forge.test/api/v1/repos/acme/big/ci', {
            method: 'PUT',
            headers: { ...owner.headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              commands: ['npm test'],
              timeout_seconds: 600,
              required_approvals: 0,
            }),
          }),
        )
      ).status,
    ).toBe(200);
    const job = await enqueueRun(bindings, repo.id, head as string, owner.userId, false, {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      pull_id: null,
      fork: false,
      actor_kind: 'human',
      origin: 'https://forge.test',
      approval_id: null,
    });
    const execs: Exec[] = [];
    await simulatedRunner(bindings, 'acme/big', execs).fetch(
      new Request('https://runner/run', {
        method: 'POST',
        body: JSON.stringify({ run_id: job.id }),
      }),
    );

    const done = await q1<CiRun>(dbEnv, 'SELECT * FROM ci_runs WHERE id = ?', [job.id]);
    const log = await (await testEnv.OBJECTS.get(done!.log_key!))!.text();
    expect(done?.state, log).toBe('passed');
    expect(log).toContain('Fetching source over Git');
    expect(log).not.toContain('Transferring source');
    const fetch = execs.find((e) => e.argv[3] === 'fetch')!;
    expect(fetch.blobs).toBe(FILES);
    // one commit, the root tree and one tree per directory
    expect(fetch.objects).toBe(FILES + 1 + 1 + DIRS);
    const basic = fetch.env?.GIT_CONFIG_VALUE_0?.replace(/^Authorization: Basic /, '');
    expect(atob(basic ?? '')).toMatch(/^runner:yagclone_/);
    expect(execs.map((e) => e.argv.slice(0, 4).join(' '))).toEqual(
      expect.arrayContaining([
        'git init -q /workspace',
        'git -C /workspace fetch',
        'git -C /workspace checkout',
      ]),
    );
    expect(execs.some((e) => e.argv[0] === 'tar')).toBe(false);
    // the token never reaches the log, and ends with the run
    expect(log).not.toContain('yagclone_');
    const row = await q1(dbEnv, 'SELECT job_token_hash FROM ci_runs WHERE id = ?', [
      job.id,
    ]);
    expect(row).toEqual({ job_token_hash: null });
  });

  it('starts later jobs from the workspace of a green push to main', async () => {
    const owner = await loginAs(testEnv, 7804, 'owner');
    const repo = await createRepo(dbEnv, { slug: 'acme/warm', createdBy: owner.userId });
    const { changeset } = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'one\n',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('a\n') }],
    });
    await setRef(dbEnv, repo.id, 'main', changeset.id);
    const bindings = runnable();
    await makeApp(bindings)(
      new Request('https://forge.test/api/v1/repos/acme/warm/ci', {
        method: 'PUT',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ commands: ['npm test'], required_approvals: 0 }),
      }),
    );
    const start = async (
      event: 'push' | 'pull_request',
      ref: string,
    ): Promise<{ done: CiRun; log: string; execs: Exec[] }> => {
      const job = await enqueueRun(bindings, repo.id, changeset.id, owner.userId, false, {
        event,
        ref,
        pull_id: event === 'pull_request' ? 1 : null,
        fork: false,
        actor_kind: 'human',
        origin: 'https://forge.test',
        approval_id: null,
      });
      const execs: Exec[] = [];
      await simulatedRunner(bindings, 'acme/warm', execs).fetch(
        new Request('https://runner/run', {
          method: 'POST',
          body: JSON.stringify({ run_id: job.id }),
        }),
      );
      const done = (await q1<CiRun>(dbEnv, 'SELECT * FROM ci_runs WHERE id = ?', [
        job.id,
      ]))!;
      return {
        done,
        log: await (await testEnv.OBJECTS.get(done.log_key!))!.text(),
        execs,
      };
    };
    const snapshots = () =>
      q<{ key: string; scope: string; state: string }>(
        dbEnv,
        'SELECT key, scope, state FROM ci_caches WHERE repo_id = ?',
        [repo.id],
      );

    // a pull request before any green main run starts cold and saves nothing
    const cold = await start('pull_request', 'refs/pull/1/head');
    expect(cold.done.state, cold.log).toBe('passed');
    expect(cold.execs.some((e) => e.argv[0] === 'tar')).toBe(false);
    expect(await snapshots()).toEqual([]);

    const push = await start('push', 'refs/heads/main');
    expect(push.done.state, push.log).toBe('passed');
    expect(push.log).toContain('Saved 1 MiB');
    const saved = await snapshots();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ scope: 'refs/heads/main', state: 'ready' });
    const [, seed, sha] = /^yag-workspace-settings-(\d+)-([0-9a-f]{40})$/.exec(
      saved[0]!.key,
    )!;
    expect(Date.now() - Number(seed)).toBeLessThan(60_000);
    const tar = push.execs.find((e) => e.argv[0] === 'tar')!;
    expect(tar.argv.slice(0, 2)).toEqual(['tar', '-czf']);
    // the job token was revoked before the workspace was read
    expect(
      await q1(dbEnv, 'SELECT 1 AS n FROM ci_job_tokens WHERE run_id = ?', [
        push.done.id,
      ]),
    ).toBeNull();

    const warm = await start('pull_request', 'refs/pull/1/head');
    expect(warm.done.state, warm.log).toBe('passed');
    expect(warm.log).toContain(`Restoring workspace snapshot of ${sha.slice(0, 12)}`);
    expect(warm.log).not.toContain('Saving workspace snapshot');
    const order = warm.execs.map((e) => e.argv.slice(0, 2).join(' '));
    expect(order.indexOf('tar -xzf')).toBeGreaterThan(-1);
    expect(order.indexOf('tar -xzf')).toBeLessThan(order.indexOf('git -C'));
    const step = warm.execs.find((e) => e.argv[0] === '/bin/bash')!;
    expect(step.env?.YAG_BASE).toBe(sha);
    // pull requests never write the snapshot
    expect(await snapshots()).toEqual(saved);

    // a day after the clean build, the next push to main builds cold and re-seeds
    const stale = `yag-workspace-settings-${Date.now() - SNAPSHOT_COLD_MS - 1}-${sha}`;
    await run(dbEnv, 'UPDATE ci_caches SET key = ? WHERE repo_id = ?', [stale, repo.id]);
    const pr = await start('pull_request', 'refs/pull/1/head');
    expect(pr.log).toContain('Restoring workspace snapshot');
    const clean = await start('push', 'refs/heads/main');
    expect(clean.done.state, clean.log).toBe('passed');
    expect(clean.log).toContain('Building from an empty workspace');
    expect(clean.execs.some((e) => e.argv[1] === '-xzf')).toBe(false);
    expect(
      clean.execs.find((e) => e.argv[0] === '/bin/bash')!.env?.YAG_BASE,
    ).toBeUndefined();
    const reseeded = (await snapshots()).map((r) => r.key);
    expect(reseeded).toHaveLength(2);
    expect(reseeded).toContain(stale);
    const fresh = reseeded.find((k) => k !== stale)!;
    expect(Date.now() - Number(/-(\d+)-[0-9a-f]{40}$/.exec(fresh)![1])).toBeLessThan(
      60_000,
    );
    // and later jobs start from the clean one
    const after = await start('pull_request', 'refs/pull/1/head');
    expect(after.log).toContain('Restoring workspace snapshot');
    expect(after.execs.find((e) => e.argv[0] === '/bin/bash')!.env?.YAG_BASE).toBe(sha);
    expect(
      (
        await q<{ key: string; last_used_at: number }>(
          dbEnv,
          'SELECT key, last_used_at FROM ci_caches WHERE repo_id = ? ORDER BY last_used_at DESC LIMIT 1',
          [repo.id],
        )
      )[0]!.key,
    ).toBe(fresh);
  });

  it('falls back to the tar copy for a run with no origin', async () => {
    const owner = await loginAs(testEnv, 7803, 'owner');
    const repo = await createRepo(dbEnv, { slug: 'acme/small', createdBy: owner.userId });
    const { changeset } = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'one\n',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('a\n') }],
    });
    await setRef(dbEnv, repo.id, 'main', changeset.id);
    const bindings = runnable();
    await makeApp(bindings)(
      new Request('https://forge.test/api/v1/repos/acme/small/ci', {
        method: 'PUT',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ commands: ['npm test'], required_approvals: 0 }),
      }),
    );
    const job = await enqueueRun(bindings, repo.id, changeset.id, owner.userId);
    const execs: Exec[] = [];
    await simulatedRunner(bindings, 'acme/small', execs).fetch(
      new Request('https://runner/run', {
        method: 'POST',
        body: JSON.stringify({ run_id: job.id }),
      }),
    );
    const done = await q1<CiRun>(dbEnv, 'SELECT * FROM ci_runs WHERE id = ?', [job.id]);
    expect(done?.state).toBe('passed');
    expect(execs.some((e) => e.argv[0] === 'tar')).toBe(true);
    expect(execs.some((e) => e.argv[0] === 'git')).toBe(false);
  });
});
