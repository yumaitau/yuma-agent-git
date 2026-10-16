import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv, Principal } from '../auth/principal';
import { q, q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { randomB64url } from '../auth/encoding';
import { errorResponse, readJsonBody } from '../api/errors';
import { appendAudit, type AuditInput } from '../audit/record';
import { commitShas } from '../git/upload-pack';
import { storeArtifact } from './artifacts';
import { parsePolicy, type CiRun } from './config';
import { parseContext } from './context';
import { prepareJob } from './inject';
import { advancePipelines } from './planner';
import { emitCiRun } from './runs';
import { guardAgentAction } from '../policy/guardrails';
import { pauseFor, pauseMessage } from '../policy/pause';
import { labelsSchema, runnerServices } from './spec';

/**
 * Self-hosted runners (issue #48), protocol in docs/runner-protocol.md:
 *
 *   POST /runner/v1/register                       one-time registration token
 *   POST /runner/v1/jobs/claim?wait=<s>            long-poll for a job
 *   POST /runner/v1/jobs/:id/heartbeat             keep the lease; learn of cancellation
 *   POST /runner/v1/jobs/:id/logs?step=<n>         append a log chunk (text/plain)
 *   POST /runner/v1/jobs/:id/steps/:step           report a step result
 *   PUT  /runner/v1/jobs/:id/artifacts/:name       upload an artifact
 *   POST /runner/v1/jobs/:id/complete              report the job result
 *
 * Everything but `register` authenticates with the runner's own credential.
 * A job goes to a runner whose labels include all of its `runs-on` labels, in
 * the runner's org or repo, at most once: the claim is one conditional UPDATE
 * and a lost claim response is never re-queued; the lease expires instead. Jobs
 * from public repos and forks never go to `trusted_only` runners. The built-in
 * Cloudflare pool is the runner `cloudflare` (ci/runner.ts) and claims the
 * same way for jobs without self-hosted labels.
 */
export const REGISTRATION_PREFIX = 'yagreg_';
const CREDENTIAL_PREFIX = 'yagrun_';
const CLONE_PREFIX = 'yagclone_';
export const REGISTRATION_TTL_MS = 60 * 60_000;
export const LEASE_MS = 90_000;
const MAX_WAIT_S = 30;
const POLL_MS = 3_000;
/** A self-hosted job no runner claims within this fails. */
const QUEUE_LIMIT_MS = 60 * 60_000;
/** Per-step cap (the old whole-run cap) and a higher total per run. */
export const MAX_STEP_LOG_BYTES = 512 * 1024;
export const MAX_RUN_LOG_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const LOG_LIMIT_NOTE = '\n[Log limit reached: further output is dropped.]\n';

export interface RunnerRow {
  id: string;
  scope: 'org' | 'repo';
  owner_id: string;
  name: string;
  labels: string;
  capabilities: string;
  ephemeral: number;
  trusted_only: number;
  disabled: number;
  credential_hash: string;
  created_by: string;
  created_at: number;
  last_seen_at: number | null;
}

/** A runner as the API shows it; the credential hash never leaves D1. */
export function runnerView(row: RunnerRow) {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    labels: JSON.parse(row.labels) as string[],
    capabilities: JSON.parse(row.capabilities) as Record<string, string>,
    ephemeral: row.ephemeral === 1,
    trusted_only: row.trusted_only === 1,
    disabled: row.disabled === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

const hash = (raw: string): Promise<string> => sha256Hex(new TextEncoder().encode(raw));

/** Where a runner's audit events chain: its repo, or its org. */
export async function auditScope(
  env: Env,
  scope: 'org' | 'repo',
  ownerId: string,
): Promise<Pick<AuditInput, 'repo' | 'orgId'>> {
  if (scope === 'repo') {
    const repo = await getRepo(env, ownerId);
    return repo ? { repo } : {};
  }
  const org = await q1<{ slug: string }>(env, 'SELECT slug FROM orgs WHERE id = ?', [
    ownerId,
  ]);
  return org ? { orgId: org.slug } : {};
}

/** A one-time registration token for an org or repo, valid for an hour. */
export async function createRegistrationToken(
  env: Env,
  scope: 'org' | 'repo',
  ownerId: string,
  trustedOnly: boolean,
  userId: string,
): Promise<{ token: string; expires_at: number }> {
  const token = `${REGISTRATION_PREFIX}${randomB64url(32)}`;
  const now = Date.now();
  await run(
    env,
    `INSERT INTO runner_registration_tokens (token_hash, scope, owner_id, trusted_only, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      await hash(token),
      scope,
      ownerId,
      trustedOnly ? 1 : 0,
      userId,
      now,
      now + REGISTRATION_TTL_MS,
    ],
  );
  return { token, expires_at: now + REGISTRATION_TTL_MS };
}

/**
 * End a self-hosted run (no-op once it is terminal): revoke its clone and OIDC
 * request tokens, and deregister its runner when that runner was ephemeral.
 */
export async function finishRun(
  env: Env,
  id: string,
  state: 'passed' | 'failed' | 'cancelled' | 'timed_out',
  error: string | null,
): Promise<void> {
  const row = await q1<{ runner_id: string | null; state: string }>(
    env,
    'SELECT runner_id, state FROM ci_runs WHERE id = ?',
    [id],
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_runs SET
        error = CASE WHEN state IN ('queued','running') THEN ? ELSE error END,
        state = CASE WHEN state IN ('queued','running') THEN ? ELSE state END,
        finished_at = COALESCE(finished_at, ?), lease_expires_at = NULL, job_token_hash = NULL
      WHERE id = ?`,
    ).bind(error, state, Date.now(), id),
    env.DB.prepare('DELETE FROM ci_job_tokens WHERE run_id = ?').bind(id),
    // an ephemeral runner takes exactly one job
    env.DB.prepare('DELETE FROM runners WHERE id = ? AND ephemeral = 1').bind(
      row?.runner_id ?? '',
    ),
  ]);
  if (row?.state === 'queued' || row?.state === 'running')
    await emitCiRun(env, id, 'completed');
}

