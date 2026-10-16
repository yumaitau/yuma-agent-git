import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { requireRecentMfa } from '../auth/session';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit, type AuditInput } from '../audit/record';
import {
  createRegistrationToken,
  failRunnerJobs,
  runnerView,
  type RunnerRow,
} from '../ci/runners';
import { apiError, errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';
import { requireOrgSso } from './secrets';

/**
 * Self-hosted runner administration (issue #48). Org owners and admins manage
 * org runners; repo admins manage repo runners.
 *
 *   POST   /orgs/:org/runners/registration-token     one-time token, 1 hour
 *   GET    /orgs/:org/runners
 *   PATCH  /orgs/:org/runners/:id                    {disabled?, trusted_only?}
 *   DELETE /orgs/:org/runners/:id                    revoke the credential now
 *   (the same under /repos/:repo/runners)
 *
 * Runners receive job secrets, so every route needs a browser session (API
 * and agent tokens never manage runners), a registration token also needs a
 * recent MFA step-up, and every change is audited.
 */
export const runnerAdminRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}/runners';

export const registrationTokenBody = z.object({
  trusted_only: z.boolean().default(false),
});
export const patchRunnerBody = z
  .object({ disabled: z.boolean(), trusted_only: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Give disabled or trusted_only');

type Scope = 'org' | 'repo';
type Where = Pick<AuditInput, 'repo' | 'orgId'>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}

function requireSession(c: Context<AppEnv>): Response | null {
  return c.get('user') ? null : apiError(c, 401, 'unauthorized', 'session required');
}

async function mintToken(
  c: Context<AppEnv>,
  scope: Scope,
  ownerId: string,
  where: Where,
): Promise<Response> {
  const body = parse(registrationTokenBody, await readJsonBody(c));
  const minted = await createRegistrationToken(
    c.env,
    scope,
    ownerId,
    body.trusted_only,
    c.get('user')!.id,
  );
  await recordAudit(c, {
    action: 'runner.registration_token.create',
    ...where,
    target: { scope, trusted_only: body.trusted_only, expires_at: minted.expires_at },
  });
  return c.json(minted, 201);
}

async function list(
  c: Context<AppEnv>,
  scope: Scope,
  ownerId: string,
): Promise<Response> {
  const rows = await q<RunnerRow>(
    c.env,
    'SELECT * FROM runners WHERE scope = ? AND owner_id = ? ORDER BY name, id',
    [scope, ownerId],
  );
  return c.json({ runners: rows.map(runnerView) });
}

async function update(
  c: Context<AppEnv>,
  scope: Scope,
  ownerId: string,
  where: Where,
): Promise<Response> {
  const body = parse(patchRunnerBody, await readJsonBody(c));
  const id = c.req.param('id');
  const row = await q1<RunnerRow>(
    c.env,
    `UPDATE runners SET disabled = COALESCE(?, disabled), trusted_only = COALESCE(?, trusted_only)
    WHERE id = ? AND scope = ? AND owner_id = ? RETURNING *`,
    [
      body.disabled === undefined ? null : Number(body.disabled),
      body.trusted_only === undefined ? null : Number(body.trusted_only),
      id,
      scope,
      ownerId,
    ],
  );
  if (!row) return apiError(c, 404, 'runner_not_found', 'No such runner');
  await recordAudit(c, {
    action: 'runner.update',
    ...where,
    target: { runner_id: id, ...body },
  });
  return c.json({ runner: runnerView(row) });
}

async function remove(
  c: Context<AppEnv>,
  scope: Scope,
  ownerId: string,
  where: Where,
): Promise<Response> {
  const id = c.req.param('id');
  const row = await q1<RunnerRow>(
    c.env,
    'DELETE FROM runners WHERE id = ? AND scope = ? AND owner_id = ? RETURNING *',
    [id, scope, ownerId],
  );
  if (!row) return apiError(c, 404, 'runner_not_found', 'No such runner');
  await failRunnerJobs(c.env, row.id);
  await recordAudit(c, {
    action: 'runner.delete',
    ...where,
    target: { runner_id: id, name: row.name },
  });
  return c.json({ ok: true });
}

// --- org runners ---------------------------------------------------------------

runnerAdminRoutes.post('/orgs/:org/runners/registration-token', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    return await mintToken(c, 'org', org.id, { orgId: org.slug });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.get('/orgs/:org/runners', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    return await list(c, 'org', org.id);
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.patch('/orgs/:org/runners/:id', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    return await update(c, 'org', org.id, { orgId: org.slug });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.delete('/orgs/:org/runners/:id', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    return await remove(c, 'org', org.id, { orgId: org.slug });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- repo runners --------------------------------------------------------------

runnerAdminRoutes.post(`${base}/registration-token`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    return await mintToken(c, 'repo', loaded.repo.id, { repo: loaded.repo });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.get(base, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return await list(c, 'repo', loaded.repo.id);
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.patch(`${base}/:id`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return await update(c, 'repo', loaded.repo.id, { repo: loaded.repo });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerAdminRoutes.delete(`${base}/:id`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return await remove(c, 'repo', loaded.repo.id, { repo: loaded.repo });
  } catch (err) {
    return errorResponse(c, err);
  }
});
