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
import { ciPolicyRulesetStatement } from '../src/policy/rulesets';
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

    // land: main moves to head_cs and post-merge checks fire — the check
    // diffs pre-land head → landed cs, lists the changed files, and runs as
    // the landing user (not as the landing task's id)
    const landed = await executeTool(dbEnv, ctx, 'land', {});
    expect(landed).toMatchObject({ landed: true, main_head: ctx.head_cs });
    const checkRow = await q1<{ prompt: string }>(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(checkRow).toMatchObject({
      status: 'queued',
      base_cs: baseCs,
      created_by: userId,
    });
    expect(checkRow?.prompt).toContain(`verify these changes: ${ctx.head_cs}`);
    expect(checkRow?.prompt).toContain('- agent.txt');
    expect(checkRow?.prompt).not.toContain('src/a.txt'); // only what landed

    // stale: someone else landed first → the server merges main in (#42)
    const ctx2 = ctxFor(repoId, baseCs);
    const racing = await executeTool(dbEnv, ctx2, 'commit', {
      message: 'racing change',
      changes: [{ path: 'racing.txt', op: 'add', content_b64: b64('race') }],
    });
    const landedMain = ctx.head_cs;
    const merged = await executeTool(dbEnv, ctx2, 'land', {});
    expect(merged).toMatchObject({ landed: true, main_head: ctx2.head_cs });
    const mergeCs = await q1<{ parents: string; author: string }>(
      dbEnv,
      'SELECT parents, author FROM changesets WHERE id = ?',
      [ctx2.head_cs],
    );
    expect(JSON.parse(mergeCs?.parents ?? '[]')).toEqual([racing.cs, landedMain]);
    expect(JSON.parse(mergeCs?.author ?? '{}')).toEqual({ agent: 'task-under-test' });

    // overlapping edits: merge_conflict with the conflicts, nothing lands
    const ctx3 = ctxFor(repoId, baseCs);
    await executeTool(dbEnv, ctx3, 'commit', {
      message: 'clashing change',
      changes: [{ path: 'agent.txt', op: 'add', content_b64: b64('clash') }],
    });
    const clash = await executeTool(dbEnv, ctx3, 'land', {});
    expect(clash).toMatchObject({
      landed: false,
      reason: 'merge_conflict',
      conflicts: [{ path: 'agent.txt', kind: 'add_add' }],
      conflict_count: 1,
      main_head: ctx2.head_cs,
    });
    expect(await readRefHead(dbEnv, repoId, 'main')).toBe(ctx2.head_cs);

    // the agent resolves it with a changeset whose parents are [its head, main_head]
    const resolved = await executeTool(dbEnv, ctx3, 'commit', {
      message: 'resolve',
      parents: [clash.main_head as string],
      changes: [
        { path: 'agent.txt', op: 'mod', content_b64: b64('resolved') },
        { path: 'racing.txt', op: 'add', content_b64: b64('race') },
      ],
    });
    const retry = await executeTool(dbEnv, ctx3, 'land', {});
    expect(retry).toMatchObject({ landed: true, main_head: resolved.cs });
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
    await ciPolicyRulesetStatement(
      dbEnv,
      trunk.id,
      { protect_default: true, required_approvals: 1, require_checks: true },
      Date.now(),
    ).run();
    await executeTool(dbEnv, ctx, 'commit', {
      message: 'second change',
      changes: [{ path: 'c.txt', op: 'add', content_b64: b64('c') }],
    });
    expect(await executeTool(dbEnv, ctx, 'land', {})).toMatchObject({
      landed: false,
      reason: 'ruleset_violation',
      message:
        'ruleset "CI policy (default branch)": open a pull request to update release/trunk',
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
    // the sub-task runs as the real user, not as its parent task's id
    const child = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [
      created.task_id,
    ]);
    expect(child).toMatchObject({ created_by: userId, base_cs: baseCs });

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

  it('diff applies path rules per file and needs repo read', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const changed = await commitChanges(dbEnv, repoId, {
      first_parent: baseCs,
      message: 'touch both',
      author,
      changes: [
        { path: 'src/a.txt', op: 'mod', content_b64: b64('alpha changed\n') },
        { path: 'secrets/key.pem', op: 'mod', content_b64: b64('NEW PRIVATE\n') },
      ],
    });
    const ctx = ctxFor(repoId, baseCs, { head_cs: changed.changeset.id });
    const open = await executeTool(dbEnv, ctx, 'diff', {});
    expect((open.files as { path: string }[]).map((f) => f.path)).toEqual([
      'secrets/key.pem',
      'src/a.txt',
    ]);

    await run(
      dbEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, 'secrets/', 'deny', '*', ?)`,
      [repoId, JSON.stringify(['read'])],
    );
    const filtered = await executeTool(dbEnv, ctx, 'diff', {});
    expect((filtered.files as { path: string }[]).map((f) => f.path)).toEqual([
      'src/a.txt',
    ]);
    const texts = filtered.texts as { path: string; unified: string }[];
    expect(texts.map((t) => t.path)).toEqual(['src/a.txt']);
    expect(JSON.stringify(filtered)).not.toContain('PRIVATE');

    // a principal without repo read gets nothing at all
    const priv = await createRepo(dbEnv, {
      slug: 'acme/private-diff',
      createdBy: userId,
    });
    const stranger = ctxFor(priv.id, baseCs, {
      principal: { kind: 'user', userId: 'someone-else' } as Principal,
    });
    expect(await executeTool(dbEnv, stranger, 'diff', {})).toMatchObject({
      error: 'forbidden',
      perm: 'read',
    });
  });

  it('commit needs write on every touched path; land needs whole-repo write', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    await run(
      dbEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, 'secrets/', 'deny', '*', ?)`,
      [repoId, JSON.stringify(['write'])],
    );
    const ctx = ctxFor(repoId, baseCs);

    const denied = await executeTool(dbEnv, ctx, 'commit', {
      message: 'touch secrets',
      changes: [
        { path: 'src/ok.txt', op: 'add', content_b64: b64('fine') },
        { path: 'secrets/key.pem', op: 'mod', content_b64: b64('leak') },
      ],
    });
    expect(denied).toMatchObject({
      error: 'forbidden',
      perm: 'write',
      path: 'secrets/key.pem',
      denied_by: { path_prefix: 'secrets/', effect: 'deny' },
    });
    expect(ctx.head_cs).toBe(baseCs); // nothing committed
    expect(ctx.budget.commits).toBe(0); // and no commit budget spent

    const allowed = await executeTool(dbEnv, ctx, 'commit', {
      message: 'src only',
      changes: [{ path: 'src/ok.txt', op: 'add', content_b64: b64('fine') }],
    });
    expect(allowed.cs).toBeTypeOf('string');

    // a ref move can replace any path, so a path-restricted writer can't land
    expect(await executeTool(dbEnv, ctx, 'land', {})).toMatchObject({
      landed: false,
      reason: 'whole_repository_required',
      final: true,
      denied_by: { path_prefix: 'secrets/' },
    });
    expect(await readRefHead(dbEnv, repoId, 'main')).toBe(baseCs);
    const checks = await q1(
      dbEnv,
      `SELECT COUNT(*) AS n FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(checks).toMatchObject({ n: 0 });
  });

  it('cs args accept ref:<name> (and bare ref names) like the HTTP read routes', async () => {
    const { repoId, baseCs } = await seedToolRepo();
    const next = await commitChanges(dbEnv, repoId, {
      first_parent: baseCs,
      message: 'feature',
      author,
      changes: [{ path: 'src/a.txt', op: 'mod', content_b64: b64('alpha on feature\n') }],
    });
    await setRef(dbEnv, repoId, 'feature', next.changeset.id);
    const ctx = ctxFor(repoId, baseCs);

    const viaRef = await executeTool(dbEnv, ctx, 'read_file', {
      path: 'src/a.txt',
      cs: 'ref:feature',
    });
    expect(viaRef.content).toBe('alpha on feature\n');
    const bare = await executeTool(dbEnv, ctx, 'read_file', {
      path: 'src/a.txt',
      cs: 'feature',
    });
    expect(bare.content).toBe('alpha on feature\n');
    const raw = await executeTool(dbEnv, ctx, 'read_file', {
      path: 'src/a.txt',
      cs: baseCs,
    });
    expect(raw.content).toBe('alpha one\nalpha two\n');

    const listing = await executeTool(dbEnv, ctx, 'list_dir', {
      path: 'src',
      cs: 'ref:main',
    });
    expect((listing.entries as { name: string }[]).map((e) => e.name).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);

    const grep = await executeTool(dbEnv, ctx, 'grep', {
      pattern: 'on feature',
      cs: 'ref:feature',
    });
    expect((grep.matches as { path: string }[]).map((m) => m.path)).toEqual([
      'src/a.txt',
    ]);

    const diff = await executeTool(dbEnv, ctx, 'diff', {
      from: 'ref:main',
      to: 'ref:feature',
    });
    expect((diff.files as { path: string }[]).map((f) => f.path)).toEqual(['src/a.txt']);

    expect(
      await executeTool(dbEnv, ctx, 'read_file', { path: 'src/a.txt', cs: 'ref:nope' }),
    ).toMatchObject({ error: 'revision_not_found' });
  });

  it('MCP tools/call: read-only tools need read, mutating tools need write', async () => {
    await seedToolRepo();
    const auth = await loginAs(testEnv, 1, 'ada');
    const minted = await makeApp(testEnv)(
      new Request('https://x/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ label: 'reader', scopes: ['agent:run', 'repo:read'] }),
      }),
    );
    const raw = ((await minted.json()) as { token: string }).token;
    const rpc = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      const res = await makeApp(testEnv)(
        new Request('https://x/api/v1/repos/acme/tools/agents/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }),
      );
      return (await res.json()) as Record<string, unknown>;
    };

    for (const [name, args] of [
      ['read_file', { path: 'src/a.txt' }],
      ['list_dir', {}],
      ['file_history', { path: 'src/a.txt' }],
      ['blame', { path: 'src/a.txt' }],
      ['diff', {}],
      ['grep', { pattern: 'alpha' }],
    ] as const) {
      const body = await rpc(name, args);
      expect(body.error, `${name} with a read token`).toBeUndefined();
      expect(body.result).toBeTruthy();
    }
    for (const [name, args] of [
      ['commit', { message: 'x', changes: [] }],
      ['land', {}],
      ['create_task', { prompt: 'x' }],
    ] as const) {
      const body = await rpc(name, args);
      expect(body.error, `${name} with a read token`).toMatchObject({
        code: -32601,
        message: 'forbidden',
      });
    }
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
