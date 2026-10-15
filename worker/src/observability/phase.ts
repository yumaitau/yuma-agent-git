import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Phase timings (issue #21) — the telemetry the superfans read. Threading a
 * timer through the request lets the slow-log attribute time to d1/r2/do/ai
 * instead of just "the request took 2s".
 *
 * The timer rides `AsyncLocalStorage` for the request (set by the observe
 * middleware) so D1/R2/DO/AI call sites can attribute time without threading
 * a context argument through every helper.
 */
export type Phase = 'd1' | 'r2' | 'do' | 'ai' | 'queue' | 'github';

const phaseStore = new AsyncLocalStorage<PhaseTimer>();

/** Run `fn` with `timer` visible to `timePhase` / `r2` in this async subtree. */
export function runWithTimer<T>(timer: PhaseTimer, fn: () => Promise<T>): Promise<T> {
  return phaseStore.run(timer, fn);
}

/** Attribute `fn` to `phase` when a request timer is active; otherwise just run it. */
export function timePhase<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  const timer = phaseStore.getStore();
  if (!timer) return fn();
  return timer.time(phase, fn);
}

const R2_OPS = new Set(['get', 'put', 'head', 'delete', 'list']);

/**
 * R2 bucket that records get/put/head/delete/list against the request timer.
 * Outside a request (queues, tests, cron) this is the bucket unchanged.
 */
export function r2(bucket: R2Bucket): R2Bucket {
  if (phaseStore.getStore() === undefined) return bucket;
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = (value as (...args: unknown[]) => unknown).bind(target);
      if (!R2_OPS.has(String(prop))) return fn;
      return (...args: unknown[]) => timePhase('r2', () => Promise.resolve(fn(...args)));
    },
  });
}

export class PhaseTimer {
  private readonly totals = new Map<Phase, number>();

  async time<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.totals.set(phase, (this.totals.get(phase) ?? 0) + (Date.now() - started));
    }
  }

  /** `{d1_ms, r2_ms, …}` totals for structured logs. */
  phases(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [phase, ms] of this.totals) out[`${phase}_ms`] = ms;
    return out;
  }
}

/** Request-keyed timers (per-request, never global state). */
const timers = new WeakMap<Request, PhaseTimer>();

export function timerFor(request: Request): PhaseTimer {
  let timer = timers.get(request);
  if (!timer) {
    timer = new PhaseTimer();
    timers.set(request, timer);
  }
  return timer;
}
