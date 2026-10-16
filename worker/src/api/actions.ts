import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { recordAudit } from '../audit/record';
import { getRef } from '../db/repos';
import { resolveRevision } from '../core/read';
import { ApiError } from '../core/errors';
import { loadPipelines, MAX_FILE_BYTES, MAX_FILES } from '../ci/spec';
import {
  actionsEnabled,
  analyseRevision,
  analyseTexts,
  summarise,
  WORKFLOW_DIR,
} from '../ci/gha/analyse';
import { enforceAgentAction } from '../policy/guardrails';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * GitHub Actions compatibility (issue #49):
 *   GET  /api/v1/repos/:repo/ci/actions   report for `.github/workflows` at a revision
 *   PUT  /api/v1/repos/:repo/ci/actions   opt in or out of running them (admin, audited)
 *   POST /api/v1/ci/actions/check         report for workflow texts sent by the caller
 * Workflows are CI scripts, so repo routes need the whole repository.
 */
export const actionsRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}/ci/actions';

export const actionsSettingsBody = z.object({ enabled: z.boolean() });
export const checkWorkflowsBody = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        content: z.string().max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

actionsRoutes.get(base, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const head = c.req.query('head');
    const enabled = await actionsEnabled(c.env, repo.id);
    if (head === undefined && !(await getRef(c.env, repo.id, repo.default_branch)))
      return c.json({
        enabled,
        active: false,
        head_cs: null,
        summary: summarise([]),
        workflows: [],
      });
    const cs = await resolveRevision(
      c.env,
      repo.id,
      head ?? `ref:${repo.default_branch}`,
    );
    const { reports } = await analyseRevision(c.env, repo.id, cs.id);
    // false while `.yuma/pipelines` files exist: those run instead
    const active =
      enabled &&
      (await loadPipelines(c.env, repo.id, cs.id)).some((f) =>
        f.path.startsWith(`${WORKFLOW_DIR.join('/')}/`),
      );
    return c.json({
      enabled,
      active,
      head_cs: cs.id,
      summary: summarise(reports),
      workflows: reports,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

actionsRoutes.put(base, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const { enabled } = parse(actionsSettingsBody, await readJsonBody(c));
    const repoId = loaded.repo.id;
    // agent guardrails (#62): turning workflows into pipelines changes what CI runs
    const change = { setting: 'ci.actions', enabled };
    await enforceAgentAction(
      c.env,
      c.get('principal'),
      loaded.repo,
      { action: 'pipeline.edit' },
      { exact: change, summary: change },
    );
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO ci_actions_settings (repo_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (repo_id) DO UPDATE SET enabled = excluded.enabled,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(repoId, enabled ? 1 : 0, c.get('principal')!.userId, Date.now()),
      // schedules are re-read from the default branch on the next sweep
      c.env.DB.prepare('DELETE FROM ci_schedule_scans WHERE repo_id = ?').bind(repoId),
    ]);
    await recordAudit(c, {
      action: 'ci.actions.update',
      repo: loaded.repo,
      target: { enabled },
    });
    return c.json({ enabled });
  } catch (err) {
    return errorResponse(c, err);
  }
});

actionsRoutes.post('/ci/actions/check', async (c) => {
  try {
    if (!c.get('principal'))
      return apiError(c, 401, 'unauthorized', 'authentication required');
    const { files } = parse(checkWorkflowsBody, await readJsonBody(c));
    const { reports } = analyseTexts(files);
    return c.json({ summary: summarise(reports), workflows: reports });
  } catch (err) {
    return errorResponse(c, err);
  }
});
