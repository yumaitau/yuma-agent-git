import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, run, type Author } from '../db/client';
import { can } from '../auth/rbac';
import { getRepo } from '../db/repos';
import { getRef } from '../db/repos';
import { getChangeset, type Changeset } from '../core/changesets';
import { dagMergeBases, isAncestorDag } from '../core/ancestry';
import { ApiError, ConflictError } from '../core/errors';
import { mergeCommit, squashCommit } from '../core/merge';
import { rebaseOnto } from '../core/rebase';
import { gitIdentity, USER_EMAIL_DOMAIN } from '../git/identity';
import { settings } from '../ci/config';
import { pipelineGate } from '../ci/planner';
import type { Principal } from '../auth/principal';
import type { RepoRecord } from '../db/client';
import { actorOf } from '../audit/record';
import {
  actorFor,
  enforcePushRules,
  evaluate,
  principalSchema,
  recordOutcome,
  mergeQueueRule,
  rulesetsFor,
  type EvalInput,
  type MergeQueueRule,
  type Outcome,
} from '../policy/rulesets';
import { commitChanges } from '../core/commit';
import { agentKey, changeFacts, enforceAgentAction } from '../policy/guardrails';
import { recordAgentProvenance } from '../auth/agents';
import { USER_TEAMS_CTE } from '../auth/rbac';
import {
  authorKey,
  reanchorThreads,
  reviewCommentInput,
  reviewCommentsInput,
  suggestionChanges,
  threadStatements,
  unresolvedThreads,
} from './threads';

import { MERGE_METHODS, type MergeMethod } from '../../shared/collaboration';
import type { Pull, Review } from '../../shared/collaboration';
export type { Pull, Review } from '../../shared/collaboration';

/** `POST …/pulls/:id/merge` body (#42). */
export const mergePullSchema = z.object({
  head_cs: z.string(),
  revision: z.int(),
  /** Defaults to the repo's default method. */
  method: z.enum(MERGE_METHODS).optional(),
  /** First line of the merge or squash commit (rebase keeps each message). */
  commit_title: z.string().trim().min(1).max(200).optional(),
  commit_message: z.string().max(20000).optional(),
  /** Why a bypass actor merged past a ruleset (audited). */
  bypass_reason: z.string().optional(),
});

/** `POST …/pulls/:id/update-branch` body: bring the target into the pull request. */
export const updateBranchSchema = z.object({
  head_cs: z.string(),
  revision: z.int(),
  method: z.enum(['merge', 'rebase']).default('merge'),
});

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
): Promise<{
  mergeable: boolean;
  reasons: string[];
  methods: MergeMethod[];
  method: MergeMethod;
  /** The target only changes through the merge queue (#43). */
  merge_queue: boolean;
}> {
  const { mergeable, reasons, methods, method, queue } = await checkMerge(
    env,
    pull,
    null,
  );
  return { mergeable, reasons, methods, method, merge_queue: queue !== null };
}

/**
 * Could the merge queue (#43) land this pull request for `actor`: every
 * merge requirement except the queue rule itself, which the queue satisfies.
 */
export async function queueGate(
  env: Env,
  pull: Pull,
  actor: Principal | null,
  method: MergeMethod | null,
): Promise<{
  mergeable: boolean;
  reasons: string[];
  method: MergeMethod;
  queue: MergeQueueRule | null;
}> {
  const {
    mergeable,
    reasons,
    method: chosen,
    queue,
  } = await checkMerge(env, pull, actor, method, true);
  return { mergeable, reasons, method: chosen, queue };
}

interface MergeCheck {
  mergeable: boolean;
  reasons: string[];
  repo: RepoRecord;
  /** Methods the repo and the target's rulesets allow (#42). */
  methods: MergeMethod[];
  /** The method checked: the one asked for, else the repo default when allowed. */
  method: MergeMethod;
  outcome: Outcome;
  /** CI settings version a passing run must match. */
  version: number;
  /** Pipeline runs on this revision; a run started after the gate blocks the merge. */
  pipelineCount: number;
  /** The settings pipeline's latest run is one of the checks. */
  settingsRun: boolean;
  /** The target's merge queue rule (#43), if any. */
  queue: MergeQueueRule | null;
}

/**
 * Merge requirements for `actor`: pull request state, then the rulesets on
 * the target branch (#41) with this revision's approvals and CI result.
 * Without an active `pull_request` rule a merge still needs one approval.
 * Pipelines (#47) that ran on this revision add checks. They never replace
 * the settings pipeline, since the pull request's author writes them and only
 * admins set the CI policy; with no CI policy at all they are the checks.
 * A moved target no longer blocks: the merge builds on its current head (#42).
 */
