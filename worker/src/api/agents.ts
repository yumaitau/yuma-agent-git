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
  loadAdminRepo,
  loadReadableRepo,
  loadReadableRepoById,
  loadWritableRepo,
  loadWritableRepoById,
} from '../auth/guards';
import type { AgentState } from '../agents/runtime';
import { SUPERFAN_COMPONENTS, superfanName } from '../agents/superfan';
import { r2 } from '../observability/phase';
import { recordAudit } from '../audit/record';

/**
 * Agent task lifecycle API (issue #17) — mounted under /api/v1:
 *   POST /api/v1/repos/:repo/agents/tasks        (write + scope agent:run)
 *   GET  /api/v1/agents/tasks/:id                (row + live DO state)
 *   GET  /api/v1/repos/:repo/agents/tasks        (list)
 *   GET  /api/v1/agents/tasks/:id/transcript     (R2 jsonl tail, ?since=)
 *   POST /api/v1/agents/tasks/:id/cancel
 *   POST|GET /api/v1/repos/:repo/agents/superfans (admin)
 *   DELETE   /api/v1/repos/:repo/agents/superfans/:component (admin)
 */
export const agentsRoutes = new Hono<AppEnv>();

interface AgentStub {
  runTask(taskId: string, opts?: Record<string, unknown>): Promise<unknown>;
  getStateSnapshot(): Promise<AgentState>;
  cancel(taskId?: string): Promise<{ ok: true }>;
}

function stubFor(env: Env, taskId: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(taskId)) as unknown as AgentStub;
}

const createTaskSchema = z
  .object({
    kind: z.enum(['freeform', 'fix_issue', 'post_merge_check', 'superfan']),
    prompt: z.string().min(1).max(65536),
    base_cs: z.string().optional(),
    /** GitHub issue number — fix_issue only (the issue body becomes the prompt). */
    github_issue: z.number().int().positive().optional(),
  })
  .refine((t) => t.github_issue === undefined || t.kind === 'fix_issue', {
    message: 'github_issue is only valid for fix_issue tasks',
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
          ${C.agentTasks.githubIssue}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt},
          ${C.agentTasks.updatedAt})
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        loaded.repo.id,
        parsed.data.kind,
        parsed.data.prompt,
        base.id,
        taskId, // DO name — deep-linkable from the dashboard
        parsed.data.github_issue === undefined ? null : String(parsed.data.github_issue),
        principal?.userId ?? 'anonymous',
        now,
        now,
      ],
    );
    await recordAudit(c, {
      action: 'agent.task.create',
      repo: loaded.repo,
      target: { task_id: taskId, kind: parsed.data.kind, base_cs: base.id },
    });
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
    const object = await r2(c.env.OBJECTS).get(key);
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

const superfanSchema = z.object({
  component: z.enum(SUPERFAN_COMPONENTS),
  interval_min: z.number().int().positive().max(1440),
});

interface SuperfanStub {
  fetch(request: Request): Promise<Response>;
}

function superfanStub(env: Env, repoId: string, component: string): SuperfanStub {
  return env.SUPERFAN.get(
    env.SUPERFAN.idFromName(superfanName(repoId, component)),
  ) as unknown as SuperfanStub;
}

/**
 * Superfans (issue #19): long-lived per-component monitors, registered on a
 * repo by one of its admins. Investigations are filed into that repo and run
 * as the registering admin.
 */
agentsRoutes.post('/repos/:repo{.+}/agents/superfans', async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const principal = (c.get('principal') ?? null) as Principal | null;
    if (!principal || !hasScope(principal, 'agent:run')) {
      return apiError(c, 403, 'forbidden', 'agent:run scope required', {
        required_scope: 'agent:run',
      });
    }
    const body = await readJsonBody(c);
    const parsed = superfanSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid superfan request');
    }
    const res = await superfanStub(c.env, loaded.repo.id, parsed.data.component).fetch(
      new Request('https://superfan/start', {
        method: 'POST',
        body: JSON.stringify({
          ...parsed.data,
          repo_id: loaded.repo.id,
          created_by: principal.userId,
        }),
      }),
    );
    await recordAudit(c, { action: 'agent.superfan.start', target: parsed.data });
    return c.json(await res.json(), 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.get('/repos/:repo{.+}/agents/superfans', async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repoId = loaded.repo.id;
    const states = await Promise.all(
      SUPERFAN_COMPONENTS.map(async (component) => {
        const res = await superfanStub(c.env, repoId, component).fetch(
          new Request('https://superfan/state'),
        );
        return (await res.json()) as { component?: string; repo_id?: string };
      }),
    );
    const superfans = states.filter((s) => s.component && s.repo_id === repoId);
    const limitRaw = Number(c.req.query('limit') ?? '50');
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    // findings belong to the repo their investigation task was filed into
    const findings = await q(
      c.env,
      `SELECT f.${C.superfanFindings.id} AS id, f.${C.superfanFindings.component} AS component,
              f.${C.superfanFindings.ts} AS ts, f.${C.superfanFindings.finding} AS finding,
              f.${C.superfanFindings.taskId} AS task_id
         FROM ${T.superfanFindings} f
         JOIN ${T.agentTasks} t ON t.${C.agentTasks.id} = f.${C.superfanFindings.taskId}
        WHERE t.${C.agentTasks.repoId} = ?
        ORDER BY f.${C.superfanFindings.ts} DESC LIMIT ?`,
      [repoId, limit],
    );
    return c.json({ superfans, findings }, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentsRoutes.delete('/repos/:repo{.+}/agents/superfans/:component', async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const component = superfanSchema.shape.component.safeParse(c.req.param('component'));
    if (!component.success) {
      return apiError(c, 404, 'superfan_not_found', 'unknown superfan component');
    }
    const res = await superfanStub(c.env, loaded.repo.id, component.data).fetch(
      new Request('https://superfan/stop', { method: 'POST' }),
    );
    const body = (await res.json()) as { stopped: boolean };
    await recordAudit(c, {
      action: 'agent.superfan.stop',
      repo: loaded.repo,
      target: { component: component.data },
    });
    return c.json({ ok: true, component: component.data, stopped: body.stopped });
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

    await stubFor(c.env, task.id).cancel(task.id);
    // terminal statuses stick: report what the task actually is now
    const after = await q1<{ status: string }>(
      c.env,
      `SELECT ${C.agentTasks.status} FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
      [task.id],
    );
    await recordAudit(c, {
      action: 'agent.task.cancel',
      repo: loaded.repo,
      target: { task_id: task.id },
    });
    return c.json({ ok: true, status: after?.status ?? 'cancelled' });
  } catch (err) {
    return errorResponse(c, err);
  }
});
