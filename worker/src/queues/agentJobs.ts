import type { Env } from '../env';
import { C, T } from '../db/schema';
import { run } from '../db/client';
import type { RunTaskOptions } from '../agents/runtime';

export interface AgentJobMessage {
  task_id: string;
  /** Run options (#19 replaces the echo loop; tests inject step behavior). */
  opts?: RunTaskOptions;
}

/**
 * `agent-jobs` queue consumer (issue #17): dispatches each task to its
 * Durable Object. Failures retry **once** (crash-safe resume re-enters from
 * persisted state); poison tasks are marked failed and acked — a runaway task
 * must never loop forever.
 */
export async function agentJobsQueue(
  batch: MessageBatch<AgentJobMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages.slice(0, 5)) {
    const taskId = message.body.task_id;
    try {
      const stub = env.AGENT.get(env.AGENT.idFromName(taskId)) as unknown as {
        runTask(taskId: string, opts?: RunTaskOptions): Promise<unknown>;
      };
      await stub.runTask(taskId, message.body.opts);
      message.ack();
    } catch (err) {
      if (message.attempts >= 2) {
        await run(
          env,
          `UPDATE ${T.agentTasks} SET ${C.agentTasks.status} = 'failed', ${C.agentTasks.updatedAt} = ? WHERE ${C.agentTasks.id} = ?`,
          [Date.now(), taskId],
        );
        console.error(
          'agent-jobs: giving up',
          JSON.stringify({ task_id: taskId, attempts: message.attempts }),
          err,
        );
        message.ack();
      } else {
        // exactly one retry — the second run resumes from persisted state
        batch.retryAll();
        return;
      }
    }
  }
}
