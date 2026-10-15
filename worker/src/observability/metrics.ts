import { C, T } from '../db/schema';
import { q, run } from '../db/client';
import type { Env } from '../env';

/**
 * In-memory component metrics (issue #21) — per-invocation counters flushed
 * every 60s by the cron trigger into `component_metrics`, the same table the
 * superfans (#19) read. Latency percentiles use a sorted reservoir (a
 * t-digest-lite: bounded 1000 samples, exact median/MAD over the reservoir).
 */

const RESERVOIR = 1000;

export interface Reservoir {
  samples: number[];
}

export function recordLatency(reservoir: Reservoir, ms: number): void {
  reservoir.samples.push(ms);
  if (reservoir.samples.length > RESERVOIR) {
    // keep a uniform-ish reservoir: drop the oldest half when full
    reservoir.samples = reservoir.samples.filter((_, i) => i % 2 === 1);
  }
}

export function percentiles(samples: number[]): {
  p50: number;
  p99: number;
  count: number;
} {
  if (samples.length === 0) return { p50: 0, p99: 0, count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
  return { p50: at(0.5), p99: at(0.99), count: sorted.length };
}

interface Counters {
  commit: { count: number; latency: Reservoir };
  import: { active: number; failed: number };
  queue: { dispatched: number };
  refs: { attempts: number; stale: number };
  agents: Record<string, number>;
  ai: { tokens: number; turns: number; failures: number };
}

let counters: Counters = fresh();

/** Test seam — counters are process-global, so suites reset before asserting. */
export function resetMetrics(): void {
  counters = fresh();
}

function hasActivity(snapshot: Counters): boolean {
  return (
    snapshot.commit.count > 0 ||
    snapshot.import.active > 0 ||
    snapshot.import.failed > 0 ||
    snapshot.queue.dispatched > 0 ||
    snapshot.refs.attempts > 0 ||
    Object.keys(snapshot.agents).length > 0 ||
    snapshot.ai.turns > 0
  );
}

/**
 * Durable sample for superfans. Request isolates and Durable Objects do not
 * share memory with the cron isolate, so producers write the row themselves;
 * the cron flush still aggregates whatever this isolate has seen.
 */
async function persistSample(
  env: Env,
  component: string,
  value: number,
  now: number = Date.now(),
): Promise<void> {
  try {
    await run(
      env,
      `INSERT INTO ${T.componentMetrics} (${C.componentMetrics.component}, ${C.componentMetrics.ts}, ${C.componentMetrics.json}) VALUES (?, ?, ?)`,
      [component, now, JSON.stringify({ value })],
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'metrics_persist_failed',
        component,
        message: err instanceof Error ? err.message : 'persist failed',
      }),
    );
  }
}

export async function recordCommit(env: Env, ms: number): Promise<void> {
  metrics.commit(ms);
  await persistSample(env, 'commit-path', ms);
}

export async function recordImport(env: Env, status: 'active' | 'failed'): Promise<void> {
  metrics.importJob(status);
  await persistSample(env, 'import-pipeline', status === 'failed' ? 1 : 0);
}

export async function recordQueue(env: Env): Promise<void> {
  metrics.queueDispatch();
  await persistSample(env, 'queues', 1);
}

export async function recordRefMove(env: Env, stale: boolean): Promise<void> {
  metrics.refMove(stale);
  await persistSample(env, 'refs', stale ? 1 : 0);
}

export async function recordAgent(env: Env, status: string): Promise<void> {
  metrics.agentTask(status);
  await persistSample(env, 'agents', 1);
}

export async function recordAi(env: Env, tokens: number, failed = false): Promise<void> {
  metrics.aiTurn(tokens, failed);
  await persistSample(env, 'ai', failed ? 1 : 0);
}

function fresh(): Counters {
  return {
    commit: { count: 0, latency: { samples: [] } },
    import: { active: 0, failed: 0 },
    queue: { dispatched: 0 },
    refs: { attempts: 0, stale: 0 },
    agents: {},
    ai: { tokens: 0, turns: 0, failures: 0 },
  };
}

