import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import type { PipelineJob, PipelineRun, SpecError } from '../../shared/collaboration';
import { ApiError } from '../core/errors';
import { parsePolicy, reservation } from './config';
import { parseContext, type RunContext } from './context';
import { jobGate } from './environments';
import { admitRun } from './runs';
import { runnerInstance, runnerLabels, type Pipeline } from './spec';
import { planErrors, poolFor } from './capacity';
import { stopSelfHosted } from './runners';

/**
 * Pipeline runs (issue #47): a DAG of jobs from one spec file. A job starts as
 * one `ci_runs` row once every job it needs has passed, through the same
 * admission as settings runs, so budget and runner slots stay shared. Jobs
 * the ledger refuses wait and are retried when a run finishes and by the cron
 * sweep. A job whose needs did not pass is skipped. A job with an environment
 * (issue #50) first passes that environment's gate and approval.
 */
const WAIT_LIMIT_MS = 60 * 60_000;
const FAILED = ['failed', 'cancelled', 'timed_out', 'skipped'];

interface RunRow {
  id: string;
  repo_id: string;
  head_cs: string;
  pipeline: string;
  name: string;
  event: PipelineRun['event'];
  ref: string | null;
  concurrency_group: string | null;
  errors: string | null;
  requested_by: string;
  created_at: number;
  cancelled_at: number | null;
  finished_at: number | null;
  context: string | null;
}

interface JobRow {
  pipeline_run_id: string;
  key: string;
  job: string;
  needs: string;
  config: string;
  skipped: string | null;
  run_id: string | null;
  run_state: string | null;
  run_error: string | null;
  run_finished_at: number | null;
  approval_id: string | null;
  approval_state: string | null;
}

export interface StartInput {
  repoId: string;
  head: string;
  path: string;
  pipeline?: Pipeline;
  errors?: SpecError[];
  event: PipelineRun['event'];
  ref: string | null;
  actor: string;
  /** Trigger for secrets, environments and OIDC claims of every job. */
  context: RunContext;
}

/** Record a pipeline run (failed at once when its spec is invalid) and start its first jobs. */
export async function startPipeline(env: Env, input: StartInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  // instance types and timeouts the org's pool does not allow fail at plan time (#52)
  const over = input.pipeline
    ? planErrors(input.pipeline, (await poolFor(env, input.repoId)).limits)
    : [];
  const p = over.length ? undefined : input.pipeline;
  const errors = over.length ? over : input.errors;
  const group = p?.concurrency
    ? p.concurrency.group.replace(/\$\{\{\s*ref\s*\}\}/g, input.ref ?? '')
    : null;
  const name = input.pipeline?.name ?? input.path.slice(input.path.lastIndexOf('/') + 1);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ci_pipeline_runs (id, repo_id, head_cs, pipeline, name, event, ref, concurrency_group, errors, requested_by, created_at, finished_at, context)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      input.repoId,
      input.head,
      input.path,
      name,
      input.event,
      input.ref,
      group,
      errors ? JSON.stringify(errors) : null,
      input.actor,
      now,
      p ? null : now,
      JSON.stringify(input.context),
    ),
    ...(p?.jobs ?? []).map((job, position) =>
      env.DB.prepare(
        'INSERT INTO ci_jobs (pipeline_run_id, key, job, needs, config, position) VALUES (?,?,?,?,?,?)',
      ).bind(
        id,
        job.key,
        job.job,
        JSON.stringify(job.needs),
        JSON.stringify({
          preset: 'custom',
          commands: job.commands,
          timeout_seconds: job.timeout_seconds,
          required_approvals: 0,
          require_checks: false,
          protect_default: false,
          dockerfile: 'Dockerfile',
          image: null,
          services: job.services,
          runs_on: job.runs_on,
          instance_type: job.instance_type,
          env: job.env,
          environment: job.environment,
          secrets: job.secrets,
          permissions: job.permissions,
          aws: job.aws,
        }),
        position,
      ),
    ),
  ]);
  if (!p) return id;
  if (group && p.concurrency?.cancel_in_progress) {
    const older = await q<{ id: string }>(
      env,
      `SELECT id FROM ci_pipeline_runs WHERE repo_id = ? AND concurrency_group = ? AND id != ?
      AND finished_at IS NULL`,
      [input.repoId, group, id],
    );
    for (const o of older)
      await cancelPipeline(env, o.id, `Replaced by a newer run in group ${group}`);
  }
  await advancePipeline(env, id);
  return id;
}

