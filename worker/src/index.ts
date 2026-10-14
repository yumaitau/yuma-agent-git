import { app } from './app';
import type { Env } from './env';
import type { DerivedMessage } from './core/derived';
import type { GitImportMessage } from './bridge/exportPush';
import { derivedQueue } from './queues/derived';
import { importQueue } from './queues/import';
import { agentJobsQueue } from './queues/agentJobs';

export { app };
// Durable Object classes must be exported from the Worker entry.
export { RefLockDO, RefLock } from './core/refdo';
export { YagAgent } from './agents/runtime';
export { SuperfanDO } from './agents/superfan';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    switch (batch.queue) {
      case 'derived-data':
        return derivedQueue(batch as MessageBatch<DerivedMessage>, env);
      case 'git-import':
        return importQueue(batch as MessageBatch<GitImportMessage>, env);
      case 'agent-jobs':
        return agentJobsQueue(batch as MessageBatch<{ task_id: string }>, env);
      default:
        console.error(`queue: unknown queue ${batch.queue}, acking`);
        batch.ackAll();
    }
  },
};
