import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { advancePipelines } from '../src/ci/planner';
import { parseSpec } from '../src/ci/spec';
import { claimsFor } from '../src/ci/oidc';
import { AWS_TOKEN_FILE, prepareJob } from '../src/ci/inject';
import { parsePolicy } from '../src/ci/config';
import { parseContext, type RunContext } from '../src/ci/context';
import { putSecret, putVariable, repoScope } from '../src/secrets/store';
import type { CiRun, PipelineRun } from '../shared/collaboration';

/**
 * Issue #50 wired into pipeline spec v2 (#47): per-job permissions, AWS web
 * identity, secrets and variables, environment gates with approval before the
 * job starts, per-job OIDC subjects, agent (#57) runs and run retries.
 */
const testEnv = env as unknown as TestEnv;
const SPEC = '.yuma/pipelines/deploy.yml';
const PUSH_ROLE = 'arn:aws:iam::123456789012:role/yag-ecr-push';
const DEPLOY_ROLE = 'arn:aws:iam::123456789012:role/yag-eks-deploy';
const DEPLOY = `on: [manual, push]
jobs:
  build:
    permissions: { id_token: write }
    aws: { role_arn: "${PUSH_ROLE}", region: ap-southeast-2 }
    steps:
      - run: helm push chart.tgz oci://\${{ vars.ECR_REGISTRY }}
  deploy:
    needs: build
    environment: production
    permissions: { id_token: write }
    aws: { role_arn: "${DEPLOY_ROLE}", region: ap-southeast-2 }
    steps:
      - run: helm upgrade --install app chart.tgz --set token=\${{ secrets.deploy_token }}
`;
const author = { name: 'Ada', email: 'ada@example.com' };
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reviewer: Login;
let repo: Awaited<ReturnType<typeof createRepo>>;
let signingKey: JsonWebKey;
const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** CI, OIDC and secrets bindings; queue sends and runner calls succeed. */
function bindings(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    CI_ENABLED: 'true',
    CI_QUEUE: { send: async () => {} },
    CI_RUNNER: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [signingKey] }),
    SECRETS_KEK: kek,
    ...overrides,
  };
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in values) return values[key];
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as Env;
}

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = owner.headers,
  envOverride: Env = bindings(),
): Promise<Response> {
  return makeApp(envOverride)(
    new Request(`https://forge.test${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const repoApi = (tail: string, method = 'GET', body?: unknown, headers = owner.headers) =>
  call(`/api/v1/repos/team/project${tail}`, method, body, headers);

async function commit(files: Record<string, string>): Promise<string> {
  const result = await commitChanges(testEnv, repo.id, {
    first_parent: null,
    message: 'pipeline',
    author,
    changes: Object.entries(files).map(([path, text]) => ({
      path,
      op: 'add' as const,
      content_b64: btoa(text),
    })),
  });
  return result.changeset.id;
}

async function environment(rules: Record<string, unknown>): Promise<void> {
  await run(
    testEnv,
    'INSERT INTO environments (repo_id, name, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [repo.id, 'production', JSON.stringify(rules), Date.now(), Date.now()],
  );
}

async function latest(): Promise<PipelineRun> {
  const res = await repoApi('/ci/pipelines');
  expect(res.status).toBe(200);
  return ((await res.json()) as { runs: PipelineRun[] }).runs[0]!;
}

const jobOf = (r: PipelineRun, key: string) => r.jobs.find((j) => j.key === key)!;

async function runRow(id: string): Promise<CiRun> {
  return (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id = ?', [id]))!;
}

/** Finish a job's run as the runner would, then advance like its `finally`. */
async function finish(r: PipelineRun, key: string, state = 'passed'): Promise<void> {
  await run(testEnv, 'UPDATE ci_runs SET state = ?, finished_at = ? WHERE id = ?', [
    state,
    Date.now(),
    jobOf(r, key).run_id,
  ]);
  await advancePipelines(bindings());
}

async function markRunning(id: string): Promise<CiRun> {
  await run(testEnv, "UPDATE ci_runs SET state = 'running', deadline = ? WHERE id = ?", [
    Date.now() + 60_000,
    id,
  ]);
  return runRow(id);
}

async function claimsOf(job: CiRun) {
  return claimsFor(
    bindings(),
    job,
    parsePolicy(JSON.parse(job.config)),
    parseContext(job.context)!,
    'sts.amazonaws.com',
    600,
  );
}

async function startManual(
  headers: Record<string, string> = owner.headers,
  head?: string,
): Promise<Response> {
  return repoApi('/ci/pipelines/runs', 'POST', { pipeline: SPEC, head }, headers);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 951, 'owner');
  reviewer = await loginAs(testEnv, 952, 'reviewer');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repo.id, reviewer.userId],
  );
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
  signingKey = {
    ...((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey),
    kid: 'k1',
  } as JsonWebKey;
});

describe('pipeline spec access fields', () => {
  it('parses permissions, aws, environment and secret and variable references per job', () => {
    const file = parseSpec(SPEC, DEPLOY);
    expect(file.errors).toBeUndefined();
    const [build, deploy] = file.pipeline!.jobs;
    expect(build).toMatchObject({
      environment: null,
      secrets: [],
      permissions: { id_token: 'write' },
      aws: { role_arn: PUSH_ROLE, region: 'ap-southeast-2' },
    });
    expect(deploy).toMatchObject({
      environment: 'production',
      secrets: ['DEPLOY_TOKEN'],
      aws: { role_arn: DEPLOY_ROLE },
    });
    // values reach steps as shell variables, never as command text
    expect(build!.commands).toEqual(['helm push chart.tgz oci://${ECR_REGISTRY}']);
    expect(deploy!.commands[0]).toBe(
      'helm upgrade --install app chart.tgz --set token=${DEPLOY_TOKEN}',
    );
  });

  it('points aws without id_token and bad references at their lines', () => {
    const file = parseSpec(
      SPEC,
      [
        'on: push', // 1
        'jobs:', // 2
        '  build:', // 3
        '    aws: { role_arn: "arn:aws:iam::123456789012:role/r", region: us-east-1 }', // 4
        '    environment: "bad name"', // 5
        '    steps:', // 6
        '      - run: echo ${{ secrets.1X }}', // 7
      ].join('\n'),
    );
    const byLine = Object.fromEntries(file.errors!.map((e) => [e.line, e.message]));
    expect(byLine[4]).toBe('jobs.build.aws: aws needs permissions.id_token: write');
    expect(byLine[5]).toMatch(/^jobs\.build\.environment:/);
    expect(byLine[7]).toContain('Unsupported expression "secrets.1X"');
  });
});

describe('environment gates for pipeline jobs', () => {
  beforeEach(async () => {
    await putSecret(
      bindings(),
      repoScope(repo, 'production'),
      'DEPLOY_TOKEN',
      'prod-deploy-value',
      owner.userId,
    );
    await putVariable(
      bindings(),
      repoScope(repo, null),
      'ECR_REGISTRY',
      '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com',
      owner.userId,
    );
    await setRef(testEnv, repo.id, 'main', await commit({ [SPEC]: DEPLOY }));
  });

  it('asks production reviewers before the deploy job starts, then mints per-job subjects', async () => {
    await environment({
      reviewers: [{ type: 'user', id: reviewer.userId, name: 'reviewer' }],
      allowed_branches: ['main'],
    });
    expect((await startManual()).status).toBe(202);
    let r = await latest();
    expect(jobOf(r, 'build').state).toBe('queued');
    expect(jobOf(r, 'deploy')).toMatchObject({ state: 'waiting', approval: null });
    await finish(r, 'build');

    r = await latest();
    const waiting = jobOf(r, 'deploy');
    expect(waiting).toMatchObject({
      state: 'waiting',
      run_id: null,
      environment: 'production',
      approval: { state: 'pending' },
    });
    expect(r.state).toBe('running');
    const listed = (await (await repoApi('/environment-approvals')).json()) as {
      approvals: { id: string; pipeline_run_id: string; job_key: string; ref: string }[];
    };
    expect(listed.approvals).toEqual([
      expect.objectContaining({
        id: waiting.approval!.id,
        pipeline_run_id: r.id,
        job_key: 'deploy',
        ref: 'refs/heads/main',
      }),
    ]);
    // a cron sweep leaves it waiting; the person who started it cannot approve it
    await advancePipelines(bindings());
    expect(jobOf(await latest(), 'deploy').state).toBe('waiting');
    const self = await repoApi(`/environment-approvals/${waiting.approval!.id}`, 'POST', {
      decision: 'approve',
    });
    expect(self.status).toBe(403);

    const approved = await repoApi(
      `/environment-approvals/${waiting.approval!.id}`,
      'POST',
      { decision: 'approve' },
      reviewer.headers,
    );
    expect(approved.status).toBe(200);
    r = await latest();
    const deploy = jobOf(r, 'deploy');
    expect(deploy).toMatchObject({ state: 'queued', approval: { state: 'dispatched' } });
    const approval = await q1<{ run_id: string; state: string }>(
      testEnv,
      'SELECT run_id, state FROM environment_approvals WHERE id = ?',
      [waiting.approval!.id],
    );
    expect(approval).toEqual({ run_id: deploy.run_id, state: 'dispatched' });

    const buildRun = await markRunning(jobOf(r, 'build').run_id!);
    const deployRun = await markRunning(deploy.run_id!);
    expect(parseContext(deployRun.context)).toMatchObject({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      actor_kind: 'human',
      approval_id: waiting.approval!.id,
    });
    expect(await claimsOf(buildRun)).toMatchObject({
      sub: 'repo:team/project:ref:refs/heads/main',
      job: 'build',
      job_workflow_ref: `team/project/${SPEC}@refs/heads/main`,
    });
    const deployClaims = await claimsOf(deployRun);
    expect(deployClaims).toMatchObject({
      sub: 'repo:team/project:environment:production',
      environment: 'production',
      job: 'deploy',
    });

    // each job gets its own role; only the gated job sees the environment secret
    const deployAccess = await prepareJob(
      bindings(),
      deployRun,
      parsePolicy(JSON.parse(deployRun.config)),
      Date.now() + 60_000,
    );
    expect(deployAccess.env).toMatchObject({
      DEPLOY_TOKEN: 'prod-deploy-value',
      ECR_REGISTRY: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com',
      AWS_ROLE_ARN: DEPLOY_ROLE,
      AWS_WEB_IDENTITY_TOKEN_FILE: AWS_TOKEN_FILE,
    });
    expect(deployAccess.mask).toContain('prod-deploy-value');
    expect(deployAccess.files.map((f) => f.path)).toEqual([AWS_TOKEN_FILE]);
    const buildAccess = await prepareJob(
      bindings(),
      buildRun,
      parsePolicy(JSON.parse(buildRun.config)),
      Date.now() + 60_000,
    );
    expect(buildAccess.env.AWS_ROLE_ARN).toBe(PUSH_ROLE);
    expect(buildAccess.env.DEPLOY_TOKEN).toBeUndefined();
    expect(buildAccess.env.YAG_ID_TOKEN_REQUEST_URL).toContain('/ci/oidc/token');
  });

  it('skips the deploy job when reviewers reject it or the branch may not deploy', async () => {
    await environment({
      reviewers: [{ type: 'user', id: reviewer.userId, name: 'reviewer' }],
      allowed_branches: ['main'],
    });
    await startManual();
    await finish(await latest(), 'build');
    const pending = jobOf(await latest(), 'deploy').approval!;
    expect(
      (
        await repoApi(
          `/environment-approvals/${pending.id}`,
          'POST',
          { decision: 'reject' },
          reviewer.headers,
        )
      ).status,
    ).toBe(200);
    let r = await latest();
    expect(jobOf(r, 'deploy')).toMatchObject({
      state: 'skipped',
      error: 'Deployment to production was rejected',
    });
    expect(r.state).toBe('failed');

    await setRef(testEnv, repo.id, 'feature', r.head_cs);
    expect((await startManual(owner.headers, 'feature')).status).toBe(202);
    await finish(await latest(), 'build');
    r = await latest();
    expect(jobOf(r, 'deploy')).toMatchObject({
      state: 'skipped',
      approval: null,
      error: 'This branch or tag may not deploy to the environment.',
    });
  });

  it('runs agent-started pipelines as agents: humans-only environments refuse them', async () => {
    await environment({ humans_only: true });
    const subject = await createApiToken(testEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await call('/api/v1/agents', 'POST', {
      name: 'Deployer',
      kind: 'codex',
      max_scopes: ['contents:read', 'contents:write', 'ci:run'],
    });
    expect(created.status).toBe(201);
    const agentId = ((await created.json()) as { id: string }).id;
    const exchange = async (scope: string): Promise<string> => {
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: subject.raw,
        agent_id: agentId,
        resource: 'team/project',
        scope,
      });
      const res = await makeApp(bindings())(
        new Request('https://forge.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        }),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { access_token: string }).access_token;
    };
    const agent = {
      authorization: `Bearer ${await exchange('contents:read contents:write ci:run')}`,
    };
    const noCi = {
      authorization: `Bearer ${await exchange('contents:read contents:write')}`,
    };

    expect((await startManual(noCi)).status).toBe(403);
    expect((await startManual(agent)).status).toBe(202);
    let r = await latest();
    const build = await markRunning(jobOf(r, 'build').run_id!);
    expect(parseContext(build.context)?.actor_kind).toBe('agent');
    expect((await claimsOf(build)).actor_kind).toBe('agent');
    await finish(r, 'build');
    r = await latest();
    expect(jobOf(r, 'deploy')).toMatchObject({
      state: 'skipped',
      error: 'This environment only accepts runs started by a signed-in person.',
    });

    // agents never write secrets, variables or environments, nor decide approvals
    for (const [path, method] of [
      ['/secrets/TOKEN', 'PUT'],
      ['/variables/REGION', 'PUT'],
      ['/environments/staging', 'PUT'],
      ['/environment-approvals/x', 'POST'],
    ] as const) {
      const res = await repoApi(path, method, { value: 'x', decision: 'approve' }, agent);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await repoApi('/secrets', 'GET', undefined, agent)).status).toBe(403);
  });
});

describe('secrets and SSO', () => {
  it('org secrets and variables need the org SSO', async () => {
    expect((await call('/api/v1/orgs', 'POST', { slug: 'acme' })).status).toBe(201);
    expect((await call('/api/v1/orgs/acme/secrets')).status).toBe(200);
    const org = await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM orgs WHERE slug = 'acme'",
    );
    await run(
      testEnv,
      `INSERT INTO org_sso (org_id, protocol, issuer, client_id, enforced, updated_by, updated_at)
       VALUES (?, 'oidc', 'https://idp.example.test', 'okta-client', 1, ?, ?)`,
      [org!.id, owner.userId, Date.now()],
    );
    for (const path of ['/api/v1/orgs/acme/secrets', '/api/v1/orgs/acme/variables']) {
      const res = await call(path);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'sso_required',
      );
    }
    const write = await call('/api/v1/orgs/acme/variables/REGION', 'PUT', { value: 'x' });
    expect(write.status).toBe(403);
  });
});

describe('retrying a run', () => {
  beforeEach(async () => {
    await setRef(testEnv, repo.id, 'main', await commit({ 'README.md': 'hi' }));
    const res = await repoApi('/ci', 'PUT', {
      commands: ['npm test'],
      timeout_seconds: 60,
      permissions: { id_token: 'write' },
    });
    expect(res.status).toBe(200);
  });

  async function started(): Promise<CiRun> {
    const res = await repoApi('/ci/runs', 'POST', {});
    expect(res.status).toBe(202);
    const job = ((await res.json()) as { run: CiRun }).run;
    await run(
      testEnv,
      "UPDATE ci_runs SET state = 'failed', finished_at = ? WHERE id = ?",
      [Date.now(), job.id],
    );
    return runRow(job.id);
  }

  it('keeps the trigger context, so the retried run can still get an ID token', async () => {
    const first = await started();
    expect(parseContext(first.context)?.ref).toBe('refs/heads/main');
    const res = await repoApi(`/ci/runs/${first.id}/retry`, 'POST', {}, reviewer.headers);
    expect(res.status).toBe(202);
    const retried = await markRunning(((await res.json()) as { run: CiRun }).run.id);
    expect(retried.requested_by).toBe(reviewer.userId);
    expect(parseContext(retried.context)).toMatchObject({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      actor_kind: 'human',
    });
    expect((await claimsOf(retried)).sub).toBe('repo:team/project:ref:refs/heads/main');
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'ci.run.create' ORDER BY rowid DESC LIMIT 1",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ retry_of: first.id });

    // a pull request run stays a pull request run; a run from before contexts uses the branch tip
    const pull: RunContext = {
      event: 'pull_request',
      ref: 'refs/pull/7/merge',
      pull_id: 7,
      fork: false,
      actor_kind: 'human',
      origin: 'https://forge.test',
      approval_id: null,
    };
    await run(testEnv, "UPDATE ci_runs SET context = ?, state = 'failed' WHERE id = ?", [
      JSON.stringify(pull),
      retried.id,
    ]);
    const again = await repoApi(`/ci/runs/${retried.id}/retry`, 'POST', {});
    const prRun = await runRow(((await again.json()) as { run: CiRun }).run.id);
    expect(parseContext(prRun.context)).toMatchObject({
      event: 'pull_request',
      pull_id: 7,
    });
    await run(
      testEnv,
      "UPDATE ci_runs SET context = NULL, state = 'failed' WHERE id = ?",
      [prRun.id],
    );
    const legacy = await repoApi(`/ci/runs/${prRun.id}/retry`, 'POST', {});
    const legacyRun = await runRow(((await legacy.json()) as { run: CiRun }).run.id);
    expect(parseContext(legacyRun.context)?.ref).toBe('refs/heads/main');
  });

  it('puts a retry behind its environment approval and keeps the access contract', async () => {
    const first = await started();
    await environment({
      reviewers: [{ type: 'user', id: reviewer.userId, name: 'reviewer' }],
    });
    const res = await repoApi('/ci', 'PUT', {
      commands: ['npm test'],
      timeout_seconds: 60,
      environment: 'production',
    });
    expect(res.status).toBe(200);
    const retry = await repoApi(`/ci/runs/${first.id}/retry`, 'POST', {});
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as {
      approval: { environment: string; state: string };
    };
    expect(body.approval).toMatchObject({ environment: 'production', state: 'pending' });

    const outsider = await loginAs(testEnv, 953, 'outsider');
    expect(
      (await repoApi(`/ci/runs/${first.id}/retry`, 'POST', {}, outsider.headers)).status,
    ).toBe(404);
    expect((await repoApi('/ci/runs/missing/retry', 'POST', {})).status).toBe(404);
  });
});

describe('scheduled runs', () => {
  it('need CI_OIDC_ISSUER for ID tokens, since no request origin exists', async () => {
    await setRef(testEnv, repo.id, 'main', await commit({ 'README.md': 'hi' }));
    await repoApi('/ci', 'PUT', {
      commands: ['npm test'],
      timeout_seconds: 60,
      permissions: { id_token: 'write' },
    });
    const res = await repoApi('/ci/runs', 'POST', {});
    const id = ((await res.json()) as { run: CiRun }).run.id;
    const schedule: RunContext = {
      event: 'schedule',
      ref: 'refs/heads/main',
      pull_id: null,
      fork: false,
      actor_kind: 'system',
      origin: null,
      approval_id: null,
    };
    await run(testEnv, 'UPDATE ci_runs SET context = ? WHERE id = ?', [
      JSON.stringify(schedule),
      id,
    ]);
    const job = await markRunning(id);
    const policy = parsePolicy(JSON.parse(job.config));
    const without = await prepareJob(bindings(), job, policy, Date.now() + 60_000);
    expect(without.summary).toContain('needs CI_OIDC_ISSUER');
    expect(without.env.YAG_ID_TOKEN_REQUEST_URL).toBeUndefined();
    const issuer = 'https://git.example.test/ci/oidc';
    const withIssuer = await prepareJob(
      bindings({ CI_OIDC_ISSUER: issuer }),
      job,
      policy,
      Date.now() + 60_000,
    );
    expect(withIssuer.env.YAG_ID_TOKEN_REQUEST_URL).toBe(`${issuer}/token?run_id=${id}`);
  });
});
