import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q, run } from '../db/client';
import { ulid } from '../core/ids';

/**
 * Superfans (issue #19, architecture §4) — long-lived monitoring agents, one
 * per component (commit path, import pipeline, queues, refs…), reading the
 * telemetry that #21's cron writes and flagging anomalies: the ops practice
 * of keeping "an agent obsessively focused on the health of a single
 * component".
 *
 * Baseline: median + 3×MAD over the last 24h of `component_metrics` rows —
 * pure TS, no stats service. An anomaly opens a freeform investigation task.
 */

export interface SuperfanState {
  component: string;
  intervalMin: number;
  checks: number;
  lastCheck?: number;
  lastFinding?: string;
}

export class SuperfanDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start') {
      const body = (await request.json()) as { component: string; interval_min: number };
      await this.state.storage.put('config', body);
      // alarm loop: check every interval
      await this.state.storage.setAlarm(Date.now() + body.interval_min * 60_000);
      return Response.json({ ok: true, component: body.component });
    }
    if (request.method === 'POST' && url.pathname === '/check') {
      return Response.json(await this.checkNow());
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      return Response.json(((await this.state.storage.get('config')) ?? {}) as object);
    }
    return new Response('not found', { status: 404 });
  }

  /** Alarm tick — same check, rescheduled at the end. */
  async alarm(): Promise<void> {
    await this.checkNow();
    const config = (await this.state.storage.get('config')) as
      { component: string; interval_min: number } | undefined;
    if (config) {
      await this.state.storage.setAlarm(Date.now() + config.interval_min * 60_000);
    }
  }

  /** Evaluate telemetry against the baseline (also the test entry point). */
  async checkNow(): Promise<{ anomalous: boolean; finding?: string }> {
    const config = (await this.state.storage.get('config')) as
      { component: string; interval_min: number } | undefined;
    if (!config) return { anomalous: false };

    const window = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await q(
      this.env,
      `SELECT * FROM ${T.componentMetrics} WHERE ${C.componentMetrics.component} = ? AND ${C.componentMetrics.ts} >= ? ORDER BY ${C.componentMetrics.ts}`,
      [config.component, window],
    );
    const values = rows
      .map(
        (row) => (JSON.parse((row as { json: string }).json) as { value?: number }).value,
      )
      .filter((v): v is number => typeof v === 'number');

    if (values.length >= 5) {
      const baseline = medianMad(values);
      const latest = values[values.length - 1] as number;
      const deviation = Math.abs(latest - baseline.median);
      const anomalous =
        baseline.mad === 0 ? latest !== baseline.median : deviation > 3 * baseline.mad;
      if (anomalous) {
        const finding = `anomaly on ${config.component}: value ${latest} deviates ${deviation.toFixed(2)} from median ${baseline.median} (3×MAD ${baseline.mad.toFixed(2)})`;
        const taskId = ulid();
        const now = Date.now();
        await run(
          this.env,
          `INSERT INTO ${T.superfanFindings} (${C.superfanFindings.id}, ${C.superfanFindings.component}, ${C.superfanFindings.ts}, ${C.superfanFindings.finding}, ${C.superfanFindings.taskId}) VALUES (?, ?, ?, ?, ?)`,
          [ulid(), config.component, now, finding, taskId],
        );
        await run(
          this.env,
          `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
           VALUES (?, (SELECT id FROM ${T.repos} LIMIT 1), 'freeform', ?, 'queued', 'superfan', ?, ?)`,
          [taskId, `Investigate: ${finding}`, now, now],
        );
        await this.env.AGENT_QUEUE.send({ task_id: taskId });
        return { anomalous: true, finding };
      }
    }
    return { anomalous: false };
  }
}

/** Median + 3×MAD baseline (pure TS). */
export function medianMad(values: number[]): { median: number; mad: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const madMid = Math.floor(deviations.length / 2);
  const mad =
    deviations.length % 2 === 0
      ? ((deviations[madMid - 1] as number) + (deviations[madMid] as number)) / 2
      : (deviations[madMid] as number);
  return { median, mad };
}

/** Recording helper for producers (#21's cron writes these). */
export async function recordMetric(
  env: Env,
  component: string,
  value: number,
  now: number = Date.now(),
): Promise<void> {
  await run(
    env,
    `INSERT INTO ${T.componentMetrics} (${C.componentMetrics.component}, ${C.componentMetrics.ts}, ${C.componentMetrics.json}) VALUES (?, ?, ?)`,
    [component, now, JSON.stringify({ value })],
  );
}
