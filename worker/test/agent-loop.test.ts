import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, q1, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { setChatProvider, type ChatResult } from '../src/agents/llm';
import { POST_MERGE_FIX_MARKER, TOOL_NUDGE } from '../src/agents/prompt';
import { recordMetric } from '../src/agents/superfan';
import { buildMessages } from '../src/agents/llm';
import {
  POST_MERGE_MAX_TOOL_CALLS,
  newBudget,
  type TaskBudget,
} from '../src/agents/budget';
import { superfanName } from '../src/agents/superfan';
import type { YagAgent } from '../src/agents/runtime';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (t: string): string => btoa(t);

interface AgentStub {
  runTask(taskId: string, opts?: Record<string, unknown>): Promise<unknown>;
  cancel(taskId?: string): Promise<{ ok: true }>;
  getStateSnapshot(): Promise<{
    status: string;
    head_cs: string;
    base_cs: string;
    transcript: { kind: string; name?: string; text?: string; output?: unknown }[];
    error?: string;
    cancelled?: boolean;
    budget?: TaskBudget;
    turn?: number;
  }>;
}

function stubFor(taskId: string): AgentStub {
  return testEnv.AGENT.get(testEnv.AGENT.idFromName(taskId)) as unknown as AgentStub;
}

/** Scripted model: returns each queued response once, in order. */
function scriptModel(script: (ChatResult | Error)[]): {
  seen: { messages: unknown[] }[];
} {
  const seen: { messages: unknown[] }[] = [];
  let index = 0;
  setChatProvider(async (_env, input) => {
    seen.push({ messages: input.messages as unknown[] });
    const next = script[Math.min(index, script.length - 1)];
    index++;
    if (next instanceof Error) throw next;
    return next as ChatResult;
  });
  return { seen };
}

const call = (name: string, args: Record<string, unknown> = {}): ChatResult => ({
  tool_calls: [{ name, arguments: args }],
});

afterEach(() => {
  setChatProvider(null);
});

async function seedAgentRepo(
  slug = 'acme/loop',
  visibility: 'public' | 'private' = 'public',
): Promise<{
  repoId: string;
  baseCs: string;
  taskId: string;
  userId: string;
}> {
  const auth = await loginAs(testEnv, 1, 'ada');
  const repo = await createRepo(dbEnv, {
    slug,
    visibility,
    createdBy: auth.userId,
    githubInstallationId: 42,
    githubRepoId: 777,
  });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: [{ path: 'src/a.txt', op: 'add', content_b64: b64('alpha\n') }],
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
    [repo.id, auth.userId],
  );
  // unique per test: DO storage outlives cleanDb, and runTask resumes
  // from a persisted state when the task id matches
  const taskId = `task-${crypto.randomUUID()}`;
  const now = Date.now();
  await run(
    dbEnv,
    `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
     VALUES (?, ?, 'freeform', ?, 'queued', ?, ?, ?, ?)`,
    [
      taskId,
      repo.id,
      'add a healthcheck endpoint',
      committed.changeset.id,
      auth.userId,
      now,
      now,
    ],
  );
  return { repoId: repo.id, baseCs: committed.changeset.id, taskId, userId: auth.userId };
}

