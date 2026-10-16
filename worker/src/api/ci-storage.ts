import { Hono } from 'hono';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import {
  artifactResponse,
  artifactView,
  listArtifacts,
  type ArtifactRow,
} from '../ci/artifacts';
import { cacheView, deleteCaches, type CacheRow } from '../ci/cache';
import { poolFor } from '../ci/capacity';
import { apiError, errorResponse } from './errors';

/**
 * CI artifacts and caches for people (issue #51). Artifacts are build output
 * of the whole tree, so every route needs whole-repo read like run logs.
 *
 *   GET    /repos/:repo/ci/runs/:id/artifacts             one job's artifacts
 *   GET    /repos/:repo/ci/pipelines/runs/:id/artifacts   every job's, for the run page
 *   GET    /repos/:repo/ci/artifacts/:id                  download
 *   GET    /repos/:repo/ci/caches                         entries and quota
 *   DELETE /repos/:repo/ci/caches/:id                     admins, browser session
 */
export const ciStorageRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}/ci';

ciStorageRoutes.get(`${base}/runs/:id/artifacts`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const job = await q1<{ id: string }>(
      c.env,
      'SELECT id FROM ci_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!job) return apiError(c, 404, 'run_not_found', 'Run not found');
    const rows = await listArtifacts(c.env, { ciRunId: job.id });
    return c.json({ artifacts: rows.map(artifactView) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

ciStorageRoutes.get(`${base}/pipelines/runs/:id/artifacts`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const found = await q1<{ id: string }>(
      c.env,
      'SELECT id FROM ci_pipeline_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!found) return apiError(c, 404, 'run_not_found', 'Run not found');
    const rows = await listArtifacts(c.env, { scope: found.id });
    return c.json({ artifacts: rows.map(artifactView) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

ciStorageRoutes.get(`${base}/artifacts/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await q1<ArtifactRow>(
      c.env,
      'SELECT * FROM ci_artifacts WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    return await artifactResponse(c.env, row);
  } catch (err) {
    return errorResponse(c, err);
  }
});

ciStorageRoutes.get(`${base}/caches`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q<CacheRow>(
      c.env,
      'SELECT * FROM ci_caches WHERE repo_id = ? ORDER BY last_used_at DESC LIMIT 200',
      [loaded.repo.id],
    );
    const used = await q1<{ total: number }>(
      c.env,
      "SELECT COALESCE(SUM(size), 0) AS total FROM ci_caches WHERE repo_id = ? AND state = 'ready'",
      [loaded.repo.id],
    );
    return c.json({
      caches: rows.map(cacheView),
      used_bytes: used?.total ?? 0,
      quota_bytes: (await poolFor(c.env, loaded.repo.id)).limits.cache_quota_bytes,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Remove an entry, e.g. one restored into a job by mistake. */
ciStorageRoutes.delete(`${base}/caches/:id`, async (c) => {
  try {
    if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await q1<CacheRow>(
      c.env,
      'SELECT * FROM ci_caches WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!row) throw new ApiError(404, 'cache_not_found', 'No such cache entry');
    await deleteCaches(c.env, [row]);
    await recordAudit(c, {
      action: 'ci.cache.delete',
      repo: loaded.repo,
      target: { cache_id: row.id, key: row.key, scope: row.scope },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