async function jobRows(env: Env, ids: string[]): Promise<JobRow[]> {
  if (ids.length === 0) return [];
  return q<JobRow>(
    env,
    `SELECT j.*, r.id AS run_id, r.state AS run_state, r.error AS run_error, r.finished_at AS run_finished_at,
      a.id AS approval_id, a.state AS approval_state
    FROM ci_jobs j LEFT JOIN ci_runs r ON r.pipeline_run_id = j.pipeline_run_id AND r.job_key = j.key
    LEFT JOIN environment_approvals a ON a.pipeline_run_id = j.pipeline_run_id AND a.job_key = j.key
    WHERE j.pipeline_run_id IN (${ids.map(() => '?').join(',')}) ORDER BY j.position`,
    ids,
  );
}

function jobView(row: JobRow): PipelineJob {
  return {
    key: row.key,
    job: row.job,
    needs: JSON.parse(row.needs) as string[],
    state: row.run_state ?? (row.skipped ? 'skipped' : 'waiting'),
    run_id: row.run_id,
    error: row.run_error ?? row.skipped,
    environment: parsePolicy(JSON.parse(row.config)).environment,
    approval: row.approval_id
      ? { id: row.approval_id, state: row.approval_state! }
      : null,
  };
}

function runState(row: RunRow, jobs: PipelineJob[]): string {
  if (row.errors) return 'failed';
  if (jobs.some((j) => ['waiting', 'queued', 'running'].includes(j.state)))
    return row.cancelled_at ? 'cancelled' : 'running';
  if (jobs.every((j) => j.state === 'passed')) return 'passed';
  return row.cancelled_at ? 'cancelled' : 'failed';
}

