import { app } from './app';
import type { Env } from './env';
import type { DerivedMessage } from './core/derived';
import type { GitImportMessage } from './bridge/exportPush';
import { derivedQueue } from './queues/derived';
import { importQueue } from './queues/import';
import { agentJobsQueue } from './queues/agentJobs';
import { ciQueue } from './ci/runs';
import { sweepPipelines } from './ci/triggers';
import { sweepRunners } from './ci/runners';
import { auditStreamQueue, kickAuditStream } from './audit/stream';
import { q, run } from './db/client';
import { flushMetrics } from './observability/metrics';
import { expireAgentRefs } from './core/refs';
import { dispatchApprovals } from './ci/environments';
import { expireLeases } from './collab/work';
import { webhooksQueue } from './queues/webhooks';
import { sweepDeliveries } from './webhooks/deliver';
import { registryCleanup } from './registry/packages';
import { mirrorQueue, scheduleMirrors } from './mirrors/sync';
import type { MirrorMessage } from './mirrors/queue';
import { sweepDependencies } from './security/deps/graph';
import { syncAdvisories } from './security/deps/osv';

export { app };
export { CiRunnerDO } from './ci/runner';
// Durable Object classes must be exported from the Worker entry.
export { RefLockDO, RefLock } from './core/refdo';
export { YagAgent } from './agents/runtime';
export { SuperfanDO } from './agents/superfan';
export { RateLimitDO } from './middleware/ratelimit';
export { MergeQueueDO } from './queue/mergeQueue';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /** Cron (`* * * * *`): flush counters, expire agent refs and tokens, sweep CI runs, pipelines and webhook deliveries, queue due mirror syncs and dependency matches, sync OSV advisories hourly. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await flushMetrics(env);
    await expireAgentRefs(env);
    await run(env, 'DELETE FROM agent_tokens WHERE expires_at < ?', [Date.now()]);
    await run(env, 'DELETE FROM app_tokens WHERE expires_at < ?', [Date.now()]);
    await run(env, 'DELETE FROM oauth_codes WHERE expires_at < ?', [Date.now()]);
    await sweepDeliveries(env);
    await kickAuditStream(env);
    await scheduleMirrors(env).catch(() =>
      console.warn('Mirror scheduling will be retried by the next sweep'),
    );
    // Work queue claims whose agent stopped heartbeating go back to `ready`.
    await expireLeases(env).catch(() =>
      console.warn('Work queue lease expiry will be retried by the next sweep'),
    );
    // Environment approvals whose reviewers approved and wait timer elapsed.
    await dispatchApprovals(env).catch(() =>
      console.warn('Environment approval dispatch will be retried by the next sweep'),
    );
    // Package registry (#53): retention, unused blobs, stale uploads and tokens.
    await registryCleanup(env).catch((err: unknown) =>
      console.warn('Registry cleanup will be retried by the next sweep', err),
    );
    // Dependency alerts (#67): match moved default branches, then refresh advisories hourly.
    await sweepDependencies(env).catch((err: unknown) =>
      console.warn('Dependency matching will be retried by the next sweep', err),
    );
    if (new Date().getUTCMinutes() === 0)
      await syncAdvisories(env).catch((err: unknown) =>
        console.warn('OSV advisory sync will be retried next hour', err),
      );
    const expired = await q<{ id: string; log_key: string }>(
      env,
      'SELECT id, log_key FROM ci_runs WHERE log_key IS NOT NULL AND finished_at < ? LIMIT 50',
      [Date.now() - 7 * 86400_000],
    );
    for (const item of expired) {
      await env.OBJECTS.delete(item.log_key);
      await run(env, 'UPDATE ci_runs SET log_key = NULL WHERE id = ?', [item.id]);
    }
    // A cron sweep also recovers jobs whose alarm setup was interrupted.
    if (env.CI_RUNNER) {
      const overdue = await q<{ id: string }>(
        env,
        "SELECT id FROM ci_runs WHERE state = 'running' AND deadline < ? AND runs_on IS NULL LIMIT 2",
        [Date.now()],
      );
      for (const job of overdue) {
        try {
          await env.CI_RUNNER.get(env.CI_RUNNER.idFromName(job.id)).fetch(
            'https://runner/expire',
            {
              method: 'POST',
              body: JSON.stringify({ run_id: job.id }),
            },
          );
        } catch {
          console.warn('CI deadline cleanup will be retried by the next sweep');
        }
      }
    }
    // An undelivered queued message cannot hold a slot forever. Running VMs own a durable alarm.
    await run(
      env,
      "UPDATE ci_runs SET state = 'failed', finished_at = ?, error = 'Queue delivery expired; retry manually' WHERE state = 'queued' AND created_at < ? AND runs_on IS NULL",
      [Date.now(), Date.now() - 15 * 60_000],
    );
    // Self-hosted runs: unclaimed for an hour, lost leases and deadlines (issue #48).
    await sweepRunners(env);
    await sweepPipelines(env);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    switch (batch.queue) {
      case 'ci-runs':
        return ciQueue(batch as MessageBatch<{ run_id: string }>, env);
      case 'derived-data':
        return derivedQueue(batch as MessageBatch<DerivedMessage>, env);
      case 'git-import':
        return importQueue(batch as MessageBatch<GitImportMessage>, env);
      case 'agent-jobs':
        return agentJobsQueue(batch as MessageBatch<{ task_id: string }>, env);
      case 'audit-stream':
        return auditStreamQueue(batch, env);
      case 'forge-events':
        return webhooksQueue(batch, env);
      case 'mirror-sync':
        return mirrorQueue(batch as MessageBatch<MirrorMessage>, env);
      default:
        console.error(`queue: unknown queue ${batch.queue}, acking`);
        batch.ackAll();
    }
  },
};