async function checkMerge(
  env: Env,
  pull: Pull,
  actor: Principal | null,
  method: MergeMethod | null = null,
  queued = false,
): Promise<MergeCheck> {
  const reasons: string[] = [];
  if (pull.state !== 'open') reasons.push('Open this pull request before merging.');
  if (!(await getRef(env, pull.repo_id, pull.base_ref)))
    reasons.push('The target branch no longer exists.');
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
  const evalActor = await actorFor(env, repo, actor, rulesets);
  const unresolved = await unresolvedThreads(env, pull.id);
  const facts = (m: MergeMethod): EvalInput => ({
    repo,
    actor: evalActor,
    ref: {
      name: pull.base_ref,
      kind: 'update',
      fastForward: true,
      queue: queued,
      merge: {
        approvals,
        checksPassed,
        method: m,
        unresolvedThreads: unresolved,
      },
    },
  });
  const methods = (repo.merge_methods ?? [...MERGE_METHODS]).filter(
    (m) => !evaluate(rulesets, facts(m)).blocking.some((v) => v.rule === 'merge_methods'),
  );
  const preferred = repo.default_merge_method ?? 'merge';
  const chosen =
    method ?? (methods.includes(preferred) ? preferred : (methods[0] ?? preferred));
  if (!(repo.merge_methods ?? MERGE_METHODS).includes(chosen))
    reasons.push(`${chosen} merges are turned off for this repository.`);
  const outcome = evaluate(rulesets, facts(chosen));
  if (outcome.requiredApprovals === null && approvals < 1)
    reasons.push('1 approval required for this revision.');
  reasons.push(...outcome.blocking.map((v) => v.message));
  if (config === null) reasons.push(...pipelines.reasons);
  return {
    mergeable: reasons.length === 0,
    reasons,
    repo,
    methods,
    method: chosen,
    outcome,
    version,
    pipelineCount: pipelines.count,
    settingsRun,
    queue: mergeQueueRule(rulesets, repo, pull.base_ref),
  };
}

/** Who a server-made commit is by: the agent, or the user at a no-reply address. */
async function authorFor(env: Env, principal: Principal | null): Promise<Author> {
  if (principal?.kind === 'agent') return { agent: principal.agentId };
  const user =
    principal === null
      ? null
      : await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
          principal.userId,
        ]);
  const login = user?.login ?? 'yuma';
  return { name: login, email: `${login}@${USER_EMAIL_DOMAIN}` };
}

/**
 * The changeset `method` lands on `target` (#42). Merge commits are by the
 * merger, like `git merge --no-ff`; rebased commits keep their authors and
 * the merger commits them; a squash keeps the first author and credits the
 * rest with `Co-authored-by` trailers.
 */
export async function landPull(
  env: Env,
  pull: Pull,
  method: MergeMethod,
  target: Changeset,
  head: Changeset,
  principal: Principal | null,
  body: Pick<z.infer<typeof mergePullSchema>, 'commit_title' | 'commit_message'>,
): Promise<Changeset> {
  const author = await authorFor(env, principal);
  const committer = { ...gitIdentity(author), at: Date.now() };
  if (method === 'rebase')
    return rebaseOnto(env, pull.repo_id, target, head.id, committer);
  const title = body.commit_title;
  if (method === 'merge')
    return mergeCommit(env, pull.repo_id, target, head, {
      author,
      message: `${title ?? `Merge pull request #${pull.number}`}\n\n${body.commit_message ?? pull.title}\n`,
    });
  const { onlyB } = await dagMergeBases(env, pull.repo_id, target.id, head.id);
  const own = onlyB.filter((cs) => cs.parents.length < 2).reverse();
  const ident = (a: Author): string => {
    const id = gitIdentity(a);
    return `${id.name} <${id.email}>`;
  };
  const first = own[0]?.author ?? author;
  const coAuthors = [...new Set(own.map((cs) => ident(cs.author)))].filter(
    (who) => who !== ident(first),
  );
  const message = [
    title ?? `${pull.title} (#${pull.number})`,
    body.commit_message ?? own.map((cs) => `* ${cs.message.split('\n')[0]}`).join('\n'),
    coAuthors.map((who) => `Co-authored-by: ${who}`).join('\n'),
  ].filter((part) => part !== '');
  return squashCommit(env, pull.repo_id, target, head, {
    author: first,
    committer,
    message: `${message.join('\n\n')}\n`,
  });
}

