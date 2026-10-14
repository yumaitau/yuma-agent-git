import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse } from './errors';
import { lookupRev } from '../core/read';
import { normalizeQueryPath } from './read';
import { blameFile, BLAME_TRUNCATED_CS, type BlameRange } from '../core/derived/blame';
import { parseChangesetRow, q } from '../db/client';
import { C, T } from '../db/schema';
import { sha256Hex } from '../core/hashing';
import { guardPathHistory, loadReadableRepo as loadReadable } from '../auth/guards';

/**
 * Blame RPC (architecture §2):
 *   GET /api/v1/repos/:repo/blame?cs=…&path=…&background=0|1&annotate=0|1
 *
 * Bounded per-request work (issue #10): cold + `background=1` → 202
 * `{status:'computing'}` + queue; inline compute over the generation budget →
 * 202 with partial attribution; oversize payloads fall back to uncached
 * attribution (`X-YAG-Blame: uncached`).
 */
export const blameRoutes = new Hono<{ Bindings: Env }>();

const CS_ID_RE = /^[0-9a-f]{64}$/;

blameRoutes.get('/repos/:repo{.+}/blame', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const rev = c.req.query('cs');
    const rawPath = c.req.query('path');
    if (!rev || rawPath === undefined) {
      return apiError(c, 400, 'invalid_request', 'cs and path are required');
    }
    const path = normalizeQueryPath(rawPath, false);
    // history permission on the specific path — path rules apply
    const denied = await guardPathHistory(c, repo, path);
    if (denied) return denied;

    const cs = await lookupRev(c.env, repo.id, rev);
    if (!cs) {
      return apiError(c, 404, 'revision_not_found', `no revision ${rev}`);
    }

    const outcome = await blameFile(c.env, repo.id, cs.id, path, {
      background: c.req.query('background') === '1',
    });

    const cacheHeaders = await blameCacheHeaders(repo.visibility, rev, cs.id, path);
    if (outcome.status === 'computing') {
      return c.json(
        {
          status: 'computing',
          path,
          cs: cs.id,
          ranges: outcome.ranges ?? [],
          complete: false,
        },
        202,
        cacheHeaders,
      );
    }

    const ranges =
      c.req.query('annotate') === '1'
        ? await annotate(c.env, repo.id, outcome.ranges)
        : outcome.ranges;
    return c.json(
      {
        path,
        cs: cs.id,
        ranges,
        complete: outcome.complete && !ranges.some((r) => r.cs === BLAME_TRUNCATED_CS),
      },
      200,
      {
        ...cacheHeaders,
        ...(outcome.cached ? {} : { 'x-yag-blame': 'uncached' }),
      },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function annotate(
  env: Env,
  repoId: string,
  ranges: BlameRange[],
): Promise<(BlameRange & { message?: string; author?: unknown })[]> {
  const ids = [...new Set(ranges.map((r) => r.cs))].filter(
    (id) => id !== BLAME_TRUNCATED_CS,
  );
  if (ids.length === 0) return [...ranges];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await q(
    env,
    `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ? AND ${C.changesets.id} IN (${placeholders})`,
    [repoId, ...ids],
  );
  const byId = new Map(
    rows.map((r) => {
      const cs = parseChangesetRow(r);
      return [cs.id, cs] as const;
    }),
  );
  return ranges.map((r) => {
    const cs = byId.get(r.cs);
    return cs ? { ...r, message: cs.message, author: cs.author } : { ...r };
  });
}

async function blameCacheHeaders(
  visibility: string,
  requestedRev: string,
  csId: string,
  path: string,
): Promise<Record<string, string>> {
  const digest = await sha256Hex(new TextEncoder().encode(`blame:${csId}:${path}`));
  const etag = `"${digest.slice(0, 32)}"`;
  if (visibility !== 'public') return { 'cache-control': 'private, no-store', etag };
  return CS_ID_RE.test(requestedRev)
    ? { 'cache-control': 'public, max-age=31536000, immutable', etag }
    : { 'cache-control': 'public, max-age=10', etag };
}
