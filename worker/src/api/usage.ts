import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { canDelegate, getAgent } from '../auth/agents';
import { canManageOwner, parseBody, requireOrgSso, sessionUser } from '../auth/owners';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { ulid } from '../core/ids';
import { recordAudit } from '../audit/record';
import {
  budgetRowSchema,
  budgetUsed,
  periodStart,
  recordUsage,
  type Budget,
} from '../usage/record';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getOrgBySlug, orgMembership } from './orgs';

/**
 * Cost and token accounting (issue #61):
 *   POST   /api/v1/usage                 report usage (Factory and other external agents)
 *   GET    /api/v1/repos/:repo/usage     report for a repo
 *   GET    /api/v1/orgs/:org/usage       report for an org
 *   GET    /api/v1/agents/:id/usage      report for an agent identity
 *   GET    /api/v1/usage/budgets         budgets of an org or agent, with use and alerts
 *   PUT    /api/v1/usage/budgets         set a budget (org owners and admins, agent owners)
 *   DELETE /api/v1/usage/budgets/:id     remove a budget
 * Reports take `format=csv` for a CSV export. Built-in Workers AI calls and
 * CI runs record themselves (usage/record.ts); usage is append-only, so a
 * correction is a new event with `correction_of` and negative counts.
 */
export const usageRoutes = new Hono<AppEnv>();

const count = z.int().min(-1_000_000_000_000).max(1_000_000_000_000);

export const reportUsageSchema = z
  .object({
    /** Repository the work was for, as `owner/name`. */
    repo: z.string().min(3).max(200),
    kind: z.enum(['tokens', 'ci_seconds']).default('tokens'),
    /** Model (tokens) or runner kind (ci_seconds), as in the price table. */
    model: z.string().min(1).max(200).optional(),
    /** `subscription`: a ChatGPT or Claude plan's usage window, recorded at zero dollars. */
    billing: z.enum(['metered', 'subscription']).default('metered'),
    input_tokens: count.default(0),
    output_tokens: count.default(0),
    cached_tokens: count.default(0),
    /** Seconds for ci_seconds. */
    quantity: count.default(0),
    /** A cost the reporter already knows; otherwise the price table sets it. */
    usd_micros: count.optional(),
    /** The agent identity that did the work; defaults to the calling agent. */
    agent_id: z.string().min(1).max(64).optional(),
    task_id: z.string().min(1).max(128).optional(),
    run_id: z.string().min(1).max(128).optional(),
    /** Ticket the work was for, such as `#42` or an external key. */
    ticket: z.string().trim().min(1).max(128).optional(),
    /** Pull request number in `repo`. */
    pull: z.int().min(1).optional(),
    /** An earlier event in the same repo this one corrects. */
    correction_of: z.string().min(1).max(128).optional(),
    /** When the work happened (ms); defaults to now. */
    at: z.int().min(0).optional(),
  })
  .refine(
    (v) =>
      v.correction_of !== undefined ||
      [
        v.input_tokens,
        v.output_tokens,
        v.cached_tokens,
        v.quantity,
        v.usd_micros ?? 0,
      ].every((n) => n >= 0),
    { message: 'negative values are only allowed in a correction' },
  );

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const GROUPS = [
  'day',
  'repo',
  'agent',
  'model',
  'kind',
  'ticket',
  'pull',
  'task',
] as const;

export const usageReportQuery = z.object({
  /** First UTC day, `YYYY-MM-DD`; default the first of this month. */
  from: z.string().regex(DAY).optional(),
  /** Last UTC day (inclusive), `YYYY-MM-DD`; default today. */
  to: z.string().regex(DAY).optional(),
  group_by: z.enum(GROUPS).default('day'),
  format: z.enum(['json', 'csv']).default('json'),
});

const budgetQuery = z.object({
  org: z.string().min(1).max(100).optional(),
  agent: z.string().min(1).max(64).optional(),
});

export const budgetInputSchema = z
  .object({
    /** Org slug, for an org budget. */
    org: z.string().min(1).max(100).optional(),
    /** Agent id, for an agent budget. */
    agent: z.string().min(1).max(64).optional(),
    metric: z.enum(['tokens', 'usd_micros']),
    period: z.enum(['day', 'month']),
    /** Alert the owner from here. */
    soft_limit: z.int().min(0).nullable().default(null),
    /** Alert and stop new work queue claims from here. */
    hard_limit: z.int().min(0).nullable().default(null),
  })
  .refine((v) => (v.org === undefined) !== (v.agent === undefined), {
    message: 'name exactly one of org or agent',
  })
  .refine((v) => v.soft_limit !== null || v.hard_limit !== null, {
    message: 'set soft_limit, hard_limit or both',
  });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return parseBody(schema, value);
}