interface PullOp {
  repo_id: string;
  id: number;
  actor: string;
  principal?: unknown;
  body: Record<string, unknown>;
}

function parseOp(input: unknown): PullOp {
  const args = input as PullOp;
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
  return args;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

function principalOf(op: PullOp): Principal | null {
  return principalSchema
    .nullable()
    .catch(null)
    .parse(op.principal ?? null);
}

function assertCurrent(pull: Pull, body: { head_cs: string; revision: number }): void {
  if (body.head_cs !== pull.head_cs || body.revision !== pull.revision)
    throw new ApiError(
      409,
      'pull_stale',
      'Pull request revision changed. Refresh and try again.',
    );
}

/** A merge or branch update built ahead of the ref DO's gate (#42). */
export interface Prepared {
  method: MergeMethod;
  /** The target head the new changesets were built on. */
  target: string;
  /** Where the target moves (merge) or the pull request's new head (update-branch). */
  result: string;
}

/**
 * Build the changesets a merge or branch update needs, before the ref DO's
 * gate: they are immutable and nothing points at them until the gate's CAS,
 * so the tree work stays out of `blockConcurrencyWhile`. Conflicts throw
 * `merge_conflict` and nothing moves. Other actions need no preparation.
 */
export async function preparePull(
  env: Env,
  action: string,
  input: unknown,
): Promise<Prepared | null> {
  if (action !== 'merge' && action !== 'update-branch') return null;
  const op = parseOp(input);
  const pull = await getPull(env, op.repo_id, op.id);
  const principal = principalOf(op);
  const ref = await getRef(env, pull.repo_id, pull.base_ref);
  const target = ref ? await getChangeset(env, pull.repo_id, ref.head) : null;
  const head = await getChangeset(env, pull.repo_id, pull.head_cs);
  if (action === 'merge') {
    const body = parseBody(mergePullSchema, op.body);
    assertCurrent(pull, body);
    const gate = await checkMerge(env, pull, principal, body.method ?? null);
    if (!gate.mergeable) throw new ApiError(409, 'merge_blocked', gate.reasons.join(' '));
    if (!target || !head)
      throw new ApiError(409, 'merge_blocked', 'The proposed revision is missing.');
    const result = await landPull(env, pull, gate.method, target, head, principal, body);
    return { method: gate.method, target: target.id, result: result.id };
  }
  const body = parseBody(updateBranchSchema, op.body);
  if (pull.state === 'merged' || pull.state === 'closed')
    throw new ApiError(409, 'pull_closed', 'This pull request is closed.');
  assertCurrent(pull, body);
  if (!target || !head)
    throw new ApiError(409, 'merge_blocked', 'The target branch no longer exists.');
  if (await isAncestorDag(env, pull.repo_id, target.id, head.id))
    throw new ConflictError(
      'up_to_date',
      'This pull request already has the latest target changes.',
    );
  const author = await authorFor(env, principal);
  const result =
    body.method === 'rebase'
      ? await rebaseOnto(env, pull.repo_id, target, head.id, {
          ...gitIdentity(author),
          at: Date.now(),
        })
      : await mergeCommit(env, pull.repo_id, head, target, {
          author,
          message: `Merge ${pull.base_ref} into pull request #${pull.number}\n`,
        });
  return { method: body.method, target: target.id, result: result.id };
}

/**
 * Invoked inside the target ref's DO gate, shared with ordinary ref moves:
 * re-checks the gate and lands `prepared` only if the target has not moved
 * since it was built (`target_moved` otherwise; the DO prepares again).
 */
export async function mergePullLocked(
  env: Env,
  repoId: string,
  id: number,
  expectedHead: string,
  actor: Principal | null,
  bypassReason: string | null,
  prepared: Prepared,
): Promise<Pull> {
  const pull = await getPull(env, repoId, id);
  if (pull.head_cs !== expectedHead)
    throw new ApiError(
      409,
      'pull_stale',
      'Pull request revision changed. Refresh before merging.',
    );
  const gate = await checkMerge(env, pull, actor, prepared.method);
  if (!gate.mergeable) throw new ApiError(409, 'merge_blocked', gate.reasons.join(' '));
  if ((await getRef(env, repoId, pull.base_ref))?.head !== prepared.target)
    throw new ConflictError(
      'target_moved',
      'The target branch moved while merging. Try again.',
    );
  // API mutations for this pull also use this ref DO, so the gate cannot race a new review/head.
  const updated = await env.DB.batch([
    env.DB.prepare(
      `UPDATE refs SET head = ?, updated_at = ? WHERE repo_id = ? AND name = ? AND head = ? AND (? = 0 OR (SELECT state FROM ci_runs WHERE repo_id = ? AND head_cs = ? AND settings_version = ? AND pipeline_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) = 'passed') AND (SELECT COUNT(*) FROM ci_pipeline_runs WHERE repo_id = ? AND head_cs = ?) = ? AND (? = 0 OR NOT EXISTS (SELECT 1 FROM review_threads WHERE pull_id = ? AND resolved_at IS NULL))`,
    ).bind(
      prepared.result,
      Date.now(),
      repoId,
      pull.base_ref,
      prepared.target,
      gate.outcome.requireChecks && gate.settingsRun ? 1 : 0,
      repoId,
      pull.head_cs,
      gate.version,
      repoId,
      pull.head_cs,
      gate.pipelineCount,
      gate.outcome.requireResolvedThreads ? 1 : 0,
      pull.id,
    ),
    env.DB.prepare(
      "UPDATE pull_requests SET state = 'merged', merged_at = ?, updated_at = ?, base_cs = ?, merge_method = ?, merged_cs = ? WHERE id = ? AND EXISTS (SELECT 1 FROM refs WHERE repo_id = ? AND name = ? AND head = ?)",
    ).bind(
      Date.now(),
      Date.now(),
      prepared.target,
      prepared.method,
      prepared.result,
      id,
      repoId,
      pull.base_ref,
      prepared.result,
    ),
  ]);
  if (!updated[0].meta.changes)
    throw new ApiError(
      409,
      'merge_blocked',
      'Checks, review threads or the target branch changed. Refresh before merging.',
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

/**
 * Private DO operation. Public routes resolve RBAC before forwarding.
 * `merge` and `update-branch` land what `preparePull` built.
 */
export async function mutatePullLocked(
  env: Env,
  action: string,
  input: unknown,
  prepared: Prepared | null = null,
): Promise<unknown> {
  const args = parseOp(input);
  const pull = await getPull(env, args.repo_id, args.id);
  const body = args.body;
  if (action === 'merge' && prepared) {
    const merge = parseBody(mergePullSchema, body);
    if (merge.revision !== pull.revision)
      throw new ApiError(
        409,
        'pull_stale',
        'Pull request revision changed. Refresh before merging.',
      );
    return {
      pull: await mergePullLocked(
        env,
        args.repo_id,
        args.id,
        merge.head_cs,
        principalOf(args),
        merge.bypass_reason?.slice(0, 500) ?? null,
        prepared,
      ),
    };
  }
  if (pull.state === 'merged' || pull.state === 'closed')
    throw new ApiError(409, 'pull_closed', 'This pull request is closed.');
  if (action === 'update-branch' && prepared) {
    assertCurrent(pull, parseBody(updateBranchSchema, body));
    // a new head is a new revision: approvals and checks start again
    await run(
      env,
      'UPDATE pull_requests SET head_cs=?, base_cs=?, revision=?, updated_at=? WHERE id=?',
      [prepared.result, prepared.target, pull.revision + 1, Date.now(), pull.id],
    );
    const updated = await getPull(env, pull.repo_id, pull.id);
    await reanchorThreads(env, updated);
    return { pull: updated };
  }
  const principal = principalSchema
    .nullable()
    .catch(null)
    .parse(args.principal ?? null);
  const author = principal ? authorKey(principal) : `user:${args.actor}`;
  if (action === 'review' || action === 'thread' || action === 'apply_suggestions') {
    if (body.head_cs !== pull.head_cs || body.revision !== pull.revision)
      throw new ApiError(
        409,
        'pull_stale',
        'Review the current revision before submitting.',
      );
  }
  if (action === 'review') {
    const comments = reviewCommentsInput.safeParse(body.comments ?? []);
    if (
      !['comment', 'approve', 'request_changes'].includes(String(body.decision)) ||
      typeof body.body !== 'string' ||
      body.body.length > 20000 ||
      !comments.success
    )
      throw new ApiError(400, 'invalid_review', 'Invalid review');
    if (body.decision !== 'comment' && args.actor === pull.author_id)
      throw new ApiError(
        403,
        'self_review',
        'Authors cannot approve or block their own pull requests.',
      );
    const now = Date.now();
    // A review answers requests for its author and, for people, their teams.
    const teams =
      principal?.kind === 'user'
        ? ` OR principal IN (WITH RECURSIVE ${USER_TEAMS_CTE} SELECT 'team:' || team_id FROM user_teams)`
        : '';
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO pull_reviews (pull_id,author_id,head_cs,decision,body,created_at,revision) VALUES (?,?,?,?,?,?,?)',
      ).bind(
        pull.id,
        args.actor,
        pull.head_cs,
        body.decision,
        body.body,
        now,
        pull.revision,
      ),
      ...(await threadStatements(env, pull, author, comments.data, true)),
      env.DB.prepare(
        `UPDATE review_requests SET state = 'reviewed', updated_at = ?
          WHERE pull_id = ? AND state = 'pending' AND (principal = ?${teams})`,
      ).bind(now, pull.id, author, ...(teams ? [args.actor] : [])),
    ]);
    return { ok: true, comments: comments.data.length };
  }
  if (action === 'thread') {
    const comment = reviewCommentInput.safeParse(body);
    if (!comment.success)
      throw new ApiError(
        400,
        'invalid_request',
        comment.error.issues.map((i) => i.message).join('; '),
      );
    const results = await env.DB.batch(
      await threadStatements(env, pull, author, [comment.data], false),
    );
    return { thread_id: results[0]!.meta.last_row_id };
  }
  if (action === 'apply_suggestions') {
    const ids = body.comment_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 50 ||
      !ids.every((id) => Number.isSafeInteger(id)) ||
      (body.message !== undefined &&
        (typeof body.message !== 'string' ||
          body.message.trim() === '' ||
          body.message.length > 65536))
    )
      throw new ApiError(400, 'invalid_request', 'Name the suggestions to apply');
    if (!principal) throw new ApiError(401, 'unauthorized', 'authentication required');
    const repo = await getRepo(env, pull.repo_id);
    if (!repo) throw new ApiError(404, 'repo_not_found', 'Repository not found');
    const { changes, threadIds } = await suggestionChanges(env, pull, ids as number[]);
    // agent guardrails (#62): a suggestion commit is a changeset like any other
    if (agentKey(principal) !== null) {
      const files = changes.map((ch) => ch.path);
      await enforceAgentAction(
        env,
        principal,
        repo,
        { action: 'changeset.create', ...(await changeFacts(env, repo.id, changes)) },
        {
          exact: { pull: pull.id, first_parent: pull.head_cs, changes },
          summary: { pull: pull.number, first_parent: pull.head_cs, files },
        },
      );
    }
    await enforcePushRules(
      env,
      repo,
      principal,
      actorOf(principal),
      changes,
      'suggestion',
    );
    const result = await commitChanges(env, repo.id, {
      first_parent: pull.head_cs,
      message:
        typeof body.message === 'string'
          ? body.message
          : `Apply suggested change${ids.length === 1 ? '' : 's'} from review`,
      author: await commitAuthor(env, principal),
      changes,
    });
    await recordAgentProvenance(env, repo.id, [result.changeset.id], principal);
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE review_threads SET resolved_by = ?, resolved_at = ?
        WHERE id IN (${threadIds.map(() => '?').join(',')}) AND resolved_at IS NULL`,
    )
      .bind(author, now, ...threadIds)
      .run();
    return {
      pull: await updatePull(env, pull, { head_cs: result.changeset.id }),
      changeset: result.changeset,
    };
  }
  if (action === 'update') return { pull: await updatePull(env, pull, body) };
  throw new ApiError(404, 'not_found', 'Unknown pull request operation');
}

/** Agents commit as themselves; people as their login and a verified email, if any. */
async function commitAuthor(
  env: Env,
  principal: Principal,
): Promise<{ agent: string } | { name: string; email: string }> {
  if (principal.kind === 'agent') return { agent: principal.agentId };
  const user = await q1<{ login: string; email: string | null }>(
    env,
    `SELECT login, (SELECT email FROM user_identities WHERE user_id = users.id
       AND email IS NOT NULL ORDER BY linked_at LIMIT 1) AS email FROM users WHERE id = ?`,
    [principal.userId],
  );
  return { name: user?.login ?? principal.userId, email: user?.email ?? '' };
}

/** Title, description, state or a new head (which rebases onto the target and re-anchors threads). */
async function updatePull(
  env: Env,
  pull: Pull,
  body: Record<string, unknown>,
): Promise<Pull> {
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
  const updated = await getPull(env, pull.repo_id, pull.id);
  if (revision !== pull.revision) await reanchorThreads(env, updated);
  return updated;
}
