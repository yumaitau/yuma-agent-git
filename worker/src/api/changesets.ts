import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from './errors';
import { commitChanges, commitRequestSchema } from '../core/commit';
import { firstParentHistory, getChangeset } from '../core/changesets';
import { lookupRev } from '../core/read';
import { loadReadableRepo as loadReadable, loadWritableRepo } from '../auth/guards';

/**
 * Changeset routes (architecture §2):
 *   POST /api/v1/repos/:repo/changesets
 *   GET  /api/v1/repos/:repo/changesets/:id
 *   GET  /api/v1/repos/:repo/changesets?head=…&limit=…
 */
export const changesetsRoutes = new Hono<{ Bindings: Env }>();

/** Metadata routes are principal-dependent: never cache them (issue #21). */
const NO_STORE = 'private, no-store';

function intParam(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

changesetsRoutes.post('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const body = await readJsonBody(c);
    const parsed = commitRequestSchema.safeParse(body);
    if (parsed.success) {
      // per-repo write burst guard (issue #21): huge commits get 429, not a
      // wedged D1 row / R2 write storm
      const changes = parsed.data.changes;
      const inlineBytes = changes.reduce((sum, change) => {
        const content = 'content_b64' in change ? change.content_b64 : undefined;
        return sum + (content ? Math.floor((content.length * 3) / 4) : 0);
      }, 0);
      if (changes.length > 1000 || inlineBytes > 64 * 1024 * 1024) {
        return apiError(c, 429, 'write_too_large', 'commit exceeds write burst limits', {
          max_files: 1000,
          max_inline_bytes: 64 * 1024 * 1024,
          files: changes.length,
          inline_bytes: inlineBytes,
        });
      }
    }
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
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const cs = await getChangeset(c.env, loaded.repo.id, c.req.param('id'));
    if (!cs) {
      return apiError(c, 404, 'changeset_not_found', `no changeset ${c.req.param('id')}`);
    }
    return c.json({ changeset: cs }, 200, { 'cache-control': NO_STORE });
  } catch (err) {
    return errorResponse(c, err);
  }
});

changesetsRoutes.get('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const headParam = c.req.query('head') ?? 'ref:main';
    const limit = intParam(c.req.query('limit'), 50, 200);

    const head = await lookupRev(c.env, loaded.repo.id, headParam);
    if (!head) {
      // Default head on an empty repo: empty history. Explicit rev: 404.
      if (c.req.query('head') === undefined) {
        return c.json({ changesets: [] }, 200, { 'cache-control': NO_STORE });
      }
      return apiError(c, 404, 'revision_not_found', `no revision ${headParam}`);
    }

    const changesets = await firstParentHistory(c.env, loaded.repo.id, head.id, limit);
    return c.json({ changesets }, 200, { 'cache-control': NO_STORE });
  } catch (err) {
    return errorResponse(c, err);
  }
});