export const metrics = {
  commit(ms: number): void {
    counters.commit.count++;
    recordLatency(counters.commit.latency, ms);
  },
  importJob(status: 'active' | 'failed'): void {
    if (status === 'active') counters.import.active++;
    else counters.import.failed++;
  },
  queueDispatch(): void {
    counters.queue.dispatched++;
  },
  refMove(stale: boolean): void {
    counters.refs.attempts++;
    if (stale) counters.refs.stale++;
  },
  agentTask(status: string): void {
    counters.agents[status] = (counters.agents[status] ?? 0) + 1;
  },
  aiTurn(tokens: number, failed = false): void {
    counters.ai.turns++;
    counters.ai.tokens += tokens;
    if (failed) counters.ai.failures++;
  },
};

/**
 * Cron handler (`* * * * *`): flush this isolate's in-memory counters into
 * `component_metrics`. Idle flushes write nothing — a zero row every minute
 * would poison the superfan baseline. The swap is synchronous so two flushes
 * in one isolate cannot double-count.
 */
export async function flushMetrics(env: Env, now: number = Date.now()): Promise<void> {
  const snapshot = counters;
  counters = fresh();
  if (!hasActivity(snapshot)) return;

  const commit = percentiles(snapshot.commit.latency.samples);
  const rows: { component: string; value: Record<string, unknown> }[] = [];
  if (snapshot.commit.count > 0) {
    rows.push({
      component: 'commit-path',
      value: {
        value: commit.p50,
        count: snapshot.commit.count,
        p50: commit.p50,
        p99: commit.p99,
      },
    });
  }
  if (snapshot.import.active > 0 || snapshot.import.failed > 0) {
    rows.push({
      component: 'import-pipeline',
      value: {
        value: snapshot.import.failed,
        active: snapshot.import.active,
        failed: snapshot.import.failed,
      },
    });
  }
  if (snapshot.queue.dispatched > 0) {
    rows.push({
      component: 'queues',
      value: {
        value: snapshot.queue.dispatched,
        dispatched: snapshot.queue.dispatched,
      },
    });
  }
  if (snapshot.refs.attempts > 0) {
    rows.push({
      component: 'refs',
      value: {
        value: snapshot.refs.stale,
        attempts: snapshot.refs.attempts,
        stale: snapshot.refs.stale,
      },
    });
  }
  if (Object.keys(snapshot.agents).length > 0) {
    rows.push({
      component: 'agents',
      value: {
        value: Object.values(snapshot.agents).reduce((a, b) => a + b, 0),
        by_status: snapshot.agents,
      },
    });
  }
  if (snapshot.ai.turns > 0) {
    rows.push({
      component: 'ai',
      value: { value: snapshot.ai.failures, ...snapshot.ai },
    });
  }

  for (const row of rows) {
    await run(
      env,
      `INSERT INTO ${T.componentMetrics} (${C.componentMetrics.component}, ${C.componentMetrics.ts}, ${C.componentMetrics.json}) VALUES (?, ?, ?)`,
      [row.component, now, JSON.stringify(row.value)],
    );
  }
}

/** Admin view over recent component rows (admin scope — #14). */
export async function readMetrics(
  env: Env,
  component: string | undefined,
  windowMs: number,
  now: number = Date.now(),
): Promise<{ rows: unknown[] }> {
  const since = now - windowMs;
  const rows = component
    ? await q(
        env,
        `SELECT * FROM ${T.componentMetrics} WHERE ${C.componentMetrics.component} = ? AND ${C.componentMetrics.ts} >= ? ORDER BY ${C.componentMetrics.ts} DESC`,
        [component, since],
      )
    : await q(
        env,
        `SELECT * FROM ${T.componentMetrics} WHERE ${C.componentMetrics.ts} >= ? ORDER BY ${C.componentMetrics.ts} DESC`,
        [since],
      );
  return { rows };
}
