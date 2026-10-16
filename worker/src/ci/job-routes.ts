import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { errorResponse, readJsonBody } from '../api/errors';
import type { CiRun } from './config';
import { authJob } from './runners';
import {
  artifactResponse,
  artifactView,
  listArtifacts,
  runScope,
  uploadArtifact,
  type ArtifactRow,
} from './artifacts';
import { cacheView, reserveCache, restoreCache, uploadCache } from './cache';

/**
 * Artifacts and caches for running jobs (issue #51), docs/runner-protocol.md.
 * Each takes the claiming runner's credential or the job's own token
 * (`YAG_RUNTIME_TOKEN`, with `YAG_RUNTIME_URL` = `/runner/v1/jobs/<id>`):
 *
 *   GET  /runner/v1/jobs/:id/artifacts             this run's artifacts
 *   GET  /runner/v1/jobs/:id/artifacts/:name       download one
 *   PUT  /runner/v1/jobs/:id/artifacts/:name       upload one (raw body)
 *   GET  /runner/v1/jobs/:id/caches?key=&restore_keys=a,b   restore (204 on a miss)
 *   POST /runner/v1/jobs/:id/caches                reserve {key}
 *   PUT  /runner/v1/jobs/:id/caches/:cache         upload once; commits
 */
export const jobStorageRoutes = new Hono<AppEnv>();
const base = '/runner/v1/jobs/:id';

export const reserveCacheBody = z.object({ key: z.string().min(1).max(512) });
export const restoreCacheQuery = z.object({
  key: z.string().min(1).max(512),
  restore_keys: z
    .string()
    .max(4096)
    .optional()
    .describe('Comma-separated key prefixes, tried in order'),
});

async function running(c: Parameters<typeof authJob>[0]): Promise<CiRun> {
  const job = await authJob(c, c.req.param('id') ?? '');
  if (job.state !== 'running')
    throw new ApiError(409, 'job_not_running', 'The job has ended.');
  return job;
}

function body(c: Parameters<typeof authJob>[0]): ReadableStream<Uint8Array> {
  const stream = c.req.raw.body;
  if (!stream) throw new ApiError(400, 'empty_body', 'Send the file as the body.');
  return stream;
}

jobStorageRoutes.get(`${base}/artifacts`, async (c) => {
  try {
    const job = await running(c);
    const rows = await listArtifacts(c.env, { scope: runScope(job) });
    return c.json({ artifacts: rows.map(artifactView) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

jobStorageRoutes.get(`${base}/artifacts/:name`, async (c) => {
  try {
    const job = await running(c);
    const row = await q1<ArtifactRow>(
      c.env,
      'SELECT * FROM ci_artifacts WHERE run_scope = ? AND name = ?',
      [runScope(job), c.req.param('name')],
    );
    return await artifactResponse(c.env, row);
  } catch (err) {
    return errorResponse(c, err);
  }
});

jobStorageRoutes.put(`${base}/artifacts/:name`, async (c) => {
  try {
    const job = await running(c);
    const row = await uploadArtifact(c.env, job, c.req.param('name'), body(c));
    return c.json({ artifact: artifactView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

jobStorageRoutes.get(`${base}/caches`, async (c) => {
  try {
    const job = await running(c);
    const parsed = restoreCacheQuery.safeParse({
      key: c.req.query('key'),
      restore_keys: c.req.query('restore_keys'),
    });
    if (!parsed.success)
      throw new ApiError(400, 'invalid_request', 'Give the cache key');
    const prefixes = (parsed.data.restore_keys ?? '').split(',').filter(Boolean);
    const row = await restoreCache(c.env, job, parsed.data.key, prefixes.slice(0, 10));
    const object = row && (await c.env.OBJECTS.get(row.object_key));
    if (!row || !object) return c.body(null, 204);
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'x-cache-key': row.key,
        'x-cache-scope': row.scope,
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

jobStorageRoutes.post(`${base}/caches`, async (c) => {
  try {
    const job = await running(c);
    const parsed = reserveCacheBody.safeParse(await readJsonBody(c));
    if (!parsed.success)
      throw new ApiError(400, 'invalid_request', 'Give the cache key');
    const row = await reserveCache(c.env, job, parsed.data.key);
    return c.json({ cache: cacheView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

jobStorageRoutes.put(`${base}/caches/:cache`, async (c) => {
  try {
    const job = await running(c);
    const row = await uploadCache(c.env, job, c.req.param('cache'), body(c));
    return c.json({ cache: cacheView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});
