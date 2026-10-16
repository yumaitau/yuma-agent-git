import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { admitRun, type Admission } from '../src/ci/runs';
import { advancePipelines } from '../src/ci/planner';
import { microsPerSecond, parsePolicy, reservation } from '../src/ci/config';
import { parseSpec, jobEnv } from '../src/ci/spec';
import type { PipelineRun } from '../shared/collaboration';

/**
 * CI capacity (issue #52): one admission ledger per org pool instead of the
 * global two slots, instance types priced per type, plan-time limits, budget
 * alerts, sharding and fair scheduling across a pool's repos.
 */
const testEnv = env as unknown as TestEnv;
const SPEC = '.yuma/pipelines/ci.yml';
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let member: Login;
let ciAdmins = '';
const repos: Record<string, string> = {};

function ci(): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_ADMIN_USER_IDS') return ciAdmins;
      if (key === 'CI_QUEUE') return { send: async () => {} };
      return Reflect.get(target, key, receiver);
    },
  });
}

function api(
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

const LIMITS = {
  max_concurrent: 3,
  monthly_budget_usd: 50,
  max_timeout_s: 3600,
  instance_types: ['standard-2'],
  cache_quota_bytes: 1024,
};

async function setLimits(org: string, limits: Record<string, unknown>): Promise<void> {
  ciAdmins = owner.userId;
  const res = await api(`/api/v1/orgs/${org}/ci/limits`, 'PUT', limits);
  ciAdmins = '';
  expect(res.status).toBe(200);
}

async function pipeline(slug: string, text: string): Promise<PipelineRun> {
  const cs = await commitChanges(testEnv, repos[slug]!, {
    first_parent: null,
    message: 'pipeline',
    author: { name: 'Ada', email: 'ada@example.com' },
    changes: [{ path: SPEC, op: 'add', content_b64: btoa(text) }],
  });
  await setRef(testEnv, repos[slug]!, 'main', cs.changeset.id);
  const res = await api(`/api/v1/repos/${slug}/ci/pipelines/runs`, 'POST', {
    pipeline: SPEC,
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { run: PipelineRun }).run;
}

function admission(slug: string, reserved = 1000): Admission {
  return {
    repoId: repos[slug]!,
    head: 'cs',
    settingsVersion: 0,
    config: '{}',
    actor: owner.userId,
    publish: false,
    reserved,
  };
}
const always = { sql: '1 = 1', binds: [] };

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  ciAdmins = '';
  owner = await loginAs(testEnv, 971, 'olive');
  member = await loginAs(testEnv, 972, 'max');
  for (const org of ['yuma', 'other']) {
    expect((await api('/api/v1/orgs', 'POST', { slug: org })).status).toBe(201);
  }
  expect(
    (await api('/api/v1/orgs/yuma/members', 'PUT', { user_login: 'max', role: 'member' }))
      .status,
  ).toBe(200);
  for (const slug of ['yuma/app', 'yuma/web', 'other/app']) {
    const [org] = slug.split('/');
    expect((await api('/api/v1/repos', 'POST', { slug, org })).status).toBe(201);
    repos[slug] = (await q1<{ id: string }>(
      testEnv,
      'SELECT id FROM repos WHERE slug = ?',
      [slug],
    ))!.id;
  }
});

