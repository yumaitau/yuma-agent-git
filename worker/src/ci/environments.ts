import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import type { RepoRecord } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { can, USER_TEAMS_CTE } from '../auth/rbac';
import { appendAudit } from '../audit/record';
import { settings, type CiPolicy, type CiRun } from './config';
import { parseContext, type RunContext } from './context';
import { enqueueRun } from './runs';
import { emitEvent } from '../webhooks/events';

/**
 * Deployment environments (issue #50). A pipeline that names an environment
 * gets that environment's secrets only after its protection rules pass:
 *   - allowed_branches: glob patterns (`main`, `release/*`, `refs/tags/v*`)
 *   - humans_only: runs started by bearer tokens (agents) are refused
 *   - reviewers: a listed person or team member, never the requester, approves
 *   - wait_timer_minutes: the run starts no earlier than this after the request
 * A run waiting on a reviewer or timer is an `environment_approvals` row; the
 * `ci_runs` row is created when it is dispatched. A v2 pipeline job with an
 * `environment` is gated the same way before it starts (`jobGate`); the
 * planner, not `dispatchApprovals`, starts it once approved.
 */
export const rulesSchema = z.object({
  reviewers: z
    .array(
      z.object({
        type: z.enum(['user', 'team']),
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(100),
      }),
    )
    .max(6)
    .default([]),
  wait_timer_minutes: z.number().int().min(0).max(43_200).default(0),
  allowed_branches: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  humans_only: z.boolean().default(false),
});
export type EnvironmentRules = z.infer<typeof rulesSchema>;
export const APPROVAL_TTL_MS = 7 * 86_400_000;

export interface ApprovalRow {
  id: string;
  repo_id: string;
  environment: string;
  head_cs: string;
  publish: number;
  context: string;
  requested_by: string;
  state: 'pending' | 'approved' | 'rejected' | 'dispatched' | 'expired' | 'failed';
  not_before: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  comment: string | null;
  run_id: string | null;
  created_at: number;
  pipeline_run_id: string | null;
  job_key: string | null;
}

export async function environmentRules(
  env: Env,
  repoId: string,
  name: string,
): Promise<EnvironmentRules> {
  const row = await q1<{ rules: string }>(
    env,
    'SELECT rules FROM environments WHERE repo_id = ? AND name = ?',
    [repoId, name],
  );
  // an environment nobody configured has no protection, like GitHub's
  return rulesSchema.parse(row ? JSON.parse(row.rules) : {});
}