// --- reporting --------------------------------------------------------------

usageRoutes.post('/usage', async (c) => {
  try {
    const input = parse(reportUsageSchema, await readJsonBody(c));
    const loaded = await loadWholeRepo(c, 'write', input.repo);
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'contents:write');
    if (scoped) return scoped;
    const principal = c.get('principal')!;
    let agentId: string | null = null;
    if (principal.kind === 'agent') {
      if (input.agent_id !== undefined && input.agent_id !== principal.agentId)
        return apiError(c, 403, 'forbidden', 'An agent reports its own usage only.');
      agentId = principal.agentId;
    } else if (input.agent_id !== undefined) {
      const agent = await getAgent(c.env, input.agent_id);
      if (!agent || !(await canDelegate(c.env, agent, principal.userId)))
        return apiError(c, 404, 'agent_not_found', `no agent ${input.agent_id}`);
      agentId = agent.id;
    }
    const pull =
      input.pull === undefined
        ? null
        : await q1<{ id: number }>(
            c.env,
            'SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?',
            [loaded.repo.id, input.pull],
          );
    if (input.pull !== undefined && !pull)
      return apiError(c, 404, 'pull_not_found', 'Pull request not found');
    if (
      input.correction_of !== undefined &&
      !(await q1(c.env, 'SELECT 1 FROM usage_events WHERE id = ? AND repo_id = ?', [
        input.correction_of,
        loaded.repo.id,
      ]))
    )
      return apiError(
        c,
        404,
        'usage_event_not_found',
        'No such usage event in this repo.',
      );
    const [event] = await recordUsage(
      c.env,
      [
        {
          repo: loaded.repo,
          agent_id: agentId,
          task_id: input.task_id ?? null,
          run_id: input.run_id ?? null,
          ticket: input.ticket ?? null,
          pull_id: pull?.id ?? null,
          kind: input.kind,
          source: 'reported',
          model: input.model ?? null,
          billing: input.billing,
          input_tokens: input.input_tokens,
          output_tokens: input.output_tokens,
          cached_tokens: input.cached_tokens,
          quantity: input.quantity,
          usd_micros: input.usd_micros ?? null,
          correction_of: input.correction_of ?? null,
          reported_by: `${principal.kind}:${principal.kind === 'agent' ? principal.agentId : principal.userId}`,
          at: input.at,
        },
      ],
      new URL(c.req.url).origin,
    );
    return c.json({ event }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

type Scope = { column: 'repo_id' | 'org_id' | 'agent_id'; id: string };

interface Row {
  key: string;
  repo?: string | null;
  label?: string | null;
  merged?: boolean;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  ci_seconds: number;
  storage_byte_days: number;
  usd_micros: number;
  unpriced: number;
}

const SUMS = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cached_tokens) AS cached_tokens,
  SUM(CASE WHEN kind = 'ci_seconds' THEN quantity ELSE 0 END) AS ci_seconds,
  SUM(CASE WHEN kind = 'storage' THEN quantity ELSE 0 END) AS storage_byte_days`;
const DAILY_SUMS = `SUM(events) AS events, ${SUMS}, SUM(usd_micros) AS usd_micros,
  SUM(unpriced) AS unpriced`;
const RAW_SUMS = `COUNT(*) AS events, ${SUMS}, COALESCE(SUM(usd_micros), 0) AS usd_micros,
  SUM(usd_micros IS NULL) AS unpriced`;
const DAILY_KEY: Record<string, string> = {
  day: 'day',
  repo: 'repo_id',
  agent: 'agent_id',
  model: 'model',
  kind: 'kind',
};
const RAW_KEY: Record<string, string> = {
  ticket: 'ticket',
  pull: 'pull_id',
  task: 'task_id',
};

function range(query: z.infer<typeof usageReportQuery>): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const from = query.from ?? `${today.slice(0, 7)}-01`;
  const to = query.to ?? today;
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (!(span >= 0 && span <= 366))
    throw new ApiError(
      400,
      'invalid_range',
      'from must be on or before to, within 366 days',
    );
  return { from, to };
}

const zero = (n: number | null | undefined): number => n ?? 0;

async function report(
  c: Context<AppEnv>,
  scope: Scope,
  pulls: { where: string; params: unknown[] },
): Promise<Response> {
  const query = parse(usageReportQuery, c.req.query());
  const { from, to } = range(query);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to) + DAY_MS;
  const totals = await q1<Omit<Row, 'key'>>(
    c.env,
    `SELECT ${DAILY_SUMS} FROM usage_daily WHERE ${scope.column} = ? AND day BETWEEN ? AND ?`,
    [scope.id, from, to],
  );
  const raw = RAW_KEY[query.group_by];
  const rows = raw
    ? await q<Row & { repo_id: string | null }>(
        c.env,
        `SELECT repo_id, ${raw} AS key, ${RAW_SUMS} FROM usage_events
          WHERE ${scope.column} = ? AND at >= ? AND at < ? AND ${raw} IS NOT NULL
          GROUP BY repo_id, ${raw} ORDER BY usd_micros DESC, key LIMIT 1000`,
        [scope.id, fromMs, toMs],
      )
    : await q<Row & { repo_id?: string }>(
        c.env,
        `SELECT ${DAILY_KEY[query.group_by]} AS key, ${DAILY_SUMS} FROM usage_daily
          WHERE ${scope.column} = ? AND day BETWEEN ? AND ?
          GROUP BY key ORDER BY key LIMIT 1000`,
        [scope.id, from, to],
      );
  // names for ids: repo slugs, agent names, pull numbers and titles
  const repoIds = [
    ...new Set(rows.map((r) => (query.group_by === 'repo' ? r.key : r.repo_id) ?? '')),
  ].filter((id) => id !== '');
  const slugs = new Map(
    repoIds.length === 0
      ? []
      : (
          await q<{ id: string; slug: string }>(
            c.env,
            `SELECT id, slug FROM repos WHERE id IN (${repoIds.map(() => '?').join(',')})`,
            repoIds,
          )
        ).map((r) => [r.id, r.slug]),
  );
  const pullIds = query.group_by === 'pull' ? rows.map((r) => Number(r.key)) : [];
  const pullRows = new Map(
    pullIds.length === 0
      ? []
      : (
          await q<{
            id: number;
            number: number;
            title: string;
            merged_at: number | null;
          }>(
            c.env,
            `SELECT id, number, title, merged_at FROM pull_requests
              WHERE id IN (${pullIds.map(() => '?').join(',')})`,
            pullIds,
          )
        ).map((p) => [String(p.id), p]),
  );
  const agentIds =
    query.group_by === 'agent' ? rows.map((r) => r.key).filter((k) => k !== '') : [];
  const agentNames = new Map(
    agentIds.length === 0
      ? []
      : (
          await q<{ id: string; name: string }>(
            c.env,
            `SELECT id, name FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})`,
            agentIds,
          )
        ).map((a) => [a.id, a.name]),
  );
  const out: Row[] = rows.map((r) => {
    const pull = pullRows.get(r.key);
    const row: Row = {
      key: pull ? `#${pull.number}` : r.key,
      events: zero(r.events),
      input_tokens: zero(r.input_tokens),
      output_tokens: zero(r.output_tokens),
      cached_tokens: zero(r.cached_tokens),
      ci_seconds: zero(r.ci_seconds),
      storage_byte_days: zero(r.storage_byte_days),
      usd_micros: zero(r.usd_micros),
      unpriced: zero(r.unpriced),
    };
    if (raw) row.repo = slugs.get(r.repo_id ?? '') ?? null;
    if (query.group_by === 'repo') row.label = slugs.get(r.key) ?? null;
    if (query.group_by === 'agent') row.label = agentNames.get(r.key) ?? null;
    if (pull) {
      row.label = pull.title;
      row.merged = pull.merged_at !== null;
    }
    return row;
  });
  // cost per merged pull request: everything recorded against pull requests
  // merged in the range, over how many there were
  const merged = await q1<{ n: number; usd: number; tokens: number }>(
    c.env,
    `WITH merged AS (SELECT id FROM pull_requests
        WHERE ${pulls.where} AND merged_at >= ? AND merged_at < ?)
     SELECT (SELECT COUNT(*) FROM merged) AS n,
       (SELECT COALESCE(SUM(usd_micros), 0) FROM usage_events
         WHERE pull_id IN (SELECT id FROM merged)) AS usd,
       (SELECT COALESCE(SUM(input_tokens + output_tokens + cached_tokens), 0)
          FROM usage_events WHERE pull_id IN (SELECT id FROM merged)) AS tokens`,
    [...pulls.params, fromMs, toMs],
  );
  const n = merged?.n ?? 0;
  if (query.format === 'csv') {
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="usage-${from}-${to}.csv"`);
    return c.body(csv(out));
  }
  c.header('cache-control', 'private, no-store');
  return c.json({
    from,
    to,
    group_by: query.group_by,
    totals: {
      events: zero(totals?.events),
      input_tokens: zero(totals?.input_tokens),
      output_tokens: zero(totals?.output_tokens),
      cached_tokens: zero(totals?.cached_tokens),
      ci_seconds: zero(totals?.ci_seconds),
      storage_byte_days: zero(totals?.storage_byte_days),
      usd_micros: zero(totals?.usd_micros),
      unpriced: zero(totals?.unpriced),
    },
    merged_pulls: n,
    usd_micros_per_merged_pull: n === 0 ? null : Math.round((merged?.usd ?? 0) / n),
    tokens_per_merged_pull: n === 0 ? null : Math.round((merged?.tokens ?? 0) / n),
    rows: out,
  });
}

const CSV_COLUMNS = [
  'key',
  'repo',
  'label',
  'merged',
  'events',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'ci_seconds',
  'storage_byte_days',
  'usd_micros',
  'unpriced',
] as const;

/** RFC 4180, with spreadsheet formulas defused (tickets and titles are user text). */
export function csv(rows: readonly Row[]): string {
  const cell = (value: unknown): string => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    CSV_COLUMNS.join(','),
    ...rows.map((r) => CSV_COLUMNS.map((col) => cell(r[col])).join(',')),
  ]
    .map((line) => `${line}\r\n`)
    .join('');
}

usageRoutes.get('/repos/:repo{.+}/usage', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return await report(
      c,
      { column: 'repo_id', id: loaded.repo.id },
      { where: 'repo_id = ?', params: [loaded.repo.id] },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

usageRoutes.get('/orgs/:org/usage', async (c) => {
  try {
    const userId = sessionUser(c);
    const org = await getOrgBySlug(c.env, c.req.param('org'));
    if (!org || !(await orgMembership(c.env, org.id, userId)))
      throw new ApiError(404, 'org_not_found', `no org ${c.req.param('org')}`);
    await requireOrgSso(c, org.id);
    return await report(
      c,
      { column: 'org_id', id: org.id },
      {
        where:
          "repo_id IN (SELECT id FROM repos WHERE owner_kind = 'org' AND owner_id = ?)",
        params: [org.id],
      },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

usageRoutes.get('/agents/:id/usage', async (c) => {
  try {
    const userId = sessionUser(c);
    const agent = await getAgent(c.env, c.req.param('id'));
    if (!agent || !(await canDelegate(c.env, agent, userId)))
      throw new ApiError(404, 'agent_not_found', `no agent ${c.req.param('id')}`);
    if (agent.owner_kind === 'org') await requireOrgSso(c, agent.owner_id);
    return await report(
      c,
      { column: 'agent_id', id: agent.id },
      { where: 'author_agent_id = ?', params: [agent.id] },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- budgets ----------------------------------------------------------------

/**
 * The budget scope named by `org` or `agent`. Reading needs org membership or
 * the right to delegate to the agent; changing needs an org owner or admin,
 * or the agent's owner. Agents never change budgets, their own included.
 */
async function budgetScope(
  c: Context<AppEnv>,
  named: { org?: string; agent?: string },
  need: 'read' | 'manage',
): Promise<{ scope: Budget['scope']; scope_id: string; auditOrg?: string }> {
  const userId = sessionUser(c);
  if (need === 'manage' && c.get('principal')?.kind === 'agent')
    throw new ApiError(403, 'forbidden', 'Agents cannot change usage budgets.');
  if (named.org !== undefined) {
    const org = await getOrgBySlug(c.env, named.org);
    const me = org ? await orgMembership(c.env, org.id, userId) : null;
    if (!org || !me) throw new ApiError(404, 'org_not_found', `no org ${named.org}`);
    if (need === 'manage' && me.role !== 'owner' && me.role !== 'admin')
      throw new ApiError(403, 'forbidden', 'org owner or admin role required');
    await requireOrgSso(c, org.id);
    return { scope: 'org', scope_id: org.id, auditOrg: org.slug };
  }
  if (named.agent !== undefined) {
    const agent = await getAgent(c.env, named.agent);
    if (!agent || !(await canDelegate(c.env, agent, userId)))
      throw new ApiError(404, 'agent_not_found', `no agent ${named.agent}`);
    const managed = await canManageOwner(c.env, agent, userId);
    if (need === 'manage' && !managed)
      throw new ApiError(
        403,
        'forbidden',
        "only the agent's owner can change its budgets",
      );
    if (agent.owner_kind === 'org') await requireOrgSso(c, agent.owner_id);
    return { scope: 'agent', scope_id: agent.id, ...managed };
  }
  throw new ApiError(400, 'invalid_request', 'name exactly one of org or agent');
}

usageRoutes.get('/usage/budgets', async (c) => {
  try {
    const query = parse(budgetQuery, c.req.query());
    const scope = await budgetScope(c, query, 'read');
    const budgets = (
      await q(
        c.env,
        'SELECT * FROM usage_budgets WHERE scope = ? AND scope_id = ? ORDER BY created_at, id',
        [scope.scope, scope.scope_id],
      )
    ).map((r) => budgetRowSchema.parse(r));
    const alerts = await q(
      c.env,
      `SELECT budget_id, period_start, level, used, limit_value, notify, at FROM usage_alerts
        WHERE scope = ? AND scope_id = ? ORDER BY at DESC LIMIT 100`,
      [scope.scope, scope.scope_id],
    );
    c.header('cache-control', 'private, no-store');
    return c.json({
      budgets: await Promise.all(
        budgets.map(async (b) => ({
          ...b,
          period_start: periodStart(b.period),
          used: await budgetUsed(c.env, b),
        })),
      ),
      alerts,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

usageRoutes.put('/usage/budgets', async (c) => {
  try {
    const input = parse(budgetInputSchema, await readJsonBody(c));
    const scope = await budgetScope(c, input, 'manage');
    const now = Date.now();
    const id = ulid();
    const target = {
      scope: scope.scope,
      scope_id: scope.scope_id,
      metric: input.metric,
      period: input.period,
      soft_limit: input.soft_limit,
      hard_limit: input.hard_limit,
    };
    await recordAudit(
      c,
      {
        action: 'usage.budget.set',
        ...(scope.auditOrg ? { orgId: scope.auditOrg } : {}),
        target,
      },
      [
        c.env.DB.prepare(
          `INSERT INTO usage_budgets (id, scope, scope_id, metric, period, soft_limit, hard_limit,
             created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (scope, scope_id, metric, period) DO UPDATE SET
             soft_limit = excluded.soft_limit, hard_limit = excluded.hard_limit,
             updated_at = excluded.updated_at`,
        ).bind(
          id,
          scope.scope,
          scope.scope_id,
          input.metric,
          input.period,
          input.soft_limit,
          input.hard_limit,
          sessionUser(c),
          now,
          now,
        ),
      ],
    );
    const budget = budgetRowSchema.parse(
      await q1(
        c.env,
        `SELECT * FROM usage_budgets WHERE scope = ? AND scope_id = ? AND metric = ?
          AND period = ?`,
        [scope.scope, scope.scope_id, input.metric, input.period],
      ),
    );
    return c.json({ budget: { ...budget, used: await budgetUsed(c.env, budget) } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

usageRoutes.delete('/usage/budgets/:id', async (c) => {
  try {
    sessionUser(c);
    const row = await q1(c.env, 'SELECT * FROM usage_budgets WHERE id = ?', [
      c.req.param('id'),
    ]);
    if (!row) throw new ApiError(404, 'budget_not_found', 'No such budget.');
    const budget = budgetRowSchema.parse(row);
    const scope = await budgetScope(
      c,
      budget.scope === 'org'
        ? {
            org:
              (
                await q1<{ slug: string }>(c.env, 'SELECT slug FROM orgs WHERE id = ?', [
                  budget.scope_id,
                ])
              )?.slug ?? '',
          }
        : { agent: budget.scope_id },
      'manage',
    ).catch((err: unknown) => {
      // a budget the caller cannot see is not there
      if (err instanceof ApiError && err.status === 404)
        throw new ApiError(404, 'budget_not_found', 'No such budget.');
      throw err;
    });
    await recordAudit(
      c,
      {
        action: 'usage.budget.delete',
        ...(scope.auditOrg ? { orgId: scope.auditOrg } : {}),
        target: {
          budget_id: budget.id,
          scope: budget.scope,
          scope_id: budget.scope_id,
          metric: budget.metric,
          period: budget.period,
        },
      },
      [c.env.DB.prepare('DELETE FROM usage_budgets WHERE id = ?').bind(budget.id)],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
