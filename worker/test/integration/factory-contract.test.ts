import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from '../helpers';
import {
  blob,
  commandBody,
  commit,
  dir,
  lines,
  packOf,
  parseFetch,
  parseReport,
  pushBody,
  tree,
  ZERO,
  type Obj,
} from '../git-helpers';
import { createRepo } from '../../src/db/repos';
import { q, run } from '../../src/db/client';
import { createApiToken } from '../../src/auth/tokens';
import { webhooksQueue } from '../../src/queues/webhooks';
import type { PipelineRun, Pull } from '../../shared/collaboration';
import type { WorkItem } from '../../shared/work';

/**
 * Yuma Factory provider contract (issue #63). Every forge call Factory makes
 * to run one ticket, in the order it makes them, against a seeded repo:
 * token exchange (#57), issues and the work queue (#59), clone and push over
 * smart HTTP (#31), pull requests, checks and CI logs (#47, #48), comments,
 * agent review findings (#39, #60), a merge commit (#42) under rulesets
 * (#41), closing the issue, provenance (#58) and the webhooks Factory
 * receives instead of GitHub's (#75). The self-hosted runner stands in for
 * CI; webhook receivers and DNS are stubbed, so nothing leaves the test.
 * See docs/integrations/yuma-factory.md.
 */

const testEnv = env as unknown as TestEnv;
const SLUG = 'acme/app';
const HOOK_URL = 'https://factory.example.com/hooks/yag';
const PIPELINE = `on: pull_request
jobs:
  test:
    runs-on: linux
    steps: [{ run: npm test }]
`;
const AGENT_SCOPES = 'contents:read contents:write pulls:write issues:write queue:claim';

type Login = Awaited<ReturnType<typeof loginAs>>;
type Headers = Record<string, string>;
let operator: Login;
let rita: Login;
/** The operator's API token Factory holds: the token exchange subject. */
let runToken = '';
let factoryAgent = '';
let reviewer: Headers = {};
let reviewerId = '';
let runnerCredential = '';
let mainSha = '';
let mainTree: Obj;
let readme: Obj;
let yuma: Obj;
let sends: unknown[] = [];

/** CI on (jobs go to the self-hosted runner) and forge events recorded for `drain`. */
const forge: Env = new Proxy(testEnv, {
  get(target, key, receiver) {
    if (key === 'CI_ENABLED') return 'true';
    if (key === 'SECRETS_KEK') return 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    if (key === 'CI_QUEUE') return { send: async () => {} };
    if (key === 'CI_RUNNER')
      return {
        idFromName: (id: string) => id,
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      };
    if (key === 'EVENTS_QUEUE')
      return {
        send: async (body: unknown) => {
          sends.push(body);
        },
      };
    return Reflect.get(target, key, receiver);
  },
});
const app = makeApp(forge);

async function call(
  method: string,
  path: string,
  headers: Headers,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://forge.test${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const repo = (tail: string): string => `/api/v1/repos/${SLUG}${tail}`;
const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });
const basic = (token: string): Headers => ({
  authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
});

/** RFC 8693 exchange of the run token for a short-lived agent token. */
async function exchange(fields: Record<string, string>): Promise<{
  access_token: string;
  expires_in: number;
  scope: string;
}> {
  const res = await app(
    new Request('https://forge.test/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        resource: SLUG,
        ...fields,
      }),
    }),
  );
  return json(res);
}