function globRe(glob: string): RegExp {
  const source = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Branch globs match `refs/heads/<name>`; patterns starting `refs/` match the full ref. */
export function refAllowed(patterns: readonly string[], ref: string | null): boolean {
  if (patterns.length === 0) return true;
  if (!ref) return false;
  return patterns.some((p) =>
    p.startsWith('refs/')
      ? globRe(p).test(ref)
      : ref.startsWith('refs/heads/') && globRe(p).test(ref.slice('refs/heads/'.length)),
  );
}

/** Why the rules refuse this trigger outright, or null. */
function ruleDenial(
  rules: EnvironmentRules,
  context: RunContext,
): { code: string; message: string } | null {
  if (context.fork)
    return {
      code: 'environment_untrusted_trigger',
      message: 'Pull requests from forks cannot deploy to an environment.',
    };
  if (rules.humans_only && context.actor_kind !== 'human')
    return {
      code: 'environment_humans_only',
      message: 'This environment only accepts runs started by a signed-in person.',
    };
  if (!refAllowed(rules.allowed_branches, context.ref))
    return {
      code: 'environment_branch_not_allowed',
      message: 'This branch or tag may not deploy to the environment.',
    };
  return null;
}

function needsApproval(rules: EnvironmentRules): boolean {
  return rules.reviewers.length > 0 || rules.wait_timer_minutes > 0;
}

/**
 * Start a run, or park it behind its environment's reviewers and wait timer.
 * Throws 403 when the environment refuses the trigger.
 */
export async function requestRun(
  env: Env,
  repo: RepoRecord,
  head: string,
  actor: string,
  publish: boolean,
  context: RunContext,
): Promise<
  { run: CiRun; approval?: undefined } | { approval: ApprovalRow; run?: undefined }
> {
  const name = (await settings(env, repo.id))?.policy.environment ?? null;
  if (name) {
    const rules = await environmentRules(env, repo.id, name);
    const denied = ruleDenial(rules, context);
    if (denied) throw new ApiError(403, denied.code, denied.message);
    if (needsApproval(rules)) {
      if (env.CI_ENABLED !== 'true' || !env.CI_QUEUE || !env.CI_RUNNER)
        throw new ApiError(503, 'ci_not_enabled', 'CI execution is not enabled.');
      const now = Date.now();
      const id = crypto.randomUUID();
      await run(
        env,
        `INSERT INTO environment_approvals
         (id, repo_id, environment, head_cs, publish, context, requested_by, state, not_before, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repo.id,
          name,
          head,
          publish ? 1 : 0,
          JSON.stringify(context),
          actor,
          rules.reviewers.length > 0 ? 'pending' : 'approved',
          now + rules.wait_timer_minutes * 60_000,
          now + rules.wait_timer_minutes * 60_000 + APPROVAL_TTL_MS,
          now,
        ],
      );
      const approval = (await approvalById(env, repo.id, id))!;
      await emitApproval(env, repo, approval, rules);
      return { approval };
    }
  }
  return { run: await enqueueRun(env, repo.id, head, actor, publish, context) };
}

/** The `environment_approval` event (#44): a run waits for the environment's reviewers. */
async function emitApproval(
  env: Env,
  repo: RepoRecord,
  row: ApprovalRow,
  rules: EnvironmentRules,
): Promise<void> {
  if (row.state !== 'pending') return;
  await emitEvent(env, repo, {
    event: 'environment_approval',
    action: 'requested',
    actor: { kind: 'user', id: row.requested_by },
    origin: parseContext(row.context)?.origin ?? null,
    data: {
      approval: {
        id: row.id,
        environment: row.environment,
        head_cs: row.head_cs,
        requested_by: row.requested_by,
        pipeline_run_id: row.pipeline_run_id,
        job_key: row.job_key,
        created_at: row.created_at,
      },
      reviewers: rules.reviewers.map((r) => ({ type: r.type, id: r.id })),
    },
  });
}

export function approvalById(
  env: Env,
  repoId: string,
  id: string,
): Promise<ApprovalRow | null> {
  return q1<ApprovalRow>(
    env,
    'SELECT * FROM environment_approvals WHERE id = ? AND repo_id = ?',
    [id, repoId],
  );
}

async function isReviewer(
  env: Env,
  rules: EnvironmentRules,
  userId: string,
): Promise<boolean> {
  if (rules.reviewers.some((r) => r.type === 'user' && r.id === userId)) return true;
  const teams = rules.reviewers.filter((r) => r.type === 'team').map((r) => r.id);
  if (teams.length === 0) return false;
  const row = await q1(
    env,
    `WITH RECURSIVE ${USER_TEAMS_CTE}
     SELECT 1 FROM user_teams WHERE team_id IN (${teams.map(() => '?').join(',')}) LIMIT 1`,
    [userId, ...teams],
  );
  return row !== null;
}

/** Approve or reject a pending run as `userId`. Approval dispatches it when due. */
export async function decideApproval(
  env: Env,
  repoId: string,
  id: string,
  userId: string,
  decision: 'approve' | 'reject',
  comment: string,
): Promise<ApprovalRow> {
  const row = await approvalById(env, repoId, id);
  if (!row) throw new ApiError(404, 'approval_not_found', 'Approval request not found');
  if (row.state !== 'pending' || row.expires_at <= Date.now())
    throw new ApiError(409, 'approval_not_pending', 'This request is no longer waiting.');
  if (row.requested_by === userId)
    throw new ApiError(
      403,
      'self_review_forbidden',
      'The person or agent that started a run cannot approve it.',
    );
  const rules = await environmentRules(env, repoId, row.environment);
  if (!(await isReviewer(env, rules, userId)))
    throw new ApiError(
      403,
      'not_a_reviewer',
      'Only the environment reviewers can approve this run.',
    );
  const updated = await env.DB.prepare(
    `UPDATE environment_approvals SET state = ?, decided_by = ?, decided_at = ?, comment = ?
     WHERE id = ? AND state = 'pending'`,
  )
    .bind(
      decision === 'approve' ? 'approved' : 'rejected',
      userId,
      Date.now(),
      comment,
      id,
    )
    .run();
  if (!updated.meta.changes)
    throw new ApiError(409, 'approval_not_pending', 'This request is no longer waiting.');
  if (decision === 'approve') await dispatchApprovals(env, id);
  return (await approvalById(env, repoId, id))!;
}

/**
 * Expire stale requests and dispatch approved ones whose wait timer elapsed
 * (cron, and right after an approval). Each row is claimed before it runs.
 */
export async function dispatchApprovals(env: Env, onlyId?: string): Promise<void> {
  const now = Date.now();
  await run(
    env,
    "UPDATE environment_approvals SET state = 'expired' WHERE state IN ('pending','approved') AND expires_at < ?",
    [now],
  );
  const due = await q<ApprovalRow>(
    env,
    `SELECT * FROM environment_approvals WHERE state = 'approved' AND not_before <= ?
     AND pipeline_run_id IS NULL
     ${onlyId ? 'AND id = ?' : ''} ORDER BY not_before LIMIT 5`,
    onlyId ? [now, onlyId] : [now],
  );
  for (const row of due) {
    const claimed = await env.DB.prepare(
      "UPDATE environment_approvals SET state = 'dispatched' WHERE id = ? AND state = 'approved'",
    )
      .bind(row.id)
      .run();
    if (!claimed.meta.changes) continue;
    const context = parseContext(row.context);
    const config = await settings(env, row.repo_id);
    let state: ApprovalRow['state'] = 'failed';
    let runId: string | null = null;
    try {
      // the pipeline must still deploy to the environment that was approved
      if (context && config?.policy.environment === row.environment) {
        const job = await enqueueRun(
          env,
          row.repo_id,
          row.head_cs,
          row.requested_by,
          row.publish === 1,
          { ...context, approval_id: row.id },
        );
        state = 'dispatched';
        runId = job.id;
        const repo = await getRepo(env, row.repo_id);
        await appendAudit(env, {
          action: 'ci.run.create',
          repo: repo ? { id: repo.id, slug: repo.slug } : null,
          actor: {
            kind: 'system',
            id: 'environment-approval',
            onBehalfOf: row.requested_by,
          },
          target: {
            run_id: job.id,
            head_cs: row.head_cs,
            environment: row.environment,
            approval_id: row.id,
          },
        });
      }
    } catch (err) {
      // capacity and outages are retried by the next cron sweep
      if (err instanceof ApiError && (err.status === 429 || err.status === 503))
        state = 'approved';
    }
    await run(
      env,
      'UPDATE environment_approvals SET state = ?, run_id = ? WHERE id = ?',
      [state, runId, row.id],
    );
  }
}

/**
 * The environment gate for a v2 pipeline job whose needs have passed. The
 * first call opens its approval request; the job may start (`approval`) once
 * reviewers approve and the wait timer is due, and is skipped when the rules
 * refuse its trigger or the request is rejected or expires.
 */
export async function jobGate(
  env: Env,
  pipeline: { id: string; repo_id: string; head_cs: string; requested_by: string },
  jobKey: string,
  name: string,
  context: RunContext | null,
): Promise<{ skip: string } | { wait: true } | { approval: ApprovalRow | null }> {
  // a run without a trigger context starts but gets no credentials (jobTrust)
  if (!context) return { approval: null };
  const rules = await environmentRules(env, pipeline.repo_id, name);
  const denied = ruleDenial(rules, context);
  if (denied) return { skip: denied.message };
  if (!needsApproval(rules)) return { approval: null };
  const now = Date.now();
  const row = await q1<ApprovalRow>(
    env,
    'SELECT * FROM environment_approvals WHERE pipeline_run_id = ? AND job_key = ?',
    [pipeline.id, jobKey],
  );
  if (!row) {
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO environment_approvals
       (id, repo_id, environment, head_cs, publish, context, requested_by, state, not_before, expires_at, created_at, pipeline_run_id, job_key)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        pipeline.repo_id,
        name,
        pipeline.head_cs,
        JSON.stringify(context),
        pipeline.requested_by,
        rules.reviewers.length > 0 ? 'pending' : 'approved',
        now + rules.wait_timer_minutes * 60_000,
        now + rules.wait_timer_minutes * 60_000 + APPROVAL_TTL_MS,
        now,
        pipeline.id,
        jobKey,
      )
      .run();
    const repo = inserted.meta.changes ? await getRepo(env, pipeline.repo_id) : null;
    const created = repo && (await approvalById(env, repo.id, id));
    if (repo && created) await emitApproval(env, repo, created, rules);
    return { wait: true };
  }
  if (row.state === 'rejected') return { skip: `Deployment to ${name} was rejected` };
  if (
    row.state === 'expired' ||
    row.state === 'failed' ||
    (['pending', 'approved'].includes(row.state) && row.expires_at < now)
  )
    return { skip: `The approval request for ${name} expired` };
  if (row.state === 'pending' || row.not_before > now || row.run_id)
    return { wait: true };
  return { approval: row };
}

/**
 * Whether a run may receive secrets, variables and OIDC tokens. Fails closed:
 * forks, pull requests from authors without write, runs without a trigger
 * context, and environment runs that skipped their gate get nothing.
 */
export async function jobTrust(
  env: Env,
  job: CiRun,
  policy: CiPolicy,
  context: RunContext | null,
): Promise<{ ok: boolean; reason: string }> {
  const deny = (reason: string): { ok: boolean; reason: string } => ({
    ok: false,
    reason,
  });
  if (!context) return deny('the run has no trigger context');
  if (context.fork) return deny('pull request from a fork');
  if (context.event === 'pull_request') {
    const pull = await q1<{ author_id: string }>(
      env,
      'SELECT author_id FROM pull_requests WHERE id = ? AND repo_id = ?',
      [context.pull_id, job.repo_id],
    );
    const repo = await getRepo(env, job.repo_id);
    const writer =
      pull &&
      repo &&
      (await can(env, repo, { kind: 'user', userId: pull.author_id }, 'write'));
    if (!writer) return deny('the pull request author lacks write access');
  }
  if (policy.environment) {
    const rules = await environmentRules(env, job.repo_id, policy.environment);
    const denied = ruleDenial(rules, context);
    if (denied) return deny(denied.message.replace(/\.$/, '').toLowerCase());
    if (needsApproval(rules)) {
      const approval = context.approval_id
        ? await approvalById(env, job.repo_id, context.approval_id)
        : null;
      // run_id is written just after dispatch; the claim already made it single-use
      if (
        approval?.state !== 'dispatched' ||
        (approval.run_id !== null && approval.run_id !== job.id) ||
        approval.environment !== policy.environment ||
        approval.pipeline_run_id !== (job.pipeline_run_id ?? null) ||
        approval.job_key !== (job.job_key ?? null)
      )
        return deny('the environment approval is missing');
    }
  }
  return { ok: true, reason: '' };
}
