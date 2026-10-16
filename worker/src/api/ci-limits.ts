import { Hono, type Context } from 'hono';
import type { AppEnv } from '../auth/principal';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import { limitsOf, limitsSchema, type LimitsRow } from '../ci/capacity';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getOrgBySlug, loadOrg } from './orgs';
import { requireOrgSso } from './secrets';

/**
 * Per-org CI capacity (issue #52). The budget is the deployment's money, so
 * only CI admins (the user ids in `CI_ADMIN_USER_IDS`, browser session) give
 * an org its own pool; org owners and admins see their limits and this
 * month's reservations. Orgs without limits use the shared pool.
 *
 *   GET    /orgs/:org/ci/limits     limits (null: shared pool) and usage
 *   PUT    /orgs/:org/ci/limits     CI admins: set the org's pool
 *   DELETE /orgs/:org/ci/limits     CI admins: back to the shared pool
 */
export const ciLimitsRoutes = new Hono<AppEnv>();
const path = '/orgs/:org/ci/limits';

async function ciAdminOrg(c: Context<AppEnv>) {
  const user = c.get('user')!;
  const admins = (c.env.CI_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim());
  if (!admins.includes(user.id))
    throw new ApiError(403, 'forbidden', 'CI admin required');
  const org = await getOrgBySlug(c.env, c.req.param('org') ?? '');
  if (!org) throw new ApiError(404, 'org_not_found', 'Organisation not found');
  return org;
}

ciLimitsRoutes.get(path, async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    const row = await q1<LimitsRow>(
      c.env,
      'SELECT * FROM org_ci_limits WHERE org_id = ?',
      [org.id],
    );
    const month = new Date().toISOString().slice(0, 7);
    // the org's own runs only: the shared pool's total belongs to the operator
    const usage = await q1<{ reserved: number; active: number }>(
      c.env,
      `SELECT COALESCE(SUM(CASE WHEN r.month = ? THEN r.reserved_micros END), 0) AS reserved,
        COUNT(CASE WHEN r.state IN ('queued','running') AND r.runs_on IS NULL THEN 1 END) AS active
      FROM ci_runs r JOIN repos p ON p.id = r.repo_id
      WHERE p.owner_kind = 'org' AND p.owner_id = ?`,
      [month, org.id],
    );
    const alerts = row
      ? await q<{ threshold: number; created_at: number }>(
          c.env,
          'SELECT threshold, created_at FROM ci_budget_alerts WHERE pool = ? AND month = ? ORDER BY threshold',
          [org.id, month],
        )
      : [];
    return c.json({
      limits: row ? limitsOf(row) : null,
      month,
      reserved_usd: (usage?.reserved ?? 0) / 1e6,
      active_jobs: usage?.active ?? 0,
      alerts,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

ciLimitsRoutes.put(path, async (c) => {
  try {
    if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
    const org = await ciAdminOrg(c);
    const parsed = limitsSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const limits = parsed.data;
    await recordAudit(
      c,
      {
        action: 'ci.limits.update',
        orgId: org.slug,
        target: { org_id: org.id, ...limits },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO org_ci_limits (org_id, max_concurrent, monthly_budget_usd, max_timeout_s, instance_types, cache_quota_bytes, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (org_id) DO UPDATE SET max_concurrent = excluded.max_concurrent,
            monthly_budget_usd = excluded.monthly_budget_usd, max_timeout_s = excluded.max_timeout_s,
            instance_types = excluded.instance_types, cache_quota_bytes = excluded.cache_quota_bytes,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).bind(
          org.id,
          limits.max_concurrent,
          limits.monthly_budget_usd,
          limits.max_timeout_s,
          JSON.stringify(limits.instance_types),
          limits.cache_quota_bytes,
          c.get('user')!.id,
          Date.now(),
        ),
      ],
    );
    return c.json({ limits });
  } catch (err) {
    return errorResponse(c, err);
  }
});

ciLimitsRoutes.delete(path, async (c) => {
  try {
    if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
    const org = await ciAdminOrg(c);
    await recordAudit(
      c,
      {
        action: 'ci.limits.update',
        orgId: org.slug,
        target: { org_id: org.id, shared: true },
      },
      [c.env.DB.prepare('DELETE FROM org_ci_limits WHERE org_id = ?').bind(org.id)],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