async function push(
  token: string,
  ref: string,
  from: string,
  objects: Obj[],
): Promise<string> {
  const head = objects[0]!;
  const res = await app(
    new Request(`https://forge.test/${SLUG}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        ...basic(token),
      },
      body: pushBody([[from, head.sha, ref]], await packOf(objects)),
    }),
  );
  expect(res.status).toBe(200);
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  expect(report.refs[ref], report.messages).toBe('ok');
  return head.sha;
}

/** A commit on `parent` with `src/app.ts` set to `source`; head commit first. */
async function change(parent: string, source: string, message: string): Promise<Obj[]> {
  const file = await blob(source);
  const src = await tree([{ name: 'app.ts', sha: file.sha }]);
  const root = await tree([
    dir('.yuma', yuma),
    { name: 'README.md', sha: readme.sha },
    dir('src', src),
  ]);
  const head = await commit(root.sha, [parent], `${message}\n`, 1_700_000_100);
  return [head, root, src, file];
}

/** A Git upload-pack v2 command with the agent token. */
async function uploadPack(
  token: string,
  command: string,
  args: string[],
): Promise<Uint8Array> {
  const res = await app(
    new Request(`https://forge.test/${SLUG}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        'git-protocol': 'version=2',
        ...basic(token),
      },
      body: commandBody(command, args),
    }),
  );
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** A runner request with its credential. */
async function runner(path: string, body?: unknown): Promise<Response> {
  return app(
    new Request(`https://forge.test/runner/v1${path}`, {
      method: 'POST',
      headers: {
        ...bearer(runnerCredential),
        'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
      },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    }),
  );
}

/** The self-hosted runner takes the queued job and ends it with `result`. */
async function runJob(log: string, result: 'passed' | 'failed'): Promise<string> {
  const claimed = await json<{ job: { id: string } }>(await runner('/jobs/claim?wait=0'));
  const id = claimed.job.id;
  await json(await runner(`/jobs/${id}/steps/0`, { state: 'running' }));
  await json(await runner(`/jobs/${id}/logs?step=0`, log));
  await json(
    await runner(`/jobs/${id}/steps/0`, {
      state: result,
      exit_code: result === 'passed' ? 0 : 1,
    }),
  );
  await json(await runner(`/jobs/${id}/complete`, { result }));
  return id;
}

// --- webhook receiver stub -----------------------------------------------------

const realFetch = globalThis.fetch;
let received: Request[] = [];