/** Start every job whose needs have passed; skip jobs that can no longer run. */
export async function advancePipeline(env: Env, id: string): Promise<void> {
  const row = await q1<RunRow>(env, 'SELECT * FROM ci_pipeline_runs WHERE id = ?', [id]);
  if (!row || row.finished_at) return;
  // Without cancel_in_progress, a group runs one pipeline at a time, oldest first.
  const blocked =
    row.concurrency_group !== null &&
    (await q1(
      env,
      `SELECT 1 FROM ci_pipeline_runs WHERE repo_id = ? AND concurrency_group = ?
      AND finished_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) LIMIT 1`,
      [row.repo_id, row.concurrency_group, row.created_at, row.created_at, row.id],
    )) !== null;
  let full = blocked;
  const context = parseContext(row.context);
  for (let changed = true; changed;) {
    changed = false;
    const rows = await jobRows(env, [id]);
    const jobs = rows.map(jobView);
    for (const [i, job] of jobs.entries()) {
      if (job.state !== 'waiting') continue;
      const needs = jobs.filter((j) => job.needs.includes(j.job));
      let skip: string | null = null;
      if (needs.some((j) => FAILED.includes(j.state))) skip = 'A needed job did not pass';
      else if (!needs.every((j) => j.state === 'passed')) continue;
      const config = rows[i]!.config;
      const environment = skip ? null : job.environment;
      // The environment gate comes first, so reviewers are asked while runners are busy.
      const gate = environment
        ? await jobGate(env, row, job.key, environment, context)
        : { approval: null };
      if ('wait' in gate) continue;
      if ('skip' in gate) skip = gate.skip;
      if (!skip && full) {
        // The wait counts from when the job became ready (or approved), not from the pipeline start.
        const ready = Math.max(
          row.created_at,
          ('approval' in gate && gate.approval?.decided_at) || 0,
          ('approval' in gate && gate.approval?.not_before) || 0,
          ...rows
            .filter((r) => job.needs.includes(r.job))
            .map((r) => r.run_finished_at ?? 0),
        );
        if (Date.now() - ready > WAIT_LIMIT_MS)
          skip = 'Waited over an hour for runner capacity or budget';
      } else if (!skip) {
        const approval = 'approval' in gate ? gate.approval : null;
        // single use: the approval is claimed before its run exists
        if (
          approval &&
          !(
            await env.DB.prepare(
              "UPDATE environment_approvals SET state = 'dispatched' WHERE id = ? AND state IN ('approved','dispatched') AND run_id IS NULL",
            )
              .bind(approval.id)
              .run()
          ).meta.changes
        )
          continue;
        try {
          const runsOn = runnerLabels(config);
          const started = await admitRun(
            env,
            {
              repoId: row.repo_id,
              head: row.head_cs,
              settingsVersion: 0,
              config,
              actor: row.requested_by,
              publish: false,
              // self-hosted runners cost the Cloudflare budget nothing
              reserved: runsOn
                ? 0
                : reservation(parsePolicy(JSON.parse(config)), runnerInstance(config)),
              runsOn,
              pipelineRunId: id,
              jobKey: job.key,
              context: context && { ...context, approval_id: approval?.id ?? null },
            },
            {
              sql: `NOT EXISTS (SELECT 1 FROM ci_runs WHERE pipeline_run_id = ? AND job_key = ?)
              AND EXISTS (SELECT 1 FROM ci_jobs WHERE pipeline_run_id = ? AND key = ? AND skipped IS NULL)`,
              binds: [id, job.key, id, job.key],
            },
          );
          if (approval)
            await run(
              env,
              started
                ? 'UPDATE environment_approvals SET run_id = ? WHERE id = ?'
                : "UPDATE environment_approvals SET state = 'approved' WHERE id = ? AND run_id IS NULL",
              started ? [started, approval.id] : [approval.id],
            );
          if (started) changed = true;
          else full = true;
        } catch (err) {
          // admitRun marked the run failed; its dependants are skipped next pass.
          if (!(err instanceof ApiError)) throw err;
          if (approval)
            await run(
              env,
              "UPDATE environment_approvals SET state = 'failed' WHERE id = ?",
              [approval.id],
            );
          changed = true;
        }
      }
      if (skip) {
        await run(
          env,
          'UPDATE ci_jobs SET skipped = ? WHERE pipeline_run_id = ? AND key = ? AND skipped IS NULL',
          [skip, id, job.key],
        );
        changed = true;
      }
    }
    if (!changed && !jobs.some((j) => ['waiting', 'queued', 'running'].includes(j.state)))
      await run(
        env,
        'UPDATE ci_pipeline_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL',
        [Date.now(), id],
      );
  }
}

/**
 * Advance unfinished pipeline runs after any run ends and from cron. Fair
 * share (issue #52): pools take turns (`capacity.ts` poolFor), so runs
 * waiting on one full pool cannot crowd another pool out of the window;
 * within a pool, repos with the fewest queued or running jobs go first, then
 * the oldest run, so one busy repo cannot hold the next free slot.
 */
export async function advancePipelines(env: Env): Promise<void> {
  const active = await q<{ id: string }>(
    env,
    `SELECT id FROM (
       SELECT id, busy, created_at,
         ROW_NUMBER() OVER (PARTITION BY pool ORDER BY busy, created_at) AS turn
       FROM (
         SELECT p.id, p.created_at, COALESCE(l.org_id, 'shared') AS pool,
           (SELECT COUNT(*) FROM ci_runs r WHERE r.repo_id = p.repo_id
             AND r.state IN ('queued','running')) AS busy
         FROM ci_pipeline_runs p
         LEFT JOIN repos o ON o.id = p.repo_id AND o.owner_kind = 'org'
         LEFT JOIN org_ci_limits l ON l.org_id = o.owner_id
         WHERE p.finished_at IS NULL))
     ORDER BY turn, busy, created_at LIMIT 20`,
  );
  for (const { id } of active) await advancePipeline(env, id);
}