/** Cancel a self-hosted run; false when the run belongs to the built-in pool. */
export async function stopSelfHosted(env: Env, id: string): Promise<boolean> {
  const row = await q1<{ runs_on: string | null }>(
    env,
    'SELECT runs_on FROM ci_runs WHERE id = ?',
    [id],
  );
  if (!row?.runs_on) return false;
  await finishRun(env, id, 'cancelled', null);
  return true;
}

/** Fail running jobs of removed runners; the runner row is already gone. */
export async function failRunnerJobs(env: Env, runnerId: string): Promise<void> {
  const jobs = await q<{ id: string }>(
    env,
    "SELECT id FROM ci_runs WHERE runner_id = ? AND state = 'running'",
    [runnerId],
  );
  for (const job of jobs)
    await finishRun(env, job.id, 'failed', 'The runner was removed');
  if (jobs.length) await advancePipelines(env);
}

/**
 * Cron: fail self-hosted jobs nobody claimed within an hour, and running jobs
 * whose runner stopped heartbeating or that passed their deadline.
 */
export async function sweepRunners(env: Env): Promise<void> {
  const now = Date.now();
  const stale = await q<{ id: string; state: string; deadline: number | null }>(
    env,
    `SELECT id, state, deadline FROM ci_runs WHERE runs_on IS NOT NULL AND (
      (state = 'queued' AND created_at < ?)
      OR (state = 'running' AND (lease_expires_at < ? OR deadline < ?))) LIMIT 50`,
    [now - QUEUE_LIMIT_MS, now, now],
  );
  for (const job of stale) {
    if (job.state === 'queued')
      await finishRun(
        env,
        job.id,
        'failed',
        'No runner with matching labels took this job within an hour',
      );
    else if ((job.deadline ?? 0) < now)
      await finishRun(env, job.id, 'timed_out', 'Run exceeded its time limit');
    else await finishRun(env, job.id, 'failed', 'The runner stopped responding');
  }
  await run(env, 'DELETE FROM runner_registration_tokens WHERE expires_at < ?', [now]);
  if (stale.length) await advancePipelines(env);
}

