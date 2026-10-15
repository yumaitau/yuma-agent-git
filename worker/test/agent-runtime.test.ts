import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentQueues, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { parseAgentTaskRow, q1, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { agentJobsQueue, type AgentJobMessage } from '../src/queues/agentJobs';
import type { AgentState, RunTaskOptions } from '../src/agents/runtime';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

interface AgentStub {
  runTask(taskId: string, opts?: RunTaskOptions): Promise<AgentState>;
  getStateSnapshot(): Promise<AgentState>;
  cancel(): Promise<{ ok: true }>;
}

function stubFor(taskId: string): AgentStub {
  return testEnv.AGENT.get(testEnv.AGENT.idFromName(taskId)) as unknown as AgentStub;
}

async function createTaskViaApi(
  slug: string,
  prompt = 'echo please',
): Promise<{ taskId: string; userId: string }> {
  const auth = await loginAs(testEnv, 1, 'ada');
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES ((SELECT id FROM ${T.repos} WHERE slug = ?), ?, 'write')`,
    [slug, auth.userId],
  );
  const res = await makeApp(testEnv)(
    new Request(`https://x/api/v1/repos/${slug}/agents/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth.cookie },
      body: JSON.stringify({ kind: 'freeform', prompt }),
    }),
  );
  const body = (await res.json()) as { task_id: string };
  return { taskId: body.task_id, userId: auth.userId };
}

async function seedTaskRepo(slug: string): Promise<string> {
  const repo = await createRepo(dbEnv, { slug, visibility: 'public' });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: [{ path: 'src/a.txt', op: 'add', content_b64: btoa('a') }],
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  return repo.id;
}

function mockBatch(messages: { body: AgentJobMessage; attempts: number }[]): {
  batch: MessageBatch<AgentJobMessage>;
  acked: number[];
  state: { retryAll: boolean };
} {
  const acked: number[] = [];
  const state = { retryAll: false };
  const batch = {
    queue: 'agent-jobs',
    messages: messages.map((entry, i) => ({
      ...entry,
      id: `m${i}`,
      timestamp: new Date(),
      ack: (): void => {
        acked.push(i);
      },
      retry: (): void => {},
    })),
    ackAll: (): void => {},
    retryAll: (): void => {
      state.retryAll = true;
    },
  } as unknown as MessageBatch<AgentJobMessage>;
  return { batch, acked, state };
}