beforeEach(() => {
  received = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com') {
      const answers = url.searchParams.get('type') === 'A' ? ['93.184.216.34'] : [];
      return Response.json({
        Status: 0,
        Answer: answers.map((data) => ({ type: 1, data })),
      });
    }
    received.push(req.clone());
    return new Response('ok');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Run the forge-events consumer over every event queued so far. */
async function drain(): Promise<{ event: string; action: string | null }[]> {
  const batch = sends;
  sends = [];
  await webhooksQueue(
    {
      queue: 'forge-events',
      messages: batch.map((body, i) => ({
        id: String(i),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: () => undefined,
        retry: () => undefined,
      })),
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch,
    forge,
  );
  const bodies = await Promise.all(
    received.map(async (r) => {
      expect(r.url).toBe(HOOK_URL);
      return JSON.parse(await r.clone().text()) as {
        event: string;
        action: string | null;
      };
    }),
  );
  return bodies;
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

let hookSecret = '';

// --- seeded repo: what an operator sets up once per repo -------------------------

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sends = [];
  operator = await loginAs(testEnv, 6301, 'justin');
  rita = await loginAs(testEnv, 6302, 'rita');
  const created = await createRepo(testEnv, { slug: SLUG, createdBy: operator.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
    [created.id, rita.userId],
  );
  runToken = (
    await createApiToken(testEnv, operator.userId, {
      label: 'yuma-factory',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    })
  ).raw;

  // main: README, the app and a pull request pipeline for the runner
  readme = await blob('# app\n');
  const spec = await blob(PIPELINE);
  const pipelines = await tree([{ name: 'ci.yml', sha: spec.sha }]);
  yuma = await tree([dir('pipelines', pipelines)]);
  const app0 = await blob('export const add = (a: number, b: number) => a + b;\n');
  const src = await tree([{ name: 'app.ts', sha: app0.sha }]);
  mainTree = await tree([
    dir('.yuma', yuma),
    { name: 'README.md', sha: readme.sha },
    dir('src', src),
  ]);
  const root = await commit(mainTree.sha, [], 'init\n');
  mainSha = await push(runToken, 'refs/heads/main', ZERO, [
    root,
    mainTree,
    yuma,
    pipelines,
    spec,
    readme,
    src,
    app0,
  ]);

  // Factory's labels, so imported tickets keep their readiness and risk
  for (const name of ['yuma:ready', 'yuma:risk:low'])
    await json(
      await call('POST', repo('/labels'), operator.headers, { name, color: '0e8a16' }),
      201,
    );

  // the Factory agent identity: may claim low-risk work only
  factoryAgent = (
    await json<{ id: string }>(
      await call('POST', '/api/v1/agents', operator.headers, {
        name: 'Yuma Factory',
        kind: 'factory',
        max_risk: 'low',
        max_scopes: AGENT_SCOPES.split(' '),
      }),
      201,
    )
  ).id;

  // a reviewer agent that another person runs (an agent never reviews for its author)
  const ritaToken = (
    await createApiToken(testEnv, rita.userId, {
      label: 'reviewer',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    })
  ).raw;
  reviewerId = (
    await json<{ id: string }>(
      await call('POST', '/api/v1/agents', rita.headers, {
        name: 'Reviewer',
        kind: 'codex',
      }),
      201,
    )
  ).id;
  await json(
    await call('PUT', repo(`/agent-reviewers/${reviewerId}`), operator.headers, {
      min_confidence: 0.8,
    }),
  );
  reviewer = bearer(
    (
      await exchange({
        subject_token: ritaToken,
        agent_id: reviewerId,
        scope: 'contents:read pulls:write',
      })
    ).access_token,
  );

  // the rules auto-merge has to pass: merge commits only, green CI, a passing
  // agent review, resolved threads and no people needed for low risk
  await json(
    await call('POST', repo('/rulesets'), operator.headers, {
      name: 'Factory gates',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [
        { type: 'merge_methods', allowed: ['merge'] },
        { type: 'required_status_checks' },
        { type: 'required_agent_review' },
        { type: 'required_review_thread_resolution' },
        { type: 'human_approvals_by_risk', low: 0, medium: 1, high: 2 },
      ],
    }),
    201,
  );

  // a self-hosted runner for the pipeline's `runs-on: linux`
  const grant = await json<{ token: string }>(
    await call('POST', repo('/runners/registration-token'), operator.headers, {}),
    201,
  );
  runnerCredential = (
    await json<{ credential: string }>(
      await app(
        new Request('https://forge.test/runner/v1/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: grant.token,
            name: 'linux-1',
            labels: ['linux', 'x64'],
            capabilities: { os: 'linux', arch: 'x64' },
          }),
        }),
      ),
      201,
    )
  ).credential;

  // Factory's webhook receiver replaces the GitHub App's
  hookSecret = (
    await json<{ secret: string }>(
      await call('POST', repo('/hooks'), operator.headers, {
        url: HOOK_URL,
        events: [
          'issues',
          'issue_comment',
          'work_item',
          'pull_request',
          'pull_request_review',
          'pull_request_review_thread',
          'ci_run',
          'agent_review',
        ],
      }),
      201,
    )
  ).secret;
  sends = [];
});