describe('think-act-observe loop', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('scripted read→commit→land→finish lands work and creates post-merge checks', async () => {
    const { repoId, baseCs, taskId } = await seedAgentRepo();
    scriptModel([
      call('read_file', { path: 'src/a.txt' }),
      call('commit', {
        message: 'add healthcheck',
        changes: [{ path: 'health.txt', op: 'add', content_b64: b64('ok') }],
      }),
      call('land', {}),
      call('finish', { summary: 'added healthcheck' }),
    ]);

    const state = await stubFor(taskId).runTask(taskId);
    const snapshot = await stubFor(taskId).getStateSnapshot();

    // transcript order: attempt note → tool calls/results → terminal
    const kinds = snapshot.transcript.map((e) => `${e.kind}:${e.name ?? ''}`);
    expect(kinds[0]).toContain('note');
    expect(kinds).toContain('tool_call:read_file');
    expect(kinds).toContain('tool_call:commit');
    expect(kinds).toContain('tool_call:land');
    expect(kinds).toContain('tool_call:finish');

    // head advanced past base and main moved
    expect(snapshot.head_cs).not.toBe(baseCs);
    const head = await q1(
      dbEnv,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [repoId],
    );
    expect((head as { head: string }).head).toBe(snapshot.head_cs);

    // post-merge check created by land
    const check = await q1(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(check).toMatchObject({ status: 'queued' });

    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'landed' });
    expect(state).toBeTruthy();
  });

  it('parses text-fenced JSON tool calls and nudges after 3 no-tool turns', async () => {
    const { taskId } = await seedAgentRepo();
    const fenced: ChatResult = {
      content:
        'Let me check the file.\n```json\n{"tool":"read_file","arguments":{"path":"src/a.txt"}}\n```',
      tool_calls: [],
    };
    const garbage: ChatResult = { content: 'hmm, thinking out loud', tool_calls: [] };
    scriptModel([
      fenced,
      garbage,
      garbage,
      garbage,
      call('finish', { summary: 'gave up' }),
    ]);

    const snapshot = (await stubFor(taskId).runTask(taskId)) as {
      transcript: { text?: string }[];
    };
    const notes = (await stubFor(taskId).getStateSnapshot()).transcript.map(
      (e) => e.text,
    );
    expect(notes).toContain(TOOL_NUDGE); // nudge injected
    void snapshot;
  });

  it('turn cap auto-finishes with committed work intact', async () => {
    const { repoId, taskId } = await seedAgentRepo();
    scriptModel([
      call('commit', {
        message: 'partial work',
        changes: [{ path: 'partial.txt', op: 'add', content_b64: b64('p') }],
      }),
      ...Array.from({ length: 12 }, () => ({ content: 'rambling', tool_calls: [] })),
    ]);

    const state = (await stubFor(taskId).runTask(taskId)) as {
      status: string;
      summary?: string;
    };
    const snapshot = await stubFor(taskId).getStateSnapshot();

    // hitting the cap is a failure with a reason, never a fake success
    expect(state.status).toBe('failed');
    expect(snapshot.error).toMatch(/budget exhausted \(llm/);
    // the committed work survived the cap
    const cs = await getChangeset(dbEnv, repoId, snapshot.head_cs);
    expect(cs?.changed_files.map((f) => f.path)).toEqual(['partial.txt']);
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'failed', result_cs: snapshot.head_cs });
  });

  it('stale land → the server merges main in (parents [head, main_head]) and lands', async () => {
    const { repoId, taskId } = await seedAgentRepo();
    // someone else lands first
    const rival = await commitChanges(dbEnv, repoId, {
      first_parent: await headOf(repoId),
      message: 'rival landed',
      author,
      changes: [{ path: 'rival.txt', op: 'add', content_b64: b64('r') }],
    });
    await setRef(dbEnv, repoId, 'main', rival.changeset.id);

    scriptModel([
      call('commit', {
        message: 'my work',
        changes: [{ path: 'mine.txt', op: 'add', content_b64: b64('m') }],
      }),
      call('land', {}),
      call('finish', { summary: 'landed after merge' }),
    ]);

    const state = (await stubFor(taskId).runTask(taskId)) as { status: string };
    expect(state.status).toBe('done');
    const head = await headOf(repoId);
    const landed = await getChangeset(dbEnv, repoId, head);
    expect(landed?.message).toBe('Merge main into agent work\n');
    expect(landed?.parents).toHaveLength(2); // the merge commit
    expect(landed?.parents[1]).toBe(rival.changeset.id);
  });

  it('resume after interruption continues from persisted state without duplicates', async () => {
    const { repoId, taskId } = await seedAgentRepo();
    // first run: read, then the "eviction" kills the run mid-flight
    scriptModel([
      call('read_file', { path: 'src/a.txt' }),
      new Error('simulated eviction'),
    ]);
    await expect(Promise.resolve(stubFor(taskId).runTask(taskId))).rejects.toThrow(
      /eviction/,
    );
    const mid = await stubFor(taskId).getStateSnapshot();
    expect(mid.transcript.some((e) => e.name === 'read_file')).toBe(true);

    // fresh invocation (new stub, same id) resumes: transcript preserved, the
    // commit happens exactly once
    setChatProvider(null);
    scriptModel([
      call('commit', {
        message: 'resumed work',
        changes: [{ path: 'resumed.txt', op: 'add', content_b64: b64('r') }],
      }),
      call('finish', { summary: 'done' }),
    ]);
    const fresh = stubFor(taskId);
    const state = (await fresh.runTask(taskId)) as {
      status: string;
      transcript: unknown[];
    };
    expect(state.status).toBe('done');

    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`,
      [repoId],
    );
    expect(rows).toHaveLength(2); // seed + exactly one commit — no duplicates
    const resumed = await fresh.getStateSnapshot();
    expect(
      resumed.transcript.filter((e) => e.kind === 'tool_call' && e.name === 'read_file'),
    ).toHaveLength(1);
    // budget counters and the turn number carried across the eviction:
    // run 1 spent turns 1–2 (read, then the crash), run 2 turns 3–4
    expect(resumed.turn).toBe(4);
    expect(resumed.budget?.llmTurns).toBe(4);
    expect(resumed.budget?.toolCalls).toBe(3); // read_file, commit, finish
    expect(resumed.budget?.commits).toBe(1);
  });

  it('resume never re-grants a spent budget', async () => {
    const { taskId } = await seedAgentRepo();
    // 9 turns, then the eviction on turn 10
    scriptModel([
      ...Array.from({ length: 9 }, () => call('read_file', { path: 'src/a.txt' })),
      new Error('simulated eviction'),
    ]);
    await expect(Promise.resolve(stubFor(taskId).runTask(taskId))).rejects.toThrow(
      /eviction/,
    );
    // the retry has only the turns left — a fresh budget would allow 10 more
    let resumedCalls = 0;
    setChatProvider(async () => {
      resumedCalls++;
      return call('read_file', { path: 'src/a.txt' });
    });
    const state = (await stubFor(taskId).runTask(taskId)) as {
      status: string;
      error?: string;
    };
    expect(resumedCalls).toBe(0); // turn 10 was the last one, already spent
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/budget exhausted/);
  });

  it('spawned tasks run as the creating user, so they work on private repos', async () => {
    const { repoId, taskId, userId } = await seedAgentRepo(
      'acme/private-loop',
      'private',
    );
    scriptModel([
      call('create_task', { prompt: 'read the readme' }),
      call('finish', { summary: 'spawned' }),
    ]);
    await stubFor(taskId).runTask(taskId);
    const child = await q1<{ id: string; created_by: string }>(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.repoId} = ? AND id != ?`,
      [repoId, taskId],
    );
    expect(child?.created_by).toBe(userId);

    scriptModel([
      call('read_file', { path: 'src/a.txt' }),
      call('finish', { summary: 'read it' }),
    ]);
    await stubFor(child!.id).runTask(child!.id);
    const snapshot = await stubFor(child!.id).getStateSnapshot();
    const result = snapshot.transcript.find(
      (e) => e.kind === 'tool_result' && e.name === 'read_file',
    );
    expect(result?.output).toMatchObject({ content: 'alpha\n' }); // not forbidden
  });

  it('post-merge check: diffs pre-land→landed, 20-call budget, failure opens one fix (no loops)', async () => {
    const { repoId, baseCs, taskId, userId } = await seedAgentRepo('acme/pmc', 'private');
    scriptModel([
      call('commit', {
        message: 'add health',
        changes: [{ path: 'health.txt', op: 'add', content_b64: b64('ok') }],
      }),
      call('land', {}),
      call('finish', { summary: 'landed health' }),
    ]);
    await stubFor(taskId).runTask(taskId);
    const landedCs = await headOf(repoId);
    const check = await q1<{
      id: string;
      prompt: string;
      base_cs: string;
      created_by: string;
    }>(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(check).toMatchObject({ base_cs: baseCs, created_by: userId });

    // the check's model sees the changed files; its diff is non-empty
    const seen = scriptModel([
      call('diff', {}),
      call('report_failure', { reason: 'health.txt should say OK' }),
    ]);
    await stubFor(check!.id).runTask(check!.id);
    expect(JSON.stringify(seen.seen[0]?.messages)).toContain('health.txt');
    const checkState = await stubFor(check!.id).getStateSnapshot();
    expect(checkState.base_cs).toBe(baseCs);
    expect(checkState.head_cs).toBe(landedCs);
    expect(checkState.budget?.maxToolCalls).toBe(POST_MERGE_MAX_TOOL_CALLS);
    const diffResult = checkState.transcript.find(
      (e) => e.kind === 'tool_result' && e.name === 'diff',
    );
    expect(diffResult?.output).toMatchObject({
      files: [{ path: 'health.txt', kind: 'add' }],
    });
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [check!.id]),
    ).toMatchObject({ status: 'failed' });

    // failure → one freeform fix task, same repo, same user, with the findings
    const fix = await q1<{ id: string; prompt: string }>(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.prompt} LIKE ?`,
      [`${POST_MERGE_FIX_MARKER}%`],
    );
    expect(fix).toMatchObject({
      kind: 'freeform',
      repo_id: repoId,
      created_by: userId,
      status: 'queued',
      base_cs: landedCs,
    });
    expect(fix?.prompt).toContain('health.txt should say OK');
    expect(fix?.prompt).toContain(check!.id);

    // the fix lands; its own check fails too — but no second fix is spawned
    scriptModel([
      call('commit', {
        message: 'fix health',
        changes: [{ path: 'health.txt', op: 'mod', content_b64: b64('OK') }],
      }),
      call('land', {}),
      call('finish', { summary: 'fixed' }),
    ]);
    await stubFor(fix!.id).runTask(fix!.id);
    const fixCheck = await q1<{ id: string; prompt: string }>(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check' AND id != ?`,
      [check!.id],
    );
    expect(fixCheck?.prompt).toContain('fix_depth: 1');
    scriptModel([call('report_failure', { reason: 'still wrong' })]);
    await stubFor(fixCheck!.id).runTask(fixCheck!.id);
    const fixes = await q(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.prompt} LIKE ?`,
      [`${POST_MERGE_FIX_MARKER}%`],
    );
    expect(fixes).toHaveLength(1);

    // nothing else was spawned
    expect(
      (
        await q(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.repoId} = ?`, [
          repoId,
        ])
      ).length,
    ).toBe(4); // task, check, fix, fix's check
  });

  it('budget exhaustion fails the task with the reason', async () => {
    const { taskId } = await seedAgentRepo();
    // 10 tool calls per turn × 6 turns → the 51st call overruns the 50-call budget
    scriptModel(
      Array.from({ length: 6 }, () => call('read_file', { path: 'src/a.txt' })).map(
        (r) => ({
          tool_calls: Array.from({ length: 10 }, () => r.tool_calls[0]!),
        }),
      ),
    );
    const state = (await stubFor(taskId).runTask(taskId)) as {
      status: string;
      error?: string;
    };
    expect(state.status).toBe('failed');
    expect(state.error).toBe('budget exhausted (tool)');
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'failed' });
  });

  it('cancel mid-loop: no further tool runs and the row stays cancelled', async () => {
    const { repoId, taskId } = await seedAgentRepo();
    let calls = 0;
    let release = false;
    setChatProvider(async () => {
      calls++;
      if (calls === 1) return call('read_file', { path: 'src/a.txt' });
      while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
      return call('commit', {
        message: 'should never happen',
        changes: [{ path: 'late.txt', op: 'add', content_b64: b64('late') }],
      });
    });
    const stub = stubFor(taskId);
    const running = stub.runTask(taskId);
    for (let i = 0; i < 200 && calls < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stub.cancel();
    release = true;
    await running;

    const snapshot = await stub.getStateSnapshot();
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.transcript.some((e) => e.name === 'commit')).toBe(false);
    const rows = await q(dbEnv, `SELECT * FROM ${T.changesets} WHERE repo_id = ?`, [
      repoId,
    ]);
    expect(rows).toHaveLength(1); // seed only
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'cancelled' });

    // a redelivery never resurrects a cancelled task
    scriptModel([call('finish', { summary: 'zombie' })]);
    await stub.runTask(taskId);
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]),
    ).toMatchObject({
      status: 'cancelled',
    });
  });

  it('deadline alarm mid-loop: a later finish never overwrites the timeout', async () => {
    const { taskId } = await seedAgentRepo();
    let calls = 0;
    let release = false;
    setChatProvider(async () => {
      calls++;
      while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
      return call('finish', { summary: 'too late' });
    });
    const stub = stubFor(taskId);
    const running = stub.runTask(taskId);
    for (let i = 0; i < 200 && calls < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runInDurableObject(
      stub as unknown as DurableObjectStub<YagAgent>,
      (instance: YagAgent) => instance.alarm(),
    );
    release = true;
    await running;

    const snapshot = await stub.getStateSnapshot();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toBe('timeout');
    expect(snapshot.transcript.some((e) => e.name === 'finish')).toBe(false);
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'failed' });
  });

  it('finish is the success signal: a land-less finish still records landed', async () => {
    const { taskId } = await seedAgentRepo();
    scriptModel([
      call('read_file', { path: 'src/a.txt' }),
      call('finish', { summary: 'ok' }),
    ]);
    await stubFor(taskId).runTask(taskId);
    // `landed` is the enum's success state: the agent called finish
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]),
    ).toMatchObject({
      status: 'landed',
    });
  });
});