/**
 * Git smart HTTP (#31) for a running job's clone token: read-only, the one repo
 * its run was admitted for, until the run ends.
 */
export async function resolveCloneToken(
  env: Env,
  raw: string,
): Promise<Principal | null> {
  if (!raw.startsWith(CLONE_PREFIX)) return null;
  const job = await q1<CiRun>(
    env,
    "SELECT * FROM ci_runs WHERE job_token_hash = ? AND state = 'running'",
    [await hash(raw)],
  );
  if (!job?.deadline || job.deadline <= Date.now()) return null;
  return {
    kind: 'token',
    userId: job.requested_by,
    tokenId: `ci-run:${job.id}`,
    scopes: ['repo:read'],
    repoId: job.repo_id,
    ciRunId: job.id,
  };
}

// --- protocol ----------------------------------------------------------------

export const registerSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  labels: labelsSchema.refine(
    (l) => !l.includes('cloudflare'),
    'The cloudflare label belongs to the built-in pool',
  ),
  ephemeral: z.boolean().default(false),
  capabilities: z
    .object({
      os: z.string().max(40),
      arch: z.string().max(40),
      version: z.string().max(40),
    })
    .partial()
    .strict()
    .default({}),
});
export const stepSchema = z.object({
  state: z.enum(['running', 'passed', 'failed', 'skipped']),
  name: z.string().max(100).optional(),
  exit_code: z.number().int().optional(),
});
export const completeSchema = z.object({ result: z.enum(['passed', 'failed']) });
const waitSchema = z.coerce.number().int().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S);
const stepIndex = z.coerce.number().int().min(0).max(63);
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

/**
 * The calling runner, re-read on every request so revocation is immediate. A
 * disabled runner may finish its job but gets no new one.
 */
async function authRunner(c: Context<AppEnv>, claiming = false): Promise<RunnerRow> {
  const header = c.req.header('authorization') ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  const row = raw.startsWith(CREDENTIAL_PREFIX)
    ? await q1<RunnerRow>(c.env, 'SELECT * FROM runners WHERE credential_hash = ?', [
        await hash(raw),
      ])
    : null;
  if (!row)
    throw new ApiError(
      401,
      'invalid_runner_credential',
      'Unknown or revoked runner credential.',
    );
  if (claiming && row.disabled)
    throw new ApiError(403, 'runner_disabled', 'An administrator disabled this runner.');
  await run(c.env, 'UPDATE runners SET last_seen_at = ? WHERE id = ?', [
    Date.now(),
    row.id,
  ]);
  return row;
}

async function runnerJob(env: Env, runner: RunnerRow, id: string): Promise<CiRun> {
  const job = await q1<CiRun>(
    env,
    'SELECT * FROM ci_runs WHERE id = ? AND runner_id = ?',
    [id, runner.id],
  );
  if (!job) throw new ApiError(404, 'job_not_found', 'No such job for this runner.');
  return job;
}

/** Private repo and not a fork pull request; unknown triggers count as untrusted. */
function trusted(job: CiRun & { visibility: string }): boolean {
  return job.visibility === 'private' && parseContext(job.context)?.fork === false;
}

/** One job at a time per runner, and one ever for an ephemeral runner. */
function busy(runner: RunnerRow): string {
  return `runner_id = ? ${runner.ephemeral ? '' : "AND state = 'running'"}`;
}

async function claimNext(env: Env, runner: RunnerRow, origin: string) {
  if (await q1(env, `SELECT 1 FROM ci_runs WHERE ${busy(runner)}`, [runner.id]))
    return null;
  const labels = JSON.parse(runner.labels) as string[];
  // fair share: repos with the fewest running self-hosted jobs first, then oldest
  const candidates = await q<CiRun & { visibility: string }>(
    env,
    `SELECT r.*, p.visibility FROM ci_runs r JOIN repos p ON p.id = r.repo_id
    WHERE r.state = 'queued' AND r.runs_on IS NOT NULL AND ${
      runner.scope === 'repo'
        ? 'r.repo_id = ?'
        : "p.owner_kind = 'org' AND p.owner_id = ?"
    }
    ORDER BY (SELECT COUNT(*) FROM ci_runs x WHERE x.repo_id = r.repo_id
      AND x.state = 'running' AND x.runs_on IS NOT NULL), r.created_at
    LIMIT 50`,
    [runner.owner_id],
  );
  for (const job of candidates) {
    const wants = JSON.parse(job.runs_on!) as string[];
    if (!wants.every((l) => labels.includes(l))) continue;
    if (runner.trusted_only && !trusted(job)) continue;
    const claimed = await claim(env, runner, job, origin);
    if (claimed) return claimed;
  }
  return null;
}

