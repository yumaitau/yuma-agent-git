import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import type { RepoWithCreator } from '../auth/rbac';
import { errorResponse, readJsonBody } from './errors';
import { ApiError } from '../core/errors';
import { getPull, type Pull } from '../reviews/pulls';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import { enforceAgentAction } from '../policy/guardrails';
import {
  enqueueSchema,
  queueStub,
  queueView,
  type PublicEntry as QueueEntry,
} from '../queue/mergeQueue';

/**
 * Merge queue routes (issue #43). Entries are ordered by the queue's Durable
 * Object; these routes resolve RBAC, agent scopes and guardrails first.
 */
export const mergeQueueRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';

export const queueListQuery = z.object({
  /** Base branch; defaults to the repository's default branch. */
  ref: z.string().min(1).max(256).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}

mergeQueueRoutes.get(`${base}/merge-queue`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = parse(queueListQuery, c.req.query());
    c.header('cache-control', 'private, no-store');
    return c.json(
      await queueView(c.env, loaded.repo, query.ref ?? loaded.repo.default_branch),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function emitQueued(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  pull: Pull,
  action: 'enqueued' | 'dequeued',
  entry: QueueEntry,
): Promise<void> {
  await emitEvent(c.env, repo, {
    event: 'pull_request',
    action,
    actor: actorOf(c.get('principal')),
    origin: new URL(c.req.url).origin,
    data: { pull_request: pull, queue_entry: entry },
  });
}

mergeQueueRoutes.post(`${base}/pulls/:id/queue`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'pulls:write');
    if (scoped) return scoped;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const body = parse(enqueueSchema, await readJsonBody(c));
    // agent guardrails (#62): queueing is how an agent lands a pull request
    const summary = { pull: pull.number, head_cs: body.head_cs, method: body.method };
    await enforceAgentAction(
      c.env,
      c.get('principal'),
      loaded.repo,
      { action: 'pr.merge', ref: pull.base_ref },
      { exact: summary, summary: { ...summary, base_ref: pull.base_ref } },
    );
    const res = await queueStub(c.env, loaded.repo.id, pull.base_ref).fetch(
      'https://merge-queue/enqueue',
      {
        method: 'POST',
        body: JSON.stringify({
          repo_id: loaded.repo.id,
          base_ref: pull.base_ref,
          pull_id: pull.id,
          body,
          principal: c.get('principal'),
        }),
      },
    );
    if (!res.ok) return new Response(res.body, res);
    const { entry } = (await res.json()) as { entry: QueueEntry };
    await recordAudit(c, {
      action: 'merge_queue.enqueue',
      repo: loaded.repo,
      target: {
        pull_id: pull.id,
        base_ref: pull.base_ref,
        head_cs: entry.head_cs,
        method: entry.method,
        priority: entry.priority,
      },
    });
    await emitQueued(c, loaded.repo, pull, 'enqueued', entry);
    return c.json({ entry }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

mergeQueueRoutes.delete(`${base}/pulls/:id/queue`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'pulls:write');
    if (scoped) return scoped;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const res = await queueStub(c.env, loaded.repo.id, pull.base_ref).fetch(
      'https://merge-queue/dequeue',
      {
        method: 'POST',
        body: JSON.stringify({
          repo_id: loaded.repo.id,
          base_ref: pull.base_ref,
          pull_id: pull.id,
          reason: 'Removed by request.',
        }),
      },
    );
    if (!res.ok) return new Response(res.body, res);
    const { entry } = (await res.json()) as { entry: QueueEntry };
    await recordAudit(c, {
      action: 'merge_queue.dequeue',
      repo: loaded.repo,
      target: { pull_id: pull.id, base_ref: pull.base_ref, reason: entry.reason },
    });
    await emitQueued(c, loaded.repo, pull, 'dequeued', entry);
    return c.json({ entry });
  } catch (err) {
    return errorResponse(c, err);
  }
});
