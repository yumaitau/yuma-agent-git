import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { createApiToken } from '../src/auth/tokens';
import { q, q1, run } from '../src/db/client';
import { chat, setChatProvider } from '../src/agents/llm';
import { emitCiRun } from '../src/ci/runs';
import { recordStorageUsage, recordUsage } from '../src/usage/record';
import { PRICES, tokenCost } from '../src/usage/prices';
import { csv } from '../src/api/usage';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
type Login = Awaited<ReturnType<typeof loginAs>>;

describe('price table (#61)', () => {
  it('prices metered tokens, records subscriptions at zero and leaves unknown models unpriced', () => {
    const version = PRICES[0]!;
    const tokens = { input: 1_000_000, output: 1_000_000, cached: 0 };
    expect(
      tokenCost(version, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', tokens, 'metered'),
    ).toBe(293_000 + 2_253_000);
    expect(tokenCost(version, 'claude-subscription', tokens, 'metered')).toBe(0);
    expect(tokenCost(version, 'gpt-x', tokens, 'subscription')).toBe(0);
    expect(tokenCost(version, 'gpt-x', tokens, 'metered')).toBeNull();
  });

  it('defuses spreadsheet formulas in CSV exports', () => {
    const text = csv([
      {
        key: '=HYPERLINK("x")',
        label: 'a, "b"',
        events: 1,
        input_tokens: -5,
        output_tokens: 0,
        cached_tokens: 0,
        ci_seconds: 0,
        storage_byte_days: 0,
        usd_micros: 0,
        unpriced: 0,
      },
    ]);
    expect(text.split('\r\n')[1]).toBe(
      `"'=HYPERLINK(""x"")",,"a, ""b""",,1,-5,0,0,0,0,0,0`,
    );
  });
});

describe('usage accounting (#61)', () => {
  let owner: Login;
  let ada: Login;
  let repoId: string;
  let pullNumber: number;
  let pullId: number;

  async function call(
    method: string,
    tail: string,
    body?: unknown,
    headers: Record<string, string> = owner.headers,
  ): Promise<Response> {
    return app(
      new Request(`https://x/api/v1${tail}`, {
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

  async function errorCode(res: Response, status: number): Promise<string> {
    return (await json<{ error: { code: string } }>(res, status)).error.code;
  }

  /** An agent identity of `org` (or the owner's own), with a token delegated by the owner. */
  async function agent(
    name: string,
    scope = 'contents:read contents:write queue:claim',
    org?: string,
  ): Promise<{ id: string; bearer: Record<string, string> }> {
    const by = org ? ada : owner;
    const delegate = await createApiToken(dbEnv, by.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await call(
        'POST',
        '/agents',
        {
          name,
          kind: 'factory',
          max_scopes: ['contents:read', 'contents:write', 'queue:claim', 'pulls:write'],
          ...(org ? { org } : {}),
        },
        by.headers,
      ),
      201,
    );
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: delegate.raw,
      agent_id: created.id,
      resource: 'acme/app',
      scope,
    });
    const token = await json<{ access_token: string }>(
      await app(
        new Request('https://x/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        }),
      ),
    );
    return { id: created.id, bearer: { authorization: `Bearer ${token.access_token}` } };
  }

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 1201, 'owner');
    ada = await loginAs(testEnv, 1202, 'ada');
    const now = Date.now();
    await run(
      dbEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1','acme','Acme',?)",
      [now],
    );
    await run(
      dbEnv,
      "INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', ?, 'admin')",
      [ada.userId],
    );
    const repo = await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId });
    repoId = repo.id;
    await run(
      dbEnv,
      "UPDATE repos SET owner_kind = 'org', owner_id = 'o1' WHERE id = ?",
      [repoId],
    );
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
      [repoId, ada.userId],
    );
    const write = async (parent: string | null, text: string) =>
      (
        await commitChanges(dbEnv, repoId, {
          first_parent: parent,
          message: 'c',
          author: { name: 'A', email: 'a@example.com' },
          changes: [
            { path: 'README.md', op: parent ? 'mod' : 'add', content_b64: btoa(text) },
          ],
        })
      ).changeset.id;
    const base = await write(null, 'a\n');
    await setRef(dbEnv, repoId, 'main', base);
    const pull = await json<{ pull: { id: number; number: number } }>(
      await call('POST', '/repos/acme/app/pulls', {
        title: 'Change',
        head_cs: await write(base, 'b\n'),
      }),
      201,
    );
    pullNumber = pull.pull.number;
    pullId = pull.pull.id;
  });

  afterEach(() => setChatProvider(null));

  it('records every Workers AI call of a built-in agent task', async () => {
    setChatProvider(async () => ({
      content: 'ok',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      tool_calls: [],
    }));
    for (let i = 0; i < 3; i++)
      await chat(
        dbEnv,
        { messages: [{ role: 'user', content: 'hi' }] },
        {
          repo_id: repoId,
          task_id: 'task-1',
          ticket: '#7',
        },
      );
    const rows = await q<{ org_id: string; input_tokens: number; usd_micros: number }>(
      dbEnv,
      "SELECT org_id, input_tokens, usd_micros FROM usage_events WHERE task_id = 'task-1'",
    );
    expect(rows).toHaveLength(3);
    // 100 × 0.293 + 50 × 2.253 micros, at the default model's price
    expect(rows[0]).toEqual({ org_id: 'o1', input_tokens: 100, usd_micros: 142 });
  });

  it('puts Factory-reported usage against the right ticket and pull request', async () => {
    const factory = await agent('factory', 'contents:write', 'acme');
    const reported = await json<{ event: { id: string; usd_micros: number } }>(
      await call(
        'POST',
        '/usage',
        {
          repo: 'acme/app',
          model: 'claude-subscription',
          billing: 'subscription',
          input_tokens: 40_000,
          output_tokens: 6_000,
          cached_tokens: 100_000,
          ticket: '#61',
          pull: pullNumber,
          run_id: 'factory-run-1',
        },
        factory.bearer,
      ),
      201,
    );
    expect(reported.event.usd_micros).toBe(0);
    const byPull = await json<{
      rows: { key: string; label: string; input_tokens: number; merged: boolean }[];
    }>(await call('GET', '/repos/acme/app/usage?group_by=pull'));
    expect(byPull.rows).toEqual([
      expect.objectContaining({
        key: `#${pullNumber}`,
        label: 'Change',
        input_tokens: 40_000,
      }),
    ]);
    const byTicket = await json<{
      rows: { key: string; repo: string; cached_tokens: number }[];
    }>(await call('GET', '/orgs/acme/usage?group_by=ticket', undefined, ada.headers));
    expect(byTicket.rows).toEqual([
      expect.objectContaining({ key: '#61', repo: 'acme/app', cached_tokens: 100_000 }),
    ]);
    const byAgent = await json<{ rows: { key: string; label: string }[] }>(
      await call(
        'GET',
        `/agents/${factory.id}/usage?group_by=agent`,
        undefined,
        ada.headers,
      ),
    );
    expect(byAgent.rows).toEqual([
      expect.objectContaining({ key: factory.id, label: 'factory' }),
    ]);
    expect(
      await q1(dbEnv, 'SELECT agent_id, pull_id, reported_by FROM usage_events'),
    ).toEqual({
      agent_id: factory.id,
      pull_id: pullId,
      reported_by: `agent:${factory.id}`,
    });

    // append-only: a correction is a new event, and the raw row cannot change
    await expect(
      run(dbEnv, 'UPDATE usage_events SET input_tokens = 0 WHERE id = ?', [
        reported.event.id,
      ]),
    ).rejects.toThrow(/append-only/);
    expect(
      await errorCode(
        await call(
          'POST',
          '/usage',
          { repo: 'acme/app', input_tokens: -1 },
          factory.bearer,
        ),
        400,
      ),
    ).toBe('invalid_request');
    await json(
      await call(
        'POST',
        '/usage',
        {
          repo: 'acme/app',
          model: 'claude-subscription',
          billing: 'subscription',
          input_tokens: -10_000,
          ticket: '#61',
          correction_of: reported.event.id,
        },
        factory.bearer,
      ),
      201,
    );
    const totals = await json<{ totals: { input_tokens: number; events: number } }>(
      await call('GET', '/repos/acme/app/usage'),
    );
    expect(totals.totals).toMatchObject({ input_tokens: 30_000, events: 2 });
    // an agent reports its own usage only; others need a pull request that exists
    expect(
      await errorCode(
        await call(
          'POST',
          '/usage',
          { repo: 'acme/app', agent_id: 'agt_other' },
          factory.bearer,
        ),
        403,
      ),
    ).toBe('forbidden');
    expect(
      await errorCode(await call('POST', '/usage', { repo: 'acme/app', pull: 999 }), 404),
    ).toBe('pull_not_found');
  });

  it('keeps a correction from lifting a budget', async () => {
    const factory = await agent('factory', 'contents:write', 'acme');
    const day = Date.UTC(2026, 0, 5);
    await recordUsage(dbEnv, [
      {
        id: 'builtin-1',
        repo: { id: repoId, owner_kind: 'org', owner_id: 'o1' },
        agent_id: factory.id,
        kind: 'tokens',
        source: 'workers_ai',
        model: 'gpt-x',
        input_tokens: 1_000,
        usd_micros: 5_000,
        at: day,
      },
    ]);
    const correct = (body: Record<string, unknown>, headers = factory.bearer) =>
      call('POST', '/usage', { repo: 'acme/app', ...body }, headers);
    // the metered agent and a repo writer who does not own the repo cannot
    // correct an event they did not report
    for (const headers of [factory.bearer, owner.headers])
      expect(
        await errorCode(
          await correct(
            {
              correction_of: 'builtin-1',
              input_tokens: -1_000_000_000_000,
              usd_micros: -1_000_000_000_000,
            },
            headers,
          ),
          403,
        ),
      ).toBe('forbidden');
    // its reporter can correct an event, but not below zero
    const own = await json<{ event: { id: string } }>(
      await correct({ model: 'gpt-x', input_tokens: 100, usd_micros: 50 }),
      201,
    );
    for (const body of [
      { input_tokens: -101 },
      { usd_micros: -51 },
      { input_tokens: -1_000_000_000_000, usd_micros: -1_000_000_000_000 },
    ])
      expect(
        await errorCode(await correct({ correction_of: own.event.id, ...body }), 400),
      ).toBe('invalid_request');
    const fix = await json<{ event: { id: string } }>(
      await correct({ correction_of: own.event.id, input_tokens: -60, usd_micros: -30 }),
      201,
    );
    expect(
      await errorCode(
        await correct({ correction_of: own.event.id, input_tokens: -41 }),
        400,
      ),
    ).toBe('invalid_request');
    expect(await errorCode(await correct({ correction_of: fix.event.id }), 400)).toBe(
      'invalid_request',
    );
    // the repo's org admin can correct any event; it keeps the event's agent and day
    await json(
      await correct(
        { correction_of: 'builtin-1', input_tokens: -1_000, usd_micros: -5_000 },
        ada.headers,
      ),
      201,
    );
    expect(
      await q1(
        dbEnv,
        "SELECT agent_id, source, at FROM usage_events WHERE correction_of = 'builtin-1'",
      ),
    ).toEqual({ agent_id: factory.id, source: 'reported', at: day });
    expect(
      await q1(
        dbEnv,
        `SELECT SUM(input_tokens) AS tokens, SUM(usd_micros) AS usd FROM usage_daily
          WHERE agent_id = ?`,
        [factory.id],
      ),
    ).toEqual({ tokens: 40, usd: 20 });
  });

  it('reports cost per merged pull request', async () => {
    await recordUsage(dbEnv, [
      {
        repo: { id: repoId, owner_kind: 'org', owner_id: 'o1' },
        pull_id: pullId,
        kind: 'tokens',
        source: 'reported',
        model: 'gpt-x',
        input_tokens: 10,
        usd_micros: 5_000,
      },
    ]);
    await run(
      dbEnv,
      "UPDATE pull_requests SET state = 'merged', merged_at = ? WHERE id = ?",
      [Date.now(), pullId],
    );
    const report = await json<{
      merged_pulls: number;
      usd_micros_per_merged_pull: number;
      rows: { merged: boolean }[];
    }>(await call('GET', '/repos/acme/app/usage?group_by=pull'));
    expect(report).toMatchObject({
      merged_pulls: 1,
      usd_micros_per_merged_pull: 5_000,
      rows: [{ merged: true }],
    });
  });

  it('records CI compute when a run completes, once', async () => {
    await run(
      dbEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state,
         publish, month, reserved_micros, created_at, started_at, finished_at, context)
       VALUES ('run-1', ?, 'x', 0, '{}', ?, 'passed', 0, '2026-10', 0, 0, 1000, 91500, ?)`,
      [
        repoId,
        owner.userId,
        JSON.stringify({
          event: 'pull_request',
          ref: null,
          pull_id: pullId,
          actor_kind: 'human',
          origin: null,
        }),
      ],
    );
    await emitCiRun(dbEnv, 'run-1', 'completed');
    await emitCiRun(dbEnv, 'run-1', 'completed');
    expect(
      await q(dbEnv, 'SELECT kind, model, quantity, pull_id, run_id FROM usage_events'),
    ).toEqual([
      {
        kind: 'ci_seconds',
        model: 'standard-2',
        quantity: 91,
        pull_id: pullId,
        run_id: 'run-1',
      },
    ]);
    // priced per built-in instance type (#52): standard-4 costs more per second
    await run(
      dbEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state,
         publish, month, reserved_micros, created_at, started_at, finished_at)
       VALUES ('run-2', ?, 'x', 0, '{"instance_type":"standard-4"}', ?, 'passed', 0, '2026-10', 0, 0, 1000, 11000)`,
      [repoId, owner.userId],
    );
    await emitCiRun(dbEnv, 'run-2', 'completed');
    expect(
      await q(
        dbEnv,
        "SELECT model, usd_micros FROM usage_events WHERE kind = 'ci_seconds' ORDER BY run_id",
      ),
    ).toEqual([
      { model: 'standard-2', usd_micros: 91 * 36 },
      { model: 'standard-4', usd_micros: 10 * 112 },
    ]);
  });

  it('records stored bytes per repo once a day', async () => {
    await run(
      dbEnv,
      "INSERT INTO search_repos (repo_id, cs_id, files, bytes, updated_at) VALUES (?, 'x', 3, 2000000000, 0)",
      [repoId],
    );
    // Git LFS (#35) and CI artifacts and caches (#51) count too; unstored ones do not
    await run(
      dbEnv,
      `INSERT INTO lfs_objects (repo_id, oid, size, status, updated_at)
       VALUES (?, 'a', 300000000, 'stored', 0), (?, 'b', 999, 'pending', 0)`,
      [repoId, repoId],
    );
    await run(
      dbEnv,
      `INSERT INTO ci_artifacts (id, repo_id, run_scope, ci_run_id, name, size, object_key, created_at, expires_at)
       VALUES ('art', ?, 'p', 'r', 'dist', 200000000, 'k', 0, 1)`,
      [repoId],
    );
    await run(
      dbEnv,
      `INSERT INTO ci_caches (id, repo_id, scope, key, state, size, object_key, ci_run_id, created_at, last_used_at)
       VALUES ('c1', ?, 'refs/heads/main', 'npm', 'ready', 500000000, 'k1', 'r', 0, 0),
              ('c2', ?, 'refs/heads/main', 'pnpm', 'pending', 7, 'k2', 'r', 0, 0)`,
      [repoId, repoId],
    );
    await recordStorageUsage(dbEnv, Date.parse('2026-10-16T01:00:00Z'));
    await recordStorageUsage(dbEnv, Date.parse('2026-10-16T02:00:00Z'));
    expect(
      await q(
        dbEnv,
        "SELECT quantity, usd_micros FROM usage_events WHERE kind = 'storage'",
      ),
    ).toEqual([{ quantity: 3_000_000_000, usd_micros: 1_500 }]);
  });

  it('alerts once per level and stops new claims at the hard limit', async () => {
    const worker = await agent('worker');
    const issue = await json<{ issue: { number: number } }>(
      await call('POST', '/repos/acme/app/issues', { title: 'Task' }),
      201,
    );
    await json(
      await call('PUT', `/repos/acme/app/work/${issue.issue.number}`, {
        readiness: 'ready',
        risk: 'low',
      }),
    );
    // agents never set budgets, their own least of all
    expect(
      await errorCode(
        await call(
          'PUT',
          '/usage/budgets',
          { agent: worker.id, metric: 'tokens', period: 'day', hard_limit: 1 },
          worker.bearer,
        ),
        403,
      ),
    ).toBe('forbidden');
    await json(
      await call('PUT', '/usage/budgets', {
        agent: worker.id,
        metric: 'tokens',
        period: 'day',
        soft_limit: 500,
        hard_limit: 1_000,
      }),
    );
    const report = (tokens: number) =>
      call(
        'POST',
        '/usage',
        { repo: 'acme/app', model: 'gpt-x', input_tokens: tokens },
        worker.bearer,
      );
    await json(await report(600), 201);
    await json(await report(100), 201);
    expect(await q(dbEnv, 'SELECT level, used, notify FROM usage_alerts')).toEqual([
      { level: 'soft', used: 600, notify: `user:${owner.userId}` },
    ]);
    await json(await report(400), 201);
    const alerts = await q<{ level: string }>(
      dbEnv,
      'SELECT level FROM usage_alerts ORDER BY at',
    );
    expect(alerts.map((a) => a.level)).toEqual(['soft', 'hard']);
    expect(
      (
        await q<{ action: string }>(
          dbEnv,
          "SELECT action FROM audit_events WHERE action LIKE 'usage.%' ORDER BY id",
        )
      ).map((r) => r.action),
    ).toEqual(['usage.budget.set', 'usage.budget.alert', 'usage.budget.alert']);

    const denied = await call('POST', '/repos/acme/app/work/claim', {}, worker.bearer);
    const body = await json<{ error: { code: string; budget: { used: number } } }>(
      denied,
      403,
    );
    expect(body.error.code).toBe('budget_exceeded');
    expect(body.error.budget.used).toBe(1_100);
    // the item stays claimable by others
    expect(
      await q1(dbEnv, 'SELECT readiness FROM work_items WHERE claimed_by IS NULL'),
    ).toEqual({ readiness: 'ready' });

    const listed = await json<{ budgets: { used: number; hard_limit: number }[] }>(
      await call('GET', `/usage/budgets?agent=${worker.id}`),
    );
    expect(listed.budgets).toEqual([
      expect.objectContaining({ used: 1_100, hard_limit: 1_000 }),
    ]);
  });

  it('keeps rollups equal to the raw events over a month of synthetic data', async () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    const agents = ['agt_a', 'agt_b', null];
    const models = [
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      'gpt-x',
      'claude-subscription',
    ];
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let day = 0; day < 30; day++) {
      const events = Array.from({ length: 6 }, (_, i) => ({
        repo: { id: repoId, owner_kind: 'org' as const, owner_id: 'o1' },
        agent_id: agents[next(3)] ?? null,
        kind: i === 5 ? ('ci_seconds' as const) : ('tokens' as const),
        source: 'reported' as const,
        model: i === 5 ? 'builtin' : models[next(3)]!,
        input_tokens: i === 5 ? 0 : next(5000),
        output_tokens: i === 5 ? 0 : next(800),
        cached_tokens: i === 5 ? 0 : next(3000),
        quantity: i === 5 ? next(600) : 0,
        at: start + day * 86_400_000 + next(86_400_000),
      }));
      await recordUsage(dbEnv, events);
    }
    const key = `strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, COALESCE(agent_id, '') AS agent_id,
      kind, COALESCE(model, '') AS model`;
    const raw = await q(
      dbEnv,
      `SELECT ${key}, COUNT(*) AS events, SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens,
         SUM(quantity) AS quantity, SUM(COALESCE(usd_micros, 0)) AS usd_micros,
         SUM(usd_micros IS NULL) AS unpriced
       FROM usage_events GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
    );
    const rolled = await q(
      dbEnv,
      `SELECT day, agent_id, kind, model, events, input_tokens, output_tokens, cached_tokens,
         quantity, usd_micros, unpriced FROM usage_daily ORDER BY 1, 2, 3, 4`,
    );
    expect(raw.length).toBeGreaterThan(30);
    expect(rolled).toEqual(raw);

    const sums = await q1<{ input: number; usd: number }>(
      dbEnv,
      'SELECT SUM(input_tokens) AS input, SUM(COALESCE(usd_micros, 0)) AS usd FROM usage_events',
    );
    const month = await json<{
      totals: { input_tokens: number; usd_micros: number; events: number };
      rows: unknown[];
    }>(
      await call(
        'GET',
        '/orgs/acme/usage?from=2026-09-01&to=2026-09-30',
        undefined,
        ada.headers,
      ),
    );
    expect(month.totals).toMatchObject({
      input_tokens: sums!.input,
      usd_micros: sums!.usd,
      events: 180,
    });
    expect(month.rows).toHaveLength(30);

    const exported = await call(
      'GET',
      '/repos/acme/app/usage?from=2026-09-01&to=2026-09-30&group_by=model&format=csv',
    );
    expect(exported.headers.get('content-type')).toContain('text/csv');
    const lines = (await exported.text()).trim().split('\r\n');
    expect(lines[0]).toBe(
      'key,repo,label,merged,events,input_tokens,output_tokens,cached_tokens,ci_seconds,storage_byte_days,usd_micros,unpriced',
    );
    expect(lines).toHaveLength(1 + 4);
  });

  it('hides reports from people outside the org or agent', async () => {
    const stranger = await loginAs(testEnv, 1299, 'stranger');
    expect(
      await errorCode(
        await call('GET', '/orgs/acme/usage', undefined, stranger.headers),
        404,
      ),
    ).toBe('org_not_found');
    const worker = await agent('worker');
    expect(
      await errorCode(
        await call('GET', `/agents/${worker.id}/usage`, undefined, stranger.headers),
        404,
      ),
    ).toBe('agent_not_found');
    expect(
      await errorCode(
        await call('GET', '/usage/budgets?org=acme', undefined, stranger.headers),
        404,
      ),
    ).toBe('org_not_found');
    expect(
      await errorCode(
        await call('GET', '/repos/acme/app/usage?from=2026-10-02&to=2026-10-01'),
        400,
      ),
    ).toBe('invalid_range');
  });
});
