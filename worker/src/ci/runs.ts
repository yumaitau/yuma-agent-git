import type { Env } from '../env';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getRepo, getRef } from '../db/repos';
import { ApiError } from '../core/errors';
import { DEFAULT_INSTANCE, reservation, settings, type CiRun } from './config';
import { budgetAlerts, budgetMicros, jobLimitError, poolFor } from './capacity';
import { runnerInstance } from './spec';
import { parseContext, type RunContext } from './context';
import { emitEvent } from '../webhooks/events';
import { recordCiUsage } from '../usage/record';

export async function enqueueRun(
  env: Env,
  repoId: string,
  head: string,
  actor: string,
  publish = false,
  context: RunContext | null = null,
): Promise<CiRun> {
  if (env.CI_ENABLED !== 'true' || !env.CI_QUEUE || !env.CI_RUNNER) {
    throw new ApiError(
      503,
      'ci_not_enabled',
      'CI execution is not enabled. Your administrator can enable the Cloudflare runner after deployment.',
    );
  }
  const config = await settings(env, repoId);
  if (!config)
    throw new ApiError(409, 'ci_not_configured', 'Set up CI for this repository first.');
  if (!(await getChangeset(env, repoId, head)))
    throw new ApiError(404, 'changeset_not_found', 'Revision not found');
  const limit = jobLimitError(
    {
      instance_type: DEFAULT_INSTANCE,
      timeout_seconds: config.policy.timeout_seconds,
      builtin: true,
    },
    (await poolFor(env, repoId)).limits,
  );
  if (limit) throw new ApiError(409, 'ci_limit_exceeded', limit);
  if (publish) {
    const repo = await getRepo(env, repoId);
    const ref = repo && (await getRef(env, repoId, repo.default_branch));
    if (
      !config.policy.image ||
      !env.CI_REGISTRY_HOST ||
      !env.CI_REGISTRY_USERNAME ||
      !env.CI_REGISTRY_PASSWORD
    ) {
      throw new ApiError(
        409,
        'registry_not_configured',
        'Configure the image destination and registry credentials before publishing.',
      );
    }
    if (
      config.policy.image.split('/')[0] !== env.CI_REGISTRY_HOST ||
      ref?.head !== head
    ) {
      throw new ApiError(
        409,
        'publish_not_allowed',
        'Publish only the current default-branch revision to the configured registry.',
      );
    }
    let destinations: Record<string, unknown> = {};
    try {
      destinations = JSON.parse(env.CI_REGISTRY_IMAGES ?? '{}');
    } catch {
      /* Fail closed. */
    }
    if (!repo || !destinations || destinations[repo.slug] !== config.policy.image) {
      throw new ApiError(
        409,
        'publish_not_allowed',
        'An operator must authorize this image destination for this repository.',
      );
    }
  }
  const id = await admitRun(
    env,
    {
      repoId,
      head,
      settingsVersion: config.version,
      config: config.config,
      actor,
      publish,
      reserved: reservation(config.policy),
      context,
    },
    {
      // pipeline jobs on the same revision do not hold back its settings run
      sql: "NOT EXISTS (SELECT 1 FROM ci_runs WHERE repo_id = ? AND head_cs = ? AND pipeline_run_id IS NULL AND state IN ('queued','running'))",
      binds: [repoId, head],
    },
  );
  if (!id)
    throw new ApiError(
      429,
      'ci_capacity_or_budget',
      'A run is already queued, runner capacity is full, or the monthly budget is exhausted.',
    );
  return (await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [id]))!;
}

/** The `ci_run` webhook event (#75) for a run's current row. */
export async function emitCiRun(
  env: Env,
  id: string,
  action: 'requested' | 'in_progress' | 'completed',
): Promise<void> {
  const job = await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [id]);
  const repo = job && (await getRepo(env, job.repo_id));
  if (!job || !repo) return;
  const context = parseContext(job.context);
  await emitEvent(env, repo, {
    event: 'ci_run',
    action,
    actor: { kind: 'user', id: job.requested_by },
    origin: context?.origin ?? null,
    data: {
      ci_run: {
        id: job.id,
        state: job.state,
        head_cs: job.head_cs,
        event: context?.event ?? null,
        ref: context?.ref ?? null,
        publish: job.publish === 1,
        pipeline_run_id: job.pipeline_run_id ?? null,
        job_key: job.job_key ?? null,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error: job.error,
      },
    },
  });
  // CI compute for cost accounting (#61), once per run
  if (action === 'completed') await recordCiUsage(env, job, repo);
}

