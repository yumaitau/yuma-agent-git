import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse } from './errors';
import { diffRevisions } from '../core/diff';
import { lookupRev } from '../core/read';
import { sha256Hex } from '../core/hashing';
import { loadReadableRepo as loadReadable, pathReadFilter } from '../auth/guards';

/**
 * Diff RPC (architecture §2.2):
 *   GET /api/v1/repos/:repo/diff?from=…&to=…&mode=merge-base|direct&text=0|1&max_files=N
 *
 * Cache policy matches the read routes (issue #21 + review): immutable only
 * when BOTH revs are content-addressed (64-hex cs ids) on a public repo —
 * ref-addressed revs are mutable URLs and must never be frozen in caches.
 *
 * Path rules: files (and their texts) the caller may not `read` are dropped
 * and counted in `omitted_paths_count`.
 */
export const diffRoutes = new Hono<{ Bindings: Env }>();

const CS_ID_RE = /^[0-9a-f]{64}$/;
const MAX_TEXTS_BYTES = 4 * 1024 * 1024;

diffRoutes.get('/repos/:repo{.+}/diff', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const fromRev = c.req.query('from');
    const toRev = c.req.query('to');
    if (!fromRev || !toRev) {
      return apiError(c, 400, 'invalid_request', 'from and to are required');
    }
    const mode = c.req.query('mode') === 'direct' ? 'direct' : 'merge-base';
    const includeText = c.req.query('text') === '1';
    const maxFilesRaw = Number(c.req.query('max_files') ?? '2000');
    const maxFiles =
      Number.isInteger(maxFilesRaw) && maxFilesRaw > 0
        ? Math.min(maxFilesRaw, 5000)
        : 2000;

    const from = await lookupRev(c.env, repo.id, fromRev);
    const to = await lookupRev(c.env, repo.id, toRev);
    if (!from || !to) {
      return apiError(
        c,
        404,
        'revision_not_found',
        `no revision ${!from ? fromRev : toRev}`,
      );
    }

    const result = await diffRevisions(c.env, repo.id, from.id, to.id, {
      mode,
      includeText,
      maxFiles,
    });

    const canRead = await pathReadFilter(c, repo);
    const files = result.files.filter((f) => canRead(f.path));
    const payload: Record<string, unknown> = { ...result, files };
    if (files.length < result.files.length) {
      payload.omitted_paths_count = result.files.length - files.length;
    }
    if (result.texts) {
      const texts = result.texts.filter((t) => canRead(t.path));
      payload.texts = texts;
      const size = JSON.stringify(texts).length;
      if (size > MAX_TEXTS_BYTES) {
        // Response-size guard: drop texts, tell the client to go per-file.
        delete payload.texts;
        payload.texts_truncated = true;
        payload.texts_hint =
          'text diffs exceeded 4 MiB; fetch individual files via /file or reduce scope';
      }
    }

    const headers: Record<string, string> = {};
    const contentAddressed = CS_ID_RE.test(fromRev) && CS_ID_RE.test(toRev);
    if (repo.visibility !== 'public') {
      headers['cache-control'] = 'private, no-store';
    } else {
      headers['cache-control'] = contentAddressed
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=10';
      const digest = await sha256Hex(
        new TextEncoder().encode(`${from.id}:${to.id}:${mode}`),
      );
      headers.etag = `"${digest.slice(0, 32)}"`;
    }
    return c.json(payload, 200, headers);
  } catch (err) {
    return errorResponse(c, err);
  }
});
