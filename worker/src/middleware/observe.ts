import type { Context, Next } from 'hono';
import type { AppEnv, Principal } from '../auth/principal';
import { runWithTimer, timerFor } from '../observability/phase';

/**
 * Structured request logging (issue #21): one JSON line per request with a
 * request id (echoed as `X-Request-Id`), route, status, duration, principal
 * kind, repo and bytes out. Error logs carry stack + route + an **input
 * digest** — never secrets, tokens or content. Requests over 2s get a
 * `{slow: true}` tail log with phase timings (d1/r2/do/ai).
 */

let slowMs = 2000;

/** Test seam: lower the slow-log threshold without fake timers across isolates. */
export function setSlowThreshold(ms: number): void {
  slowMs = ms;
}

function digest(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  // cheap non-reversible digest of the input shape — content never logged
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `sha1ish:${(hash >>> 0).toString(16)}:${text.length}`;
}

const requestIds = new WeakMap<Request, string>();

/** The `X-Request-Id` of a request seen by this middleware (audit events cite it). */
export function requestIdOf(request: Request): string | null {
  return requestIds.get(request) ?? null;
}

export async function observeMiddleware(c: Context<AppEnv>, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  requestIds.set(c.req.raw, requestId);
  const started = Date.now();
  c.header('x-request-id', requestId);
  const timer = timerFor(c.req.raw);

  await runWithTimer(timer, () => next());

  const duration = Date.now() - started;
  const principal = (c.get('principal') ?? null) as Principal | null;
  const path = new URL(c.req.url).pathname;
  const line: Record<string, unknown> = {
    request_id: requestId,
    route: `${c.req.method} ${path}`,
    status: c.res.status,
    duration_ms: duration,
    principal: principal ? principal.kind : 'anonymous',
    bytes_out: Number(c.res.headers.get('content-length') ?? 0),
  };
  if (duration > slowMs) {
    console.log(
      JSON.stringify({
        ...line,
        slow: true,
        ...timer.phases(),
      }),
    );
  } else if (c.res.status >= 500) {
    console.error(
      JSON.stringify({
        ...line,
        input_digest: digest({ method: c.req.method, path }),
      }),
    );
  } else {
    console.log(JSON.stringify(line));
  }
}