export interface Admission {
  repoId: string;
  head: string;
  /** 0 for pipeline jobs, so they never count as a settings pipeline result. */
  settingsVersion: number;
  config: string;
  actor: string;
  publish: boolean;
  reserved: number;
  pipelineRunId?: string;
  jobKey?: string;
  /** Trigger context for secrets, environments and OIDC claims. */
  context?: RunContext | null;
  /** Self-hosted runner labels (issue #48); null or absent for the built-in pool. */
  runsOn?: string[] | null;
}

/**
 * Queue one run inside its pool's ledger (issue #52): the pool's monthly
 * budget and job slots, and the caller's duplicate `guard`. Returns null when
 * it is not admitted. Pools are separate, so one org's queue never holds back
 * another's. Self-hosted runs (issue #48) skip the budget and the built-in
 * slots and wait for a runner to claim them instead of a queue message.
 */
export async function admitRun(
  env: Env,
  a: Admission,
  guard: { sql: string; binds: unknown[] },
): Promise<string | null> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const month = new Date(now).toISOString().slice(0, 7);
  const runsOn = a.runsOn ? JSON.stringify(a.runsOn) : null;
  const pool = await poolFor(env, a.repoId);
  // Single SQLite statement serializes admission across concurrent requests.
  // Never refund reservations: retries, failures and cancellations cannot hide spend.
  const inserted = await env.DB.prepare(
    `INSERT INTO ci_runs
    (id, repo_id, head_cs, settings_version, config, requested_by, state, publish, month, reserved_micros, created_at, pipeline_run_id, job_key, context, runs_on, pool, instance_type)
    SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (? IS NOT NULL OR (
      (SELECT COALESCE(SUM(reserved_micros), 0) FROM ci_runs WHERE pool = ? AND month = ?) + ? <= ?
      AND (SELECT COUNT(*) FROM ci_runs WHERE pool = ? AND state IN ('queued','running') AND runs_on IS NULL) < ?))
      AND ${guard.sql}`,
  )
    .bind(
      id,
      a.repoId,
      a.head,
      a.settingsVersion,
      a.config,
      a.actor,
      a.publish ? 1 : 0,
      month,
      a.reserved,
      now,
      a.pipelineRunId ?? null,
      a.jobKey ?? null,
      a.context ? JSON.stringify(a.context) : null,
      runsOn,
      pool.id,
      runsOn ? null : runnerInstance(a.config),
      runsOn,
      pool.id,
      month,
      a.reserved,
      budgetMicros(pool.limits),
      pool.id,
      pool.limits.max_concurrent,
      ...guard.binds,
    )
    .run();
  if (!inserted.meta.changes) return null;
  if (runsOn) return id;
  try {
    await budgetAlerts(env, pool, month);
  } catch (err) {
    console.warn('CI budget alert failed', err instanceof Error ? err.message : err);
  }
  try {
    await env.CI_QUEUE!.send({ run_id: id });
  } catch {
    await run(
      env,
      "UPDATE ci_runs SET state = 'failed', finished_at = ?, error = 'Queue dispatch failed; retry manually' WHERE id = ?",
      [Date.now(), id],
    );
    throw new ApiError(
      503,
      'ci_dispatch_failed',
      'Could not queue the run. Retry when the queue is available.',
    );
  }
  await emitCiRun(env, id, 'requested');
  return id;
}

export async function ciQueue(
  batch: MessageBatch<{ run_id: string }>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const id = message.body.run_id;
    try {
      if (!env.CI_RUNNER) throw new Error('Runner binding unavailable');
      const response = await env.CI_RUNNER.get(env.CI_RUNNER.idFromName(id)).fetch(
        'https://runner/run',
        {
          method: 'POST',
          body: JSON.stringify({ run_id: id }),
        },
      );
      if (!response.ok) throw new Error('Runner rejected the job');
    } catch {
      // At-most-once execution: a failed delivery never automatically reruns scripts or pushes.
      await run(
        env,
        "UPDATE ci_runs SET state = 'failed', finished_at = ?, error = 'Runner interrupted; retry manually' WHERE id = ? AND state = 'queued'",
        [Date.now(), id],
      );
    }
    message.ack();
  }
}
