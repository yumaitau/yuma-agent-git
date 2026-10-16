import { z } from 'zod';
import type { Env } from '../env';
import type { SpecError } from '../../shared/collaboration';
import { q1 } from '../db/client';
import { appendAudit } from '../audit/record';
import {
  DEFAULT_INSTANCE,
  INSTANCE_NAMES,
  MAX_TIMEOUT_S,
  monthlyBudget,
  type InstanceType,
} from './config';
import type { Pipeline } from './spec';

/**
 * CI capacity (issue #52). Every run counts against one admission ledger, its
 * pool: an org an operator provisioned in `org_ci_limits`, or the shared
 * deployment pool (CI_MONTHLY_BUDGET_USD, two slots) for everyone else, as
 * before. Pools never block each other. The ledger is admission control, not
 * a billing cap: reservations are never refunded and actual spend is not
 * measured.
 */
export const SHARED_POOL = 'shared';

/**
 * The built-in pool runs a job inside one queue consumer invocation, so its
 * deadline stays at the pilot's 10 minutes whatever the org allows; longer
 * jobs (up to 6 hours) go to self-hosted runners.
 */
export const BUILTIN_MAX_TIMEOUT_S = 600;
const GIB = 1024 ** 3;

export const limitsSchema = z.object({
  max_concurrent: z.number().int().min(0).max(100),
  monthly_budget_usd: z.number().min(0).max(100_000),
  max_timeout_s: z.number().int().min(30).max(MAX_TIMEOUT_S),
  instance_types: z
    .array(z.enum(INSTANCE_NAMES))
    .min(1)
    .max(INSTANCE_NAMES.length)
    .transform((t) => [...new Set(t)]),
  cache_quota_bytes: z
    .number()
    .int()
    .min(0)
    .max(1024 * GIB),
});
export type CiLimits = z.infer<typeof limitsSchema>;

export interface Pool {
  /** `shared` or the org id. */
  id: string;
  limits: CiLimits;
}

export function sharedLimits(env: Env): CiLimits {
  return {
    max_concurrent: 2,
    monthly_budget_usd: monthlyBudget(env) / 1e6,
    max_timeout_s: BUILTIN_MAX_TIMEOUT_S,
    instance_types: [DEFAULT_INSTANCE],
    cache_quota_bytes: 10 * GIB,
  };
}

export interface LimitsRow {
  org_id: string;
  max_concurrent: number;
  monthly_budget_usd: number;
  max_timeout_s: number;
  instance_types: string;
  cache_quota_bytes: number;
}

export function limitsOf(row: LimitsRow): CiLimits {
  return limitsSchema.parse({ ...row, instance_types: JSON.parse(row.instance_types) });
}

/** The pool a repository's runs count against. */
export async function poolFor(env: Env, repoId: string): Promise<Pool> {
  const row = await q1<LimitsRow>(
    env,
    `SELECT l.* FROM repos r JOIN org_ci_limits l ON l.org_id = r.owner_id
    WHERE r.id = ? AND r.owner_kind = 'org'`,
    [repoId],
  );
  return row
    ? { id: row.org_id, limits: limitsOf(row) }
    : { id: SHARED_POOL, limits: sharedLimits(env) };
}

/** Whole micro-dollars of a pool's monthly budget. */
export function budgetMicros(limits: CiLimits): number {
  return Math.floor(limits.monthly_budget_usd * 1_000_000);
}

/** Reasons a job cannot run in this pool, checked when a pipeline is planned. */
export function jobLimitError(
  job: { instance_type: InstanceType; timeout_seconds: number; builtin: boolean },
  limits: CiLimits,
): string | null {
  if (job.builtin && !limits.instance_types.includes(job.instance_type))
    return `Instance type ${job.instance_type} is not allowed for this organisation. Allowed: ${limits.instance_types.join(', ')}`;
  const max = job.builtin
    ? Math.min(limits.max_timeout_s, BUILTIN_MAX_TIMEOUT_S)
    : limits.max_timeout_s;
  if (job.timeout_seconds > max)
    return `timeout_seconds ${job.timeout_seconds} is over this ${job.builtin ? 'Cloudflare pool' : 'organisation'} limit of ${max} seconds`;
  return null;
}

/** Plan-time errors for every job of a pipeline, one per offending job. */
export function planErrors(pipeline: Pipeline, limits: CiLimits): SpecError[] {
  const errors: SpecError[] = [];
  const seen = new Set<string>();
  for (const job of pipeline.jobs) {
    const message = jobLimitError(
      {
        instance_type: job.instance_type,
        timeout_seconds: job.timeout_seconds,
        builtin: job.runs_on === null,
      },
      limits,
    );
    // matrix jobs share their job's settings; report the job once
    if (message && !seen.has(job.job)) {
      seen.add(job.job);
      errors.push({ line: 1, column: 1, message: `jobs.${job.job}: ${message}` });
    }
  }
  return errors;
}

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

/**
 * Budget alerts (issue #52): the first admission that takes a pool's monthly
 * reservations past 50%, 80% or 100% records each threshold once per month
 * and writes a `ci.budget.alert` audit event to the org's chain.
 */
export async function budgetAlerts(
  env: Env,
  pool: Pool,
  month: string,
): Promise<number[]> {
  const budget = budgetMicros(pool.limits);
  if (budget <= 0) return [];
  const used =
    (
      await q1<{ used: number }>(
        env,
        'SELECT COALESCE(SUM(reserved_micros), 0) AS used FROM ci_runs WHERE pool = ? AND month = ?',
        [pool.id, month],
      )
    )?.used ?? 0;
  const fired: number[] = [];
  for (const threshold of BUDGET_THRESHOLDS) {
    if (used * 100 < budget * threshold) break;
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO ci_budget_alerts (pool, month, threshold, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(pool.id, month, threshold, Date.now())
      .run();
    if (!inserted.meta.changes) continue;
    fired.push(threshold);
    const org =
      pool.id === SHARED_POOL
        ? null
        : await q1<{ slug: string }>(env, 'SELECT slug FROM orgs WHERE id = ?', [
            pool.id,
          ]);
    await appendAudit(env, {
      action: 'ci.budget.alert',
      ...(org ? { orgId: org.slug } : {}),
      actor: { kind: 'system', id: 'ci' },
      target: {
        pool: pool.id,
        month,
        threshold,
        reserved_usd: used / 1e6,
        budget_usd: budget / 1e6,
      },
    });
  }
  return fired;
}
