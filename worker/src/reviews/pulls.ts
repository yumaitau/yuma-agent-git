import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { can } from '../auth/rbac';
import { getRepo } from '../db/repos';
import { getRef } from '../db/repos';
import { getChangeset } from '../core/changesets';
import { isAncestorDag } from '../core/ancestry';
import { ApiError } from '../core/errors';
import { settings } from '../ci/config';
import { pipelineGate } from '../ci/planner';
import type { Principal } from '../auth/principal';
import type { RepoRecord } from '../db/client';
import { actorOf } from '../audit/record';
import {
  actorFor,
  evaluate,
  principalSchema,
  recordOutcome,
  rulesetsFor,
  type Outcome,
} from '../policy/rulesets';

import type { Pull, Review } from '../../shared/collaboration';
export type { Pull, Review } from '../../shared/collaboration';
export async function getPull(env: Env, repoId: string, id: number): Promise<Pull> {
  const pull = await q1<Pull>(
    env,
    'SELECT * FROM pull_requests WHERE repo_id = ? AND id = ?',
    [repoId, id],
  );
  if (!pull) throw new ApiError(404, 'pull_not_found', 'Pull request not found');
  return pull;
}
export async function pullGate(
  env: Env,
  pull: Pull,
): Promise<{ mergeable: boolean; reasons: string[] }> {
  const { mergeable, reasons } = await checkMerge(env, pull, null);
  return { mergeable, reasons };
}

interface MergeCheck {
  mergeable: boolean;
  reasons: string[];
  repo: RepoRecord;
  outcome: Outcome;
  /** CI settings version a passing run must match. */
  version: number;
  /** Pipeline runs on this revision; a run started after the gate blocks the merge. */
  pipelineCount: number;
  /** The settings pipeline's latest run is one of the checks. */
  settingsRun: boolean;
}

/**
 * Merge requirements for `actor`: pull request state, then the rulesets on
 * the target branch (#41) with this revision's approvals and CI result.
 * Without an active `pull_request` rule a merge still needs one approval.
 * Pipelines (#47) that ran on this revision add checks. They never replace
 * the settings pipeline, since the pull request's author writes them and only
 * admins set the CI policy; with no CI policy at all they are the checks.
 */