describe('agent runtime', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    await seedTaskRepo('acme/agents');
  });

  it('create → 202 + queued row + queue message; echo loop lands; state matches D1', async () => {
    const probe = instrumentQueues(testEnv);
    const auth = await loginAs(testEnv, 1, 'ada');
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES ((SELECT id FROM ${T.repos} WHERE slug = ?), ?, 'write')`,
      ['acme/agents', auth.userId],
    );
    const res = await makeApp(probe.env)(
      new Request('https://x/api/v1/repos/acme/agents/agents/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ kind: 'freeform', prompt: 'hello' }),
      }),
    );
    expect(res.status).toBe(202);
    const { task_id: taskId } = (await res.json()) as { task_id: string };
    expect(probe.sends).toEqual([{ queue: 'AGENT_QUEUE', body: { task_id: taskId } }]);

    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(row).toMatchObject({ status: 'queued', kind: 'freeform', prompt: 'hello' });

    // queue dispatch runs the echo loop → landed
    const { batch, acked } = mockBatch([
      { body: { task_id: taskId, opts: { mode: 'echo' } }, attempts: 1 },
    ]);
    await agentJobsQueue(batch, testEnv);
    expect(acked).toEqual([0]);

    const after = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(after).toMatchObject({ status: 'landed' });

    const state = await stubFor(taskId).getStateSnapshot();
    expect(state.status).toBe('done');
    expect(state.steps).toBe(1);
    expect(state.transcript.some((e) => e.name === 'read_file')).toBe(true);
  });

  it('cancel mid-run: in-flight step finishes, no further steps', async () => {
    await createTaskViaApi('acme/agents');
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} ORDER BY created_at DESC`);
    const taskId = (row as { id: string }).id;

    const stub = stubFor(taskId);
    const running = stub.runTask(taskId, { mode: 'echo', steps: 3, stepDelayMs: 250 });

    // wait for step 1 to land, then cancel
    for (let i = 0; i < 100; i++) {
      const snapshot = await stub.getStateSnapshot();
      if (snapshot.steps >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stub.cancel();
    const finalState = await running;

    expect(finalState.cancelled).toBe(true);
    expect(finalState.steps).toBeLessThan(3); // step 3 never ran
    const after = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(after).toMatchObject({ status: 'cancelled' });
  });

  it('cancel before the DO ever ran sticks; terminal statuses are never overwritten', async () => {
    const { taskId } = await createTaskViaApi('acme/agents');
    const auth = await loginAs(testEnv, 1, 'ada');
    const cancel = async (id: string): Promise<{ status: string }> =>
      (await (
        await makeApp(testEnv)(
          new Request(`https://x/api/v1/agents/tasks/${id}/cancel`, {
            method: 'POST',
            headers: { cookie: auth.cookie },
          }),
        )
      ).json()) as { status: string };

    // queued task, fresh DO (empty state): the row still flips to cancelled
    expect(await cancel(taskId)).toMatchObject({ status: 'cancelled' });
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]),
    ).toMatchObject({ status: 'cancelled' });
    // …and the queued message, when delivered, does not run it
    const { batch, acked } = mockBatch([
      { body: { task_id: taskId, opts: { mode: 'echo' } }, attempts: 1 },
    ]);
    await agentJobsQueue(batch, testEnv);
    expect(acked).toEqual([0]);
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]),
    ).toMatchObject({ status: 'cancelled' });
    expect((await stubFor(taskId).getStateSnapshot()).steps).toBe(0);

    // a landed task cannot be cancelled after the fact
    const second = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/agents/agents/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ kind: 'freeform', prompt: 'second' }),
      }),
    );
    const doneId = ((await second.json()) as { task_id: string }).task_id;
    await stubFor(doneId).runTask(doneId, { mode: 'echo' });
    expect(await cancel(doneId)).toMatchObject({ status: 'landed' });
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [doneId]),
    ).toMatchObject({ status: 'landed' });
  });

  it('deadline: tasks past deadline fail with timeout', async () => {
    await createTaskViaApi('acme/agents');
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} ORDER BY created_at DESC`);
    const taskId = (row as { id: string }).id;

    const stub = stubFor(taskId);
    await expect(
      Promise.resolve(stub.runTask(taskId, { steps: 5, deadlineMs: 1 })),
    ).rejects.toThrow(/timeout/);

    const state = await stub.getStateSnapshot();
    expect(state.status).toBe('failed');
    expect(state.error).toBe('timeout');
    const after = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(after).toMatchObject({ status: 'failed' });
  });

  it('step failures fail the task; the queue retries once then marks poison', async () => {
    await createTaskViaApi('acme/agents');
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} ORDER BY created_at DESC`);
    const taskId = (row as { id: string }).id;
    const opts: RunTaskOptions = { mode: 'echo', steps: 5, failAtStep: 2 };

    // first delivery: step 1 lands, step 2 throws → retry
    const first = mockBatch([{ body: { task_id: taskId, opts }, attempts: 1 }]);
    await agentJobsQueue(first.batch, testEnv);
    expect(first.state.retryAll).toBe(true);
    expect(first.acked).toEqual([]);

    // second delivery: attempt 2 recorded in transcript meta, fails again →
    // poison: marked failed + acked, consumer never crashed
    const second = mockBatch([{ body: { task_id: taskId, opts }, attempts: 2 }]);
    await agentJobsQueue(second.batch, testEnv);
    expect(second.acked).toEqual([0]);

    const state = await stubFor(taskId).getStateSnapshot();
    expect(state.status).toBe('failed');
    expect(state.error).toContain('injected failure');
    expect(state.attempt).toBe(2);
    expect(state.transcript.some((e) => e.text === 'attempt 2')).toBe(true);
    const after = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [taskId]);
    expect(after).toMatchObject({ status: 'failed' });
  });

  it('transcript: ring cap 200 in state, full stream in R2', async () => {
    await createTaskViaApi('acme/agents');
    const row = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} ORDER BY created_at DESC`);
    const task = parseAgentTaskRow(row);
    const stub = stubFor(task.id);

    await stub.runTask(task.id, { mode: 'echo', steps: 125 }); // 1 note + 2 entries/step
    const state = await stub.getStateSnapshot();
    expect(state.transcript).toHaveLength(200); // ring cap
    expect(state.total).toBe(251); // full stream count

    const object = await testEnv.OBJECTS.get(
      `repos/${task.repo_id}/agents/${task.id}/transcript.jsonl`,
    );
    const lines = ((await object?.text()) ?? '')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(state.total as number); // nothing lost at the 20-entry flushes

    // API serves the tail with since-cursor filtering
    const auth = await loginAs(testEnv, 1, 'ada');
    const since = state.transcript[0]?.t as number;
    const tail = await makeApp(testEnv)(
      new Request(
        `https://x/api/v1/agents/tasks/${task.id}/transcript?since=${since + 1}`,
        {
          headers: { cookie: auth.cookie },
        },
      ),
    );
    const entries = ((await tail.json()) as { entries: { t: number }[] }).entries;
    expect(entries.every((e) => e.t > since)).toBe(true);
  });

  it('principal without agent:run scope is rejected', async () => {
    const auth = await loginAs(testEnv, 1, 'ada');
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES ((SELECT id FROM ${T.repos} WHERE slug = ?), ?, 'write')`,
      ['acme/agents', auth.userId],
    );
    // a machine token WITHOUT agent:run
    const created = await makeApp(testEnv)(
      new Request('https://x/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ label: 'writer', scopes: ['repo:write'] }),
      }),
    );
    const raw = ((await created.json()) as { token: string }).token;

    const res = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/agents/agents/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${raw}`,
        },
        body: JSON.stringify({ kind: 'freeform', prompt: 'nope' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; required_scope?: string };
    };
    expect(body.error.required_scope).toBe('agent:run');
  });

  it('task detail returns the row plus the live DO snapshot', async () => {
    const { taskId } = await createTaskViaApi('acme/agents');
    const auth = await loginAs(testEnv, 1, 'ada');
    await stubFor(taskId).runTask(taskId, { mode: 'echo' });

    const res = await makeApp(testEnv)(
      new Request(`https://x/api/v1/agents/tasks/${taskId}`, {
        headers: { cookie: auth.cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { id: string; status: string };
      state: { steps: number };
    };
    expect(body.task.id).toBe(taskId);
    expect(body.state.steps).toBe(1);

    const list = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/agents/agents/tasks?status=landed', {
        headers: { cookie: auth.cookie },
      }),
    );
    expect(((await list.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});
