import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { requireRecentMfa } from '../auth/session';
import { q, q1, run } from '../db/client';
import { ApiError } from '../core/errors';
import { apiError, errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';
import { recordAudit } from '../audit/record';
import {
  checkName,
  deleteEntry,
  ENVIRONMENT_RE,
  listSecrets,
  listVariables,
  orgScope,
  putSecret,
  putVariable,
  repoScope,
  type Scope,
} from '../secrets/store';
import { rewrapDataKeys } from '../secrets/crypto';
import { decideApproval, rulesSchema, type ApprovalRow } from '../ci/environments';

/**
 * CI secrets, variables and environments (issue #50).
 *
 *   GET|PUT|DELETE /repos/:repo/secrets[/:name][?environment=]    repo admins
 *   GET|PUT|DELETE /repos/:repo/variables[/:name][?environment=]  repo admins
 *   GET|PUT|DELETE /repos/:repo/environments[/:env]               read / admin
 *   GET  /repos/:repo/environment-approvals[?state=]              readers
 *   POST /repos/:repo/environment-approvals/:id                   listed reviewers
 *   GET|PUT|DELETE /orgs/:org/secrets[/:name], /orgs/:org/variables[/:name]
 *   POST /admin/secrets/rewrap                                    SECRETS_ADMIN_USER_IDS
 *
 * Secret values are write-only: no route returns one. Changes need a browser
 * session; secret and environment changes also need a recent MFA step-up
 * when the user has a factor enrolled. Every change is audited.
 */
export const secretsRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';
const secretBody = z.object({ value: z.string() });
const variableBody = z.object({ value: z.string() });
const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).default(''),
});
const environmentBody = z.object({
  reviewers: z
    .array(z.object({ type: z.enum(['user', 'team']), name: z.string().min(1).max(100) }))
    .max(6)
    .default([]),
  wait_timer_minutes: z.number().int().min(0).max(43_200).default(0),
  allowed_branches: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  humans_only: z.boolean().default(false),
});

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

function environmentOf(c: Context<AppEnv>): string | null {
  const name = c.req.query('environment');
  if (name === undefined || name === '') return null;
  if (!ENVIRONMENT_RE.test(name))
    throw new ApiError(400, 'invalid_environment', 'Invalid environment name');
  return name;
}

async function environmentExists(
  c: Context<AppEnv>,
  repoId: string,
  name: string | null,
): Promise<void> {
  if (
    name &&
    !(await q1(c.env, 'SELECT 1 FROM environments WHERE repo_id = ? AND name = ?', [
      repoId,
      name,
    ]))
  )
    throw new ApiError(404, 'environment_not_found', `No environment ${name}`);
}

// --- repository and environment secrets -------------------------------------