async function claim(env: Env, runner: RunnerRow, job: CiRun, origin: string) {
  const repo = await getRepo(env, job.repo_id);
  let commit: string | undefined;
  try {
    commit = (await commitShas(env, job.repo_id, [job.head_cs])).get(job.head_cs);
  } catch {
    // Git object ids are still being computed; a later poll takes the job
  }
  if (!repo || !commit) return null;
  const policy = parsePolicy(JSON.parse(job.config));
  const context = parseContext(job.context);
  if (context?.agent_id) {
    // agent guardrails (#62): the kill switch ends a job an agent started,
    // and a deploy waits for the policy (held: stays queued until approved)
    const pause = await pauseFor(env, repo);
    if (pause) {
      await finishRun(env, job.id, 'cancelled', pauseMessage(pause));
      await advancePipelines(env);
      return null;
    }
    if (policy.environment) {
      const deploy = {
        run: job.id,
        job: job.job_key ?? null,
        environment: policy.environment,
        head_cs: job.head_cs,
      };
      const agent: Principal = {
        kind: 'agent',
        userId: job.requested_by,
        agentId: context.agent_id,
        jti: `ci-run:${job.id}`,
        taskId: null,
        scopes: [],
        repoIds: [job.repo_id],
      };
      const guard = await guardAgentAction(
        env,
        agent,
        repo,
        { action: 'deploy', ...(context.ref ? { ref: context.ref } : {}) },
        { exact: deploy, summary: deploy },
      );
      if (guard.outcome === 'deny') {
        await finishRun(env, job.id, 'failed', guard.message);
        await advancePipelines(env);
      }
      if (guard.outcome !== 'allow') return null;
    }
  }
  const now = Date.now();
  const deadline = now + policy.timeout_seconds * 1000;
  const token = `${CLONE_PREFIX}${randomB64url(32)}`;
  const claimed = await env.DB.prepare(
    `UPDATE ci_runs SET state = 'running', runner_id = ?, started_at = ?, deadline = ?,
      lease_expires_at = ?, job_token_hash = ?
    WHERE id = ? AND state = 'queued' AND runner_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM ci_runs WHERE ${busy(runner)})`,
  )
    .bind(runner.id, now, deadline, now + LEASE_MS, await hash(token), job.id, runner.id)
    .run();
  if (!claimed.meta.changes) return null;
  let access;
  try {
    access = await prepareJob(
      env,
      { ...job, state: 'running', deadline },
      policy,
      deadline,
    );
  } catch {
    await finishRun(env, job.id, 'failed', 'Job credentials could not be prepared');
    await advancePipelines(env);
    return null;
  }
  await emitCiRun(env, job.id, 'in_progress');
  return {
    id: job.id,
    repo: repo.slug,
    job: job.job_key ?? null,
    head_cs: job.head_cs,
    commit,
    clone: { url: `${origin}/${repo.slug}.git`, token },
    steps: policy.commands,
    services: runnerServices(job.config),
    deadline,
    env: access.env,
    files: access.files,
    mask: [...access.mask, token],
    summary: access.summary,
  };
}

export const runnerRoutes = new Hono<AppEnv>();

