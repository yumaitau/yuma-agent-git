import { app } from './app';
import type { Env } from './env';
import type { DerivedMessage } from './core/derived';
import { derivedQueue } from './queues/derived';

export { app };
// Durable Object classes must be exported from the Worker entry.
export { RefLockDO, RefLock } from './core/refdo';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    switch (batch.queue) {
      case 'derived-data':
        return derivedQueue(batch as MessageBatch<DerivedMessage>, env);
      case 'git-import':
        // TODO(issue #15): import queue consumer
        batch.retryAll();
        return;
      case 'agent-jobs':
        // TODO(issue #17): agent job consumer
        batch.retryAll();
        return;
      default:
        console.error(`queue: unknown queue ${batch.queue}, acking`);
        batch.ackAll();
    }
  },
};