secretsRoutes.get(`${base}/secrets`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const environment = environmentOf(c);
    return c.json({
      secrets: await listSecrets(c.env, repoScope(loaded.repo, environment)),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

for (const method of ['put', 'delete'] as const) {
  secretsRoutes[method](`${base}/secrets/:name`, async (c) => {
    try {
      const noSession = requireSession(c);
      if (noSession) return noSession;
      const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
      if (!loaded.ok) return loaded.response;
      const mfa = await requireRecentMfa(c);
      if (mfa) return mfa;
      const environment = environmentOf(c);
      await environmentExists(c, loaded.repo.id, environment);
      const scope = repoScope(loaded.repo, environment);
      return await writeSecret(c, method, scope, { repo: loaded.repo });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

async function writeSecret(
  c: Context<AppEnv>,
  method: 'put' | 'delete',
  scope: Scope,
  where: { repo?: { id: string; slug: string }; orgId?: string },
): Promise<Response> {
  const name = checkName(c.req.param('name') ?? '');
  const target = { scope: scope.scope, environment: scope.environment || null, name };
  if (method === 'delete') {
    if (!(await deleteEntry(c.env, 'secrets', scope, name)))
      return apiError(c, 404, 'secret_not_found', `No secret ${name}`);
    await recordAudit(c, { action: 'secret.delete', ...where, target });
    return c.json({ ok: true });
  }
  const body = parse(secretBody, await readJsonBody(c));
  const meta = await putSecret(c.env, scope, name, body.value, c.get('user')!.id);
  await recordAudit(c, { action: 'secret.set', ...where, target });
  // write-only: the value is never echoed back
  return c.json({ secret: meta });
}

// --- repository and environment variables -----------------------------------

secretsRoutes.get(`${base}/variables`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return c.json({
      variables: await listVariables(c.env, repoScope(loaded.repo, environmentOf(c))),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

for (const method of ['put', 'delete'] as const) {
  secretsRoutes[method](`${base}/variables/:name`, async (c) => {
    try {
      const noSession = requireSession(c);
      if (noSession) return noSession;
      const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
      if (!loaded.ok) return loaded.response;
      const environment = environmentOf(c);
      await environmentExists(c, loaded.repo.id, environment);
      return await writeVariable(c, method, repoScope(loaded.repo, environment), {
        repo: loaded.repo,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

async function writeVariable(
  c: Context<AppEnv>,
  method: 'put' | 'delete',
  scope: Scope,
  where: { repo?: { id: string; slug: string }; orgId?: string },
): Promise<Response> {
  const name = checkName(c.req.param('name') ?? '');
  const target = { scope: scope.scope, environment: scope.environment || null, name };
  if (method === 'delete') {
    if (!(await deleteEntry(c.env, 'variables', scope, name)))
      return apiError(c, 404, 'variable_not_found', `No variable ${name}`);
    await recordAudit(c, { action: 'variable.delete', ...where, target });
    return c.json({ ok: true });
  }
  const body = parse(variableBody, await readJsonBody(c));
  const variable = await putVariable(c.env, scope, name, body.value, c.get('user')!.id);
  await recordAudit(c, { action: 'variable.set', ...where, target });
  return c.json({ variable });
}

// --- environments -----------------------------------------------------------

secretsRoutes.get(`${base}/environments`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q<{ name: string; rules: string; updated_at: number }>(
      c.env,
      'SELECT name, rules, updated_at FROM environments WHERE repo_id = ? ORDER BY name',
      [loaded.repo.id],
    );
    return c.json({
      environments: rows.map((r) => ({
        name: r.name,
        rules: rulesSchema.parse(JSON.parse(r.rules)),
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretsRoutes.put(`${base}/environments/:env`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const name = c.req.param('env');
    if (!ENVIRONMENT_RE.test(name))
      throw new ApiError(400, 'invalid_environment', 'Invalid environment name');
    const body = parse(environmentBody, await readJsonBody(c));
    const reviewers = [];
    for (const reviewer of body.reviewers) {
      if (reviewer.type === 'user') {
        const user = await q1<{ id: string; login: string }>(
          c.env,
          'SELECT id, login FROM users WHERE login = ? COLLATE NOCASE',
          [reviewer.name],
        );
        if (!user) throw new ApiError(404, 'user_not_found', `No user ${reviewer.name}`);
        reviewers.push({ type: 'user' as const, id: user.id, name: user.login });
      } else {
        const team =
          loaded.repo.owner_kind === 'org'
            ? await q1<{ id: string; slug: string }>(
                c.env,
                'SELECT id, slug FROM teams WHERE org_id = ? AND slug = ?',
                [loaded.repo.owner_id, reviewer.name],
              )
            : null;
        if (!team)
          throw new ApiError(
            404,
            'team_not_found',
            `No team ${reviewer.name} in this org`,
          );
        reviewers.push({ type: 'team' as const, id: team.id, name: team.slug });
      }
    }
    const rules = rulesSchema.parse({ ...body, reviewers });
    const now = Date.now();
    await run(
      c.env,
      `INSERT INTO environments (repo_id, name, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, name) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`,
      [loaded.repo.id, name, JSON.stringify(rules), now, now],
    );
    await recordAudit(c, {
      action: 'environment.set',
      repo: loaded.repo,
      target: { environment: name, ...rules },
    });
    return c.json({ environment: { name, rules, updated_at: now } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretsRoutes.delete(`${base}/environments/:env`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const name = c.req.param('env');
    const exists = await q1(
      c.env,
      'SELECT 1 FROM environments WHERE repo_id = ? AND name = ?',
      [loaded.repo.id, name],
    );
    if (!exists)
      return apiError(c, 404, 'environment_not_found', `No environment ${name}`);
    // its secrets and variables go with it
    await recordAudit(
      c,
      { action: 'environment.delete', repo: loaded.repo, target: { environment: name } },
      [
        c.env.DB.prepare('DELETE FROM environments WHERE repo_id = ? AND name = ?').bind(
          loaded.repo.id,
          name,
        ),
        ...['secrets', 'variables'].map((table) =>
          c.env.DB.prepare(
            `DELETE FROM ${table} WHERE scope = 'environment' AND owner_id = ? AND environment = ?`,
          ).bind(loaded.repo.id, name),
        ),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- approvals --------------------------------------------------------------

function publicApproval(row: ApprovalRow): Omit<ApprovalRow, 'context'> & {
  ref: string | null;
  actor_kind: string | null;
} {
  const { context, ...rest } = row;
  let ref: string | null = null;
  let actorKind: string | null = null;
  try {
    const parsed = JSON.parse(context) as { ref?: string | null; actor_kind?: string };
    ref = parsed.ref ?? null;
    actorKind = parsed.actor_kind ?? null;
  } catch {
    /* shown without trigger details */
  }
  return { ...rest, ref, actor_kind: actorKind };
}

secretsRoutes.get(`${base}/environment-approvals`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const state = c.req.query('state');
    const rows = await q<ApprovalRow>(
      c.env,
      `SELECT * FROM environment_approvals WHERE repo_id = ? ${state ? 'AND state = ?' : ''}
       ORDER BY created_at DESC LIMIT 50`,
      state ? [loaded.repo.id, state] : [loaded.repo.id],
    );
    return c.json({ approvals: rows.map(publicApproval) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretsRoutes.post(`${base}/environment-approvals/:id`, async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = parse(decisionBody, await readJsonBody(c));
    const row = await decideApproval(
      c.env,
      loaded.repo.id,
      c.req.param('id'),
      c.get('user')!.id,
      body.decision,
      body.comment,
    );
    await recordAudit(c, {
      action:
        body.decision === 'approve'
          ? 'environment.approval.approve'
          : 'environment.approval.reject',
      repo: loaded.repo,
      target: {
        approval_id: row.id,
        environment: row.environment,
        head_cs: row.head_cs,
        requested_by: row.requested_by,
        run_id: row.run_id,
      },
    });
    return c.json({ approval: publicApproval(row) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- org secrets and variables ------------------------------------------------

secretsRoutes.get('/orgs/:org/secrets', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    return c.json({ secrets: await listSecrets(c.env, orgScope(org.id)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

secretsRoutes.get('/orgs/:org/variables', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const { org } = await loadOrg(c, 'manage');
    return c.json({ variables: await listVariables(c.env, orgScope(org.id)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

for (const method of ['put', 'delete'] as const) {
  secretsRoutes[method]('/orgs/:org/secrets/:name', async (c) => {
    try {
      const noSession = requireSession(c);
      if (noSession) return noSession;
      const { org } = await loadOrg(c, 'manage');
      const mfa = await requireRecentMfa(c);
      if (mfa) return mfa;
      return await writeSecret(c, method, orgScope(org.id), { orgId: org.slug });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
  secretsRoutes[method]('/orgs/:org/variables/:name', async (c) => {
    try {
      const noSession = requireSession(c);
      if (noSession) return noSession;
      const { org } = await loadOrg(c, 'manage');
      return await writeVariable(c, method, orgScope(org.id), { orgId: org.slug });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

// --- KEK rotation -----------------------------------------------------------

secretsRoutes.post('/admin/secrets/rewrap', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const admins = (c.env.SECRETS_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim());
    if (!admins.includes(c.get('user')!.id))
      return apiError(c, 403, 'forbidden', 'secrets admin required');
    const mfa = await requireRecentMfa(c, { strict: true });
    if (mfa) return mfa;
    const result = await rewrapDataKeys(c.env, 200);
    await recordAudit(c, { action: 'secret.kek.rewrap', target: result });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
});
