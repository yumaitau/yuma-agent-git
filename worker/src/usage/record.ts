import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q, q1 } from '../db/client';
import { getRepo } from '../db/repos';
import { ulid } from '../core/ids';
import { appendAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import type { CiRun } from '../ci/config';
import { parseContext } from '../ci/context';
import { runnerInstance } from '../ci/spec';
import { priceVersionAt, storageDayCost, tokenCost } from './prices';

/**
 * Usage accounting (issue #61): one append-only row per model call, CI run or
 * storage reading, priced from `prices.ts` when it is recorded. A trigger
 * keeps `usage_daily` in the same transaction, so rollups always match the
 * raw rows. Budgets are checked after each write: crossing a limit records
 * one alert per budget, period and level, audits it and emits the
 * `usage_budget` webhook event; a hard limit also stops new work queue
 * claims for the agent (`budgetStop`, called from the guardrails).
 */

export const USAGE_KINDS = ['tokens', 'ci_seconds', 'storage'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface UsageEvent {
  /** Fixed ids make a re-sent event a no-op (CI runs use `ci_<run id>`). */
  id?: string;
  repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'> | null;
  agent_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  ticket?: string | null;
  pull_id?: number | null;
  kind: UsageKind;
  source: 'workers_ai' | 'reported' | 'ci' | 'meter';
  model?: string | null;
  billing?: 'metered' | 'subscription';
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  quantity?: number;
  /** A cost the reporter already knows; otherwise the price table sets it. */
  usd_micros?: number | null;
  correction_of?: string | null;
  reported_by?: string | null;
  at?: number;
}

export function orgOf(
  repo: Pick<RepoRecord, 'owner_kind' | 'owner_id'> | null,
): string | null {
  return repo?.owner_kind === 'org' ? (repo.owner_id ?? null) : null;
}

function priced(event: UsageEvent, at: number): { usd: number | null; version: string } {
  const version = priceVersionAt(at);
  if (event.usd_micros !== undefined && event.usd_micros !== null)
    return { usd: event.usd_micros, version: version.version };
  if (event.kind === 'tokens')
    return {
      usd: tokenCost(
        version,
        event.model ?? null,
        {
          input: event.input_tokens ?? 0,
          output: event.output_tokens ?? 0,
          cached: event.cached_tokens ?? 0,
        },
        event.billing ?? 'metered',
      ),
      version: version.version,
    };
  if (event.kind === 'ci_seconds') {
    const rate = event.model ? version.instances[event.model] : undefined;
    return {
      usd: rate === undefined ? null : Math.round((event.quantity ?? 0) * rate),
      version: version.version,
    };
  }
  return { usd: storageDayCost(version, event.quantity ?? 0), version: version.version };
}

/** Record events (one D1 batch), then check the budgets they count against. */
export async function recordUsage(
  env: Env,
  events: readonly UsageEvent[],
  origin: string | null = null,
): Promise<{ id: string; usd_micros: number | null }[]> {
  if (events.length === 0) return [];
  const now = Date.now();
  const out: { id: string; usd_micros: number | null }[] = [];
  const statements = events.map((event) => {
    const id = event.id ?? ulid();
    const at = event.at ?? now;
    const { usd, version } = priced(event, at);
    out.push({ id, usd_micros: usd });
    return env.DB.prepare(
      `INSERT INTO usage_events (id, org_id, repo_id, agent_id, task_id, run_id, ticket, pull_id,
         kind, source, model, billing, input_tokens, output_tokens, cached_tokens, quantity,
         usd_micros, price_version, correction_of, reported_by, at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    ).bind(
      id,
      orgOf(event.repo),
      event.repo?.id ?? null,
      event.agent_id ?? null,
      event.task_id ?? null,
      event.run_id ?? null,
      event.ticket ?? null,
      event.pull_id ?? null,
      event.kind,
      event.source,
      event.model ?? null,
      event.billing ?? 'metered',
      event.input_tokens ?? 0,
      event.output_tokens ?? 0,
      event.cached_tokens ?? 0,
      event.quantity ?? 0,
      usd,
      version,
      event.correction_of ?? null,
      event.reported_by ?? null,
      at,
      now,
    );
  });
  await env.DB.batch(statements);
  const groups = new Map<string, { repo: UsageEvent['repo']; agents: Set<string> }>();
  for (const event of events) {
    const key = event.repo?.id ?? '';
    const group = groups.get(key) ?? { repo: event.repo, agents: new Set<string>() };
    if (event.agent_id) group.agents.add(event.agent_id);
    groups.set(key, group);
  }
  for (const { repo, agents } of groups.values())
    await checkBudgets(env, repo, [...agents], origin);
  return out;
}

/** Token usage of one model call; failures are logged, never thrown. */
export async function recordModelUsage(
  env: Env,
  scope: {
    repo_id: string;
    task_id?: string | null;
    agent_id?: string | null;
    pull_id?: number | null;
    ticket?: string | null;
  },
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): Promise<void> {
  try {
    const repo = await getRepo(env, scope.repo_id);
    await recordUsage(env, [
      {
        repo,
        agent_id: scope.agent_id ?? null,
        task_id: scope.task_id ?? null,
        pull_id: scope.pull_id ?? null,
        ticket: scope.ticket ?? null,
        kind: 'tokens',
        source: 'workers_ai',
        model,
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    ]);
  } catch (err) {
    console.error('usage: model call not recorded', err);
  }
}

/** CI compute for a finished run, once (the event id is the run's). */
export async function recordCiUsage(
  env: Env,
  job: CiRun,
  repo: RepoRecord,
): Promise<void> {
  if (job.started_at === null || job.finished_at === null) return;
  try {
    const context = parseContext(job.context);
    await recordUsage(env, [
      {
        id: `ci_${job.id}`,
        repo,
        agent_id: context?.agent_id ?? null,
        pull_id: context?.pull_id ?? null,
        run_id: job.id,
        kind: 'ci_seconds',
        source: 'ci',
        model: job.runs_on ? 'self_hosted' : runnerInstance(job.config),
        quantity: Math.max(0, Math.ceil((job.finished_at - job.started_at) / 1000)),
        at: job.finished_at,
      },
    ]);
  } catch (err) {
    console.error('usage: CI run not recorded', job.id, err);
  }
}

/**
 * Stored bytes per repo for one UTC day (cron): the default branch as code
 * search last indexed it, release assets, package files, Git LFS objects the
 * repo links (a fork network's shared object counts in each repo linking it,
 * as LFS quotas do) and CI artifacts and caches. One event per repo and day,
 * so a second run the same day is a no-op.
 */
export async function recordStorageUsage(env: Env, now = Date.now()): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = await q<{
    id: string;
    owner_kind: 'user' | 'org';
    owner_id: string | null;
    bytes: number;
  }>(
    env,
    `SELECT r.id, r.owner_kind, r.owner_id,
       COALESCE((SELECT bytes FROM search_repos WHERE repo_id = r.id), 0)
       + COALESCE((SELECT SUM(size) FROM release_assets WHERE repo_id = r.id), 0)
       + COALESCE((SELECT SUM(f.size) FROM package_files f JOIN packages p ON p.id = f.package_id
                    WHERE p.repo_id = r.id), 0)
       + COALESCE((SELECT SUM(size) FROM lfs_objects WHERE repo_id = r.id AND status = 'stored'), 0)
       + COALESCE((SELECT SUM(size) FROM ci_artifacts WHERE repo_id = r.id), 0)
       + COALESCE((SELECT SUM(size) FROM ci_caches WHERE repo_id = r.id AND state = 'ready'), 0) AS bytes
       FROM repos r
      WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE id = 'storage_' || r.id || '_' || ?)`,
    [day],
  );
  for (let i = 0; i < rows.length; i += 50)
    await recordUsage(
      env,
      rows.slice(i, i + 50).map((r) => ({
        id: `storage_${r.id}_${day}`,
        repo: { id: r.id, owner_kind: r.owner_kind, owner_id: r.owner_id },
        kind: 'storage' as const,
        source: 'meter' as const,
        quantity: r.bytes,
        at: now,
      })),
    );
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const budgetRowSchema = z.object({
  id: z.string(),
  scope: z.enum(['org', 'agent']),
  scope_id: z.string(),
  metric: z.enum(['tokens', 'usd_micros']),
  period: z.enum(['day', 'month']),
  soft_limit: z.number().nullable(),
  hard_limit: z.number().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Budget = z.infer<typeof budgetRowSchema>;

/** First UTC day of the budget's current period, as `YYYY-MM-DD`. */
export function periodStart(period: Budget['period'], now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return period === 'day' ? day : `${day.slice(0, 7)}-01`;
}

/** What the budget's scope has used so far this period, from the rollups. */
export async function budgetUsed(
  env: Env,
  budget: Budget,
  now = Date.now(),
): Promise<number> {
  const column = budget.scope === 'org' ? 'org_id' : 'agent_id';
  const sum =
    budget.metric === 'tokens'
      ? 'SUM(input_tokens + output_tokens + cached_tokens)'
      : 'SUM(usd_micros)';
  const row = await q1<{ used: number | null }>(
    env,
    `SELECT ${sum} AS used FROM usage_daily WHERE ${column} = ? AND day >= ?`,
    [budget.scope_id, periodStart(budget.period, now)],
  );
  return row?.used ?? 0;
}

/** The audit chain of a budget: its org's slug, or none for a personal agent. */
export async function auditOrgOf(env: Env, budget: Budget): Promise<string | null> {
  const orgId =
    budget.scope === 'org'
      ? budget.scope_id
      : ((
          await q1<{ owner_id: string }>(
            env,
            "SELECT owner_id FROM agents WHERE id = ? AND owner_kind = 'org'",
            [budget.scope_id],
          )
        )?.owner_id ?? null);
  if (orgId === null) return null;
  const org = await q1<{ slug: string }>(env, 'SELECT slug FROM orgs WHERE id = ?', [
    orgId,
  ]);
  return org?.slug ?? null;
}

/** Who an alert goes to: the org, or the agent's owner. */
async function ownerOf(env: Env, budget: Budget): Promise<string> {
  if (budget.scope === 'org') return `org:${budget.scope_id}`;
  const agent = await q1<{ owner_kind: string; owner_id: string }>(
    env,
    'SELECT owner_kind, owner_id FROM agents WHERE id = ?',
    [budget.scope_id],
  );
  return agent ? `${agent.owner_kind}:${agent.owner_id}` : `agent:${budget.scope_id}`;
}

async function budgetsFor(
  env: Env,
  orgId: string | null,
  agents: readonly string[],
): Promise<Budget[]> {
  if (orgId === null && agents.length === 0) return [];
  const rows = await q(
    env,
    `SELECT * FROM usage_budgets WHERE (scope = 'org' AND scope_id = ?)
       OR (scope = 'agent' AND scope_id IN (${agents.map(() => '?').join(',') || "''"}))`,
    [orgId ?? '', ...agents],
  );
  return rows.map((r) => budgetRowSchema.parse(r));
}

/** Alert once per budget, period and level that the scope's usage has reached. */
export async function checkBudgets(
  env: Env,
  repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'> | null,
  agents: readonly string[],
  origin: string | null = null,
): Promise<void> {
  try {
    const now = Date.now();
    for (const budget of await budgetsFor(env, orgOf(repo), agents)) {
      const used = await budgetUsed(env, budget, now);
      for (const level of ['soft', 'hard'] as const) {
        const limit = level === 'soft' ? budget.soft_limit : budget.hard_limit;
        if (limit === null || used < limit) continue;
        const notify = await ownerOf(env, budget);
        const start = periodStart(budget.period, now);
        const inserted = await env.DB.prepare(
          `INSERT INTO usage_alerts (budget_id, period_start, level, scope, scope_id, used,
             limit_value, notify, at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        )
          .bind(
            budget.id,
            start,
            level,
            budget.scope,
            budget.scope_id,
            used,
            limit,
            notify,
            now,
          )
          .run();
        if (!inserted.meta.changes) continue;
        const target = {
          budget_id: budget.id,
          scope: budget.scope,
          scope_id: budget.scope_id,
          metric: budget.metric,
          period: budget.period,
          period_start: start,
          level,
          used,
          limit,
          notify,
        };
        const actor = { kind: 'system' as const, id: 'usage' };
        const org = await auditOrgOf(env, budget);
        await appendAudit(env, {
          action: 'usage.budget.alert',
          actor,
          ...(org ? { orgId: org } : {}),
          target,
        });
        if (repo)
          await emitEvent(env, repo, {
            event: 'usage_budget',
            action: level === 'soft' ? 'soft_limit' : 'hard_limit',
            actor,
            origin,
            data: { budget: target },
          });
      }
    }
  } catch (err) {
    console.error('usage: budget check failed', err);
  }
}

/**
 * The hard budget that stops this agent taking new work, or null. Only agent
 * identities are metered; people and API tokens are never stopped.
 */
export async function budgetStop(
  env: Env,
  repo: Pick<RepoRecord, 'owner_kind' | 'owner_id'>,
  agentId: string | null,
): Promise<{ budget: Budget; used: number } | null> {
  if (agentId === null) return null;
  const now = Date.now();
  for (const budget of await budgetsFor(env, orgOf(repo), [agentId])) {
    if (budget.hard_limit === null) continue;
    const used = await budgetUsed(env, budget, now);
    if (used >= budget.hard_limit) return { budget, used };
  }
  return null;
}
