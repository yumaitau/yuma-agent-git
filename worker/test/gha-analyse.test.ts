import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { loadPipelines } from '../src/ci/spec';
import { sweepPipelines } from '../src/ci/triggers';
import { CiRunnerDO } from '../src/ci/runner';
import type { CiRun, PipelineRun } from '../shared/collaboration';
import type { WorkflowReport } from '../src/ci/gha/translate';
import lint from './fixtures/gha/lint.yml?raw';
import nightly from './fixtures/gha/nightly.yml?raw';
import security from './fixtures/gha/security.yml?raw';

/**
 * GitHub Actions compatibility (#49): the report for a repository's
 * `.github/workflows`, the per-repo opt-in, and opted-in workflows running as
 * pipelines with GitHub-style variables.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const MANUAL = `name: Release notes
on: workflow_dispatch
jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "\${{ github.repository }}@\${{ github.ref_name }}"
`;
type Actor = { headers: Record<string, string> };
interface Report {
  enabled: boolean;
  active: boolean;
  head_cs: string | null;
  summary: Record<string, number>;
  workflows: WorkflowReport[];
}
let owner: Actor & { userId: string };
let writer: Actor;
let stranger: Actor;
let repoId = '';
let sends: string[] = [];

function ci(): Env {
  return new Proxy(dbEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_QUEUE')
        return { send: async (body: { run_id: string }) => void sends.push(body.run_id) };
      if (key === 'CI_RUNNER')
        return {
          idFromName: (id: string) => id,
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

async function call(
  actor: Actor | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  return makeApp(ci())(
    new Request(`https://forge.example${url}`, {
      method,
      headers: { ...(actor?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const repo = (tail: string): string => `/api/v1/repos/team/project${tail}`;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function commit(files: Record<string, string>): Promise<string> {
  const head = await q1<{ head: string }>(
    dbEnv,
    "SELECT head FROM refs WHERE repo_id = ? AND name = 'main'",
    [repoId],
  );
  const cs = (
    await commitChanges(dbEnv, repoId, {
      first_parent: head?.head ?? null,
      message: 'change',
      author,
      changes: Object.entries(files).map(([path, text]) => ({
        path,
        op: 'add' as const,
        content_b64: btoa(text),
      })),
    })
  ).changeset.id;
  await setRef(dbEnv, repoId, 'main', cs);
  return cs;
}

/** A runner whose container records each command and its environment. */
function mockRunner(
  seen: { argv: string[]; env?: Record<string, string> }[],
): CiRunnerDO {
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
      seen.push({ argv: args, env: options.env as Record<string, string> | undefined });
      if (options.stdin && typeof options.stdin !== 'string')
        await new Response(options.stdin).arrayBuffer();
      return {
        stdout: options.stdout === 'ignore' ? null : new Blob(['ok\n']).stream(),
        exitCode: Promise.resolve(0),
      };
    },
  };
  return Object.assign(Object.create(CiRunnerDO.prototype), {
    env: ci(),
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

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sends = [];
  owner = await loginAs(testEnv, 901, 'owner');
  writer = await loginAs(testEnv, 902, 'writer');
  stranger = await loginAs(testEnv, 903, 'stranger');
  repoId = (await createRepo(dbEnv, { slug: 'team/project', createdBy: owner.userId }))
    .id;
  await run(
    dbEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [
      repoId,
      (await q1<{ id: string }>(dbEnv, "SELECT id FROM users WHERE login = 'writer'"))!
        .id,
    ],
  );
});

