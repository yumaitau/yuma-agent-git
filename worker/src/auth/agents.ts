import { z } from 'zod';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q, q1 } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { actorOf, recordAudit } from '../audit/record';
import { can } from './rbac';
import { hasScope, type AppEnv, type Principal } from './principal';
import { ssoMessage, ssoRequirement } from './sso';
import { resolveTokenPrincipal } from './tokens';
import { getPause, INSTANCE_SCOPE, pauseMessage } from '../policy/pause';
import { RISKS, type Risk } from '../../shared/work';

/**
 * Agent identities (issue #57). An agent is a principal (`agent:<id>`) owned
 * by a user or an org, with a kind, the most it may ever be granted
 * (`max_scopes`) and optionally the repos it may touch. It holds no secret:
 * a human with an `agent:run` API token delegates through the RFC 8693 token
 * exchange (`POST /oauth/token`), which issues a `yagat_` token that lasts
 * 15 minutes by default and one hour at most, bound to named repos, scopes
 * and an optional task. RBAC resolves the human's role for that token, so an
 * agent never exceeds the person it acts for. Disabling an agent deletes its
 * tokens and every lookup also checks the flag, so the next request fails.
 * Each lookup also needs the delegating API token, whose sign-in method the
 * agent carries for org SSO, so revoking that token revokes the agent's.
 */

