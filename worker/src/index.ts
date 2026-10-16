import { app } from './app';
import type { Env } from './env';
import type { DerivedMessage } from './core/derived';
import type { GitImportMessage } from './bridge/exportPush';
import { derivedQueue } from './queues/derived';
import { importQueue } from './queues/import';
import { agentJobsQueue } from './queues/agentJobs';
import { ciQueue } from './ci/runs';
import { auditStreamQueue, kickAuditStream } from './audit/stream';
import { q, run } from './db/client';
import { flushMetrics } from './observability/metrics';
import { expireAgentRefs } from './core/refs';

export { app };
export { CiRunnerDO } from './ci/runner';
// Durable Object classes must be exported from the Worker entry.
export { RefLockDO, RefLock } from './core/refdo';
export { YagAgent } from './agents/runtime';
export { SuperfanDO } from './agents/superfan';
export { RateLimitDO } from './middleware/ratelimit';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /** Cron (`* * * * *`): flush counters, expire idle agent refs, sweep CI runs. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await flushMetrics(env);
    await expireAgentRefs(env);
    await kickAuditStream(env);
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
        "SELECT id FROM ci_runs WHERE state = 'running' AND deadline < ? LIMIT 2",
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
      "UPDATE ci_runs SET state = 'failed', finished_at = ?, error = 'Queue delivery expired; retry manually' WHERE state = 'queued' AND created_at < ?",
      [Date.now(), Date.now() - 15 * 60_000],
    );
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
      default:
        console.error(`queue: unknown queue ${batch.queue}, acking`);
        batch.ackAll();
    }
  },
};
