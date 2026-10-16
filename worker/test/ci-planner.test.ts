import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  blob,
  commit as gitCommit,
  dir,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
} from './git-helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { advancePipelines } from '../src/ci/planner';
import { sweepPipelines } from '../src/ci/triggers';
import { CiRunnerDO } from '../src/ci/runner';
import type { CiRun, PipelineRun, Pull } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const SPEC = '.yuma/pipelines/ci.yml';
const THREE_JOBS = `on: [manual, pull_request]
jobs:
  lint:
    steps: [{ run: npm run lint }]
  test:
    matrix: { node: [20, 22] }
    steps: [{ run: "npx -y node@\${{ matrix.node }} --version" }]
  build:
    needs: [lint, test]
    services:
      postgres: { image: "postgres:16", env: { POSTGRES_PASSWORD: ci } }
    steps: [{ run: npm run build }]
`;
const author = { name: 'Ada', email: 'ada@example.com' };
let owner: Awaited<ReturnType<typeof loginAs>>;
let reviewer: Awaited<ReturnType<typeof loginAs>>;
let repoId = '';
let sends: string[] = [];

/** CI bindings: queue sends are recorded, runner cancellation stops the run in D1. */
function ci(): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_QUEUE')
        return {
          send: async (body: { run_id: string }) => {
            sends.push(body.run_id);
          },
        };
      if (key === 'CI_RUNNER')
        return {
          idFromName: (id: string) => id,
          get: (id: string) => ({
            fetch: async (url: string) => {
              if (url.endsWith('/cancel'))
                await run(
                  testEnv,
                  "UPDATE ci_runs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state IN ('queued','running')",
                  [Date.now(), id],
                );
              return Response.json({ ok: true });
            },
          }),
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

async function commit(
  parent: string | null,
  files: Record<string, string>,
  op: 'add' | 'mod' = 'add',
): Promise<string> {
  const result = await commitChanges(testEnv, repoId, {
    first_parent: parent,
    message: 'change',
    author,
    changes: Object.entries(files).map(([path, text]) => ({
      path,
      op,
      content_b64: btoa(text),
    })),
  });
  return result.changeset.id;
}

async function api(
  tail: string,
  method = 'GET',
  body?: unknown,
  actor: { headers: Record<string, string> } | null = owner,
): Promise<Response> {
  return makeApp(ci())(
    new Request(`https://x/api/v1/repos/team/project${tail}`, {
      method,
      headers: { ...(actor?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function pipelines(head?: string): Promise<PipelineRun[]> {
  const res = await api(`/ci/pipelines${head ? `?head=${head}` : ''}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { runs: PipelineRun[] }).runs;
}

const states = (r: PipelineRun): Record<string, string> =>
  Object.fromEntries(r.jobs.map((j) => [j.key, j.state]));

/** Finish a job's run as the runner would, then advance like its `finally`. */
async function finish(r: PipelineRun, key: string, state = 'passed'): Promise<void> {
  const job = r.jobs.find((j) => j.key === key)!;
  await run(testEnv, 'UPDATE ci_runs SET state = ?, finished_at = ? WHERE id = ?', [
    state,
    Date.now(),
    job.run_id,
  ]);
  await advancePipelines(ci());
}

async function latest(): Promise<PipelineRun> {
  return (await pipelines())[0]!;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sends = [];
  owner = await loginAs(testEnv, 801, 'owner');
  reviewer = await loginAs(testEnv, 802, 'reviewer');
  repoId = (await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId }))
    .id;
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repoId, reviewer.userId],
  );
});
afterEach(() => vi.restoreAllMocks());

describe('pipeline runs', () => {
  it('runs lint, a Node 20/22 test matrix and build in order and reports four checks', async () => {
    await setRef(testEnv, repoId, 'main', await commit(null, { [SPEC]: THREE_JOBS }));
    const started = await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    expect(started.status).toBe(202);
    // Two runner slots: the third root job waits in the shared ledger.
    expect(states(((await started.json()) as { run: PipelineRun }).run)).toEqual({
      lint: 'queued',
      'test (20)': 'queued',
      'test (22)': 'waiting',
      build: 'waiting',
    });
    await finish(await latest(), 'lint');
    expect(states(await latest())).toMatchObject({
      'test (22)': 'queued',
      build: 'waiting',
    });
    await finish(await latest(), 'test (20)');
    expect(states(await latest()).build).toBe('waiting');
    await finish(await latest(), 'test (22)');
    expect(states(await latest()).build).toBe('queued');
    await finish(await latest(), 'build');
    const done = await latest();
    expect(done.state).toBe('passed');
    expect(done.finished_at).not.toBeNull();
    expect(done.jobs).toHaveLength(4);
    expect(done.jobs.every((j) => j.state === 'passed')).toBe(true);
    // Each job is one ci_runs row with its own reservation; none count as a settings run.
    const rows = await q<CiRun>(
      testEnv,
      'SELECT * FROM ci_runs WHERE pipeline_run_id = ?',
      [done.id],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.settings_version === 0 && r.reserved_micros > 0)).toBe(
      true,
    );
    expect(sends).toHaveLength(4);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'ci.run.create'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ pipeline: SPEC });
  });

  it('runs each job in the existing runner, with services, and advances when a run ends', async () => {
    await setRef(testEnv, repoId, 'main', await commit(null, { [SPEC]: THREE_JOBS }));
    expect((await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC })).status).toBe(
      202,
    );
    const order: string[] = [];
    const argv: string[][] = [];
    for (let i = 0; i < sends.length; i++) {
      const job = await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id = ?', [
        sends[i],
      ]);
      order.push(job!.job_key!);
      await mockRunner(ci(), argv).fetch(
        new Request('https://runner/run', {
          method: 'POST',
          body: JSON.stringify({ run_id: sends[i] }),
        }),
      );
    }
    expect(order).toEqual(['lint', 'test (20)', 'test (22)', 'build']);
    expect((await latest()).state).toBe('passed');
    expect(argv).toContainEqual([
      'docker',
      '--host',
      'unix:///var/run/docker.sock',
      'run',
      '-d',
      '--rm',
      '--network=host',
      '--name',
      'yag-svc-postgres',
      '-e',
      'POSTGRES_PASSWORD=ci',
      'postgres:16',
    ]);
    expect(argv.some((a) => a.at(-1) === 'npx -y node@22 --version')).toBe(true);
  });

  it('skips jobs whose needs failed', async () => {
    await setRef(testEnv, repoId, 'main', await commit(null, { [SPEC]: THREE_JOBS }));
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    await finish(await latest(), 'lint', 'failed');
    await finish(await latest(), 'test (20)');
    await finish(await latest(), 'test (22)');
    const done = await latest();
    expect(states(done).build).toBe('skipped');
    expect(done.jobs.find((j) => j.key === 'build')!.error).toBe(
      'A needed job did not pass',
    );
    expect(done.state).toBe('failed');
  });

  it('cancels a pipeline run: started jobs stop, waiting jobs are skipped', async () => {
    await setRef(testEnv, repoId, 'main', await commit(null, { [SPEC]: THREE_JOBS }));
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    const id = (await latest()).id;
    expect((await api(`/ci/pipelines/runs/${id}/cancel`, 'POST', {})).status).toBe(200);
    const done = await latest();
    expect(done.state).toBe('cancelled');
    expect(states(done)).toEqual({
      lint: 'cancelled',
      'test (20)': 'cancelled',
      'test (22)': 'skipped',
      build: 'skipped',
    });
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'ci.run.cancel'",
    );
    expect(JSON.parse(audit!.target)).toEqual({ pipeline_run_id: id });
    expect((await api('/ci/pipelines/runs/nope/cancel', 'POST', {})).status).toBe(404);
  });

  it('waits in the shared ledger while runner slots are full, for an hour at most', async () => {
    const head = await commit(null, { [SPEC]: THREE_JOBS });
    await setRef(testEnv, repoId, 'main', head);
    for (const id of ['busy-1', 'busy-2'])
      await run(
        testEnv,
        `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state, month, reserved_micros, created_at)
        VALUES (?, ?, ?, 1, '{}', ?, 'running', ?, 1, ?)`,
        [
          id,
          repoId,
          head,
          owner.userId,
          new Date().toISOString().slice(0, 7),
          Date.now(),
        ],
      );
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    expect(Object.values(states(await latest()))).toEqual([
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
    await advancePipelines(ci());
    const done = await latest();
    expect(done.state).toBe('failed');
    expect(done.jobs[0]!.error).toBe('Waited over an hour for runner capacity or budget');
    expect(states(done).build).toBe('skipped');
  });

  it('refuses manual runs of pipelines without a manual trigger', async () => {
    await setRef(
      testEnv,
      repoId,
      'main',
      await commit(null, { [SPEC]: 'on: push\njobs:\n  a:\n    steps: [{run: x}]\n' }),
    );
    const res = await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'manual_not_allowed' } });
  });
});

describe('pull request pipelines', () => {
  async function openPull(head: string): Promise<Pull> {
    const res = await api('/pulls', 'POST', { title: 'Change', head_cs: head });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pull: Pull; ci: { status: string } };
    return body.pull;
  }
  async function gate(id: number): Promise<string[]> {
    const res = await api(`/pulls/${id}`);
    return ((await res.json()) as { gate: { reasons: string[] } }).gate.reasons;
  }
  const spec = (job: string): string =>
    `on: pull_request\njobs:\n  ${job}:\n    steps: [{ run: "true" }]\n`;

  it("runs the pull request's own spec and needs fresh results after it changes", async () => {
    const base = await commit(null, { [SPEC]: spec('old') });
    await setRef(testEnv, repoId, 'main', base);
    const head = await commit(base, { [SPEC]: spec('new') }, 'mod');
    const pull = await openPull(head);
    let runs = await pipelines(head);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ event: 'pull_request', ref: `pull/${pull.id}` });
    expect(runs[0]!.jobs.map((j) => j.key)).toEqual(['new']);
    expect(await gate(pull.id)).toContain('Pipeline ci must pass for this revision.');
    await finish(runs[0]!, 'new');
    expect(await gate(pull.id)).not.toContain('Pipeline ci must pass for this revision.');

    // A new revision with a changed pipeline needs its own passing run.
    const head2 = await commit(head, { [SPEC]: spec('newer') }, 'mod');
    const updated = await api(`/pulls/${pull.id}/update`, 'POST', { head_cs: head2 });
    expect(updated.status).toBe(200);
    expect(await gate(pull.id)).toContain('Pipeline ci must pass for this revision.');
    runs = await pipelines(head2);
    expect(runs[0]!.jobs.map((j) => j.key)).toEqual(['newer']);
    const approve = await api(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head2, decision: 'approve', body: '', revision: 2 },
      reviewer,
    );
    expect(approve.status).toBe(200);
    expect(
      (await api(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head2, revision: 2 }))
        .status,
    ).toBe(409);
    await finish(runs[0]!, 'newer');
    expect(await gate(pull.id)).toEqual([]);
    expect(
      (await api(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head2, revision: 2 }))
        .status,
    ).toBe(200);
  });

  it('shows line-numbered errors for an invalid spec in the checks panel', async () => {
    const base = await commit(null, { 'README.md': 'hi' });
    await setRef(testEnv, repoId, 'main', base);
    const head = await commit(base, {
      [SPEC]:
        'on: pull_request\njobs:\n  a:\n    needs: [missing]\n    steps: [{run: x}]\n',
    });
    const pull = await openPull(head);
    const [failed] = await pipelines(head);
    expect(failed).toMatchObject({ state: 'failed', jobs: [] });
    expect(failed!.errors).toEqual([
      { line: 4, column: 13, message: 'jobs.a.needs.0: Unknown job "missing"' },
    ]);
    expect(await gate(pull.id)).toContain(`Fix the errors in ${SPEC}.`);
  });

  it('keeps the settings pipeline when the revision has no spec', async () => {
    const base = await commit(null, { 'README.md': 'hi' });
    await setRef(testEnv, repoId, 'main', base);
    const head = await commit(base, { 'b.txt': 'b' });
    expect(
      (
        await api('/ci', 'PUT', {
          commands: ['npm test'],
          timeout_seconds: 60,
          required_approvals: 1,
        })
      ).status,
    ).toBe(200);
    await openPull(head);
    expect(await pipelines(head)).toEqual([]);
    const v1 = await q<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE head_cs = ?', [head]);
    expect(v1).toHaveLength(1);
    expect(v1[0]!.pipeline_run_id).toBeNull();
  });

  const settingsRuns = (head: string) =>
    q<CiRun>(
      testEnv,
      'SELECT * FROM ci_runs WHERE head_cs = ? AND pipeline_run_id IS NULL',
      [head],
    );
  const CI_MUST_PASS =
    'The latest CI run must pass for this revision and current pipeline.';

  it("keeps the settings pipeline required when the pull request's spec passes", async () => {
    const base = await commit(null, { 'README.md': 'hi' });
    await setRef(testEnv, repoId, 'main', base);
    expect(
      (
        await api('/ci', 'PUT', {
          commands: ['npm test'],
          timeout_seconds: 60,
          required_approvals: 0,
        })
      ).status,
    ).toBe(200);
    // the author's own pipeline passes, but the admin's CI policy still has to
    const head = await commit(base, { [SPEC]: spec('ok'), 'src.ts': 'broken' });
    const pull = await openPull(head);
    const [own] = await pipelines(head);
    await finish(own!, 'ok');
    expect(await settingsRuns(head)).toHaveLength(1);
    expect(await gate(pull.id)).toContain(CI_MUST_PASS);
    expect(
      (await api(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head, revision: 1 }))
        .status,
    ).toBe(409);
    await run(
      testEnv,
      "UPDATE ci_runs SET state = 'passed' WHERE head_cs = ? AND pipeline_run_id IS NULL",
      [head],
    );
    expect(await gate(pull.id)).toEqual([]);
  });

  it('queues the settings pipeline when no pipeline file runs on pull requests', async () => {
    const nightly =
      'on:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  a:\n    steps: [{ run: "true" }]\n';
    const base = await commit(null, { [SPEC]: nightly });
    await setRef(testEnv, repoId, 'main', base);
    expect(
      (await api('/ci', 'PUT', { commands: ['npm test'], timeout_seconds: 60 })).status,
    ).toBe(200);
    const head = await commit(base, { 'b.txt': 'b' });
    await openPull(head);
    expect(await pipelines(head)).toEqual([]);
    expect(await settingsRuns(head)).toHaveLength(1);
  });

  it('starts push pipelines for the target branch when a pull request merges', async () => {
    const both = 'on: [push, pull_request]\njobs:\n  a:\n    steps: [{ run: "true" }]\n';
    const base = await commit(null, { [SPEC]: both });
    await setRef(testEnv, repoId, 'main', base);
    const head = await commit(base, { 'b.txt': 'b' });
    const pull = await openPull(head);
    const [own] = await pipelines(head);
    expect(own).toMatchObject({ event: 'pull_request' });
    await finish(own!, 'a');
    const approve = await api(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head, decision: 'approve', body: '', revision: 1 },
      reviewer,
    );
    expect(approve.status).toBe(200);
    expect(
      (await api(`/pulls/${pull.id}/merge`, 'POST', { head_cs: head, revision: 1 }))
        .status,
    ).toBe(200);
    expect((await pipelines(head)).map((r) => [r.event, r.ref])).toContainEqual([
      'push',
      'main',
    ]);
  });
});

describe('triggers', () => {
  it('fires schedules within a minute in Australia/Sydney and UTC', async () => {
    const spec = `on:
  schedule:
    - cron: "0 3 * * *"
      timezone: Australia/Sydney
    - cron: "30 16 * * *"
jobs:
  nightly:
    steps: [{ run: "true" }]
`;
    await setRef(testEnv, repoId, 'main', await commit(null, { [SPEC]: spec }));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(Date.UTC(2026, 9, 16, 12));
    await sweepPipelines(ci());
    const due = await q<{ timezone: string; next_at: number }>(
      testEnv,
      'SELECT timezone, next_at FROM ci_schedules ORDER BY next_at',
    );
    expect(due).toEqual([
      { timezone: 'Australia/Sydney', next_at: Date.UTC(2026, 9, 16, 16) },
      { timezone: 'UTC', next_at: Date.UTC(2026, 9, 16, 16, 30) },
    ]);
    clock.mockReturnValue(Date.UTC(2026, 9, 16, 15, 59));
    await sweepPipelines(ci());
    expect(await pipelines()).toHaveLength(0);
    clock.mockReturnValue(Date.UTC(2026, 9, 16, 16, 0, 40));
    await sweepPipelines(ci());
    await sweepPipelines(ci());
    let runs = await pipelines();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      event: 'schedule',
      ref: 'main',
      requested_by: 'schedule',
    });
    clock.mockReturnValue(Date.UTC(2026, 9, 16, 16, 31));
    await sweepPipelines(ci());
    runs = await pipelines();
    expect(runs).toHaveLength(2);
    const next = await q<{ next_at: number }>(
      testEnv,
      'SELECT next_at FROM ci_schedules ORDER BY next_at',
    );
    expect(next.map((n) => n.next_at)).toEqual([
      Date.UTC(2026, 9, 17, 16),
      Date.UTC(2026, 9, 17, 16, 30),
    ]);
  });

  it('cancels older runs in a concurrency group, or queues behind them', async () => {
    const spec = (cancel: boolean): string => `on: manual
concurrency:
  group: deploy-\${{ ref }}
  cancel_in_progress: ${cancel}
jobs:
  deploy:
    steps: [{ run: "true" }]
`;
    const base = await commit(null, { [SPEC]: spec(true) });
    await setRef(testEnv, repoId, 'main', base);
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    const [newer, older] = await pipelines();
    expect(older).toMatchObject({ state: 'cancelled', concurrency_group: 'deploy-main' });
    expect(states(older!).deploy).toBe('cancelled');
    expect(states(newer!).deploy).toBe('queued');
    await finish(newer!, 'deploy');

    await setRef(
      testEnv,
      repoId,
      'main',
      await commit(base, { [SPEC]: spec(false) }, 'mod'),
    );
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    const [waiting, first] = await pipelines();
    expect(states(first!).deploy).toBe('queued');
    expect(states(waiting!).deploy).toBe('waiting');
    await finish(first!, 'deploy');
    expect(states((await pipelines())[0]!).deploy).toBe('queued');
  });

  it('starts matching push pipelines from git receive-pack', async () => {
    const yml = await blob(
      'on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps: [{run: "true"}]\n',
    );
    const pipelinesDir = await tree([{ name: 'ci.yml', sha: yml.sha }]);
    const yuma = await tree([dir('pipelines', pipelinesDir)]);
    const root = await tree([dir('.yuma', yuma)]);
    const head = await gitCommit(root.sha, [], 'ci\n');
    const token = await createApiToken(testEnv, owner.userId, { label: 'git' });
    const res = await makeApp(ci())(
      new Request('https://x/team/project.git/git-receive-pack', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token.raw}`)}`,
        },
        body: pushBody(
          [
            [ZERO, head.sha, 'refs/heads/main'],
            [ZERO, head.sha, 'refs/heads/feature'],
          ],
          await packOf([head, root, yuma, pipelinesDir, yml]),
        ),
      }),
    );
    const report = parseReport(new Uint8Array(await res.arrayBuffer()));
    expect(report.refs).toEqual({ 'refs/heads/main': 'ok', 'refs/heads/feature': 'ok' });
    expect(report.messages).toContain('CI main: started ci');
    const runs = await pipelines();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ event: 'push', ref: 'main', state: 'running' });
  });

  it('starts no push pipeline when a ruleset refuses the push', async () => {
    const created = await api('/rulesets', 'POST', {
      name: 'Small files',
      target: 'push',
      rules: [{ type: 'max_file_size', max_bytes: 10 }],
    });
    expect(created.status).toBe(201);
    const yml = await blob(
      'on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps: [{run: "true"}]\n',
    );
    const pipelinesDir = await tree([{ name: 'ci.yml', sha: yml.sha }]);
    const yuma = await tree([dir('pipelines', pipelinesDir)]);
    const root = await tree([dir('.yuma', yuma)]);
    const head = await gitCommit(root.sha, [], 'ci\n');
    const token = await createApiToken(testEnv, owner.userId, { label: 'git' });
    const res = await makeApp(ci())(
      new Request('https://x/team/project.git/git-receive-pack', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token.raw}`)}`,
        },
        body: pushBody(
          [[ZERO, head.sha, 'refs/heads/main']],
          await packOf([head, root, yuma, pipelinesDir, yml]),
        ),
      }),
    );
    const report = parseReport(new Uint8Array(await res.arrayBuffer()));
    expect(report.refs['refs/heads/main']).toMatch(
      /^ruleset "Small files" max_file_size/,
    );
    expect(report.messages).not.toContain('CI');
    expect(await pipelines()).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe('pipeline API access', () => {
  it('keeps the anonymous, hidden and path-rule contracts', async () => {
    expect((await api('/ci/pipelines', 'GET', undefined, null)).status).toBe(401);
    const outsider = await loginAs(testEnv, 803, 'outsider');
    expect((await api('/ci/pipelines', 'GET', undefined, outsider)).status).toBe(404);
    await run(
      testEnv,
      "INSERT INTO path_rules (repo_id,path_prefix,effect,principal,perms) VALUES (?,?,'deny',?,?)",
      [repoId, 'private/', `user:${reviewer.userId}`, JSON.stringify(['read'])],
    );
    const denied = await api('/ci/pipelines', 'GET', undefined, reviewer);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: 'whole_repository_required', denied_by: {} },
    });
    expect(
      (await api('/ci/pipelines/runs', 'POST', { pipeline: SPEC }, reviewer)).status,
    ).toBe(403);
  });
});

function mockRunner(bindings: Env, argv: string[][]): CiRunnerDO {
  const storage = new Map<string, unknown>();
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
    async exec(args: string[], options: ContainerExecOptions = {}) {
      argv.push(args);
      if (options.stdin && typeof options.stdin !== 'string')
        await new Response(options.stdin).arrayBuffer();
      return {
        stdout: options.stdout === 'ignore' ? null : new Blob(['ok\n']).stream(),
        exitCode: Promise.resolve(0),
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
        put: async (key: string, value: unknown) => storage.set(key, value),
        get: async (key: string) => storage.get(key),
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    },
  }) as CiRunnerDO;
}
