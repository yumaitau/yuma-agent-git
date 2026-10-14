import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse } from './errors';
import { commitChanges, commitRequestSchema } from '../core/commit';
import { firstParentHistory, getChangeset } from '../core/changesets';
import { lookupRev } from '../core/read';
import { getRepoBySlug } from '../db/repos';
import { requireRepoWrite } from '../auth/guards';

/**
 * Changeset routes (architecture §2):
 *   POST /api/v1/repos/:repo/changesets
 *   GET  /api/v1/repos/:repo/changesets/:id
 *   GET  /api/v1/repos/:repo/changesets?head=…&limit=…
 */
export const changesetsRoutes = new Hono<{ Bindings: Env }>();

changesetsRoutes.post('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoWrite(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'write access required');
    }

    const body: unknown = await c.req.json();
    const parsed = commitRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid commit request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const result = await commitChanges(c.env, repo.id, parsed.data);
    return c.json(
      { changeset: result.changeset, deduped: result.deduped },
      result.deduped ? 200 : 201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

changesetsRoutes.get('/repos/:repo{.+}/changesets/:id', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    const cs = await getChangeset(c.env, repo.id, c.req.param('id'));
    if (!cs) {
      return apiError(c, 404, 'changeset_not_found', `no changeset ${c.req.param('id')}`);
    }
    return c.json({ changeset: cs });
  } catch (err) {
    return errorResponse(c, err);
  }
});

changesetsRoutes.get('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }

    const headParam = c.req.query('head') ?? 'ref:main';
    const limitRaw = Number(c.req.query('limit') ?? '50');
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

    const head = await lookupRev(c.env, repo.id, headParam);
    if (!head) {
      // Default head on an empty repo: empty history. Explicit rev: 404.
      if (c.req.query('head') === undefined) return c.json({ changesets: [] });
      return apiError(c, 404, 'revision_not_found', `no revision ${headParam}`);
    }

    const changesets = await firstParentHistory(c.env, repo.id, head.id, limit);
    return c.json({ changesets });
  } catch (err) {
    return errorResponse(c, err);
  }
});