describe('fix_issue + superfan', () => {
  const realFetch = globalThis.fetch;
  const posted: { url: string; body: unknown }[] = [];

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    posted.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      const url = new URL(req.url);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (req.method === 'POST') {
        const text = await req.text();
        posted.push({
          url: url.pathname,
          body: text ? (JSON.parse(text) as unknown) : undefined,
        });
        return json({ ok: true });
      }
      if (url.pathname.includes('/access_tokens')) {
        return json({
          token: 't',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url.pathname.includes('/issues/')) {
        return json({
          number: 42,
          title: 'Broken widget',
          body: 'widget crashes on load',
        });
      }
      return json({ message: 'not found' }, 404);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setChatProvider(null);
  });

  it('fix_issue embeds the issue body and comments the changeset on finish', async () => {
    const { repoId, baseCs } = await seedAgentRepo('acme/fix');
    const now = Date.now();
    const fixId = `fix-task-${crypto.randomUUID()}`;
    await run(
      dbEnv,
      `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.githubIssue}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
       VALUES (?, ?, 'fix_issue', 'fix it', 'queued', ?, '42', 'ada', ?, ?)`,
      [fixId, repoId, baseCs, now, now],
    );

    const seen = scriptModel([
      call('commit', {
        message: 'fix widget crash',
        changes: [{ path: 'widget.txt', op: 'add', content_b64: b64('fixed') }],
      }),
      call('finish', { summary: 'fixed the widget', result_cs: '' }),
    ]);
    await stubFor(fixId).runTask(fixId);

    // the issue body reached the model
    const promptMessages = JSON.stringify(seen.seen[0]?.messages ?? []);
    expect(promptMessages).toContain('Broken widget');
    expect(promptMessages).toContain('widget crashes on load');

    // export-sync + issue comment on finish
    expect(posted.some((p) => p.url.includes('/issues/42/comments'))).toBe(true);
    const exportRows = await q(dbEnv, `SELECT * FROM ${T.exportJobs}`);
    expect(exportRows.length).toBeGreaterThanOrEqual(1);
  });

  it('superfan flags anomalies (median + 3×MAD) and opens investigation tasks', async () => {
    const { repoId, userId } = await seedAgentRepo('acme/fan', 'private');
    const auth = await loginAs(testEnv, 1, 'ada');
    // seedAgentRepo makes ada a write member — registration needs admin
    await run(
      dbEnv,
      `UPDATE ${T.repoMembers} SET ${C.repoMembers.role} = 'admin' WHERE ${C.repoMembers.userId} = ?`,
      [userId],
    );
    const register = async (cookie: string, slug = 'acme/fan'): Promise<Response> =>
      makeApp(testEnv)(
        new Request(`https://x/api/v1/repos/${slug}/agents/superfans`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ component: 'commit-path', interval_min: 5 }),
        }),
      );

    // the old unscoped route is gone; write members can't register
    const global = await makeApp(testEnv)(
      new Request('https://x/api/v1/agents/superfans', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ component: 'commit-path', interval_min: 5 }),
      }),
    );
    expect(global.status).toBe(404);
    const writer = await loginAs(testEnv, 2, 'wendy');
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
      [repoId, writer.userId],
    );
    expect((await register(writer.cookie)).status).toBe(403);
    expect((await register(auth.cookie, 'acme/missing')).status).toBe(404);

    const created = await register(auth.cookie);
    expect(created.status).toBe(201);

    const stub = testEnv.SUPERFAN.get(
      testEnv.SUPERFAN.idFromName(superfanName(repoId, 'commit-path')),
    ) as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    const checkNow = async (): Promise<{ anomalous: boolean; finding?: string }> =>
      (await (
        await stub.fetch(new Request('https://superfan/check', { method: 'POST' }))
      ).json()) as { anomalous: boolean; finding?: string };

    // seeding the repo commits, which now records a commit-path sample.
    // drop it so the synthetic series below is the whole baseline.
    await run(dbEnv, `DELETE FROM ${T.componentMetrics}`);

    // calm telemetry → no finding
    for (let i = 0; i < 10; i++) {
      await recordMetric(
        dbEnv,
        'commit-path',
        100 + (i % 2),
        Date.now() - (10 - i) * 60_000,
      );
    }
    const calm = await checkNow();
    expect(calm.anomalous).toBe(false);

    // spike → anomaly + finding + investigation task in THIS repo, as the admin
    await recordMetric(dbEnv, 'commit-path', 5000, Date.now());
    const spiked = await checkNow();
    expect(spiked.anomalous).toBe(true);

    const findings = await q(dbEnv, `SELECT * FROM ${T.superfanFindings}`);
    expect(findings).toHaveLength(1);
    const task = await q1(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.prompt} LIKE 'Investigate:%'`,
    );
    expect(task).toMatchObject({
      kind: 'freeform',
      status: 'queued',
      repo_id: repoId,
      created_by: userId,
      base_cs: await headOf(repoId),
    });

    // admin list: the monitor and its findings
    const listed = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/fan/agents/superfans', {
        headers: { cookie: auth.cookie },
      }),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      superfans: { component: string; interval_min: number; created_by: string }[];
      findings: { component: string; task_id: string; finding: string }[];
    };
    expect(body.superfans).toEqual([
      expect.objectContaining({
        component: 'commit-path',
        interval_min: 5,
        created_by: userId,
      }),
    ]);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      component: 'commit-path',
      task_id: (task as { id: string }).id,
    });
    const writerList = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/fan/agents/superfans', {
        headers: { cookie: writer.cookie },
      }),
    );
    expect(writerList.status).toBe(403);

    // stop: the monitor is gone from the list
    const stopped = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/fan/agents/superfans/commit-path', {
        method: 'DELETE',
        headers: { cookie: auth.cookie },
      }),
    );
    expect(await stopped.json()).toEqual({
      ok: true,
      component: 'commit-path',
      stopped: true,
    });
    const after = (await (
      await makeApp(testEnv)(
        new Request('https://x/api/v1/repos/acme/fan/agents/superfans', {
          headers: { cookie: auth.cookie },
        }),
      )
    ).json()) as { superfans: unknown[] };
    expect(after.superfans).toEqual([]);
    expect((await checkNow()).anomalous).toBe(false); // no config, no checks
  });

  it('fix_issue tasks take github_issue at creation and use it', async () => {
    const { repoId } = await seedAgentRepo('acme/issue');
    const auth = await loginAs(testEnv, 1, 'ada');
    const create = async (payload: unknown): Promise<Response> =>
      makeApp(testEnv)(
        new Request('https://x/api/v1/repos/acme/issue/agents/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: auth.cookie },
          body: JSON.stringify(payload),
        }),
      );
    expect(
      (await create({ kind: 'freeform', prompt: 'x', github_issue: 42 })).status,
    ).toBe(400);
    expect(
      (await create({ kind: 'fix_issue', prompt: 'x', github_issue: -1 })).status,
    ).toBe(400);
    const res = await create({ kind: 'fix_issue', prompt: 'fix it', github_issue: 42 });
    expect(res.status).toBe(202);
    const { task_id: fixId } = (await res.json()) as { task_id: string };
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [fixId]),
    ).toMatchObject({
      repo_id: repoId,
      github_issue: '42',
    });

    const seen = scriptModel([call('finish', { summary: 'fixed the widget' })]);
    await stubFor(fixId).runTask(fixId);
    expect(JSON.stringify(seen.seen[0]?.messages ?? [])).toContain(
      'widget crashes on load',
    );
    expect(posted.some((p) => p.url.includes('/issues/42/comments'))).toBe(true);
  });
});

async function headOf(repoId: string): Promise<string> {
  const row = await q1(
    dbEnv,
    `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
    [repoId],
  );
  return (row as { head: string }).head;
}

describe('context assembly', () => {
  it('caps at ~100 KiB and trims the oldest tool results first', () => {
    const transcript = Array.from({ length: 50 }, (_, i) => ({
      t: i,
      kind: i % 2 === 0 ? ('tool_call' as const) : ('tool_result' as const),
      name: 'read_file',
      input: { path: `f${i}.txt` },
      output: { content: 'x'.repeat(3000) },
    }));
    const messages = buildMessages(
      {
        transcript,
        head_cs: 'h'.repeat(64),
        base_cs: 'b'.repeat(64),
        budget: newBudget(),
      },
      'do the thing',
    );
    expect(JSON.stringify(messages).length).toBeLessThanOrEqual(100 * 1024);
    expect(messages[0]?.role).toBe('system');
  });
});
