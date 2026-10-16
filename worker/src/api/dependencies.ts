import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { actorOf, recordAudit } from '../audit/record';
import { q, q1 } from '../db/client';
import { emitEvent } from '../webhooks/events';
import { getIssueRow, hydrateIssues, nextNumber } from '../collab/issues';
import { claimantOf, isApprover } from '../collab/work';
import {
  ALERT_COLUMNS,
  alertRowSchema,
  alertViews,
  snapshotOf,
  type DependencyAlert,
} from '../security/deps/graph';
import {
  compareVersions,
  loadAdvisories,
  OSV_ATTRIBUTION,
  osvEntrySchema,
  SEVERITIES,
} from '../security/deps/osv';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Dependency alerts (issue #67), for people with whole-repository write:
 *   GET   /api/v1/repos/:repo/dependencies                 default branch packages
 *   GET   /api/v1/repos/:repo/dependency-alerts            ?state=&severity=&cursor=
 *   PATCH /api/v1/repos/:repo/dependency-alerts/:id        dismiss or reopen
 *   POST  /api/v1/repos/:repo/dependency-alerts/:id/work   update work item (#59)
 *   POST  /api/v1/admin/advisories                         load an OSV snapshot
 * Agents read alerts and file update work; they cannot dismiss alerts.
 */
export const dependencyRoutes = new Hono<AppEnv>();

const PAGE = 100;
export const dependencyListQuery = z.object({
  ecosystem: z.string().max(20).optional(),
  cursor: z.string().optional(),
});
export const dependencyAlertQuery = z.object({
  state: z.enum(['open', 'fixed', 'dismissed']).optional(),
  severity: z.enum([...SEVERITIES, 'unknown']).optional(),
  cursor: z.string().optional(),
});
export const DISMISS_REASONS = [
  'fix_started',
  'inaccurate',
  'no_bandwidth',
  'not_used',
  'tolerable_risk',
] as const;
export const updateDependencyAlert = z.union([
  z.object({ state: z.literal('dismissed'), reason: z.enum(DISMISS_REASONS) }),
  z.object({ state: z.literal('open') }),
]);
export const loadAdvisoriesSchema = z.object({
  advisories: z.array(osvEntrySchema).min(1).max(1000),
});

function refuseAgents(c: Context<AppEnv>): Response | null {
  return c.get('principal')?.kind === 'agent'
    ? apiError(c, 403, 'forbidden', 'Agents cannot dismiss or reopen alerts')
    : null;
}

dependencyRoutes.get('/repos/:repo{.+}/dependencies', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = dependencyListQuery.safeParse(c.req.query());
    const offset = Number(query.data?.cursor ?? 0);
    if (!query.success || !Number.isSafeInteger(offset) || offset < 0)
      return apiError(c, 400, 'invalid_request', 'Invalid ecosystem or cursor');
    const eco = query.data.ecosystem;
    const rows = await q(
      c.env,
      `SELECT ecosystem, name, version, path FROM repo_dependencies
        WHERE repo_id = ? ${eco ? 'AND ecosystem = ?' : ''}
        ORDER BY ecosystem, name, version, path LIMIT ? OFFSET ?`,
      [loaded.repo.id, ...(eco ? [eco] : []), PAGE + 1, offset],
    );
    return c.json(
      {
        dependencies: rows.slice(0, PAGE),
        next_cursor: rows.length > PAGE ? String(offset + PAGE) : null,
        snapshot: await snapshotOf(c.env, loaded.repo.id),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

dependencyRoutes.get('/repos/:repo{.+}/dependency-alerts', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = dependencyAlertQuery.safeParse(c.req.query());
    const before = Number(query.data?.cursor ?? Number.MAX_SAFE_INTEGER);
    if (!query.success || !Number.isSafeInteger(before))
      return apiError(c, 400, 'invalid_request', 'Invalid state, severity or cursor');
    const { state, severity } = query.data;
    const rows = await q(
      c.env,
      `SELECT ${ALERT_COLUMNS} FROM dependency_alerts
        WHERE repo_id = ? AND id < ? ${state ? 'AND state = ?' : ''} ${severity ? 'AND severity = ?' : ''}
        ORDER BY id DESC LIMIT ?`,
      [
        loaded.repo.id,
        before,
        ...(state ? [state] : []),
        ...(severity ? [severity] : []),
        PAGE + 1,
      ],
    );
    const alerts = rows.slice(0, PAGE).map((r) => alertRowSchema.parse(r));
    return c.json(
      {
        alerts: await alertViews(c.env, alerts),
        next_cursor: rows.length > PAGE ? String(alerts[alerts.length - 1]?.id) : null,
        snapshot: await snapshotOf(c.env, loaded.repo.id),
        attribution: OSV_ATTRIBUTION,
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function loadAlert(
  c: Context<AppEnv>,
  repoId: string,
): Promise<DependencyAlert | null> {
  const row = await q1(
    c.env,
    `SELECT ${ALERT_COLUMNS} FROM dependency_alerts WHERE repo_id = ? AND id = ?`,
    [repoId, Number(c.req.param('id'))],
  );
  return row ? alertRowSchema.parse(row) : null;
}

dependencyRoutes.patch('/repos/:repo{.+}/dependency-alerts/:id', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const agent = refuseAgents(c);
    if (agent) return agent;
    const repo = loaded.repo;
    const parsed = updateDependencyAlert.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        'Send state open, or dismissed with a reason',
      );
    const before = await loadAlert(c, repo.id);
    if (!before) return apiError(c, 404, 'alert_not_found', 'Alert not found');
    if (before.state === 'fixed')
      return apiError(
        c,
        409,
        'alert_fixed',
        'A fixed alert cannot be dismissed or reopened',
      );
    const dismissed = parsed.data.state === 'dismissed';
    const after: DependencyAlert = {
      ...before,
      state: parsed.data.state,
      dismissed_reason: parsed.data.state === 'dismissed' ? parsed.data.reason : null,
      dismissed_by: dismissed ? (c.get('principal')?.userId ?? null) : null,
      updated_at: Date.now(),
    };
    await recordAudit(
      c,
      {
        action: 'dependency_alert.update',
        repo,
        target: {
          alert_id: before.id,
          advisory_id: before.advisory_id,
          package: `${before.ecosystem}:${before.name}`,
          state: after.state,
          reason: after.dismissed_reason,
          previous: { state: before.state, reason: before.dismissed_reason },
        },
      },
      [
        c.env.DB.prepare(
          'UPDATE dependency_alerts SET state = ?, dismissed_reason = ?, dismissed_by = ?, updated_at = ? WHERE id = ?',
        ).bind(
          after.state,
          after.dismissed_reason,
          after.dismissed_by,
          after.updated_at,
          before.id,
        ),
      ],
    );
    const [view] = await alertViews(c.env, [after]);
    if (before.state !== after.state)
      await emitEvent(c.env, repo, {
        event: 'dependency_alert',
        action: dismissed ? 'dismissed' : 'reopened',
        actor: actorOf(c.get('principal')),
        origin: new URL(c.req.url).origin,
        data: { alert: view },
      });
    return c.json({ alert: view });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** A patch update (same major and minor) is low risk; anything larger is medium. */
function riskOf(from: string, to: string): 'low' | 'medium' {
  const head = (v: string): string =>
    v.replace(/^v/, '').split(/[.-]/).slice(0, 2).join('.');
  return head(from) === head(to) ? 'low' : 'medium';
}

/**
 * File the update as a work item (#59) for an agent (or a person) to claim
 * and open the pull request: an issue that names the package, versions,
 * lockfile and advisory. Approvers file it `ready`, others `needs-prep`.
 */
dependencyRoutes.post('/repos/:repo{.+}/dependency-alerts/:id/work', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scope = requireAgentScope(c, 'issues:write');
    if (scope) return scope;
    const repo = loaded.repo;
    const principal = c.get('principal')!;
    const alert = await loadAlert(c, repo.id);
    if (!alert) return apiError(c, 404, 'alert_not_found', 'Alert not found');
    if (alert.state !== 'open')
      return apiError(c, 409, 'alert_not_open', 'Only open alerts get update work');
    const fixed = alert.fixed_version;
    if (!fixed || compareVersions(fixed, alert.version) <= 0)
      return apiError(c, 422, 'no_fixed_version', 'The advisory names no fixed version');
    if (alert.work_number !== null) {
      const existing = await getIssueRow(c.env, repo.id, alert.work_number);
      if (existing?.state === 'open') {
        const [issue] = await hydrateIssues(c.env, [existing]);
        return c.json({ issue, created: false });
      }
    }
    const [view] = await alertViews(c.env, [alert]);
    const advisory = (view?.advisory ?? {}) as { url?: string; summary?: string };
    const title =
      `Bump ${alert.name} from ${alert.version} to ${fixed} in ${alert.path}`.slice(
        0,
        256,
      );
    const body = [
      `Bump \`${alert.name}\` (${alert.ecosystem}) from \`${alert.version}\` to \`${fixed}\` in \`${alert.path}\`.`,
      '',
      `Fixes dependency alert ${alert.id}: [${alert.advisory_id}](${advisory.url ?? ''}) (${alert.severity})${advisory.summary ? `, ${advisory.summary}` : ''}.`,
      '',
      'Update the lockfile with the package manager, run the tests and open a pull request.',
      '',
      OSV_ATTRIBUTION,
    ].join('\n');
    const ready = await isApprover(c.env, repo, principal);
    const readiness = ready ? 'ready' : 'needs-prep';
    const risk = riskOf(alert.version, fixed);
    const number = await nextNumber(c.env, repo.id);
    const now = Date.now();
    const issueId = `(SELECT id FROM issues WHERE repo_id = ? AND number = ?)`;
    await recordAudit(
      c,
      {
        action: 'dependency_alert.work',
        repo,
        target: { alert_id: alert.id, advisory_id: alert.advisory_id, number, risk },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO issues (repo_id, number, title, body, author_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).bind(repo.id, number, title, body, principal.userId, now, now),
        c.env.DB.prepare(
          `INSERT INTO work_items (issue_id, repo_id, readiness, risk, ready_at, updated_at)
           VALUES (${issueId}, ?, ?, ?, ?, ?)`,
        ).bind(repo.id, number, repo.id, readiness, risk, ready ? now : null, now),
        c.env.DB.prepare(
          `INSERT INTO work_events (issue_id, actor, kind, from_readiness, to_readiness, reason, created_at)
           VALUES (${issueId}, ?, 'created', NULL, ?, ?, ?)`,
        ).bind(
          repo.id,
          number,
          claimantOf(principal),
          readiness,
          `dependency alert ${alert.id}`,
          now,
        ),
        c.env.DB.prepare(
          'UPDATE dependency_alerts SET work_number = ?, updated_at = ? WHERE id = ?',
        ).bind(number, now, alert.id),
      ],
    );
    const row = await getIssueRow(c.env, repo.id, number);
    const [issue] = await hydrateIssues(c.env, row ? [row] : []);
    await emitEvent(c.env, repo, {
      event: 'issues',
      action: 'opened',
      actor: actorOf(principal),
      origin: new URL(c.req.url).origin,
      data: { issue },
    });
    return c.json({ issue, created: true, readiness, risk }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

dependencyRoutes.post('/admin/advisories', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const admins = (c.env.SECURITY_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim());
    if (!admins.includes(user.id))
      return apiError(c, 403, 'forbidden', 'security admin required');
    const parsed = loadAdvisoriesSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        'Send 1 to 1000 OSV entries as advisories',
      );
    const result = await loadAdvisories(c.env, parsed.data.advisories);
    await recordAudit(c, {
      action: 'advisories.load',
      target: {
        loaded: result.loaded,
        unchanged: result.unchanged,
        packages: result.packages.length,
      },
    });
    return c.json({
      loaded: result.loaded,
      unchanged: result.unchanged,
      packages: result.packages.length,
      attribution: OSV_ATTRIBUTION,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
