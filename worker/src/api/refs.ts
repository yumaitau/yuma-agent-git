import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getChangeset } from '../core/changesets';
import { listRefs, getRef, moveRefViaDO, validateRefName } from '../core/refs';
import { getRepoBySlug } from '../db/repos';
import { requireRepoRead, requireRepoWrite } from '../auth/guards';

/**
 * Ref routes (architecture §1.4) — refs are discouraged global state; moves
 * are compare-and-swap through the per-ref Durable Object.
 *   GET /api/v1/repos/:repo/refs
 *   GET /api/v1/repos/:repo/refs/:name
 *   PUT /api/v1/repos/:repo/refs/:name   {from, to, force?}
 */
export const refsRoutes = new Hono<{ Bindings: Env }>();

const NO_STORE = 'private, no-store';

const moveRefSchema = z.object({
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
  force: z.boolean().optional(),
});

async function loadReadable(
  c: Parameters<typeof apiError>[0],
  slug: string,
): Promise<
  | { ok: true; repo: NonNullable<Awaited<ReturnType<typeof getRepoBySlug>>> }
  | { ok: false; response: Response }
> {
  const repo = await getRepoBySlug(c.env, slug);
  // Guard failure maps to 404 — never leak repo existence (issue #14).
  if (!repo || !(await requireRepoRead(c.env, c, repo))) {
    return {
      ok: false,
      response: apiError(c, 404, 'repo_not_found', `no repo ${slug}`),
    };
  }
  return { ok: true, repo };
}

refsRoutes.get('/repos/:repo{.+}/refs', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const refs = await listRefs(c.env, loaded.repo.id);
    return c.json(
      {
        refs: refs.map((r) => ({
          name: r.name,
          head: r.head,
          updated_at: r.updated_at,
        })),
      },
      200,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

refsRoutes.get('/repos/:repo{.+}/refs/:name{.+}', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const name = validateRefName(c.req.param('name'));
    const ref = await getRef(c.env, loaded.repo.id, name);
    if (!ref) {
      return apiError(c, 404, 'ref_not_found', `no ref ${name}`);
    }
    return c.json({ name: ref.name, head: ref.head, updated_at: ref.updated_at }, 200, {
      'cache-control': NO_STORE,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

refsRoutes.put('/repos/:repo{.+}/refs/:name{.+}', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoWrite(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'write access required');
    }
    const name = validateRefName(c.req.param('name'));

    const body = await readJsonBody(c);
    const parsed = moveRefSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid ref move request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    // Cheap 400 before the DO roundtrip: the target must exist.
    const target = await getChangeset(c.env, repo.id, parsed.data.to);
    if (!target) {
      return apiError(c, 400, 'unknown_target', `no changeset ${parsed.data.to}`, {
        to: parsed.data.to,
      });
    }

    const result = await moveRefViaDO(c.env, repo.id, name, parsed.data);
    return c.json(result, 200, { 'cache-control': NO_STORE });
  } catch (err) {
    return errorResponse(c, err);
  }
});
