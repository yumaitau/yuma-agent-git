import { app } from './app';
import type { Env } from './env';

export { app };
// Durable Object classes must be exported from the Worker entry.
export { RefLockDO, RefLock } from './core/refdo';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