/** Skip jobs not yet started and stop started ones. */
export async function cancelPipeline(
  env: Env,
  id: string,
  reason: string,
): Promise<void> {
  await run(
    env,
    'UPDATE ci_pipeline_runs SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL',
    [Date.now(), id],
  );
  await run(
    env,
    "UPDATE environment_approvals SET state = 'expired' WHERE pipeline_run_id = ? AND state IN ('pending','approved')",
    [id],
  );
  await run(
    env,
    `UPDATE ci_jobs SET skipped = ? WHERE pipeline_run_id = ? AND skipped IS NULL
    AND NOT EXISTS (SELECT 1 FROM ci_runs r WHERE r.pipeline_run_id = ci_jobs.pipeline_run_id AND r.job_key = ci_jobs.key)`,
    [reason, id],
  );
  const started = await q<{ id: string }>(
    env,
    "SELECT id FROM ci_runs WHERE pipeline_run_id = ? AND state IN ('queued','running')",
    [id],
  );
  for (const job of started) {
    if (await stopSelfHosted(env, job.id)) continue;
    if (env.CI_RUNNER) {
      try {
        await env.CI_RUNNER.get(env.CI_RUNNER.idFromName(job.id)).fetch(
          'https://runner/cancel',
          { method: 'POST', body: JSON.stringify({ run_id: job.id }) },
        );
      } catch {
        console.warn(
          'CI pipeline cancel: runner did not confirm; the deadline still applies',
        );
      }
    } else
      await run(
        env,
        "UPDATE ci_runs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'",
        [Date.now(), job.id],
      );
  }
  await advancePipeline(env, id);
}

/** Pipeline runs with their jobs, newest first. */
export async function listPipelineRuns(
  env: Env,
  repoId: string,
  head?: string,
): Promise<PipelineRun[]> {
  const rows = await q<RunRow>(
    env,
    `SELECT * FROM ci_pipeline_runs WHERE repo_id = ? ${head ? 'AND head_cs = ?' : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    head ? [repoId, head] : [repoId],
  );
  const jobs = await jobRows(
    env,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const mine = jobs.filter((j) => j.pipeline_run_id === row.id).map(jobView);
    return {
      id: row.id,
      pipeline: row.pipeline,
      name: row.name,
      event: row.event,
      ref: row.ref,
      head_cs: row.head_cs,
      concurrency_group: row.concurrency_group,
      state: runState(row, mine),
      errors: row.errors ? (JSON.parse(row.errors) as SpecError[]) : null,
      requested_by: row.requested_by,
      created_at: row.created_at,
      finished_at: row.finished_at,
      jobs: mine,
    };
  });
}

/**
 * Merge gate for v2 pipelines: the latest run of every pipeline file at this
 * revision must pass. `count` lets a merge detect a run started after the gate.
 */
export async function pipelineGate(
  env: Env,
  repoId: string,
  head: string,
): Promise<{ count: number; reasons: string[] }> {
  const runs = await listPipelineRuns(env, repoId, head);
  const latest = new Map<string, PipelineRun>();
  for (const r of runs) if (!latest.has(r.pipeline)) latest.set(r.pipeline, r);
  const reasons: string[] = [];
  for (const r of latest.values()) {
    if (r.errors) reasons.push(`Fix the errors in ${r.pipeline}.`);
    else if (r.state !== 'passed')
      reasons.push(`Pipeline ${r.name} must pass for this revision.`);
  }
  const total = await q1<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM ci_pipeline_runs WHERE repo_id = ? AND head_cs = ?',
    [repoId, head],
  );
  return { count: total?.n ?? 0, reasons };
}