runnerRoutes.post('/runner/v1/register', async (c) => {
  try {
    const body = parse(registerSchema, await readJsonBody(c));
    const now = Date.now();
    // single use: the token row is gone whether or not it was still valid
    const grant = await c.env.DB.prepare(
      'DELETE FROM runner_registration_tokens WHERE token_hash = ? RETURNING *',
    )
      .bind(await hash(body.token))
      .first<{
        scope: 'org' | 'repo';
        owner_id: string;
        trusted_only: number;
        created_by: string;
        expires_at: number;
      }>();
    if (!grant || grant.expires_at <= now)
      throw new ApiError(
        401,
        'invalid_registration_token',
        'Unknown, used or expired registration token.',
      );
    const id = crypto.randomUUID();
    const credential = `${CREDENTIAL_PREFIX}${randomB64url(32)}`;
    const labels = [...new Set(body.labels)];
    await run(
      c.env,
      `INSERT INTO runners (id, scope, owner_id, name, labels, capabilities, ephemeral, trusted_only, credential_hash, created_by, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        grant.scope,
        grant.owner_id,
        body.name,
        JSON.stringify(labels),
        JSON.stringify(body.capabilities),
        body.ephemeral ? 1 : 0,
        grant.trusted_only,
        await hash(credential),
        grant.created_by,
        now,
        now,
      ],
    );
    await appendAudit(c.env, {
      action: 'runner.register',
      ...(await auditScope(c.env, grant.scope, grant.owner_id)),
      actor: { kind: 'token', id: `runner:${id}`, onBehalfOf: grant.created_by },
      target: { runner_id: id, name: body.name, labels, ephemeral: body.ephemeral },
    });
    // the credential is shown once; only its hash is kept
    return c.json({ runner: { id, name: body.name, labels }, credential }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.post('/runner/v1/jobs/claim', async (c) => {
  try {
    const wait = parse(waitSchema, c.req.query('wait'));
    const until = Date.now() + wait * 1000;
    const origin = new URL(c.req.url).origin;
    for (;;) {
      // re-authenticated each round: a revoked runner stops within one poll
      const runner = await authRunner(c, true);
      const job = await claimNext(c.env, runner, origin);
      if (job) return c.json({ job });
      if (Date.now() + POLL_MS > until) return c.body(null, 204);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.post('/runner/v1/jobs/:id/heartbeat', async (c) => {
  try {
    const job = await runnerJob(c.env, await authRunner(c), c.req.param('id'));
    if (job.state === 'running')
      await run(
        c.env,
        "UPDATE ci_runs SET lease_expires_at = ? WHERE id = ? AND state = 'running'",
        [Date.now() + LEASE_MS, job.id],
      );
    return c.json({ cancel: job.state !== 'running' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.post('/runner/v1/jobs/:id/logs', async (c) => {
  try {
    const job = await runnerJob(c.env, await authRunner(c), c.req.param('id'));
    const step = parse(stepIndex, c.req.query('step'));
    const chunk = new Uint8Array(await c.req.arrayBuffer());
    if (chunk.byteLength > MAX_CHUNK_BYTES)
      throw new ApiError(
        413,
        'log_chunk_too_large',
        'Send log chunks of 64 KiB at most.',
      );
    if (job.state !== 'running') return c.json({ cancel: true });
    const used = await q1<{ total: number; step: number }>(
      c.env,
      `SELECT COALESCE(SUM(log_bytes), 0) AS total,
        COALESCE(SUM(CASE WHEN step = ? THEN log_bytes END), 0) AS step
      FROM ci_run_steps WHERE run_id = ?`,
      [step, job.id],
    );
    const stepUsed = used?.step ?? 0;
    const totalUsed = used?.total ?? 0;
    const room = Math.max(
      0,
      Math.min(MAX_STEP_LOG_BYTES - stepUsed, MAX_RUN_LOG_BYTES - totalUsed),
    );
    const kept = chunk.subarray(0, Math.min(room, chunk.byteLength));
    // the note goes in once; its extra counted byte marks the step (or run) as over
    const over =
      kept.byteLength < chunk.byteLength &&
      stepUsed <= MAX_STEP_LOG_BYTES &&
      totalUsed <= MAX_RUN_LOG_BYTES;
    const text = new TextDecoder().decode(kept) + (over ? LOG_LIMIT_NOTE : '');
    await run(
      c.env,
      `INSERT INTO ci_run_steps (run_id, step, state, log_bytes, started_at) VALUES (?, ?, 'running', ?, ?)
      ON CONFLICT (run_id, step) DO UPDATE SET log_bytes = log_bytes + excluded.log_bytes`,
      [job.id, step, kept.byteLength + (over ? 1 : 0), Date.now()],
    );
    if (text) {
      // chunks append in order; a runner sends one at a time
      const key = `ci/logs/${job.repo_id}/${job.id}.txt`;
      const previous = await c.env.OBJECTS.get(key);
      await c.env.OBJECTS.put(key, `${previous ? await previous.text() : ''}${text}`, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
      await run(c.env, 'UPDATE ci_runs SET log_key = ? WHERE id = ?', [key, job.id]);
    }
    return c.json({ cancel: false });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.post('/runner/v1/jobs/:id/steps/:step', async (c) => {
  try {
    const job = await runnerJob(c.env, await authRunner(c), c.req.param('id'));
    const step = parse(stepIndex, c.req.param('step'));
    const body = parse(stepSchema, await readJsonBody(c));
    if (step >= parsePolicy(JSON.parse(job.config)).commands.length)
      throw new ApiError(400, 'invalid_step', 'This job has no such step.');
    if (job.state !== 'running') return c.json({ cancel: true });
    const now = Date.now();
    const done = body.state !== 'running';
    await run(
      c.env,
      `INSERT INTO ci_run_steps (run_id, step, name, state, exit_code, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, step) DO UPDATE SET name = COALESCE(excluded.name, name),
        state = excluded.state, exit_code = excluded.exit_code,
        finished_at = excluded.finished_at`,
      [
        job.id,
        step,
        body.name ?? null,
        body.state,
        body.exit_code ?? null,
        now,
        done ? now : null,
      ],
    );
    return c.json({ cancel: false });
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.put('/runner/v1/jobs/:id/artifacts/:name', async (c) => {
  try {
    const job = await runnerJob(c.env, await authRunner(c), c.req.param('id'));
    const name = c.req.param('name');
    if (!ARTIFACT_NAME.test(name))
      throw new ApiError(400, 'invalid_artifact_name', 'Use letters, digits, ., _ or -.');
    if (job.state !== 'running')
      throw new ApiError(409, 'job_not_running', 'The job has ended.');
    const prefix = `ci/artifacts/${job.repo_id}/${job.id}/`;
    const existing = await c.env.OBJECTS.list({ prefix, limit: MAX_ARTIFACTS });
    if (
      existing.objects.length >= MAX_ARTIFACTS &&
      !existing.objects.some((o) => o.key === prefix + name)
    )
      throw new ApiError(
        409,
        'too_many_artifacts',
        `A job keeps ${MAX_ARTIFACTS} artifacts at most.`,
      );
    const body = c.req.raw.body;
    if (!body)
      throw new ApiError(400, 'empty_artifact', 'Send the artifact as the body.');
    try {
      await storeArtifact(c.env.OBJECTS, prefix + name, body, MAX_ARTIFACT_BYTES);
    } catch {
      throw new ApiError(
        413,
        'artifact_rejected',
        'Artifacts must be non-empty and 100 MiB at most.',
      );
    }
    return c.json({ artifact: { name } }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

runnerRoutes.post('/runner/v1/jobs/:id/complete', async (c) => {
  try {
    const job = await runnerJob(c.env, await authRunner(c), c.req.param('id'));
    const body = parse(completeSchema, await readJsonBody(c));
    if (job.state === 'running') {
      // the runner's own error text could hold job output; store a fixed message
      if ((job.deadline ?? 0) <= Date.now())
        await finishRun(c.env, job.id, 'timed_out', 'Run exceeded its time limit');
      else if (body.result === 'passed') await finishRun(c.env, job.id, 'passed', null);
      else await finishRun(c.env, job.id, 'failed', 'A step failed. See the build log.');
      await advancePipelines(c.env);
    }
    const final = await q1<{ state: string }>(
      c.env,
      'SELECT state FROM ci_runs WHERE id = ?',
      [job.id],
    );
    return c.json({ state: final?.state ?? job.state });
  } catch (err) {
    return errorResponse(c, err);
  }
});
