import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { recordAudit } from '../audit/record';
import { q1 } from '../db/client';
import { resolveRevision } from '../core/read';
import { ApiError } from '../core/errors';
import { cancelPipeline, listPipelineRuns, startPipeline } from '../ci/planner';
import { loadPipelines } from '../ci/spec';
import { ciReady } from '../ci/triggers';
import { errorResponse, readJsonBody } from './errors';

/** Pipeline spec v2 runs (issue #47). Runs read the whole tree, so every route needs the whole repo. */
export const pipelineRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}/ci/pipelines';

pipelineRoutes.get(base, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const head = c.req.query('head');
    if (head !== undefined && !/^[a-f0-9]{64}$/.test(head))
      throw new ApiError(400, 'invalid_head', 'head must be a changeset id');
    return c.json({ runs: await listPipelineRuns(c.env, loaded.repo.id, head) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

const manual = z.object({
  pipeline: z.string().min(1).max(300),
  head: z.string().min(1).max(300).optional(),
});
pipelineRoutes.post(`${base}/runs`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const parsed = manual.safeParse(await readJsonBody(c));
    if (!parsed.success)
      throw new ApiError(400, 'invalid_request', 'Give the pipeline file path');
    const input = parsed.data;
    if (!ciReady(c.env))
      throw new ApiError(
        503,
        'ci_not_enabled',
        'CI execution is not enabled. Your administrator can enable the Cloudflare runner after deployment.',
      );
    const ref = input.head ?? loaded.repo.default_branch;
    const cs = await resolveRevision(c.env, loaded.repo.id, input.head ?? `ref:${ref}`);
    const file = (await loadPipelines(c.env, loaded.repo.id, cs.id)).find(
      (f) => f.path === input.pipeline,
    );
    if (!file)
      throw new ApiError(404, 'pipeline_not_found', 'No such pipeline at this revision');
    if (file.errors)
      throw new ApiError(422, 'invalid_pipeline', 'Fix the pipeline file first', {
        errors: file.errors,
      });
    if (file.pipeline!.on.manual === undefined)
      throw new ApiError(
        409,
        'manual_not_allowed',
        'Add a manual trigger to run it here',
      );
    const id = await startPipeline(c.env, {
      repoId: loaded.repo.id,
      head: cs.id,
      path: file.path,
      pipeline: file.pipeline,
      event: 'manual',
      ref,
      actor: c.get('principal')!.userId,
    });
    await recordAudit(c, {
      action: 'ci.run.create',
      repo: loaded.repo,
      target: { pipeline_run_id: id, pipeline: file.path, head_cs: cs.id },
    });
    const runs = await listPipelineRuns(c.env, loaded.repo.id, cs.id);
    return c.json({ run: runs.find((r) => r.id === id) }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

pipelineRoutes.post(`${base}/runs/:id/cancel`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const found = await q1<{ id: string }>(
      c.env,
      'SELECT id FROM ci_pipeline_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!found) throw new ApiError(404, 'run_not_found', 'Run not found');
    await cancelPipeline(c.env, found.id, 'Cancelled');
    await recordAudit(c, {
      action: 'ci.run.cancel',
      repo: loaded.repo,
      target: { pipeline_run_id: found.id },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
