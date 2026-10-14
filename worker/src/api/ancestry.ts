import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse } from './errors';
import { ancestorDistance, isAncestor, mergeBase } from '../core/ancestry';
import { lookupRev } from '../core/read';
import { sha256Hex } from '../core/hashing';
import { loadReadableRepo as loadReadable } from '../auth/guards';
import type { RepoWithCreator } from '../auth/rbac';

/**
 * Ancestry RPCs (architecture §2) — O(log n) skip-list queries:
 *   GET /api/v1/repos/:repo/merge-base?a=…&b=…
 *   GET /api/v1/repos/:repo/is-ancestor?a=…&b=…
 *
 * Semantics: first-parent spine reachability (Scion footnote 1). Cache policy
 * follows the read routes: immutable only for content-addressed revs on
 * public repos.
 */
export const ancestryRoutes = new Hono<{ Bindings: Env }>();

const CS_ID_RE = /^[0-9a-f]{64}$/;

async function cacheHeaders(
  repo: RepoWithCreator | null,
  revs: string[],
  variant: string,
): Promise<Record<string, string>> {
  const digest = await sha256Hex(new TextEncoder().encode(variant));
  const etag = `"${digest.slice(0, 32)}"`;
  if (!repo || repo.visibility !== 'public')
    return { 'cache-control': 'private, no-store' };
  return revs.every((r) => CS_ID_RE.test(r))
    ? { 'cache-control': 'public, max-age=31536000, immutable', etag }
    : { 'cache-control': 'public, max-age=10', etag };
}

ancestryRoutes.get('/repos/:repo{.+}/merge-base', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const aRev = c.req.query('a');
    const bRev = c.req.query('b');
    if (!aRev || !bRev) {
      return apiError(c, 400, 'invalid_request', 'a and b are required');
    }
    const a = await lookupRev(c.env, loaded.repo.id, aRev);
    const b = await lookupRev(c.env, loaded.repo.id, bRev);
    if (!a || !b) {
      return apiError(c, 404, 'revision_not_found', `no revision ${!a ? aRev : bRev}`);
    }

    const base = await mergeBase(c.env, loaded.repo.id, a.id, b.id);
    return c.json(
      { merge_base: base, provisional: false },
      200,
      await cacheHeaders(loaded.repo, [aRev, bRev], `merge-base:${a.id}:${b.id}`),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

ancestryRoutes.get('/repos/:repo{.+}/is-ancestor', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const aRev = c.req.query('a');
    const bRev = c.req.query('b');
    if (!aRev || !bRev) {
      return apiError(c, 400, 'invalid_request', 'a and b are required');
    }
    const a = await lookupRev(c.env, loaded.repo.id, aRev);
    const b = await lookupRev(c.env, loaded.repo.id, bRev);
    if (!a || !b) {
      return apiError(c, 404, 'revision_not_found', `no revision ${!a ? aRev : bRev}`);
    }

    const is = await isAncestor(c.env, loaded.repo.id, a.id, b.id);
    return c.json(
      { is_ancestor: is },
      200,
      await cacheHeaders(loaded.repo, [aRev, bRev], `is-ancestor:${a.id}:${b.id}`),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

ancestryRoutes.get('/repos/:repo{.+}/ancestor-distance', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const aRev = c.req.query('a');
    const bRev = c.req.query('b');
    if (!aRev || !bRev) {
      return apiError(c, 400, 'invalid_request', 'a and b are required');
    }
    const a = await lookupRev(c.env, loaded.repo.id, aRev);
    const b = await lookupRev(c.env, loaded.repo.id, bRev);
    if (!a || !b) {
      return apiError(c, 404, 'revision_not_found', `no revision ${!a ? aRev : bRev}`);
    }
    const distance = await ancestorDistance(c.env, loaded.repo.id, a.id, b.id);
    return c.json(
      { distance },
      200,
      await cacheHeaders(loaded.repo, [aRev, bRev], `distance:${a.id}:${b.id}`),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