describe('Yuma Factory provider contract (#63)', () => {
  it('runs one low-risk ticket end to end: claim, push, PR, CI, review, merge, close, provenance', async () => {
    // a person files the ticket with Factory's labels and imports them as work fields
    const issue = await json<{ issue: { number: number } }>(
      await call('POST', repo('/issues'), operator.headers, {
        title: 'Fix add() for negative numbers',
        body: 'add(-1, 1) should be 0.',
        labels: ['yuma:ready', 'yuma:risk:low'],
      }),
      201,
    );
    const number = issue.issue.number;
    await json(
      await call('POST', repo('/work/import-labels'), operator.headers, {
        prefix: 'yuma',
      }),
    );

    // 1. auth: the run token becomes a 15 minute agent token for this repo
    const dispatch = await exchange({
      subject_token: runToken,
      agent_id: factoryAgent,
      scope: AGENT_SCOPES,
    });
    expect(dispatch).toMatchObject({ expires_in: 900, scope: AGENT_SCOPES });
    expect(dispatch.access_token).toMatch(/^yagat_/);
    const orchestrator = bearer(dispatch.access_token);

    // 2. list issues: labelled, open tickets and the ready work queue
    const listed = await json<{
      issues: { number: number; labels: { name: string }[] }[];
    }>(await call('GET', repo('/issues?state=open&label=yuma:ready'), orchestrator));
    expect(listed.issues.map((i) => i.number)).toEqual([number]);
    const queue = await json<{ items: WorkItem[] }>(
      await call('GET', repo('/work?readiness=ready'), orchestrator),
    );
    expect(queue.items).toMatchObject([{ number, readiness: 'ready', risk: 'low' }]);

    // 3. claim: atomic, leased, within the agent's max risk
    const claimed = await json<{ item: WorkItem }>(
      await call('POST', repo('/work/claim'), orchestrator, { lease_seconds: 900 }),
    );
    expect(claimed.item).toMatchObject({
      number,
      readiness: 'claimed',
      claimed_by: `agent:${factoryAgent}`,
    });

    // the sandbox gets its own token, bound to the task for provenance
    const sandbox = await exchange({
      subject_token: runToken,
      agent_id: factoryAgent,
      scope: AGENT_SCOPES,
      task_id: String(number),
    });
    const token = sandbox.access_token;
    const agent = bearer(token);

    // 4. clone over smart HTTP: advertisement, ls-refs and a fetch of main
    const advert = await app(
      new Request(`https://forge.test/${SLUG}.git/info/refs?service=git-upload-pack`, {
        headers: { ...basic(token), 'git-protocol': 'version=2' },
      }),
    );
    expect(advert.status).toBe(200);
    const refs = lines(
      await uploadPack(token, 'ls-refs', ['symrefs', 'ref-prefix HEAD']),
    );
    expect(refs[0]).toBe(`${mainSha} HEAD symref-target:refs/heads/main`);
    const fetched = parseFetch(
      await uploadPack(token, 'fetch', [`want ${mainSha}`, 'done']),
    );
    expect(fetched.errors).toBe('');
    expect(new TextDecoder().decode(fetched.pack.subarray(0, 4))).toBe('PACK');

    // the lease is kept alive while the agent works
    await json(await call('POST', repo(`/work/${number}/heartbeat`), agent, {}));

    // 5. push a branch: allowed; main is not
    const branch = 'refs/heads/factory/issue-1';
    const first = await change(
      mainSha,
      'export const add = (a: number, b: number) => a + b + 0;\n',
      'Fix add',
    );
    const refused = await app(
      new Request(`https://forge.test/${SLUG}.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          ...basic(token),
        },
        body: pushBody(
          [[mainSha, first[0]!.sha, 'refs/heads/main']],
          await packOf(first),
        ),
      }),
    );
    expect(
      parseReport(new Uint8Array(await refused.arrayBuffer())).refs['refs/heads/main'],
    ).toMatch(/^agent_default_branch/);
    let headSha = await push(token, branch, ZERO, first);
    const ref = await json<{ head: string }>(
      await call('GET', repo('/refs/factory/issue-1'), agent),
    );

    // 6. open the pull request; CI starts on its own
    const opened = await json<{ pull: Pull; ci: { status: string } }>(
      await call('POST', repo('/pulls'), agent, {
        title: 'Fix add() for negative numbers',
        body: `Work item #${number}, implemented by Yuma Factory.`,
        head_cs: ref.head,
      }),
      201,
    );
    expect(opened.ci.status).toBe('queued');
    const pullId = opened.pull.id;
    expect(opened.pull.author_agent_id).toBe(factoryAgent);
    await json(
      await call('POST', repo(`/work/${number}/release`), agent, {
        outcome: 'in-review',
        reason: `pull request #${opened.pull.number}`,
      }),
    );

    // 7. comment on the issue
    await json(
      await call('POST', repo(`/issues/${number}/comments`), agent, {
        body: `Opened pull request #${opened.pull.number}.`,
      }),
      201,
    );

    // 8. list checks for the head, then read the failing job's log
    await runJob('FAIL add(-1, 1): expected 0\n', 'failed');
    const checks = async (head: string) =>
      (
        await json<{ runs: PipelineRun[] }>(
          await call('GET', repo(`/ci/pipelines?head=${head}`), agent),
        )
      ).runs.flatMap((r) => r.jobs);
    const failed = await checks(ref.head);
    expect(failed).toMatchObject([{ job: 'test', state: 'failed' }]);
    const log = await call('GET', repo(`/ci/runs/${failed[0]!.run_id}/log`), agent);
    expect(log.status).toBe(200);
    expect(await log.text()).toContain('FAIL add(-1, 1)');

    // 9. the reviewer agent posts findings; Factory reads them as threads
    const current = async () =>
      (await json<{ pull: Pull }>(await call('GET', repo(`/pulls/${pullId}`), agent)))
        .pull;
    let pull = await current();
    const review = await json<{ passed: boolean; threads: number }>(
      await call('POST', repo(`/pulls/${pullId}/agent-review`), reviewer, {
        head_cs: pull.head_cs,
        revision: pull.revision,
        verdict: 'fail',
        confidence: 0.9,
        findings: [
          {
            severity: 'medium',
            path: 'src/app.ts',
            line: 1,
            body: 'The + 0 is a no-op.',
          },
        ],
      }),
      201,
    );
    expect(review).toMatchObject({ passed: false, threads: 1 });
    const loop = await json<{ rounds: unknown[] }>(
      await call('GET', repo(`/pulls/${pullId}/agent-review`), agent),
    );
    expect(JSON.stringify(loop)).toContain('The + 0 is a no-op.');
    // a person leaves a review comment too
    await json(
      await call('POST', repo(`/pulls/${pullId}/threads`), rita.headers, {
        head_cs: pull.head_cs,
        revision: pull.revision,
        path: 'src/app.ts',
        line: 1,
        body: 'Please add a return type.',
      }),
      201,
    );
    const threads = await json<{ threads: { id: number; author: string }[] }>(
      await call('GET', repo(`/pulls/${pullId}/threads`), agent),
    );
    expect(threads.threads.map((t) => t.author)).toEqual([
      `agent:${reviewerId}`,
      `user:${rita.userId}`,
    ]);

    // 10. respond to the findings: push a fix, move the PR, reply, resolve
    const fix = await change(
      headSha,
      'export const add = (a: number, b: number): number => a + b;\n',
      'Drop the no-op, add a return type',
    );
    headSha = await push(token, branch, headSha, fix);
    const fixed = await json<{ head: string }>(
      await call('GET', repo('/refs/factory/issue-1'), agent),
    );
    const updated = await json<{ pull: Pull; ci: { status: string } }>(
      await call('POST', repo(`/pulls/${pullId}/update`), agent, {
        head_cs: fixed.head,
      }),
    );
    expect(updated.ci.status).toBe('queued');
    for (const thread of threads.threads) {
      await json(
        await call('POST', repo(`/pulls/${pullId}/threads/${thread.id}/replies`), agent, {
          body: 'Fixed in the next revision.',
        }),
        201,
      );
      await json(
        await call(
          'PUT',
          repo(`/pulls/${pullId}/threads/${thread.id}/resolution`),
          agent,
          { resolved: true },
        ),
      );
    }
    // a pull request comment is a `comment` review
    pull = await current();
    await json(
      await call('POST', repo(`/pulls/${pullId}/review`), agent, {
        head_cs: pull.head_cs,
        revision: pull.revision,
        decision: 'comment',
        body: 'Addressed the review findings.',
      }),
    );
    await runJob('ok\n', 'passed');
    expect(await checks(fixed.head)).toMatchObject([{ job: 'test', state: 'passed' }]);
    await json(
      await call('POST', repo(`/pulls/${pullId}/agent-review`), reviewer, {
        head_cs: pull.head_cs,
        revision: pull.revision,
        verdict: 'pass',
        confidence: 0.95,
      }),
      201,
    );

    // 11. auto-merge eligibility: the gate passes, the work item is low risk
    const gated = await json<{
      gate: { mergeable: boolean; reasons: string[]; methods: string[] };
    }>(await call('GET', repo(`/pulls/${pullId}`), agent));
    expect(gated.gate).toMatchObject({
      mergeable: true,
      reasons: [],
      methods: ['merge'],
    });
    const work = await json<{ item: WorkItem }>(
      await call('GET', repo(`/work/${number}`), agent),
    );
    expect(work.item).toMatchObject({ risk: 'low', readiness: 'in-review' });

    // agent tokens never merge (#57): Factory merges with the run token, as the operator
    pull = await current();
    const at = { head_cs: pull.head_cs, revision: pull.revision };
    const byAgent = await call('POST', repo(`/pulls/${pullId}/merge`), agent, {
      ...at,
      method: 'merge',
    });
    expect(byAgent.status).toBe(403);
    const squash = await call('POST', repo(`/pulls/${pullId}/merge`), bearer(runToken), {
      ...at,
      method: 'squash',
    });
    expect(squash.status).toBe(409);
    expect(((await squash.json()) as { error: { code: string } }).error.code).toBe(
      'merge_blocked',
    );
    const merged = await json<{ pull: Pull }>(
      await call('POST', repo(`/pulls/${pullId}/merge`), bearer(runToken), {
        ...at,
        method: 'merge',
      }),
    );
    expect(merged.pull).toMatchObject({ state: 'merged', merge_method: 'merge' });
    const mergedCs = merged.pull.merged_cs!;
    expect(mergedCs).not.toBe(fixed.head);

    // 12. close the issue
    const closed = await json<{ issue: { state: string; state_reason: string } }>(
      await call('PATCH', repo(`/issues/${number}`), agent, {
        state: 'closed',
        state_reason: 'completed',
      }),
    );
    expect(closed.issue).toMatchObject({ state: 'closed', state_reason: 'completed' });

    // 13. provenance: a signed record of the merge, naming the agent and its task
    const provenance = await json<{
      records: {
        via: string;
        verified: boolean;
        statement: { predicate: Record<string, unknown> };
      }[];
    }>(await call('GET', repo(`/provenance?cs=${mergedCs}`), agent));
    expect(provenance.records).toHaveLength(1);
    const record = provenance.records[0]!;
    expect(record).toMatchObject({ via: 'merge', verified: true });
    expect(record.statement.predicate['pull_requests']).toMatchObject([
      { number: opened.pull.number, agent_reviews: [{ verdict: 'pass' }] },
    ]);
    expect(record.statement.predicate['changesets']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixed.head,
          agent: expect.objectContaining({ id: factoryAgent, task_id: String(number) }),
        }),
      ]),
    );

    // 14. webhooks Factory receives instead of GitHub's, signed with its secret
    const delivered = await drain();
    const seen = delivered.map((b) => `${b.event}:${String(b.action)}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        'issues:opened',
        'work_item:claimed',
        'pull_request:opened',
        'work_item:released',
        'issue_comment:created',
        'ci_run:completed',
        'agent_review:completed',
        'pull_request_review_thread:created',
        'pull_request_review_thread:replied',
        'pull_request_review_thread:resolved',
        'pull_request_review:submitted',
        'pull_request:closed',
        'issues:closed',
      ]),
    );
    expect(seen.filter((s) => s === 'ci_run:completed')).toHaveLength(2);
    const sample = received[0]!;
    expect(sample.headers.get('x-yag-signature-256')).toBe(
      await hmac(hookSecret, await sample.text()),
    );

    // every Factory call is in the audit log as the agent, acting for the operator
    const audit = await q<{ action: string; actor_kind: string }>(
      testEnv,
      `SELECT action, actor_kind FROM audit_events
        WHERE action IN ('work.claim', 'pull.create', 'pull.merge', 'issue.update')
        ORDER BY id`,
    );
    expect(audit).toEqual([
      // the person labelling the ticket
      { action: 'issue.update', actor_kind: 'user' },
      { action: 'work.claim', actor_kind: 'agent' },
      { action: 'pull.create', actor_kind: 'agent' },
      { action: 'pull.merge', actor_kind: 'token' },
      { action: 'issue.update', actor_kind: 'agent' },
    ]);
  });
});
