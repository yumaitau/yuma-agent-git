import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { parseSpec } from '../src/ci/spec';
import { MAX_STEP_LOG_BYTES, sweepRunners } from '../src/ci/runners';
import { prepareJob } from '../src/ci/inject';
import { parsePolicy } from '../src/ci/config';
import type { CiRun, PipelineRun } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const SPEC = '.yuma/pipelines/ci.yml';
const PIPELINE = `on: [manual]
jobs:
  build:
    runs-on: linux
    steps: [{ run: echo hello }, { run: make test }]
  ios:
    runs-on: [macos, arm64]
    steps: [{ run: swift build }]
  cloud:
    steps: [{ run: npm test }]
`;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let member: Login;
let repoId = '';
let sends: string[] = [];
let events: string[] = [];

interface Job {
  id: string;
  repo: string;
  job: string;
  commit: string;
  clone: { url: string; token: string };
  steps: string[];
  mask: string[];
  deadline: number;
}

/** CI bindings: queue sends are recorded; nothing here reaches a container. */
function ci(): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'EVENTS_QUEUE')
        return {
          send: async (m: { event: { event: string; action: string } }) => {
            events.push(`${m.event.event}:${m.event.action}`);
          },
        };
      if (key === 'CI_QUEUE')
        return {
          send: async (body: { run_id: string }) => {
            sends.push(body.run_id);
          },
        };
      if (key === 'CI_RUNNER')
        return {
          idFromName: (id: string) => id,
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = owner.headers,
): Promise<Response> {
  return Promise.resolve(
    makeApp(ci())(
      new Request(`https://x${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  );
}

/** A request from a runner with its credential. */
function runner(
  credential: string,
  path: string,
  method = 'POST',
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    makeApp(ci())(
      new Request(`https://x/runner/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
        },
        body:
          body === undefined
            ? undefined
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      }),
    ),
  );
}