describe('compatibility report', () => {
  it('reports each workflow at the default branch or a given revision', async () => {
    const empty = await json<Report>(await call(owner, 'GET', repo('/ci/actions')));
    expect(empty).toMatchObject({
      enabled: false,
      active: false,
      head_cs: null,
      workflows: [],
    });
    const cs = await commit({
      '.github/workflows/security.yml': security,
      '.github/workflows/lint.yml': lint,
      '.github/workflows/README.md': 'not a workflow',
      '.github/workflows/broken.yaml': 'on: [push\n',
    });
    // members who can read the repository can read the report
    const report = await json<Report>(await call(writer, 'GET', repo('/ci/actions')));
    expect(report).toMatchObject({
      enabled: false,
      active: false,
      head_cs: cs,
      summary: { supported: 1, translated: 0, unsupported: 2 },
    });
    expect(report.workflows.map((w) => [w.path, w.status])).toEqual([
      ['.github/workflows/broken.yaml', 'unsupported'],
      ['.github/workflows/lint.yml', 'supported'],
      ['.github/workflows/security.yml', 'unsupported'],
    ]);
    expect(report.workflows[1]!.pipeline).toContain('npm run lint');
    expect(report.workflows[2]!.findings).toContainEqual({
      status: 'unsupported',
      line: 9,
      message:
        'No built-in equivalent for aquasecurity/trivy-action; replace the step with run steps',
    });
    const at = await json<Report>(
      await call(owner, 'GET', repo(`/ci/actions?head=${cs}`)),
    );
    expect(at.workflows).toEqual(report.workflows);
  });

  it('answers 401 anonymously and 404 to people who cannot read the repository', async () => {
    await commit({ '.github/workflows/lint.yml': lint });
    expect((await call(null, 'GET', repo('/ci/actions'))).status).toBe(401);
    expect((await call(stranger, 'GET', repo('/ci/actions'))).status).toBe(404);
    expect(
      (await call(stranger, 'PUT', repo('/ci/actions'), { enabled: true })).status,
    ).toBe(404);
    expect((await call(null, 'POST', '/api/v1/ci/actions/check', {})).status).toBe(401);
  });

  it('checks workflow files sent by the caller without storing anything', async () => {
    const res = await call(stranger, 'POST', '/api/v1/ci/actions/check', {
      files: [
        { path: '.github/workflows/lint.yml', content: lint },
        { path: '.github/workflows/nightly.yml', content: nightly },
      ],
    });
    const body = await json<{
      summary: Record<string, number>;
      workflows: WorkflowReport[];
    }>(res);
    expect(body.summary).toEqual({ supported: 1, translated: 1, unsupported: 0 });
    expect(body.workflows.map((w) => w.status)).toEqual(['supported', 'translated']);
    const bad = await call(owner, 'POST', '/api/v1/ci/actions/check', { files: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    );
  });
});

describe('running translated workflows', () => {
  it('needs a repository admin to opt in, audits it and is off by default', async () => {
    await commit({ '.github/workflows/lint.yml': lint });
    const head = (await q1<{ head: string }>(dbEnv, 'SELECT head FROM refs'))!.head;
    expect(await loadPipelines(dbEnv, repoId, head)).toEqual([]);
    const denied = await call(writer, 'PUT', repo('/ci/actions'), { enabled: true });
    expect(denied.status).toBe(403);
    expect(
      (await call(owner, 'PUT', repo('/ci/actions'), { enabled: 'yes' })).status,
    ).toBe(400);
    expect(
      await json(await call(owner, 'PUT', repo('/ci/actions'), { enabled: true })),
    ).toEqual({ enabled: true });
    const audit = await q<{ actor_id: string; target: string }>(
      dbEnv,
      "SELECT actor_id, target FROM audit_events WHERE action = 'ci.actions.update'",
    );
    expect(audit.map((a) => [a.actor_id, JSON.parse(a.target)])).toEqual([
      [owner.userId, { enabled: true }],
    ]);
    expect(
      await call(owner, 'GET', repo('/ci/actions')).then((r) => r.json()),
    ).toMatchObject({
      enabled: true,
      active: true,
    });
    expect((await loadPipelines(dbEnv, repoId, head)).map((f) => f.path)).toEqual([
      '.github/workflows/lint.yml',
    ]);
    // a .yuma pipeline takes over: workflows stop running
    const withPipeline = await commit({
      '.yuma/pipelines/ci.yml': 'on: push\njobs:\n  a:\n    steps: [{ run: make }]\n',
    });
    expect((await loadPipelines(dbEnv, repoId, withPipeline)).map((f) => f.path)).toEqual(
      ['.yuma/pipelines/ci.yml'],
    );
    expect(
      await call(owner, 'GET', repo('/ci/actions')).then((r) => r.json()),
    ).toMatchObject({
      enabled: true,
      active: false,
    });
    await json(await call(owner, 'PUT', repo('/ci/actions'), { enabled: false }));
    expect((await loadPipelines(dbEnv, repoId, head)).map((f) => f.path)).toEqual([]);
  });

  it('runs a workflow_dispatch workflow with GitHub variables from forge data', async () => {
    await commit({
      '.github/workflows/notes.yml': MANUAL,
      '.github/workflows/security.yml': security,
    });
    const dispatch = (pipeline: string): Promise<Response> =>
      call(owner, 'POST', repo('/ci/pipelines/runs'), { pipeline });
    // not opted in: workflows are not pipelines
    expect((await dispatch('.github/workflows/notes.yml')).status).toBe(404);
    await json(await call(owner, 'PUT', repo('/ci/actions'), { enabled: true }));
    // an unsupported workflow is a pipeline with errors, as a broken spec is
    const broken = await dispatch('.github/workflows/security.yml');
    expect(broken.status).toBe(422);
    expect(
      ((await broken.json()) as { error: { errors: { line: number }[] } }).error
        .errors[0]!.line,
    ).toBe(9);
    const started = await json<{ run: PipelineRun }>(
      await dispatch('.github/workflows/notes.yml'),
      202,
    );
    expect(started.run).toMatchObject({
      name: 'Release notes',
      pipeline: '.github/workflows/notes.yml',
    });
    expect(sends).toHaveLength(1);
    const seen: { argv: string[]; env?: Record<string, string> }[] = [];
    await mockRunner(seen).fetch(
      new Request('https://runner/run', {
        method: 'POST',
        body: JSON.stringify({ run_id: sends[0] }),
      }),
    );
    const step = seen.find((s) => s.argv[0] === '/bin/bash')!;
    expect(step.argv.at(-1)).toBe(
      'set +u +o pipefail\necho "${GITHUB_REPOSITORY}@${GITHUB_REF_NAME}"',
    );
    expect(step.env).toMatchObject({
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'Release notes',
      GITHUB_REPOSITORY: 'team/project',
      GITHUB_REPOSITORY_OWNER: 'team',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_ACTOR: 'owner',
      GITHUB_JOB: 'notes',
      GITHUB_RUN_ID: started.run.id,
      GITHUB_SERVER_URL: 'https://forge.example',
    });
    const job = await q1<CiRun>(dbEnv, 'SELECT * FROM ci_runs WHERE id = ?', [sends[0]]);
    expect(job!.state).toBe('passed');
  });

  it('gives jobs of .yuma pipelines no GitHub variables', async () => {
    await commit({
      '.yuma/pipelines/ci.yml': 'on: manual\njobs:\n  a:\n    steps: [{ run: make }]\n',
    });
    await json(await call(owner, 'PUT', repo('/ci/actions'), { enabled: true }));
    await json(
      await call(owner, 'POST', repo('/ci/pipelines/runs'), {
        pipeline: '.yuma/pipelines/ci.yml',
      }),
      202,
    );
    const seen: { argv: string[]; env?: Record<string, string> }[] = [];
    await mockRunner(seen).fetch(
      new Request('https://runner/run', {
        method: 'POST',
        body: JSON.stringify({ run_id: sends[0] }),
      }),
    );
    const step = seen.find((s) => s.argv[0] === '/bin/bash')!;
    expect(Object.keys(step.env ?? {}).filter((k) => k.startsWith('GITHUB_'))).toEqual(
      [],
    );
  });

  it('schedules workflow crons once the repository opts in', async () => {
    await commit({ '.github/workflows/nightly.yml': nightly });
    await sweepPipelines(ci());
    expect(await q(dbEnv, 'SELECT * FROM ci_schedules')).toEqual([]);
    await json(await call(owner, 'PUT', repo('/ci/actions'), { enabled: true }));
    await sweepPipelines(ci());
    expect(
      await q<{ pipeline: string; cron: string; timezone: string }>(
        dbEnv,
        'SELECT pipeline, cron, timezone FROM ci_schedules',
      ),
    ).toEqual([
      { pipeline: '.github/workflows/nightly.yml', cron: '0 17 * * *', timezone: 'UTC' },
    ]);
  });

  it('never lets an agent opt in: agents are not repository admins (#57)', async () => {
    const delegate = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    const created = await json<{ id: string }>(
      await call(owner, 'POST', '/api/v1/agents', {
        name: 'Worker',
        kind: 'codex',
        max_risk: 'high',
        max_scopes: ['contents:read', 'contents:write'],
      }),
      201,
    );
    const token = await makeApp(ci())(
      new Request('https://forge.example/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          subject_token: delegate,
          agent_id: created.id,
          resource: 'team/project',
          scope: 'contents:read contents:write',
        }),
      }),
    );
    const agent = {
      headers: {
        authorization: `Bearer ${(await json<{ access_token: string }>(token)).access_token}`,
      },
    };
    const res = await call(agent, 'PUT', repo('/ci/actions'), { enabled: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'forbidden',
    );
    expect(await q(dbEnv, 'SELECT * FROM ci_actions_settings')).toEqual([]);
  });
});