export const AGENT_TOKEN_PREFIX = 'yagat_';
export const AGENT_KINDS = [
  'factory',
  'claude_code',
  'codex',
  'grok',
  'builtin',
] as const;
/** Scopes an agent token can carry; admin scopes are never delegable. */
export const AGENT_SCOPES = [
  'contents:read',
  'contents:write',
  'pulls:write',
  'ci:run',
  'releases:write',
  // work queue (#59): claim, heartbeat and release; approve marks work ready
  'queue:claim',
  'queue:approve',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
const DEFAULT_SCOPES: AgentScope[] = ['contents:read', 'contents:write', 'pulls:write'];

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const DEFAULT_TTL_S = 15 * 60;
const MAX_TTL_S = 60 * 60;

const agentRowSchema = z.object({
  id: z.string(),
  owner_kind: z.enum(['user', 'org']),
  owner_id: z.string(),
  name: z.string(),
  kind: z.enum(AGENT_KINDS),
  max_scopes: z.string(),
  allowed_repos: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  disabled: z.number(),
  max_risk: z.enum(RISKS),
  live_tokens: z.number().optional(),
});

export interface Agent {
  id: string;
  owner_kind: 'user' | 'org';
  owner_id: string;
  name: string;
  kind: (typeof AGENT_KINDS)[number];
  max_scopes: string[];
  allowed_repos: string[] | null;
  created_at: number;
  disabled: boolean;
  /** Highest work-queue risk the agent may claim (#59). */
  max_risk: Risk;
  live_tokens?: number;
}

function parseAgent(raw: unknown): Agent {
  const row = agentRowSchema.parse(raw);
  return {
    id: row.id,
    owner_kind: row.owner_kind,
    owner_id: row.owner_id,
    name: row.name,
    kind: row.kind,
    max_scopes: JSON.parse(row.max_scopes) as string[],
    allowed_repos:
      row.allowed_repos === null ? null : (JSON.parse(row.allowed_repos) as string[]),
    created_at: row.created_at,
    disabled: row.disabled !== 0,
    max_risk: row.max_risk,
    ...(row.live_tokens === undefined ? {} : { live_tokens: row.live_tokens }),
  };
}

async function getAgent(env: Env, id: string): Promise<Agent | null> {
  const row = await q1(env, 'SELECT * FROM agents WHERE id = ?', [id]);
  return row ? parseAgent(row) : null;
}

async function orgRole(env: Env, orgId: string, userId: string): Promise<string | null> {
  const row = await q1<{ role: string }>(
    env,
    `SELECT ${C.orgMembers.role} AS role FROM ${T.orgMembers}
      WHERE ${C.orgMembers.orgId} = ? AND ${C.orgMembers.userId} = ?`,
    [orgId, userId],
  );
  return row?.role ?? null;
}

/** Owners manage an agent: the owning user, or an org owner or admin. */
async function canManage(env: Env, agent: Agent, userId: string): Promise<boolean> {
  if (agent.owner_kind === 'user') return agent.owner_id === userId;
  const role = await orgRole(env, agent.owner_id, userId);
  return role === 'owner' || role === 'admin';
}

/** Who may delegate to an agent: its owning user, or any member of its org. */
async function canDelegate(env: Env, agent: Agent, userId: string): Promise<boolean> {
  if (agent.owner_kind === 'user') return agent.owner_id === userId;
  const role = await orgRole(env, agent.owner_id, userId);
  return role === 'owner' || role === 'admin' || role === 'member';
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hashToken(raw: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(raw));
}

const agentTokenRowSchema = z.object({
  jti: z.string(),
  agent_id: z.string(),
  on_behalf_of: z.string(),
  task_id: z.string().nullable(),
  scopes: z.string(),
  repos: z.string(),
  expires_at: z.number(),
  auth_method: z.string().nullable(),
});

/**
 * Resolve a raw `yagat_` token. Null when unknown, expired, revoked, its
 * agent disabled, its delegating API token revoked or expired, the human it
 * acts for deprovisioned, or agents paused (#62) on the instance, the agent's
 * org or the org of any repo the token is bound to.
 */
export async function resolveAgentToken(
  env: Env,
  raw: string,
  now: number = Date.now(),
): Promise<Principal | null> {
  const row = await q1(
    env,
    `SELECT t.jti, t.agent_id, t.on_behalf_of, t.task_id, t.scopes, t.repos, t.expires_at,
            s.auth_method
       FROM agent_tokens t
       JOIN agents a ON a.id = t.agent_id
       JOIN ${T.users} u ON u.${C.users.id} = t.on_behalf_of
       JOIN ${T.apiTokens} s ON s.${C.apiTokens.id} = t.subject_token_id
      WHERE t.token_hash = ? AND a.disabled = 0 AND u.active = 1
        AND (s.${C.apiTokens.expiresAt} IS NULL OR s.${C.apiTokens.expiresAt} >= ?)
        AND NOT EXISTS (
          SELECT 1 FROM agent_pauses p
           WHERE p.scope_id = '${INSTANCE_SCOPE}'
              OR (a.owner_kind = 'org' AND p.scope_id = a.owner_id)
              OR p.scope_id IN (
                   SELECT r.${C.repos.ownerId} FROM json_each(t.repos) j
                     JOIN ${T.repos} r ON r.${C.repos.id} = j.value
                    WHERE r.${C.repos.ownerKind} = 'org'))`,
    [await hashToken(raw), now],
  );
  if (!row) return null;
  const token = agentTokenRowSchema.parse(row);
  if (token.expires_at <= now) return null;
  return {
    kind: 'agent',
    userId: token.on_behalf_of,
    agentId: token.agent_id,
    jti: token.jti,
    taskId: token.task_id,
    scopes: JSON.parse(token.scopes) as string[],
    repoIds: JSON.parse(token.repos) as string[],
    authMethod: token.auth_method,
  };
}

// ---------------------------------------------------------------------------
// Provenance: which agent, for whom and for which task wrote a changeset
// ---------------------------------------------------------------------------

export interface AgentProvenance {
  agent_id: string;
  agent_name: string | null;
  agent_kind: string | null;
  on_behalf_of: string;
  on_behalf_of_login: string | null;
  task_id: string | null;
}

/** Stamp changesets an agent token wrote; the first writer of a changeset wins. */
export async function recordAgentProvenance(
  env: Env,
  repoId: string,
  changesetIds: string[],
  principal: Principal | null,
): Promise<void> {
  if (principal?.kind !== 'agent' || changesetIds.length === 0) return;
  const now = Date.now();
  await env.DB.batch(
    changesetIds.map((id) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO changeset_agents
           (repo_id, changeset_id, agent_id, on_behalf_of, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(repoId, id, principal.agentId, principal.userId, principal.taskId, now),
    ),
  );
}

export async function changesetProvenance(
  env: Env,
  repoId: string,
  changesetId: string,
): Promise<AgentProvenance | null> {
  return q1<AgentProvenance>(
    env,
    `SELECT ca.agent_id, a.name AS agent_name, a.kind AS agent_kind, ca.on_behalf_of,
            u.${C.users.login} AS on_behalf_of_login, ca.task_id
       FROM changeset_agents ca
       LEFT JOIN agents a ON a.id = ca.agent_id
       LEFT JOIN ${T.users} u ON u.${C.users.id} = ca.on_behalf_of
      WHERE ca.repo_id = ? AND ca.changeset_id = ?`,
    [repoId, changesetId],
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const agentIdentityRoutes = new Hono<AppEnv>();

const NO_STORE = { 'cache-control': 'no-store' };

export const exchangeSchema = z.object({
  grant_type: z.string(),
  subject_token: z.string().min(1),
  subject_token_type: z.literal(ACCESS_TOKEN_TYPE),
  agent_id: z.string().min(1),
  /** Repo slugs (`owner/name`) the token is bound to. */
  resource: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => [...new Set([v].flat())])
    .pipe(z.array(z.string().min(1)).min(1).max(10)),
  scope: z.string().optional(),
  task_id: z.string().min(1).max(200).optional(),
  expires_in: z.coerce.number().int().min(60).max(MAX_TTL_S).optional(),
});

/** RFC 8693 bodies are form encoded; JSON is accepted too. */
async function exchangeParams(c: Context<AppEnv>): Promise<unknown> {
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    return readJsonBody(c);
  }
  return c.req.parseBody({ all: true });
}

/**
 * RFC 8693 token exchange: the subject token is the delegating human's
 * `agent:run` API token, `agent_id` names the actor. Errors use the API
 * envelope with the OAuth error names as codes.
 */
agentIdentityRoutes.post('/oauth/token', async (c) => {
  try {
    const parsed = exchangeSchema.safeParse(await exchangeParams(c));
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid token exchange request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const input = parsed.data;
    if (input.grant_type !== TOKEN_EXCHANGE_GRANT) {
      return apiError(
        c,
        400,
        'unsupported_grant_type',
        'only token exchange is supported',
      );
    }

    // Delegation is one hop: the subject must be a human's API token.
    const subject = await resolveTokenPrincipal(c.env, input.subject_token);
    if (subject?.kind !== 'token' || !hasScope(subject, 'agent:run')) {
      return apiError(
        c,
        400,
        'invalid_grant',
        'subject_token must be a valid API token with agent:run',
      );
    }
    const agent = await getAgent(c.env, input.agent_id);
    if (!agent || agent.disabled || !(await canDelegate(c.env, agent, subject.userId))) {
      return apiError(c, 400, 'invalid_grant', 'agent not found or not delegable by you');
    }

    const scopes = input.scope
      ? [...new Set(input.scope.split(' ').filter((s) => s !== ''))]
      : agent.max_scopes;
    // An agent never gets more than its grant or the delegating token holds.
    const denied = scopes.find(
      (s) =>
        !agent.max_scopes.includes(s) ||
        !hasScope(subject, s === 'contents:read' ? 'repo:read' : 'repo:write'),
    );
    if (denied !== undefined || scopes.length === 0) {
      return apiError(c, 400, 'invalid_scope', `scope ${denied ?? ''} is not grantable`, {
        allowed: agent.max_scopes,
      });
    }

    const repos = [];
    for (const slug of input.resource) {
      const repo = await getRepoBySlug(c.env, slug);
      if (
        !repo ||
        (agent.allowed_repos !== null && !agent.allowed_repos.includes(repo.id)) ||
        !(await can(c.env, repo, subject, 'read'))
      ) {
        return apiError(c, 400, 'invalid_target', `repo ${slug} is not available`);
      }
      // public org repos pass the read check above even when org SSO is unmet
      const sso = await ssoRequirement(c.env, repo, subject);
      if (sso) {
        return apiError(
          c,
          403,
          'sso_required',
          ssoMessage(sso, new URL(c.req.url).origin),
          {
            ...sso,
          },
        );
      }
      repos.push(repo);
    }
    // kill switch (#62): no new tokens while the instance or an org is paused
    const orgs = new Set([
      INSTANCE_SCOPE,
      ...(agent.owner_kind === 'org' ? [agent.owner_id] : []),
      ...repos.flatMap((r) => (r.owner_kind === 'org' && r.owner_id ? [r.owner_id] : [])),
    ]);
    for (const scope of orgs) {
      const pause = await getPause(c.env, scope);
      if (pause) return apiError(c, 403, 'agents_paused', pauseMessage(pause));
    }

    const now = Date.now();
    const ttl = input.expires_in ?? DEFAULT_TTL_S;
    const raw = `${AGENT_TOKEN_PREFIX}${randomHex(20)}`;
    const jti = ulid(now);
    const expiresAt = now + ttl * 1000;
    const insert = c.env.DB.prepare(
      `INSERT INTO agent_tokens
         (jti, token_hash, agent_id, on_behalf_of, task_id, scopes, repos, created_at, expires_at,
          subject_token_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jti,
      await hashToken(raw),
      agent.id,
      subject.userId,
      input.task_id ?? null,
      JSON.stringify(scopes),
      JSON.stringify(repos.map((r) => r.id)),
      now,
      expiresAt,
      subject.tokenId,
    );
    // one event per repo so each owner's chain shows it; the first carries the insert
    for (const [i, repo] of repos.entries()) {
      await recordAudit(
        c,
        {
          action: 'agent.token.issue',
          repo,
          actor: actorOf(subject),
          target: {
            agent_id: agent.id,
            jti,
            scopes,
            repo_ids: repos.map((r) => r.id),
            task_id: input.task_id ?? null,
            expires_at: expiresAt,
          },
        },
        i === 0 ? [insert] : [],
      );
    }
    return c.json(
      {
        access_token: raw,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: ttl,
        scope: scopes.join(' '),
      },
      200,
      NO_STORE,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(AGENT_KINDS),
  max_scopes: z.array(z.enum(AGENT_SCOPES)).min(1).optional(),
  /** Repo slugs; omitted or null means any repo the delegating human can read. */
  allowed_repos: z.array(z.string().min(1)).max(50).nullable().optional(),
  /** Org slug for an org-owned agent; omitted means owned by the caller. */
  org: z.string().min(1).optional(),
  /** Highest work-queue risk it may claim; defaults to `low`. */
  max_risk: z.enum(RISKS).optional(),
});

agentIdentityRoutes.get('/api/v1/agents', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const rows = await q(
      c.env,
      `SELECT a.*, (SELECT COUNT(*) FROM agent_tokens t
                     WHERE t.agent_id = a.id AND t.expires_at > ?) AS live_tokens
         FROM agents a
        WHERE (a.owner_kind = 'user' AND a.owner_id = ?)
           OR (a.owner_kind = 'org' AND a.owner_id IN (
                SELECT ${C.orgMembers.orgId} FROM ${T.orgMembers}
                 WHERE ${C.orgMembers.userId} = ? AND ${C.orgMembers.role} IN ('owner', 'admin')))
        ORDER BY a.created_at DESC`,
      [Date.now(), user.id, user.id],
    );
    return c.json({ agents: rows.map(parseAgent) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentIdentityRoutes.post('/api/v1/agents', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const parsed = createAgentSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid agent request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const input = parsed.data;
    let owner: { kind: 'user' | 'org'; id: string } = { kind: 'user', id: user.id };
    let orgSlug: string | undefined;
    if (input.org !== undefined) {
      const org = await q1<{ id: string }>(
        c.env,
        `SELECT ${C.orgs.id} AS id FROM ${T.orgs} WHERE ${C.orgs.slug} = ?`,
        [input.org],
      );
      const role = org ? await orgRole(c.env, org.id, user.id) : null;
      if (!org || role === null) {
        return apiError(c, 404, 'org_not_found', `no org ${input.org}`);
      }
      if (role !== 'owner' && role !== 'admin') {
        return apiError(c, 403, 'forbidden', 'org owner or admin required');
      }
      owner = { kind: 'org', id: org.id };
      orgSlug = input.org;
    }
    let allowed: string[] | null = null;
    if (input.allowed_repos) {
      allowed = [];
      for (const slug of input.allowed_repos) {
        const repo = await getRepoBySlug(c.env, slug);
        if (!repo || !(await can(c.env, repo, c.get('principal'), 'read'))) {
          return apiError(c, 404, 'repo_not_found', 'Repository not found');
        }
        allowed.push(repo.id);
      }
    }
    const now = Date.now();
    const agent: Agent = {
      id: `agt_${ulid(now)}`,
      owner_kind: owner.kind,
      owner_id: owner.id,
      name: input.name,
      kind: input.kind,
      max_scopes: input.max_scopes ?? DEFAULT_SCOPES,
      allowed_repos: allowed,
      created_at: now,
      disabled: false,
      max_risk: input.max_risk ?? 'low',
    };
    await recordAudit(
      c,
      {
        action: 'agent.create',
        orgId: orgSlug,
        target: {
          agent_id: agent.id,
          owner_kind: agent.owner_kind,
          owner_id: agent.owner_id,
          kind: agent.kind,
          max_scopes: agent.max_scopes,
          allowed_repos: agent.allowed_repos,
          max_risk: agent.max_risk,
        },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO agents (id, owner_kind, owner_id, name, kind, max_scopes, allowed_repos,
                               created_by, created_at, disabled, max_risk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).bind(
          agent.id,
          agent.owner_kind,
          agent.owner_id,
          agent.name,
          agent.kind,
          JSON.stringify(agent.max_scopes),
          allowed === null ? null : JSON.stringify(allowed),
          user.id,
          now,
          agent.max_risk,
        ),
      ],
    );
    return c.json(agent, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Audit chain for an agent event: its org's, else the instance chain. */
async function auditOrg(env: Env, agent: Agent): Promise<string | undefined> {
  if (agent.owner_kind !== 'org') return undefined;
  const org = await q1<{ slug: string }>(
    env,
    `SELECT ${C.orgs.slug} AS slug FROM ${T.orgs} WHERE ${C.orgs.id} = ?`,
    [agent.owner_id],
  );
  return org?.slug;
}

/** The agent named in the path when `userId` manages it, else a 404. */
async function loadManaged(
  c: Context<AppEnv>,
  userId: string,
): Promise<{ ok: true; agent: Agent } | { ok: false; response: Response }> {
  const agent = await getAgent(c.env, c.req.param('id') ?? '');
  if (!agent || !(await canManage(c.env, agent, userId))) {
    return {
      ok: false,
      response: apiError(c, 404, 'agent_not_found', `no agent ${c.req.param('id')}`),
    };
  }
  return { ok: true, agent };
}

export const patchAgentSchema = z.object({ disabled: z.boolean() });

/** Kill switch: disabling an agent also deletes every token it holds. */
agentIdentityRoutes.patch('/api/v1/agents/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const loaded = await loadManaged(c, user.id);
    if (!loaded.ok) return loaded.response;
    const parsed = patchAgentSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'expected { disabled: boolean }');
    }
    const { agent } = loaded;
    const disabled = parsed.data.disabled;
    await recordAudit(
      c,
      {
        action: disabled ? 'agent.disable' : 'agent.enable',
        orgId: await auditOrg(c.env, agent),
        target: { agent_id: agent.id },
      },
      [
        c.env.DB.prepare('UPDATE agents SET disabled = ? WHERE id = ?').bind(
          disabled ? 1 : 0,
          agent.id,
        ),
        ...(disabled
          ? [
              c.env.DB.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').bind(
                agent.id,
              ),
            ]
          : []),
      ],
    );
    return c.json({ ...agent, disabled });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Revoke every live token of an agent without disabling it. */
agentIdentityRoutes.delete('/api/v1/agents/:id/tokens', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const loaded = await loadManaged(c, user.id);
    if (!loaded.ok) return loaded.response;
    await recordAudit(
      c,
      {
        action: 'agent.token.revoke',
        orgId: await auditOrg(c.env, loaded.agent),
        target: { agent_id: loaded.agent.id },
      },
      [
        c.env.DB.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').bind(
          loaded.agent.id,
        ),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
