import { Hono, type Context } from 'hono';
import type { AppEnv } from '../auth/principal';
import { requireRecentMfa } from '../auth/session';
import { parseBody, requireOrgSso } from '../auth/owners';
import { q1 } from '../db/client';
import type { OrgRecord } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import {
  bulkImportSchema,
  bulkRepos,
  getBulkJob,
  listBulkJobs,
  resumeBulkImport,
  startBulkImport,
  type BulkJob,
} from '../bridge/bulk-import';
import { errorResponse, readJsonBody } from './errors';
import { getOrgBySlug, orgMembership } from './orgs';

/**
 * Org bulk import from GitHub (issue #72), mounted under /api/v1:
 *
 *   POST /orgs/:org/imports              start (owners and admins)
 *   GET  /orgs/:org/imports              recent jobs
 *   GET  /orgs/:org/imports/:id          progress and the per-repo report
 *   POST /orgs/:org/imports/:id/resume   retry failed repos from their checkpoints
 *
 * Org owners and admins only, with the org's SSO. A browser session needs a
 * recent MFA step-up to start or resume; an API token must be unbound to a
 * repo and carry `repo:write` (the CLI). Agents never run imports. Members
 * who cannot manage the org get 403, others 404.
 */
export const bulkImportRoutes = new Hono<AppEnv>();

async function loadImportOrg(c: Context<AppEnv>): Promise<OrgRecord> {
  const principal = c.get('principal');
  if (!principal) throw new ApiError(401, 'unauthorized', 'authentication required');
  const org = await getOrgBySlug(c.env, c.req.param('org') ?? '');
  const me = org ? await orgMembership(c.env, org.id, principal.userId) : null;
  if (!org || !me) throw new ApiError(404, 'org_not_found', 'Organisation not found');
  if (principal.kind === 'agent') {
    throw new ApiError(403, 'forbidden', 'agents cannot run imports');
  }
  if (
    principal.kind === 'token' &&
    (principal.repoId !== null || !principal.scopes.includes('repo:write'))
  ) {
    throw new ApiError(403, 'forbidden', 'an unbound token with repo:write is required');
  }
  if (me.role !== 'owner' && me.role !== 'admin') {
    throw new ApiError(403, 'forbidden', 'org owner or admin role required');
  }
  await requireOrgSso(c, org.id);
  return org;
}

/** Sessions step up with MFA to start or resume; tokens cannot. */
function stepUp(c: Context<AppEnv>): Promise<Response | null> {
  return c.get('principal')?.kind === 'user'
    ? requireRecentMfa(c)
    : Promise.resolve(null);
}

function jobView(job: BulkJob): Record<string, unknown> {
  return {
    id: job.id,
    source: 'github',
    github_org: job.source_org,
    installation_id: job.installation_id,
    repos: job.options.repos ?? null,
    status: job.status,
    resume_at: job.resume_at,
    error: job.error,
    created_by: job.created_by,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

async function report(
  c: Context<AppEnv>,
  job: BulkJob,
): Promise<Record<string, unknown>> {
  const repos = await bulkRepos(c.env, job.id);
  const slugs = new Map<string, string>();
  for (const r of repos) {
    if (!r.repo_id) continue;
    const row = await q1<{ slug: string }>(c.env, 'SELECT slug FROM repos WHERE id = ?', [
      r.repo_id,
    ]);
    if (row) slugs.set(r.repo_id, row.slug);
  }
  const totals: Record<string, number> = {};
  for (const r of repos) {
    for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;
  }
  return {
    ...jobView(job),
    listed: job.listed === 1,
    totals,
    repos: repos.map((r) => ({
      github: r.full_name,
      repo: r.repo_id ? (slugs.get(r.repo_id) ?? null) : null,
      status: r.status,
      phase: r.phase,
      counts: r.counts,
      warnings: r.warnings,
      error: r.error,
    })),
  };
}

bulkImportRoutes.post('/orgs/:org/imports', async (c) => {
  try {
    const org = await loadImportOrg(c);
    const mfa = await stepUp(c);
    if (mfa) return mfa;
    const input = parseBody(bulkImportSchema, await readJsonBody(c));
    const principal = c.get('principal');
    const job = await startBulkImport(c.env, org, principal?.userId ?? '', input);
    await recordAudit(c, {
      action: 'org.import',
      orgId: org.slug,
      target: {
        job_id: job.id,
        github_org: input.github_org,
        installation_id: input.installation_id,
        repos: input.repos ?? null,
      },
    });
    return c.json({ import: jobView(job) }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

bulkImportRoutes.get('/orgs/:org/imports', async (c) => {
  try {
    const org = await loadImportOrg(c);
    const jobs = await listBulkJobs(c.env, org.id);
    return c.json({ imports: jobs.map(jobView) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

bulkImportRoutes.get('/orgs/:org/imports/:id', async (c) => {
  try {
    const org = await loadImportOrg(c);
    const job = await getBulkJob(c.env, org.id, c.req.param('id'));
    return c.json({ import: await report(c, job) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

bulkImportRoutes.post('/orgs/:org/imports/:id/resume', async (c) => {
  try {
    const org = await loadImportOrg(c);
    const mfa = await stepUp(c);
    if (mfa) return mfa;
    const job = await resumeBulkImport(
      c.env,
      await getBulkJob(c.env, org.id, c.req.param('id')),
    );
    await recordAudit(c, {
      action: 'org.import.resume',
      orgId: org.slug,
      target: { job_id: job.id },
    });
    return c.json({ import: jobView(job) }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});
