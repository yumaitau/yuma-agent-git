import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { requireRecentMfa } from '../auth/session';
import { ssoMessage, unmetSso } from '../auth/sso';
import { C, T } from '../db/schema';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import {
  evaluatePolicy,
  policyInputSchema,
  policySchema,
  type Policy,
} from '../policy/engine';
import { DEFAULT_POLICY } from '../policy/guardrails';
import { getPause, INSTANCE_SCOPE, type Pause } from '../policy/pause';
import { apiError, errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';

/**
 * Agent guardrails (issue #62):
 *   GET  /api/v1/orgs/:org/policy             policy in force (default pack when unset)
 *   PUT  /api/v1/orgs/:org/policy             new version (owners and admins)
 *   GET  /api/v1/orgs/:org/policy/versions    version history
 *   POST /api/v1/policy/test                  run a policy against test cases
 *   GET|POST|DELETE /api/v1/orgs/:org/agents/pause   org kill switch
 *   GET|POST|DELETE /api/v1/admin/agents/pause       instance kill switch
 *   GET  /api/v1/repos/:repo/approvals        held agent actions
 *   POST /api/v1/repos/:repo/approvals/:id    approve or reject (a human)
 * Pausing, resuming, policy changes and approval decisions are audited.
 */
export const guardrailsRoutes = new Hono<AppEnv>();

function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'invalid_request'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      code,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

/** Org-wide settings reach every org repo, so they need the org's SSO (#27). */
async function requireOrgSso(c: Context<AppEnv>, orgId: string): Promise<void> {
  const sso = (await unmetSso(c.env, c.get('principal'))).get(orgId);
  if (sso)
    throw new ApiError(403, 'sso_required', ssoMessage(sso, new URL(c.req.url).origin), {
      ...sso,
    });
}

// --- policies ---------------------------------------------------------------

interface VersionRow {
  version: number;
  document: string;
  created_by: string;
  created_by_login: string | null;
  created_at: number;
}

const VERSION_SELECT = `SELECT p.version, p.document, p.created_by, p.created_at,
       u.${C.users.login} AS created_by_login
  FROM agent_policies p LEFT JOIN ${T.users} u ON u.${C.users.id} = p.created_by`;

guardrailsRoutes.get('/orgs/:org/policy', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const row = await q1<VersionRow>(
      c.env,
      `${VERSION_SELECT} WHERE p.org_id = ? ORDER BY p.version DESC LIMIT 1`,
      [org.id],
    );
    if (!row) return c.json({ version: 0, default: true, policy: DEFAULT_POLICY });
    const { document, ...meta } = row;
    return c.json({ ...meta, default: false, policy: JSON.parse(document) as Policy });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.put('/orgs/:org/policy', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    const policy = parse(policySchema, await readJsonBody(c), 'invalid_policy');
    const user = c.get('user')!;
    const prior = await q1<{ version: number }>(
      c.env,
      'SELECT MAX(version) AS version FROM agent_policies WHERE org_id = ?',
      [org.id],
    );
    const version = (prior?.version ?? 0) + 1;
    const now = Date.now();
    try {
      await recordAudit(
        c,
        {
          action: 'policy.update',
          orgId: org.slug,
          target: { version, previous_version: version - 1, policy },
        },
        [
          c.env.DB.prepare(
            `INSERT INTO agent_policies (org_id, version, document, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(org.id, version, JSON.stringify(policy), user.id, now),
        ],
      );
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed: agent_policies'))
        throw new ApiError(409, 'policy_conflict', 'another change saved first; reload');
      throw err;
    }
    return c.json({
      version,
      default: false,
      policy,
      created_by: user.id,
      created_at: now,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.get('/orgs/:org/policy/versions', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    const rows = await q<VersionRow>(
      c.env,
      `${VERSION_SELECT} WHERE p.org_id = ? ORDER BY p.version DESC LIMIT 100`,
      [org.id],
    );
    return c.json({
      versions: rows.map(({ document, ...meta }) => ({
        ...meta,
        policy: JSON.parse(document) as Policy,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const policyTestSchema = z.object({
  /** Omitted: the default pack. */
  policy: z.unknown().optional(),
  cases: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        input: policyInputSchema,
        expect: z.enum(['allow', 'deny', 'require_approval']),
      }),
    )
    .min(1)
    .max(500),
});

/** `yag policy test`: pure evaluation, nothing is stored. */
guardrailsRoutes.post('/policy/test', async (c) => {
  try {
    if (!c.get('principal'))
      return apiError(c, 401, 'unauthorized', 'authentication required');
    const body = parse(policyTestSchema, await readJsonBody(c));
    const policy =
      body.policy === undefined
        ? DEFAULT_POLICY
        : parse(policySchema, body.policy, 'invalid_policy');
    const results = body.cases.map((t) => {
      const { outcome, matches } = evaluatePolicy(policy, t.input);
      return {
        name: t.name,
        expect: t.expect,
        outcome,
        pass: outcome === t.expect,
        matches,
      };
    });
    const failed = results.filter((r) => !r.pass).length;
    return c.json({ passed: results.length - failed, failed, results });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- kill switch ------------------------------------------------------------

export const pauseSchema = z.object({ reason: z.string().trim().max(500).default('') });

/** Pause agents in `scope` (an org id or `_instance`): revoke tokens, stop runs. */
async function pause(
  c: Context<AppEnv>,
  scope: string,
  orgSlug: string | undefined,
): Promise<Pause | null> {
  const { reason } = parse(pauseSchema, await readJsonBody(c));
  const user = c.get('user')!;
  const now = Date.now();
  const db = c.env.DB;
  const org = scope === INSTANCE_SCOPE ? null : scope;
  const orgRepos = `SELECT ${C.repos.id} FROM ${T.repos}
                     WHERE ${C.repos.ownerKind} = 'org' AND ${C.repos.ownerId} = ?`;
  await recordAudit(
    c,
    {
      action: 'agents.pause',
      orgId: orgSlug,
      target: { scope: orgSlug ?? scope, reason },
    },
    [
      db
        .prepare(
          'INSERT OR IGNORE INTO agent_pauses (scope_id, paused_by, reason, paused_at) VALUES (?, ?, ?, ?)',
        )
        .bind(scope, user.id, reason, now),
      org === null
        ? db.prepare('DELETE FROM agent_tokens')
        : db
            .prepare(
              `DELETE FROM agent_tokens
              WHERE agent_id IN (SELECT id FROM agents WHERE owner_kind = 'org' AND owner_id = ?)
                 OR EXISTS (SELECT 1 FROM json_each(agent_tokens.repos) j
                             WHERE j.value IN (${orgRepos}))`,
            )
            .bind(org, org),
      org === null
        ? db
            .prepare(
              `UPDATE ${T.agentTasks} SET ${C.agentTasks.status} = 'cancelled', ${C.agentTasks.updatedAt} = ?
              WHERE ${C.agentTasks.status} IN ('queued', 'running')`,
            )
            .bind(now)
        : db
            .prepare(
              `UPDATE ${T.agentTasks} SET ${C.agentTasks.status} = 'cancelled', ${C.agentTasks.updatedAt} = ?
              WHERE ${C.agentTasks.status} IN ('queued', 'running')
                AND ${C.agentTasks.repoId} IN (${orgRepos})`,
            )
            .bind(now, org),
    ],
  );
  return getPause(c.env, scope);
}

async function resume(
  c: Context<AppEnv>,
  scope: string,
  orgSlug: string | undefined,
): Promise<Response> {
  const current = await getPause(c.env, scope);
  if (!current) return c.json({ paused: null });
  await recordAudit(
    c,
    {
      action: 'agents.resume',
      orgId: orgSlug,
      target: { scope: orgSlug ?? scope, paused_at: current.paused_at },
    },
    [c.env.DB.prepare('DELETE FROM agent_pauses WHERE scope_id = ?').bind(scope)],
  );
  return c.json({ paused: null });
}

function view(p: Pause | null): Record<string, unknown> | null {
  return (
    p && {
      paused_by: p.paused_by,
      paused_by_login: p.paused_by_login,
      reason: p.reason,
      paused_at: p.paused_at,
    }
  );
}

guardrailsRoutes.get('/orgs/:org/agents/pause', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    return c.json({
      paused: view(await getPause(c.env, org.id)),
      instance: view(await getPause(c.env, INSTANCE_SCOPE)),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.post('/orgs/:org/agents/pause', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    return c.json({ paused: view(await pause(c, org.id, org.slug)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.delete('/orgs/:org/agents/pause', async (c) => {
  try {
    const { org } = await loadOrg(c, 'manage');
    await requireOrgSso(c, org.id);
    return await resume(c, org.id, org.slug);
  } catch (err) {
    return errorResponse(c, err);
  }
});

function requireSession(c: Context<AppEnv>): Response | null {
  return c.get('user') ? null : apiError(c, 401, 'unauthorized', 'session required');
}

/** Instance admins: the user ids in `AGENTS_ADMIN_USER_IDS`. Call after `requireSession`. */
function requireAgentsAdmin(c: Context<AppEnv>): Response | null {
  const admins = (c.env.AGENTS_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim());
  return admins.includes(c.get('user')!.id)
    ? null
    : apiError(c, 403, 'forbidden', 'agents admin required');
}

guardrailsRoutes.get('/admin/agents/pause', async (c) => {
  try {
    const denied = requireSession(c) ?? requireAgentsAdmin(c);
    if (denied) return denied;
    return c.json({ paused: view(await getPause(c.env, INSTANCE_SCOPE)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.post('/admin/agents/pause', async (c) => {
  try {
    const denied = requireSession(c) ?? requireAgentsAdmin(c);
    if (denied) return denied;
    return c.json({ paused: view(await pause(c, INSTANCE_SCOPE, undefined)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

guardrailsRoutes.delete('/admin/agents/pause', async (c) => {
  try {
    const denied = requireSession(c) ?? requireAgentsAdmin(c);
    if (denied) return denied;
    return await resume(c, INSTANCE_SCOPE, undefined);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- approvals --------------------------------------------------------------

export const approvalsQuery = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
});
export const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

const APPROVAL_SELECT = `SELECT a.*, b.${C.users.login} AS on_behalf_of_login,
       d.${C.users.login} AS decided_by_login
  FROM approvals a
  LEFT JOIN ${T.users} b ON b.${C.users.id} = a.on_behalf_of
  LEFT JOIN ${T.users} d ON d.${C.users.id} = a.decided_by`;

function approvalView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    payload: JSON.parse(String(row['payload'])) as unknown,
    reasons: JSON.parse(String(row['reasons'])) as unknown,
  };
}

/** Held actions in a repo, newest first; repo admins see and decide them. */
guardrailsRoutes.get('/repos/:repo{.+}/approvals', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const state =
      parse(approvalsQuery, { state: c.req.query('state') }).state ?? 'pending';
    const rows = await q(
      c.env,
      `${APPROVAL_SELECT} WHERE a.repo_id = ? ${state === 'all' ? '' : 'AND a.decision = ?'}
        ORDER BY a.requested_at DESC LIMIT 100`,
      state === 'all' ? [loaded.repo.id] : [loaded.repo.id, state],
    );
    return c.json({ approvals: rows.map(approvalView) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** A human decides; the agent's next identical attempt then lands or fails. */
guardrailsRoutes.post('/repos/:repo{.+}/approvals/:id', async (c) => {
  try {
    // only a person in a browser session decides, never a token
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const user = c.get('user')!;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const { decision } = parse(decisionSchema, await readJsonBody(c));
    const id = c.req.param('id');
    const row = await q1<{
      decision: string;
      action: string;
      payload_hash: string;
      principal: string;
    }>(
      c.env,
      'SELECT decision, action, payload_hash, principal FROM approvals WHERE id = ? AND repo_id = ?',
      [id, loaded.repo.id],
    );
    if (!row) return apiError(c, 404, 'approval_not_found', 'Approval not found');
    if (row.decision !== 'pending')
      return apiError(c, 409, 'approval_decided', `already ${row.decision}`);
    const now = Date.now();
    const final = decision === 'approve' ? 'approved' : 'rejected';
    await recordAudit(
      c,
      {
        action:
          decision === 'approve' ? 'policy.approval.approve' : 'policy.approval.reject',
        repo: loaded.repo,
        target: {
          approval_id: id,
          action: row.action,
          principal: row.principal,
          payload_hash: row.payload_hash,
        },
      },
      [
        c.env.DB.prepare(
          `UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?
            WHERE id = ? AND decision = 'pending'`,
        ).bind(final, user.id, now, id),
      ],
    );
    const updated = await q1(c.env, `${APPROVAL_SELECT} WHERE a.id = ?`, [id]);
    return c.json({ approval: approvalView(updated!) });
  } catch (err) {
    return errorResponse(c, err);
  }
});
