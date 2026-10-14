import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getImportJob, startImport } from '../bridge/import';
import { loadReadableRepo, loadWritableRepo } from '../auth/guards';

/**
 * Import job routes (issue #15), mounted under /api/v1:
 *   POST /api/v1/repos/:repo/import
 *   GET  /api/v1/repos/:repo/import/:job_id
 */
export const importRoutes = new Hono<{ Bindings: Env }>();

const importSchema = z.object({
  source: z.string(),
  mode: z.enum(['snapshot', 'full_history']).optional(),
  ref: z.string().optional(),
});

importRoutes.post('/repos/:repo{.+}/import', async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid import request');
    }
    const started = await startImport(c.env, loaded.repo.id, parsed.data);
    return c.json({ job_id: started.job_id, status: 'queued' }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

importRoutes.get('/repos/:repo{.+}/import/:job_id', async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const job = await getImportJob(c.env, loaded.repo.id, c.req.param('job_id'));
    return c.json(
      {
        job_id: job.id,
        status: job.status,
        mode: job.mode,
        commits_total: job.commits_total,
        commits_done: job.commits_done,
        checkpoint: job.checkpoint,
        error: job.error,
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
