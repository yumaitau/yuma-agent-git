import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv } from '../auth/principal';
import { C, T } from '../db/schema';
import { parseAgentTaskRow, q, q1, run } from '../db/client';
import { apiError, errorResponse, readJsonBody } from './errors';
import { ulid } from '../core/ids';
import { lookupRev } from '../core/read';
import { hasScope, type Principal } from '../auth/principal';
import {
  loadReadableRepo,
  loadReadableRepoById,
  loadWritableRepo,
  loadWritableRepoById,
} from '../auth/guards';
import type { AgentState } from '../agents/runtime';

/**
 * Agent task lifecycle API (issue #17) — mounted under /api/v1:
 *   POST /api/v1/repos/:repo/agents/tasks        (write + scope agent:run)
 *   GET  /api/v1/agents/tasks/:id                (row + live DO state)
 *   GET  /api/v1/repos/:repo/agents/tasks        (list)
 *   GET  /api/v1/agents/tasks/:id/transcript     (R2 jsonl tail, ?since=)
 *   POST /api/v1/agents/tasks/:id/cancel
 */
export const agentsRoutes = new Hono<AppEnv>();

interface AgentStub {
  runTask(taskId: string, opts?: Record<string, unknown>): Promise<unknown>;
  getStateSnapshot(): Promise<AgentState>;
  cancel(): Promise<{ ok: true }>;
}

function stubFor(env: Env, taskId: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(taskId)) as unknown as AgentStub;
}

const createTaskSchema = z.object({
  kind: z.enum(['freeform', 'fix_issue', 'post_merge_check', 'superfan']),
  prompt: z.string().min(1).max(65536),
  base_cs: z.string().optional(),
});

agentsRoutes.post('/repos/:repo{.+}/agents/tasks', async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    // scope gate: machine principals need agent:run; session users have it
    const principal = (c.get('principal') ?? null) as Principal | null;
    if (!hasScope(principal, 'agent:run')) {
      return apiError(c, 403, 'forbidden', 'agent:run scope required', {
        required_scope: 'agent:run',
      });
    }

    const body = await readJsonBody(c);
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid task request');
    }

    const baseCs = parsed.data.base_cs ?? 'ref:main';
    const base = await lookupRev(c.env, loaded.repo.id, baseCs);
    if (!base) {
      return apiError(c, 404, 'revision_not_found', `no revision ${baseCs}`);
    }

    const taskId = ulid();
    const now = Date.now();
    await run(
      c.env,
      `INSERT INTO ${T.agentTasks}
         (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt},
          ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.agentState},
          ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      [
        taskId,
        loaded.repo.id,
        parsed.data.kind,
        parsed.data.prompt,
        base.id,
        taskId, // DO name — deep-linkable from the dashboard
        principal?.userId ?? 'anonymous',
        now,
        now,
      ],
    );
    await c.env.AGENT_QUEUE.send({ task_id: taskId });
    return c.json({ task_id: taskId, status: 'queued' }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.get('/repos/:repo{.+}/agents/tasks', async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const status = c.req.query('status');
    const limitRaw = Number(c.req.query('limit') ?? '50');
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

    const rows = await q(
      c.env,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.repoId} = ?
        ${status ? `AND ${C.agentTasks.status} = ?` : ''}
        ORDER BY ${C.agentTasks.createdAt} DESC LIMIT ?`,
      status ? [loaded.repo.id, status, limit] : [loaded.repo.id, limit],
    );
    return c.json({ tasks: rows.map(parseAgentTaskRow) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.get('/agents/tasks/:id', async (c) => {
  try {
    const row = await q1(
      c.env,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
      [c.req.param('id')],
    );
    if (!row) return apiError(c, 404, 'task_not_found', `no task ${c.req.param('id')}`);
    const task = parseAgentTaskRow(row);

    // task visibility follows repo read access
    const loaded = await loadReadableRepoById(c, task.repo_id);
    if (!loaded.ok) return loaded.response;

    const state = await stubFor(c.env, task.id).getStateSnapshot();
    return c.json({ task, state }, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.get('/agents/tasks/:id/transcript', async (c) => {
  try {
    const row = await q1(
      c.env,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
      [c.req.param('id')],
    );
    if (!row) return apiError(c, 404, 'task_not_found', `no task ${c.req.param('id')}`);
    const task = parseAgentTaskRow(row);
    const loaded = await loadReadableRepoById(c, task.repo_id);
    if (!loaded.ok) return loaded.response;

    const since = Number(c.req.query('since') ?? '0');
    const key = `repos/${task.repo_id}/agents/${task.id}/transcript.jsonl`;
    const object = await c.env.OBJECTS.get(key);
    const text = object ? await object.text() : '';
    const entries = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { t: number })
      .filter((entry) => entry.t >= since);
    return c.json({ entries }, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.post('/agents/tasks/:id/cancel', async (c) => {
  try {
    const row = await q1(
      c.env,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
      [c.req.param('id')],
    );
    if (!row) return apiError(c, 404, 'task_not_found', `no task ${c.req.param('id')}`);
    const task = parseAgentTaskRow(row);
    const loaded = await loadWritableRepoById(c, task.repo_id);
    if (!loaded.ok) return loaded.response;

    await stubFor(c.env, task.id).cancel();
    return c.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    return errorResponse(c, err);
  }
});
