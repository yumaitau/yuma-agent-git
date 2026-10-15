import type { Env } from '../env';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getRepo, getRef } from '../db/repos';
import { ApiError } from '../core/errors';
import { monthlyBudget, reservation, settings, type CiRun } from './config';

export async function enqueueRun(
  env: Env,
  repoId: string,
  head: string,
  actor: string,
  publish = false,
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
  const now = Date.now();
  const id = crypto.randomUUID();
  const month = new Date(now).toISOString().slice(0, 7);
  const reserved = reservation(config.policy);
  // Single SQLite statement serializes admission across concurrent requests.
  // Never refund reservations: retries, failures and cancellations cannot hide spend.
  const inserted = await env.DB.prepare(
    `INSERT INTO ci_runs
    (id, repo_id, head_cs, settings_version, config, requested_by, state, publish, month, reserved_micros, created_at)
    SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
    WHERE (SELECT COALESCE(SUM(reserved_micros), 0) FROM ci_runs WHERE month = ?) + ? <= ?
      AND (SELECT COUNT(*) FROM ci_runs WHERE state IN ('queued','running')) < 2
      AND NOT EXISTS (SELECT 1 FROM ci_runs WHERE repo_id = ? AND head_cs = ? AND state IN ('queued','running'))`,
  )
    .bind(
      id,
      repoId,
      head,
      config.version,
      config.config,
      actor,
      publish ? 1 : 0,
      month,
      reserved,
      now,
      month,
      reserved,
      monthlyBudget(env),
      repoId,
      head,
    )
    .run();
  if (!inserted.meta.changes)
    throw new ApiError(
      429,
      'ci_capacity_or_budget',
      'A run is already queued, runner capacity is full, or the monthly budget is exhausted.',
    );
  try {
    await env.CI_QUEUE.send({ run_id: id });
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
  return (await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [id]))!;
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
