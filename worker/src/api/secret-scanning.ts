import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { actorOf, recordAudit } from '../audit/record';
import { q, q1 } from '../db/client';
import { emitEvent } from '../webhooks/events';
import { DETECTOR_NAMES, DETECTORS_VERSION } from '../security/secrets/detectors';
import { latestSecretScan, startSecretScan } from '../security/secrets/history';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Secret scanning alerts (issue #66), for whole-repository admins:
 *   GET   /api/v1/repos/:repo/secret-scanning/alerts?state=&cursor=
 *   PATCH /api/v1/repos/:repo/secret-scanning/alerts/:id   resolve or reopen
 *   POST  /api/v1/repos/:repo/secret-scanning/scans        scan the history again
 * Alerts never carry the secret; they say which detector found what where.
 * Agents cannot resolve alerts or start scans.
 */
export const secretScanningRoutes = new Hono<AppEnv>();

export const RESOLUTIONS = [
  'revoked',
  'false_positive',
  'test_data',
  'wont_fix',
] as const;
export const alertListQuery = z.object({
  state: z.enum(['open', 'resolved']).optional(),
  cursor: z.string().optional(),
});
export const updateAlertSchema = z.union([
  z.object({ state: z.literal('resolved'), resolution: z.enum(RESOLUTIONS) }),
  z.object({ state: z.literal('open') }),
]);

const alertRowSchema = z.object({
  id: z.number(),
  detector: z.string(),
  path: z.string(),
  line: z.number(),
  changeset_id: z.string().nullable(),
  source: z.string(),
  state: z.enum(['open', 'resolved']),
  resolution: z.string().nullable(),
  bypass_reason: z.string().nullable(),
  bypass_comment: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  resolved_by: z.string().nullable(),
  resolved_at: z.number().nullable(),
});
type Alert = z.infer<typeof alertRowSchema>;

const ALERT_COLUMNS =
  'id, detector, path, line, changeset_id, source, state, resolution, bypass_reason, bypass_comment, created_by, created_at, resolved_by, resolved_at';

function view(alert: Alert): Record<string, unknown> {
  return { ...alert, detector_name: DETECTOR_NAMES[alert.detector] ?? alert.detector };
}

/** Agents may read alerts but never resolve them or start scans. */
function refuseAgents(c: Context<AppEnv>): Response | null {
  return c.get('principal')?.kind === 'agent'
    ? apiError(c, 403, 'forbidden', 'Agents cannot manage secret scanning')
    : null;
}

secretScanningRoutes.get('/repos/:repo{.+}/secret-scanning/alerts', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = alertListQuery.safeParse(c.req.query());
    const before = Number(query.data?.cursor ?? Number.MAX_SAFE_INTEGER);
    if (!query.success || !Number.isSafeInteger(before))
      return apiError(c, 400, 'invalid_request', 'Invalid state or cursor');
    const rows = await q(
      c.env,
      `SELECT ${ALERT_COLUMNS} FROM secret_alerts
        WHERE repo_id = ? AND id < ? ${query.data.state ? 'AND state = ?' : ''}
        ORDER BY id DESC LIMIT 101`,
      [loaded.repo.id, before, ...(query.data.state ? [query.data.state] : [])],
    );
    const alerts = rows.slice(0, 100).map((r) => alertRowSchema.parse(r));
    return c.json(
      {
        alerts: alerts.map(view),
        next_cursor: rows.length > 100 ? String(alerts[alerts.length - 1]?.id) : null,
        scan: await latestSecretScan(c.env, loaded.repo.id),
        detectors_version: DETECTORS_VERSION,
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretScanningRoutes.patch('/repos/:repo{.+}/secret-scanning/alerts/:id', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const agent = refuseAgents(c);
    if (agent) return agent;
    const repo = loaded.repo;
    const parsed = updateAlertSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        'Send state open, or resolved with a resolution',
      );
    const row = await q1(
      c.env,
      `SELECT ${ALERT_COLUMNS} FROM secret_alerts WHERE repo_id = ? AND id = ?`,
      [repo.id, Number(c.req.param('id'))],
    );
    if (!row) return apiError(c, 404, 'alert_not_found', 'Alert not found');
    const before = alertRowSchema.parse(row);
    const principal = c.get('principal');
    const resolved = parsed.data.state === 'resolved';
    const now = Date.now();
    const after: Alert = {
      ...before,
      state: parsed.data.state,
      resolution: parsed.data.state === 'resolved' ? parsed.data.resolution : null,
      resolved_by: resolved ? (principal?.userId ?? null) : null,
      resolved_at: resolved ? now : null,
    };
    await recordAudit(
      c,
      {
        action: 'secret_scanning.alert.update',
        repo,
        target: {
          alert_id: before.id,
          detector: before.detector,
          path: before.path,
          state: after.state,
          resolution: after.resolution,
          previous: { state: before.state, resolution: before.resolution },
        },
      },
      [
        c.env.DB.prepare(
          'UPDATE secret_alerts SET state = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
        ).bind(
          after.state,
          after.resolution,
          after.resolved_by,
          after.resolved_at,
          before.id,
        ),
      ],
    );
    if (before.state !== after.state) {
      await emitEvent(c.env, repo, {
        event: 'secret_scanning_alert',
        action: resolved ? 'resolved' : 'reopened',
        actor: actorOf(principal),
        origin: new URL(c.req.url).origin,
        data: { alert: view(after) },
      });
    }
    return c.json({ alert: view(after) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretScanningRoutes.post('/repos/:repo{.+}/secret-scanning/scans', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const agent = refuseAgents(c);
    if (agent) return agent;
    const scan = await startSecretScan(
      c.env,
      loaded.repo.id,
      actorOf(c.get('principal')),
    );
    await recordAudit(c, {
      action: 'secret_scanning.scan.start',
      repo: loaded.repo,
      target: { scan_id: scan.id },
    });
    return c.json({ scan }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});
