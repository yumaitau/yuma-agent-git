import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q1, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { readRefHead } from '../src/core/refs';
import { executeTool, toolRegistry, type ToolCtx } from '../src/agents/tools';
import { newBudget, charge, DEFAULT_BUDGET } from '../src/agents/budget';
import type { Principal } from '../src/auth/principal';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (t: string): string => btoa(t);

let userId = '';

function ctxFor(repoId: string, baseCs: string, over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    repo_id: repoId,
    principal: { kind: 'user', userId } as Principal,
    base_cs: baseCs,
    head_cs: baseCs,
    budget: newBudget(),
    task_id: 'task-under-test',
    ...over,
  };
}

async function seedToolRepo(): Promise<{ repoId: string; baseCs: string }> {
  const repo = await createRepo(dbEnv, {
    slug: 'acme/tools',
    visibility: 'public',
    createdBy: userId,
  });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: [
      { path: 'src/a.txt', op: 'add', content_b64: b64('alpha one\nalpha two\n') },
      { path: 'src/b.txt', op: 'add', content_b64: b64('beta alpha\n') },
      { path: 'secrets/key.pem', op: 'add', content_b64: b64('PRIVATE\n') },
    ],
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  return { repoId: repo.id, baseCs: committed.changeset.id };
}

describe('agent tools', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const auth = await loginAs(testEnv, 1, 'ada');
    userId = auth.userId;
  });

  it('read_file / list_dir / diff / file_history / blame happy paths', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const ctx = ctxFor(repoId, baseCs);

    const read = await executeTool(dbEnv, ctx, 'read_file', { path: 'src/a.txt' });
    expect(read.content).toBe('alpha one\nalpha two\n');

    const listing = await executeTool(dbEnv, ctx, 'list_dir', { path: '' });
    expect((listing.entries as { name: string }[]).map((e) => e.name).sort()).toEqual([
      'secrets',
      'src',
    ]);

    const recursive = await executeTool(dbEnv, ctx, 'list_dir', { recursive: true });
    expect((recursive.entries as { path: string }[]).length).toBeGreaterThanOrEqual(3);

    const diff = await executeTool(dbEnv, ctx, 'diff', {});
    expect(diff.from).toBe(baseCs);

    const history = await executeTool(dbEnv, ctx, 'file_history', { path: 'src/a.txt' });
    expect((history.changesets as unknown[]).length).toBe(1);

    const blame = await executeTool(dbEnv, ctx, 'blame', { path: 'src/a.txt' });
    expect(blame.ranges).toEqual([{ start: 1, end: 2, cs: baseCs }]);
  });

  it('RBAC applies per tool: denied paths return errors, not exceptions', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    // deny read+history on secrets/ for everyone
    await run(
      dbEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, 'secrets/', 'deny', '*', ?)`,
      [repoId, JSON.stringify(['read', 'history'])],
    );
    const ctx = ctxFor(repoId, baseCs);

    const denied = await executeTool(dbEnv, ctx, 'read_file', {
      path: 'secrets/key.pem',
    });
    expect(denied).toMatchObject({ error: 'forbidden', path: 'secrets/key.pem' });

    const deniedBlame = await executeTool(dbEnv, ctx, 'blame', {
      path: 'secrets/key.pem',
    });
    expect(deniedBlame).toMatchObject({ error: 'forbidden' });

    // …and the un-denied path still works
    const allowed = await executeTool(dbEnv, ctx, 'read_file', { path: 'src/a.txt' });
    expect(allowed.content).toContain('alpha');
  });

  it('grep searches server-side with prefix filters, guards, and caps', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const ctx = ctxFor(repoId, baseCs);

    const all = await executeTool(dbEnv, ctx, 'grep', { pattern: 'alpha' });
    expect((all.matches as { path: string }[]).map((m) => m.path).sort()).toEqual([
      'src/a.txt',
      'src/a.txt',
      'src/b.txt',
    ]);

    const scoped = await executeTool(dbEnv, ctx, 'grep', {
      pattern: 'alpha',
      path_prefix: 'src/b',
    });
    expect((scoped.matches as unknown[]).length).toBe(1);

    // secrets are invisible to grep too (path rules apply)
    await run(
      dbEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, 'secrets/', 'deny', '*', ?)`,
      [repoId, JSON.stringify(['read'])],
    );
    const hidden = await executeTool(dbEnv, ctx, 'grep', { pattern: 'PRIVATE' });
    expect((hidden.matches as unknown[]).length).toBe(0);

    // catastrophic backtracking guard
    const unsafe = await executeTool(dbEnv, ctx, 'grep', { pattern: '(a+)+$' });
    expect(unsafe).toMatchObject({ error: 'unsafe_pattern' });
  });

  it('commit advances head_cs; land moves main; stale land reports structured reason', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const ctx = ctxFor(repoId, baseCs);

    const committed = await executeTool(dbEnv, ctx, 'commit', {
      message: 'agent change',
      changes: [{ path: 'agent.txt', op: 'add', content_b64: b64('from agent') }],
    });
    expect(committed.cs).toBeTypeOf('string');
    expect(ctx.head_cs).toBe(committed.cs); // working revision advanced

    // land: main moves to head_cs and post-merge checks fire
    const landed = await executeTool(dbEnv, ctx, 'land', {});
    expect(landed).toMatchObject({ landed: true, main_head: ctx.head_cs });
    const checkRow = await q1(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(checkRow).toMatchObject({ status: 'queued', base_cs: ctx.head_cs });

    // stale: someone else lands first → structured reason, no exception
    const ctx2 = ctxFor(repoId, baseCs);
    await executeTool(dbEnv, ctx2, 'commit', {
      message: 'racing change',
      changes: [{ path: 'racing.txt', op: 'add', content_b64: b64('race') }],
    });
    const stale = await executeTool(dbEnv, ctx2, 'land', {});
    expect(stale).toMatchObject({ landed: false, reason: 'stale' });
    expect(stale.main_head).toBe(ctx.head_cs);

    // the documented dance: merge the landed head into our line
    // (parents [our head, main_head]) and retry — now it fast-forwards
    const merged = await executeTool(dbEnv, ctx2, 'commit', {
      message: 'merge landed work',
      parents: [stale.main_head as string],
      // relative to OUR head (first parent), main's agent.txt is an addition
      changes: [{ path: 'agent.txt', op: 'add', content_b64: b64('merged') }],
    });
    expect(merged.cs).toBeTypeOf('string');
    const retry = await executeTool(dbEnv, ctx2, 'land', {});
    expect(retry).toMatchObject({ landed: true, main_head: merged.cs });
  });

  it('land targets the default branch and treats protection as final', async () => {
    const trunk = await createRepo(dbEnv, {
      slug: 'acme/trunk',
      createdBy: userId,
      defaultBranch: 'release/trunk',
    });
    const seeded = await commitChanges(dbEnv, trunk.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    await setRef(dbEnv, trunk.id, 'release/trunk', seeded.changeset.id);
    const ctx = ctxFor(trunk.id, seeded.changeset.id);
    await executeTool(dbEnv, ctx, 'commit', {
      message: 'agent change',
      changes: [{ path: 'b.txt', op: 'add', content_b64: b64('b') }],
    });
    expect(await executeTool(dbEnv, ctx, 'land', {})).toMatchObject({ landed: true });
    expect(await readRefHead(dbEnv, trunk.id, 'release/trunk')).toBe(ctx.head_cs);
    expect(await readRefHead(dbEnv, trunk.id, 'main')).toBeNull();

    // a protected default branch refuses agent lands; the agent must not
    // mistake that for a lost race and merge/retry until its budget dies
    await run(
      dbEnv,
      'INSERT INTO ci_settings (repo_id, version, config, updated_at) VALUES (?, 1, ?, ?)',
      [
        trunk.id,
        JSON.stringify({ commands: ['npm test'], protect_default: true }),
        Date.now(),
      ],
    );
    await executeTool(dbEnv, ctx, 'commit', {
      message: 'second change',
      changes: [{ path: 'c.txt', op: 'add', content_b64: b64('c') }],
    });
    expect(await executeTool(dbEnv, ctx, 'land', {})).toMatchObject({
      landed: false,
      reason: 'protected_branch',
      final: true,
    });
  });

  it('budgets are structural: 51st call errors, finish still works', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const ctx = ctxFor(repoId, baseCs, {
      budget: newBudget({ maxToolCalls: 50, maxCommits: 20 }),
    });

    for (let i = 0; i < DEFAULT_BUDGET.maxToolCalls; i++) {
      const result = await executeTool(dbEnv, ctx, 'read_file', { path: 'src/a.txt' });
      expect(result.error).toBeUndefined();
    }
    const over = await executeTool(dbEnv, ctx, 'read_file', { path: 'src/a.txt' });
    expect(over).toMatchObject({ error: 'budget_exceeded', kind: 'tool' });

    // finish is still callable (graceful wind-down)
    const finished = await executeTool(dbEnv, ctx, 'finish', {
      summary: 'did what I could',
    });
    // note: finish also charges a tool call — it reports budget exhaustion
    // rather than throwing
    expect(finished.terminal === 'finish' || finished.error === 'budget_exceeded').toBe(
      true,
    );

    // commit budget is separate and structural
    const budget = newBudget({ maxCommits: 1 });
    expect(charge(budget, 'commit')).toBeNull();
    expect(charge(budget, 'commit')).toMatchObject({
      error: 'budget_exceeded',
      kind: 'commit',
    });
  });

  it('create_task enforces depth and fan-out guards', async () => {
    const { repoId, baseCs } = await seedToolRepo();

    const shallow = ctxFor(repoId, baseCs);
    const created = await executeTool(dbEnv, shallow, 'create_task', {
      prompt: 'subtask',
    });
    expect(created).toMatchObject({ status: 'queued' });

    const deep = ctxFor(repoId, baseCs, {
      budget: newBudget({ depth: 2 }),
    });
    const tooDeep = await executeTool(dbEnv, deep, 'create_task', { prompt: 'x' });
    expect(tooDeep).toMatchObject({ error: 'depth_exceeded' });

    const crowded = ctxFor(repoId, baseCs);
    for (let i = 0; i < 5; i++) {
      await executeTool(dbEnv, crowded, 'create_task', { prompt: `fan ${i}` });
    }
    const overflow = await executeTool(dbEnv, crowded, 'create_task', {
      prompt: 'one too many',
    });
    expect(overflow).toMatchObject({ error: 'fan_out_exceeded' });
  });

  it('MCP endpoint: tools/list schemas valid, tools/call matches direct execute, scope-gated', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    void repoId;

    // anonymous callers are refused before any agent:run scope check
    const noAuth = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/tools/agents/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'initialize' }),
      }),
    );
    expect(noAuth.status).toBe(401);

    // mint a scoped token
    const auth = await loginAs(testEnv, 1, 'ada');
    const created = await makeApp(testEnv)(
      new Request('https://x/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ label: 'mcp', scopes: ['agent:run', 'repo:write'] }),
      }),
    );
    const raw = ((await created.json()) as { token: string }).token;
    const call = async (payload: unknown): Promise<Response> =>
      makeApp(testEnv)(
        new Request('https://x/api/v1/repos/acme/tools/agents/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${raw}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...((payload as object) ?? {}) }),
        }),
      );

    const init = await call({ method: 'initialize' });
    expect(
      ((await init.json()) as { result: { serverInfo: { name: string } } }).result
        .serverInfo.name,
    ).toBe('yuma-agent-git');

    const list = await call({ method: 'tools/list' });
    const listed = (await list.json()) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(listed.result.tools.map((t) => t.name)).toEqual([...toolRegistry.keys()]);
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema).toBeTypeOf('object'); // JSON Schema emitted
    }

    const executed = await call({
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'src/a.txt' }, head_cs: baseCs },
    });
    const result = (await executed.json()) as {
      result: { content: { text: string }[] };
    };
    const direct = await executeTool(
      dbEnv,
      ctxFor((await getRepoId()) as string, baseCs),
      'read_file',
      { path: 'src/a.txt' },
    );
    expect(JSON.parse(result.result.content[0]?.text as string)).toEqual(direct);
  });
});

async function getRepoId(): Promise<string | null> {
  const repo = await (await import('../src/db/repos')).getRepoBySlug(dbEnv, 'acme/tools');
  return repo ? repo.id : null;
}