describe('org CI limits API', () => {
  it('CI admins set an org pool; org admins read it; everyone else is refused', async () => {
    expect((await api('/api/v1/orgs/yuma/ci/limits', 'GET', undefined, {})).status).toBe(
      401,
    );
    expect(
      (await api('/api/v1/orgs/yuma/ci/limits', 'GET', undefined, member.headers)).status,
    ).toBe(403);
    const shared = (await (await api('/api/v1/orgs/yuma/ci/limits')).json()) as {
      limits: unknown;
    };
    expect(shared.limits).toBeNull();
    // an org owner is not a CI admin: the budget is the deployment's
    const denied = await api('/api/v1/orgs/yuma/ci/limits', 'PUT', LIMITS);
    expect(denied.status).toBe(403);
    expect((await api('/api/v1/orgs/yuma/ci/limits', 'PUT', LIMITS, {})).status).toBe(
      401,
    );
    ciAdmins = owner.userId;
    expect(
      (
        await api('/api/v1/orgs/yuma/ci/limits', 'PUT', {
          ...LIMITS,
          max_timeout_s: 99_999,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('/api/v1/orgs/yuma/ci/limits', 'PUT', {
          ...LIMITS,
          instance_types: ['gpu'],
        })
      ).status,
    ).toBe(400);
    expect((await api('/api/v1/orgs/nope/ci/limits', 'PUT', LIMITS)).status).toBe(404);
    expect((await api('/api/v1/orgs/yuma/ci/limits', 'PUT', LIMITS)).status).toBe(200);
    ciAdmins = '';
    const view = (await (await api('/api/v1/orgs/yuma/ci/limits')).json()) as {
      limits: typeof LIMITS;
      reserved_usd: number;
      active_jobs: number;
    };
    expect(view).toMatchObject({ limits: LIMITS, reserved_usd: 0, active_jobs: 0 });
    const audit = await q<{ action: string; org_id: string }>(
      testEnv,
      "SELECT action, org_id FROM audit_events WHERE action = 'ci.limits.update'",
    );
    expect(audit).toEqual([{ action: 'ci.limits.update', org_id: 'yuma' }]);
    ciAdmins = owner.userId;
    expect((await api('/api/v1/orgs/yuma/ci/limits', 'DELETE')).status).toBe(200);
    ciAdmins = '';
    expect(
      ((await (await api('/api/v1/orgs/yuma/ci/limits')).json()) as { limits: unknown })
        .limits,
    ).toBeNull();
  });
});

describe('admission ledger per pool', () => {
  it('replaces the global two slots with per-org slots; pools never block each other', async () => {
    await setLimits('yuma', LIMITS);
    // three slots for the yuma pool, across its repos
    expect(await admitRun(testEnv, admission('yuma/app'), always)).not.toBeNull();
    expect(await admitRun(testEnv, admission('yuma/web'), always)).not.toBeNull();
    expect(await admitRun(testEnv, admission('yuma/app'), always)).not.toBeNull();
    expect(await admitRun(testEnv, admission('yuma/web'), always)).toBeNull();
    // the shared pool keeps its two slots, untouched by yuma's full pool
    expect(await admitRun(testEnv, admission('other/app'), always)).not.toBeNull();
    expect(await admitRun(testEnv, admission('other/app'), always)).not.toBeNull();
    expect(await admitRun(testEnv, admission('other/app'), always)).toBeNull();
    const pools = await q<{ pool: string; n: number }>(
      testEnv,
      'SELECT pool, COUNT(*) AS n FROM ci_runs GROUP BY pool ORDER BY pool',
    );
    const yumaId = (await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM orgs WHERE slug = 'yuma'",
    ))!.id;
    expect(pools).toEqual(
      [
        { pool: 'shared', n: 2 },
        { pool: yumaId, n: 3 },
      ].sort((a, b) => a.pool.localeCompare(b.pool)),
    );
    // a finished run frees its slot but never refunds its reservation
    await run(testEnv, "UPDATE ci_runs SET state = 'passed' WHERE pool = ?", [yumaId]);
    expect(await admitRun(testEnv, admission('yuma/app'), always)).not.toBeNull();
    const view = (await (await api('/api/v1/orgs/yuma/ci/limits')).json()) as {
      reserved_usd: number;
      active_jobs: number;
    };
    expect(view).toMatchObject({ reserved_usd: 0.004, active_jobs: 1 });
  });

  it('holds each pool to its monthly budget and alerts at 50%, 80% and 100% once', async () => {
    await setLimits('yuma', { ...LIMITS, max_concurrent: 10, monthly_budget_usd: 0.01 });
    const admitted: (string | null)[] = [];
    for (let i = 0; i < 5; i++)
      admitted.push(await admitRun(testEnv, admission('yuma/app', 2500), always));
    expect(admitted.map((id) => id !== null)).toEqual([true, true, true, true, false]);
    const alerts = await q<{ threshold: number }>(
      testEnv,
      'SELECT threshold FROM ci_budget_alerts ORDER BY threshold',
    );
    expect(alerts.map((a) => a.threshold)).toEqual([50, 80, 100]);
    const events = await q<{ org_id: string; target: string }>(
      testEnv,
      "SELECT org_id, target FROM audit_events WHERE action = 'ci.budget.alert' ORDER BY id",
    );
    expect(events.map((e) => [e.org_id, JSON.parse(e.target).threshold])).toEqual([
      ['yuma', 50],
      ['yuma', 80],
      ['yuma', 100],
    ]);
    // the shared pool's budget is separate
    expect(await admitRun(testEnv, admission('other/app', 2500), always)).not.toBeNull();
  });
});

describe('instance types, limits and sharding', () => {
  it('prices each Cloudflare instance type per second in the reservation', () => {
    expect(microsPerSecond('standard-2')).toBe(36);
    expect(microsPerSecond('standard-4')).toBe(112);
    const policy = parsePolicy({ commands: ['npm test'] });
    expect(reservation(policy)).toBe((300 + 30) * 36);
    expect(reservation(policy, 'standard-4')).toBe((300 + 30) * 112);
  });

  it('rejects jobs over the pool limits at plan time and admits the allowed instance type', async () => {
    const over = await pipeline(
      'yuma/app',
      `on: [manual]
jobs:
  big: { runs-on: [cloudflare, standard-4], steps: [{ run: npm test }] }
  slow: { timeout_seconds: 1200, steps: [{ run: npm test }] }
`,
    );
    expect(over.errors?.map((e) => e.message)).toEqual([
      expect.stringContaining('jobs.big: Instance type standard-4 is not allowed'),
      expect.stringContaining('jobs.slow: timeout_seconds 1200'),
    ]);
    expect(over.jobs).toEqual([]);

    // self-hosted jobs may run up to the org's max_timeout_s; the built-in pool stays at 600
    await setLimits('yuma', { ...LIMITS, instance_types: ['standard-2', 'standard-4'] });
    const ok = await pipeline(
      'yuma/app',
      `on: [manual]
jobs:
  big: { runs-on: [cloudflare, standard-4], steps: [{ run: npm test }] }
  long: { runs-on: linux, timeout_seconds: 3600, steps: [{ run: npm test }] }
`,
    );
    expect(ok.errors).toBeNull();
    const rows = await q<{
      job_key: string;
      instance_type: string;
      reserved_micros: number;
    }>(
      testEnv,
      'SELECT job_key, instance_type, reserved_micros FROM ci_runs WHERE pipeline_run_id = ? ORDER BY job_key',
      [ok.id],
    );
    expect(rows).toEqual([
      { job_key: 'big', instance_type: 'standard-4', reserved_micros: (300 + 30) * 112 },
      { job_key: 'long', instance_type: null, reserved_micros: 0 },
    ]);
    const tooLong = await pipeline(
      'yuma/app',
      `on: [manual]
jobs:
  long: { runs-on: linux, timeout_seconds: 7200, steps: [{ run: npm test }] }
`,
    );
    expect(tooLong.errors?.[0]?.message).toContain('organisation limit of 3600 seconds');
  });

  it('splits matrix.shard jobs and gives each its shard variables', async () => {
    const spec = parseSpec(
      SPEC,
      `on: [manual]
jobs:
  test:
    matrix: { shard: 3 }
    steps: [{ run: 'npx vitest run --shard=$YAG_SHARD_INDEX/$YAG_SHARD_TOTAL' }]
`,
    );
    expect(spec.errors).toBeUndefined();
    expect(spec.pipeline!.jobs.map((j) => [j.key, j.env])).toEqual([
      ['test (1/3)', { YAG_SHARD_INDEX: '1', YAG_SHARD_TOTAL: '3' }],
      ['test (2/3)', { YAG_SHARD_INDEX: '2', YAG_SHARD_TOTAL: '3' }],
      ['test (3/3)', { YAG_SHARD_INDEX: '3', YAG_SHARD_TOTAL: '3' }],
    ]);
    const bad = parseSpec(
      SPEC,
      `on: [manual]
jobs:
  test: { matrix: { node: 3 }, steps: [{ run: x }] }
`,
    );
    expect(bad.errors?.[0]?.message).toContain('only shard takes a number');

    const started = await pipeline(
      'yuma/app',
      `on: [manual]
jobs:
  test: { matrix: { shard: 2 }, runs-on: linux, steps: [{ run: x }] }
`,
    );
    const configs = await q<{ config: string }>(
      testEnv,
      'SELECT config FROM ci_runs WHERE pipeline_run_id = ? ORDER BY job_key',
      [started.id],
    );
    expect(configs.map((c) => jobEnv(c.config))).toEqual([
      { YAG_SHARD_INDEX: '1', YAG_SHARD_TOTAL: '2' },
      { YAG_SHARD_INDEX: '2', YAG_SHARD_TOTAL: '2' },
    ]);
  });
});

describe('fair scheduling', () => {
  it('gives a freed slot to the pool repo with the fewest active jobs, not the oldest run', async () => {
    await setLimits('yuma', { ...LIMITS, max_concurrent: 2 });
    const busy = await pipeline(
      'yuma/app',
      `on: [manual]
jobs:
  a: { steps: [{ run: x }] }
  b: { steps: [{ run: x }] }
  c: { steps: [{ run: x }] }
`,
    );
    expect(busy.jobs.map((j) => j.state)).toEqual(['queued', 'queued', 'waiting']);
    const quiet = await pipeline(
      'yuma/web',
      `on: [manual]
jobs:
  one: { steps: [{ run: x }] }
`,
    );
    expect(quiet.jobs.map((j) => j.state)).toEqual(['waiting']);
    // one of yuma/app's jobs ends: yuma/web has none running, so it goes first
    await run(
      testEnv,
      "UPDATE ci_runs SET state = 'passed', finished_at = ? WHERE id = ?",
      [Date.now(), busy.jobs[0]!.run_id],
    );
    await advancePipelines(testEnv);
    const web = await q<{ n: number }>(
      testEnv,
      'SELECT COUNT(*) AS n FROM ci_runs WHERE repo_id = ?',
      [repos['yuma/web']],
    );
    expect(web[0]!.n).toBe(1);
    const app = await q<{ n: number }>(
      testEnv,
      'SELECT COUNT(*) AS n FROM ci_runs WHERE repo_id = ?',
      [repos['yuma/app']],
    );
    expect(app[0]!.n).toBe(2);
  });

  it('lets each pool take turns, so runs blocked on one pool cannot stall another', async () => {
    // yuma's pool has no free slot: 21 runs in yuma/web wait on it
    await setLimits('yuma', { ...LIMITS, max_concurrent: 0 });
    for (let i = 0; i < 21; i++)
      await pipeline(
        'yuma/web',
        `on: [manual]\njobs:\n  j${i}: { steps: [{ run: x }] }\n`,
      );
    // the shared pool is idle; its second job only waits on the first
    const other = await pipeline(
      'other/app',
      `on: [manual]
jobs:
  a: { steps: [{ run: x }] }
  b: { needs: [a], steps: [{ run: x }] }
`,
    );
    expect(other.jobs.map((j) => j.state)).toEqual(['queued', 'waiting']);
    await run(
      testEnv,
      "UPDATE ci_runs SET state = 'passed', finished_at = ? WHERE id = ?",
      [Date.now(), other.jobs[0]!.run_id],
    );
    await advancePipelines(testEnv);
    expect(
      await q1(
        testEnv,
        "SELECT state FROM ci_runs WHERE pipeline_run_id = ? AND job_key = 'b'",
        [other.id],
      ),
    ).toEqual({ state: 'queued' });
  });
});