async function token(
  base = '/api/v1/orgs/yuma',
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(`${base}/runners/registration-token`, 'POST', body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function register(
  labels: string[],
  opts: { ephemeral?: boolean; trusted_only?: boolean; base?: string } = {},
): Promise<{ id: string; credential: string }> {
  const grant = await token(opts.base, { trusted_only: opts.trusted_only ?? false });
  const res = await runner('', '/register', 'POST', {
    token: grant,
    name: `runner-${labels.join('-')}`,
    labels,
    ephemeral: opts.ephemeral ?? false,
    capabilities: { os: 'linux', arch: 'x64' },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { runner: { id: string }; credential: string };
  return { id: body.runner.id, credential: body.credential };
}

async function claim(credential: string): Promise<Job | null> {
  const res = await runner(credential, '/jobs/claim?wait=0');
  if (res.status === 204) return null;
  expect(res.status).toBe(200);
  return ((await res.json()) as { job: Job }).job;
}

async function startPipeline(): Promise<PipelineRun> {
  const cs = await commitChanges(testEnv, repoId, {
    first_parent: null,
    message: 'pipeline',
    author: { name: 'Ada', email: 'ada@example.com' },
    changes: [{ path: SPEC, op: 'add', content_b64: btoa(PIPELINE) }],
  });
  await setRef(testEnv, repoId, 'main', cs.changeset.id);
  const res = await call('/api/v1/repos/yuma/app/ci/pipelines/runs', 'POST', {
    pipeline: SPEC,
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { run: PipelineRun }).run;
}

async function runRow(id: string): Promise<CiRun & { runs_on: string | null }> {
  return (await q1<CiRun & { runs_on: string | null }>(
    testEnv,
    'SELECT * FROM ci_runs WHERE id = ?',
    [id],
  ))!;
}

function git(cloneToken: string, service = 'git-upload-pack'): Promise<Response> {
  return Promise.resolve(
    makeApp(ci())(
      new Request(`https://x/yuma/app.git/info/refs?service=${service}`, {
        headers: { authorization: `Basic ${btoa(`runner:${cloneToken}`)}` },
      }),
    ),
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sends = [];
  events = [];
  owner = await loginAs(testEnv, 901, 'olive');
  member = await loginAs(testEnv, 902, 'max');
  expect((await call('/api/v1/orgs', 'POST', { slug: 'yuma' })).status).toBe(201);
  expect(
    (
      await call('/api/v1/orgs/yuma/members', 'PUT', {
        user_login: 'max',
        role: 'member',
      })
    ).status,
  ).toBe(200);
  const created = await call('/api/v1/repos', 'POST', { slug: 'yuma/app', org: 'yuma' });
  expect(created.status).toBe(201);
  repoId = (await q1<{ id: string }>(
    testEnv,
    "SELECT id FROM repos WHERE slug = 'yuma/app'",
  ))!.id;
});

describe('runs-on routing', () => {
  it('parses runs-on and keeps cloudflare jobs on the built-in pool', () => {
    const spec = parseSpec(
      SPEC,
      `on: [manual]
jobs:
  a: { runs-on: Linux, steps: [{ run: x }] }
  b: { runs-on: [cloudflare, linux], steps: [{ run: x }] }
  c: { runs-on: [cloudflare, macos], steps: [{ run: x }] }
`,
    );
    expect(spec.errors?.map((e) => e.message)).toEqual([
      expect.stringContaining('jobs.a.runs-on'),
      expect.stringContaining('Cloudflare runners only carry the labels'),
    ]);
    const ok = parseSpec(
      SPEC,
      `on: [manual]
jobs:
  a: { runs-on: linux, steps: [{ run: x }] }
  b: { runs-on: [cloudflare, linux], steps: [{ run: x }] }
  c: { steps: [{ run: x }] }
`,
    );
    expect(ok.pipeline!.jobs.map((j) => j.runs_on)).toEqual([['linux'], null, null]);
  });

  it('queues self-hosted jobs for runners, outside the Cloudflare budget and slots', async () => {
    const started = await startPipeline();
    // all three start at once: self-hosted jobs do not hold the two built-in slots
    expect(started.jobs.map((j) => j.state)).toEqual(['queued', 'queued', 'queued']);
    const rows = await q<CiRun & { runs_on: string | null }>(
      testEnv,
      'SELECT * FROM ci_runs ORDER BY job_key',
    );
    expect(rows.map((r) => [r.job_key, r.runs_on, r.reserved_micros > 0])).toEqual([
      ['build', '["linux"]', false],
      ['cloud', null, true],
      ['ios', '["macos","arm64"]', false],
    ]);
    // only the built-in job goes to the container queue
    expect(sends).toEqual([rows[1]!.id]);
  });
});

describe('self-hosted runner protocol', () => {
  it('a Linux runner registers once, takes a linux job, streams logs live and passes', async () => {
    const grant = await token();
    const body = { token: grant, name: 'linux-1', labels: ['linux', 'x64'] };
    const registered = await runner('', '/register', 'POST', body);
    expect(registered.status).toBe(201);
    const { credential } = (await registered.json()) as { credential: string };
    expect(credential).toMatch(/^yagrun_/);
    // one-time: the same token cannot register a second runner
    const again = await runner('', '/register', 'POST', body);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_registration_token',
    );

    const pipeline = await startPipeline();
    expect((await runner('yagrun_nope', '/jobs/claim?wait=0')).status).toBe(401);
    const job = (await claim(credential))!;
    expect(job).toMatchObject({
      repo: 'yuma/app',
      job: 'build',
      steps: ['echo hello', 'make test'],
      clone: { url: 'https://x/yuma/app.git' },
    });
    expect(job.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(job.mask).toContain(job.clone.token);
    // the ios job needs macos and arm64; the cloud job is not self-hosted
    expect(await claim(credential)).toBeNull();

    // the clone token reads this repo over Git smart HTTP, and nothing else
    expect((await git(job.clone.token)).status).toBe(200);
    expect((await git(job.clone.token, 'git-receive-pack')).status).toBe(403);

    expect(
      (await runner(credential, `/jobs/${job.id}/steps/0`, 'POST', { state: 'running' }))
        .status,
    ).toBe(200);
    expect(
      await (
        await runner(credential, `/jobs/${job.id}/logs?step=0`, 'POST', 'hello\n')
      ).json(),
    ).toEqual({ cancel: false });
    // live: readers see the log while the job runs
    const live = await call(`/api/v1/repos/yuma/app/ci/runs/${job.id}/log`);
    expect(await live.text()).toBe('hello\n');
    expect(await (await runner(credential, `/jobs/${job.id}/heartbeat`)).json()).toEqual({
      cancel: false,
    });
    await runner(credential, `/jobs/${job.id}/steps/0`, 'POST', {
      state: 'passed',
      exit_code: 0,
    });
    await runner(credential, `/jobs/${job.id}/logs?step=1`, 'POST', 'ok\n');
    await runner(credential, `/jobs/${job.id}/steps/1`, 'POST', {
      state: 'passed',
      exit_code: 0,
    });
    const artifact = await runner(
      credential,
      `/jobs/${job.id}/artifacts/report.txt`,
      'PUT',
      'r',
    );
    expect(artifact.status).toBe(201);
    const stored = (await artifact.json()) as { artifact: { id: string } };
    const download = await call(
      `/api/v1/repos/yuma/app/ci/artifacts/${stored.artifact.id}`,
    );
    expect(await download.text()).toBe('r');
    const done = await runner(credential, `/jobs/${job.id}/complete`, 'POST', {
      result: 'passed',
    });
    expect(await done.json()).toEqual({ state: 'passed' });

    const row = await runRow(job.id);
    expect(row.runner_id).not.toBe('cloudflare');
    expect(row.state).toBe('passed');
    const steps = await q<{ step: number; state: string; exit_code: number }>(
      testEnv,
      'SELECT step, state, exit_code FROM ci_run_steps WHERE run_id = ? ORDER BY step',
      [job.id],
    );
    expect(steps).toEqual([
      { step: 0, state: 'passed', exit_code: 0 },
      { step: 1, state: 'passed', exit_code: 0 },
    ]);
    const runs = (await (await call('/api/v1/repos/yuma/app/ci/pipelines')).json()) as {
      runs: PipelineRun[];
    };
    const build = runs.runs
      .find((r) => r.id === pipeline.id)!
      .jobs.find((j) => j.key === 'build');
    expect(build?.state).toBe('passed');
    // the clone token ends with the run
    expect((await git(job.clone.token)).status).toBe(401);
    const actions = await q<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'runner.%' ORDER BY id",
    );
    expect(actions.map((a) => a.action)).toEqual([
      'runner.registration_token.create',
      'runner.register',
    ]);
  });

  it('routes jobs by labels and keeps repo runners to their repo', async () => {
    await startPipeline();
    const linux = await register(['linux']);
    const mac = await register(['macos', 'arm64', 'xcode-16']);
    expect((await claim(mac.credential))?.job).toBe('ios');
    expect((await claim(linux.credential))?.job).toBe('build');

    // a runner registered on another repo never sees this repo's jobs
    await call('/api/v1/repos', 'POST', { slug: 'yuma/other', org: 'yuma' });
    const other = await register(['linux'], { base: '/api/v1/repos/yuma/other' });
    await run(
      testEnv,
      "UPDATE ci_runs SET state = 'queued', runner_id = NULL WHERE job_key = 'build'",
    );
    expect(await claim(other.credential)).toBeNull();
  });

  it('an ephemeral runner takes exactly one job and deregisters', async () => {
    await startPipeline();
    const once = await register(['linux', 'macos', 'arm64'], { ephemeral: true });
    // two jobs match, but even racing claims hand it only one
    const raced = await Promise.all([claim(once.credential), claim(once.credential)]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const job = raced.find(Boolean)!;
    // busy: no second job while the first runs
    expect(await claim(once.credential)).toBeNull();
    await runner(once.credential, `/jobs/${job.id}/complete`, 'POST', {
      result: 'failed',
    });
    expect((await runRow(job.id)).state).toBe('failed');
    expect((await runner(once.credential, '/jobs/claim?wait=0')).status).toBe(401);
    const listed = (await (await call('/api/v1/orgs/yuma/runners')).json()) as {
      runners: unknown[];
    };
    expect(listed.runners).toEqual([]);
    // the other matching job is still waiting for a runner
    expect(
      (await q1<{ n: number }>(
        testEnv,
        "SELECT COUNT(*) AS n FROM ci_runs WHERE state = 'queued' AND runs_on IS NOT NULL",
      ))!.n,
    ).toBe(1);
  });

  it('a revoked runner gets no job, even mid long-poll, and its running job fails', async () => {
    const r = await register(['linux']);
    const polling = runner(r.credential, '/jobs/claim?wait=6');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await call(`/api/v1/orgs/yuma/runners/${r.id}`, 'DELETE')).status).toBe(200);
    // noticed at the next poll round (seconds), well inside 60 seconds
    expect((await polling).status).toBe(401);

    await startPipeline();
    const s = await register(['linux']);
    const job = (await claim(s.credential))!;
    expect((await call(`/api/v1/orgs/yuma/runners/${s.id}`, 'DELETE')).status).toBe(200);
    expect(await runRow(job.id)).toMatchObject({
      state: 'failed',
      error: 'The runner was removed',
    });
    expect((await runner(s.credential, `/jobs/${job.id}/heartbeat`)).status).toBe(401);
    expect((await git(job.clone.token)).status).toBe(401);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'runner.delete' ORDER BY id DESC",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ runner_id: s.id });
  });

  it('a disabled runner finishes its job but gets no new one', async () => {
    await startPipeline();
    const r = await register(['linux', 'macos', 'arm64']);
    const job = (await claim(r.credential))!;
    const patched = await call(`/api/v1/orgs/yuma/runners/${r.id}`, 'PATCH', {
      disabled: true,
    });
    expect(
      ((await patched.json()) as { runner: { disabled: boolean } }).runner.disabled,
    ).toBe(true);
    expect((await runner(r.credential, `/jobs/${job.id}/heartbeat`)).status).toBe(200);
    await runner(r.credential, `/jobs/${job.id}/complete`, 'POST', { result: 'passed' });
    const refused = await runner(r.credential, '/jobs/claim?wait=0');
    expect(refused.status).toBe(403);
  });

  it('never runs public repo or fork jobs on trusted-only runners', async () => {
    await startPipeline();
    const trusted = await register(['linux', 'macos', 'arm64'], { trusted_only: true });
    await run(testEnv, "UPDATE repos SET visibility = 'public' WHERE id = ?", [repoId]);
    expect(await claim(trusted.credential)).toBeNull();
    // private again, but the run came from a fork pull request
    await run(testEnv, "UPDATE repos SET visibility = 'private' WHERE id = ?", [repoId]);
    const rows = await q<{ id: string; context: string }>(
      testEnv,
      'SELECT id, context FROM ci_runs WHERE runs_on IS NOT NULL',
    );
    for (const row of rows)
      await run(testEnv, 'UPDATE ci_runs SET context = ? WHERE id = ?', [
        JSON.stringify({ ...JSON.parse(row.context), fork: true }),
        row.id,
      ]);
    expect(await claim(trusted.credential)).toBeNull();
    const open = await register(['linux']);
    expect((await claim(open.credential))?.job).toBe('build');
    // with an ordinary private trigger the trusted runner takes the other job
    for (const row of rows)
      await run(testEnv, 'UPDATE ci_runs SET context = ? WHERE id = ?', [
        row.context,
        row.id,
      ]);
    expect((await claim(trusted.credential))?.job).toBe('ios');
  });

  it('claims at most once and fails a job whose runner stops heartbeating', async () => {
    await startPipeline();
    const a = await register(['linux']);
    const b = await register(['linux']);
    const [x, y] = await Promise.all([claim(a.credential), claim(b.credential)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const job = (x ?? y)!;
    // a lost claim response is never handed to another runner; the lease ends it
    await run(testEnv, 'UPDATE ci_runs SET lease_expires_at = ? WHERE id = ?', [
      Date.now() - 1,
      job.id,
    ]);
    await sweepRunners(ci());
    expect(await runRow(job.id)).toMatchObject({
      state: 'failed',
      error: 'The runner stopped responding',
    });
    expect(await claim(a.credential)).toBeNull();
    expect(await claim(b.credential)).toBeNull();
  });

  it('fails self-hosted jobs nobody claims within an hour', async () => {
    await startPipeline();
    await run(testEnv, 'UPDATE ci_runs SET created_at = ? WHERE runs_on IS NOT NULL', [
      Date.now() - 61 * 60_000,
    ]);
    await sweepRunners(ci());
    const rows = await q<{ state: string; error: string }>(
      testEnv,
      'SELECT state, error FROM ci_runs WHERE runs_on IS NOT NULL',
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.state === 'failed' && /within an hour/.test(r.error)),
    ).toBe(true);
  });

  it('cancellation reaches the runner on its next heartbeat', async () => {
    const pipeline = await startPipeline();
    const r = await register(['linux']);
    const job = (await claim(r.credential))!;
    const cancelled = await call(
      `/api/v1/repos/yuma/app/ci/pipelines/runs/${pipeline.id}/cancel`,
      'POST',
    );
    expect(cancelled.status).toBe(200);
    expect(
      await (await runner(r.credential, `/jobs/${job.id}/heartbeat`)).json(),
    ).toEqual({
      cancel: true,
    });
    expect(
      await (
        await runner(r.credential, `/jobs/${job.id}/logs?step=0`, 'POST', 'late')
      ).json(),
    ).toEqual({ cancel: true });
    await runner(r.credential, `/jobs/${job.id}/complete`, 'POST', { result: 'passed' });
    expect((await runRow(job.id)).state).toBe('cancelled');
  });

  it('caps each step log and keeps later steps', async () => {
    await startPipeline();
    const r = await register(['linux']);
    const job = (await claim(r.credential))!;
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < MAX_STEP_LOG_BYTES / chunk.length + 1; i++)
      await runner(r.credential, `/jobs/${job.id}/logs?step=0`, 'POST', chunk);
    await runner(r.credential, `/jobs/${job.id}/logs?step=1`, 'POST', 'step two\n');
    const tooBig = await runner(
      r.credential,
      `/jobs/${job.id}/logs?step=1`,
      'POST',
      `${chunk}x`,
    );
    expect(tooBig.status).toBe(413);
    const log = await (await testEnv.OBJECTS.get(
      `ci/logs/${repoId}/${job.id}.txt`,
    ))!.text();
    expect(log.match(/Log limit reached/g)).toHaveLength(1);
    expect(log.endsWith('step two\n')).toBe(true);
    expect(log.length).toBeLessThan(MAX_STEP_LOG_BYTES + 200);
  });
});

describe('runner administration', () => {
  it('needs an org owner or admin with a browser session', async () => {
    const asMember = await call(
      '/api/v1/orgs/yuma/runners/registration-token',
      'POST',
      {},
      member.headers,
    );
    expect(asMember.status).toBe(403);
    const api = await createApiToken(testEnv, owner.userId, { label: 'cli' });
    const asToken = await call('/api/v1/orgs/yuma/runners', 'GET', undefined, {
      authorization: `Bearer ${api.raw}`,
    });
    expect(asToken.status).toBe(401);
    // repo runners need repo admin; a non-member sees no repo at all
    const stranger = await loginAs(testEnv, 903, 'stan');
    const hidden = await call(
      '/api/v1/repos/yuma/app/runners',
      'GET',
      undefined,
      stranger.headers,
    );
    expect(hidden.status).toBe(404);
    const r = await register(['linux'], { base: '/api/v1/repos/yuma/app' });
    const listed = (await (await call('/api/v1/repos/yuma/app/runners')).json()) as {
      runners: { id: string; labels: string[]; credential_hash?: string }[];
    };
    expect(listed.runners).toEqual([
      expect.objectContaining({ id: r.id, labels: ['linux'], trusted_only: false }),
    ]);
    expect(listed.runners[0]!.credential_hash).toBeUndefined();
    // an org route cannot touch a repo runner
    expect((await call(`/api/v1/orgs/yuma/runners/${r.id}`, 'DELETE')).status).toBe(404);
  });

  it('refuses expired registration tokens', async () => {
    const grant = await token();
    await run(testEnv, 'UPDATE runner_registration_tokens SET expires_at = ?', [
      Date.now() - 1,
    ]);
    const res = await runner('', '/register', 'POST', {
      token: grant,
      name: 'late',
      labels: ['linux'],
    });
    expect(res.status).toBe(401);
    expect(
      (
        await runner('', '/register', 'POST', {
          token: grant,
          name: 'x',
          labels: ['cloudflare'],
        })
      ).status,
    ).toBe(400);
  });
});

describe('agent guardrails on runner jobs (#62)', () => {
  /** The queued linux job (or built-in `cloud` job), marked as started by an agent identity. */
  async function agentJob(
    environment: string | null = null,
    key = 'build',
  ): Promise<string> {
    await startPipeline();
    const build = (await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM ci_runs WHERE job_key = ? AND state = 'queued'",
      [key],
    ))!.id;
    await run(
      testEnv,
      `UPDATE ci_runs SET context = json_set(context, '$.agent_id', 'agt_worker'),
         config = json_set(config, '$.environment', ?) WHERE id = ?`,
      [environment, build],
    );
    return build;
  }

  it('the kill switch cancels running and queued agent jobs, and claims skip them', async () => {
    const { credential } = await register(['linux']);
    const id = await agentJob();
    await run(
      testEnv,
      `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                             events, created_by, created_at, updated_at)
       VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, '["ci_run"]', ?, 0, 0)`,
      [repoId, owner.userId],
    );
    const job = (await claim(credential))!;
    expect(job.id).toBe(id);
    // webhooks (#75) follow the runner job's status
    expect(events).toEqual(['ci_run:in_progress']);
    const paused = await call('/api/v1/orgs/yuma/agents/pause', 'POST', {
      reason: 'stop',
    });
    expect(paused.status).toBe(200);
    expect(await runRow(id)).toMatchObject({
      state: 'cancelled',
      error: 'Agents were paused',
    });
    expect(events).toEqual(['ci_run:in_progress', 'ci_run:completed']);
    expect(await (await runner(credential, `/jobs/${id}/heartbeat`)).json()).toEqual({
      cancel: true,
    });

    // while paused, a queued agent job is ended at claim time instead of run
    const next = await agentJob();
    expect(await claim(credential)).toBeNull();
    expect((await runRow(next)).state).toBe('cancelled');
  });

  async function holdDeploys(): Promise<void> {
    const org = (await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM orgs WHERE slug = 'yuma'",
    ))!;
    await run(
      testEnv,
      'INSERT INTO agent_policies (org_id, version, document, created_by, created_at) VALUES (?, 1, ?, ?, ?)',
      [
        org.id,
        JSON.stringify({
          version: 1,
          rules: [
            { id: 'agent-deploys', actions: ['deploy'], effect: 'require_approval' },
          ],
        }),
        owner.userId,
        Date.now(),
      ],
    );
  }

  it('built-in pool jobs get no credentials while a deploy is held or agents are paused', async () => {
    await holdDeploys();
    const id = await agentJob('prod', 'cloud');
    const job = await runRow(id);
    const policy = parsePolicy(JSON.parse(job.config));
    await expect(
      prepareJob(ci(), job, policy, Date.now() + 60_000),
    ).rejects.toMatchObject({ code: 'approval_required' });
    const listed = await call('/api/v1/repos/yuma/app/approvals');
    const { approvals } = (await listed.json()) as { approvals: { id: string }[] };
    expect(
      (
        await call(`/api/v1/repos/yuma/app/approvals/${approvals[0]!.id}`, 'POST', {
          decision: 'approve',
        })
      ).status,
    ).toBe(200);
    await prepareJob(ci(), job, policy, Date.now() + 60_000);

    // the kill switch cancels queued built-in agent jobs and refuses credentials
    expect((await call('/api/v1/orgs/yuma/agents/pause', 'POST', {})).status).toBe(200);
    expect(await runRow(id)).toMatchObject({
      state: 'cancelled',
      error: 'Agents were paused',
    });
    await expect(
      prepareJob(ci(), job, policy, Date.now() + 60_000),
    ).rejects.toMatchObject({ code: 'agents_paused' });
  });

  it('a deploy by an agent waits for the policy, then runs once approved', async () => {
    await holdDeploys();
    const { credential } = await register(['linux']);
    const id = await agentJob('prod');
    expect(await claim(credential)).toBeNull();
    expect((await runRow(id)).state).toBe('queued');
    const listed = await call('/api/v1/repos/yuma/app/approvals');
    const { approvals } = (await listed.json()) as {
      approvals: { id: string; action: string; principal: string }[];
    };
    expect(approvals).toMatchObject([
      { action: 'deploy', principal: 'agent:agt_worker' },
    ]);
    const decided = await call(
      `/api/v1/repos/yuma/app/approvals/${approvals[0]!.id}`,
      'POST',
      {
        decision: 'approve',
      },
    );
    expect(decided.status).toBe(200);
    expect((await claim(credential))?.id).toBe(id);
  });
});