async function checkMerge(
  env: Env,
  pull: Pull,
  actor: Principal | null,
): Promise<MergeCheck> {
  const reasons: string[] = [];
  if (pull.state !== 'open') reasons.push('Open this pull request before merging.');
  const ref = await getRef(env, pull.repo_id, pull.base_ref);
  if (ref?.head !== pull.base_cs)
    reasons.push('The target branch moved. Rebase and update the pull request.');
  const config = await settings(env, pull.repo_id);
  const repo = await getRepo(env, pull.repo_id);
  if (!repo) throw new ApiError(404, 'repo_not_found', 'Repository not found');
  const reviews = await q<Review>(
    env,
    `SELECT * FROM pull_reviews WHERE pull_id = ? AND head_cs = ?
    AND revision = ? AND decision != 'comment' ORDER BY id DESC`,
    [pull.id, pull.head_cs, pull.revision],
  );
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (latest.has(review.author_id) || review.author_id === pull.author_id) continue;
    if (await can(env, repo, { kind: 'user', userId: review.author_id }, 'write'))
      latest.set(review.author_id, review);
  }
  if ([...latest.values()].some((r) => r.decision === 'request_changes'))
    reasons.push('A reviewer requested changes.');
  const approvals = [...latest.values()].filter((r) => r.decision === 'approve').length;
  const version = config?.version ?? 0;
  const pipelines = await pipelineGate(env, pull.repo_id, pull.head_cs);
  const settingsRun = config !== null || pipelines.count === 0;
  const check = !settingsRun
    ? null
    : await q1<{ state: string }>(
        env,
        `SELECT state FROM ci_runs WHERE repo_id = ? AND head_cs = ? AND settings_version = ?
          AND pipeline_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [pull.repo_id, pull.head_cs, version],
      );
  const checksPassed =
    (!settingsRun || check?.state === 'passed') && pipelines.reasons.length === 0;
  const rulesets = await rulesetsFor(env, repo);
  const outcome = evaluate(rulesets, {
    repo,
    actor: await actorFor(env, repo, actor, rulesets),
    ref: {
      name: pull.base_ref,
      kind: 'update',
      fastForward: true,
      merge: { approvals, checksPassed },
    },
  });
  if (outcome.requiredApprovals === null && approvals < 1)
    reasons.push('1 approval required for this revision.');
  reasons.push(...outcome.blocking.map((v) => v.message));
  if (config === null) reasons.push(...pipelines.reasons);
  return {
    mergeable: reasons.length === 0,
    reasons,
    repo,
    outcome,
    version,
    pipelineCount: pipelines.count,
    settingsRun,
  };
}

/** Invoked inside the target ref's DO gate, shared with ordinary ref moves. */
export async function mergePullLocked(
  env: Env,
  repoId: string,
  id: number,
  expectedHead: string,
  actor: Principal | null = null,
  bypassReason: string | null = null,
): Promise<Pull> {
  const pull = await getPull(env, repoId, id);
  if (pull.head_cs !== expectedHead)
    throw new ApiError(
      409,
      'pull_stale',
      'Pull request revision changed. Refresh before merging.',
    );
  const gate = await checkMerge(env, pull, actor);
  if (!gate.mergeable) throw new ApiError(409, 'merge_blocked', gate.reasons.join(' '));
  if (
    !(await getChangeset(env, repoId, pull.head_cs)) ||
    !(await isAncestorDag(env, repoId, pull.base_cs, pull.head_cs))
  ) {
    throw new ApiError(
      409,
      'rebase_required',
      'Rebase the proposed changes onto the target revision before merging.',
    );
  }
  // API mutations for this pull also use this ref DO, so the gate cannot race a new review/head.
  const updated = await env.DB.batch([
    env.DB.prepare(
      `UPDATE refs SET head = ?, updated_at = ? WHERE repo_id = ? AND name = ? AND head = ? AND (? = 0 OR (SELECT state FROM ci_runs WHERE repo_id = ? AND head_cs = ? AND settings_version = ? AND pipeline_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) = 'passed') AND (SELECT COUNT(*) FROM ci_pipeline_runs WHERE repo_id = ? AND head_cs = ?) = ?`,
    ).bind(
      pull.head_cs,
      Date.now(),
      repoId,
      pull.base_ref,
      pull.base_cs,
      gate.outcome.requireChecks && gate.settingsRun ? 1 : 0,
      repoId,
      pull.head_cs,
      gate.version,
      repoId,
      pull.head_cs,
      gate.pipelineCount,
    ),
    env.DB.prepare(
      "UPDATE pull_requests SET state = 'merged', merged_at = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM refs WHERE repo_id = ? AND name = ? AND head = ?)",
    ).bind(Date.now(), Date.now(), id, repoId, pull.base_ref, pull.head_cs),
  ]);
  if (!updated[0].meta.changes)
    throw new ApiError(
      409,
      'merge_blocked',
      'Checks or the target branch changed. Refresh before merging.',
    );
  try {
    await recordOutcome(env, gate.outcome, {
      repo: gate.repo,
      actor: actorOf(actor),
      ref: pull.base_ref,
      via: 'merge',
      reason: bypassReason,
    });
  } catch (err) {
    console.error('merge: ruleset outcome not recorded', err);
  }
  return getPull(env, repoId, id);
}

/** Private DO operation. Public routes resolve RBAC before forwarding. */
export async function mutatePullLocked(
  env: Env,
  action: string,
  input: unknown,
): Promise<unknown> {
  const args = input as {
    repo_id: string;
    id: number;
    actor: string;
    principal?: unknown;
    body: Record<string, unknown>;
  };
  if (
    !args ||
    typeof args.repo_id !== 'string' ||
    !Number.isSafeInteger(args.id) ||
    typeof args.actor !== 'string' ||
    !args.body ||
    typeof args.body !== 'object'
  ) {
    throw new ApiError(400, 'invalid_request', 'Invalid pull request operation');
  }
  const pull = await getPull(env, args.repo_id, args.id);
  const body = args.body;
  if (action === 'merge') {
    if (typeof body.head_cs !== 'string')
      throw new ApiError(400, 'invalid_request', 'Expected head_cs is required');
    if (body.revision !== pull.revision)
      throw new ApiError(
        409,
        'pull_stale',
        'Pull request revision changed. Refresh before merging.',
      );
    const principal = principalSchema
      .nullable()
      .catch(null)
      .parse(args.principal ?? null);
    const reason =
      typeof body.bypass_reason === 'string' ? body.bypass_reason.slice(0, 500) : null;
    return {
      pull: await mergePullLocked(
        env,
        args.repo_id,
        args.id,
        body.head_cs,
        principal,
        reason,
      ),
    };
  }
  if (pull.state === 'merged' || pull.state === 'closed')
    throw new ApiError(409, 'pull_closed', 'This pull request is closed.');
  if (action === 'review') {
    if (body.head_cs !== pull.head_cs || body.revision !== pull.revision)
      throw new ApiError(
        409,
        'pull_stale',
        'Review the current revision before submitting.',
      );
    if (
      !['comment', 'approve', 'request_changes'].includes(String(body.decision)) ||
      typeof body.body !== 'string' ||
      body.body.length > 20000
    )
      throw new ApiError(400, 'invalid_review', 'Invalid review');
    if (body.decision !== 'comment' && args.actor === pull.author_id)
      throw new ApiError(
        403,
        'self_review',
        'Authors cannot approve or block their own pull requests.',
      );
    await run(
      env,
      'INSERT INTO pull_reviews (pull_id,author_id,head_cs,decision,body,created_at,revision) VALUES (?,?,?,?,?,?,?)',
      [
        pull.id,
        args.actor,
        pull.head_cs,
        body.decision,
        body.body,
        Date.now(),
        pull.revision,
      ],
    );
    return { ok: true };
  }
  if (action === 'update') {
    const head = typeof body.head_cs === 'string' ? body.head_cs : pull.head_cs;
    if (!(await getChangeset(env, pull.repo_id, head)))
      throw new ApiError(404, 'changeset_not_found', 'Proposed revision not found');
    const ref = await getRef(env, pull.repo_id, pull.base_ref);
    const state = body.state ?? pull.state;
    if (!['draft', 'open', 'closed'].includes(String(state)))
      throw new ApiError(400, 'invalid_state', 'Choose draft, open, or closed');
    const title = body.title ?? pull.title;
    const description = body.body ?? pull.body;
    if (
      typeof title !== 'string' ||
      title.trim().length < 1 ||
      title.length > 200 ||
      typeof description !== 'string' ||
      description.length > 20000
    )
      throw new ApiError(400, 'invalid_request', 'Invalid title or description');
    const base = body.head_cs ? (ref?.head ?? pull.base_cs) : pull.base_cs;
    if (head === base)
      throw new ApiError(
        409,
        'no_changes',
        'Choose a proposed revision different from the target branch.',
      );
    const revision =
      pull.revision + (head !== pull.head_cs || base !== pull.base_cs ? 1 : 0);
    await run(
      env,
      'UPDATE pull_requests SET title=?, body=?, head_cs=?, base_cs=?, state=?, updated_at=?, revision=? WHERE id=?',
      [title.trim(), description, head, base, state, Date.now(), revision, pull.id],
    );
    return { pull: await getPull(env, pull.repo_id, pull.id) };
  }
  throw new ApiError(404, 'not_found', 'Unknown pull request operation');
}
