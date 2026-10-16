import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../env';
import { q, q1, run, type RepoRecord } from '../db/client';
import { getRef, getRepo } from '../db/repos';
import { getChangeset, type Changeset } from '../core/changesets';
import { commitChanges } from '../core/commit';
import { mergeTrees } from '../core/merge';
import { ApiError } from '../core/errors';
import { getPull, landPull, queueGate } from '../reviews/pulls';
import {
  mergeQueueRule,
  principalSchema,
  rulesetsFor,
  type MergeQueueRule,
} from '../policy/rulesets';
import { cancelPipeline, listPipelineRuns } from '../ci/planner';
import { mergeGroupPipelines, mergeGroupReady, pushPipelines } from '../ci/triggers';
import type { Trigger } from '../ci/context';
import { appendAudit, type AuditActor } from '../audit/record';
import { emitEvent, emitRefUpdate } from '../webhooks/events';
import { workEventStatement } from '../collab/work';
import { linkLanded, linkReferences } from '../collab/references';
import { USER_EMAIL_DOMAIN } from '../git/identity';
import type { Principal } from '../auth/principal';
import { parseReferences } from '../../shared/markdown';
import { MERGE_METHODS, type MergeMethod, type Pull } from '../../shared/collaboration';

/**
 * Merge queue (issue #43): one `MergeQueueDO` per (repo, base ref), so a
 * release branch never waits on `main`. The DO runs one operation at a time;
 * every entry and group lives in D1 and the DO's own storage keeps only its
 * key, the bisection width and its alarm, so a restarted DO carries on.
 *
 * Strict mode takes up to `max_batch` queued pull requests (priority, then
 * position), builds their speculative merge on the base head with the
 * server-side merge (#42), runs the `merge_group` pipelines on it and, when
 * they pass, lands the whole group with one compare-and-swap ref move. A
 * failed group is bisected: the queue retries with half as many entries until
 * a group of one fails, and ejects that pull request with a comment.
 *
 * Optimistic mode lands each group at once and runs the same pipelines after
 * the land; when they fail, the queue commits a revert on the current head and
 * reopens the group's pull requests (the Scion approach).
 */

export const MERGE_QUEUE_ACTOR: AuditActor = { kind: 'system', id: 'merge_queue' };
/** `pull_reviews.author_id` of the comments the queue leaves. */
export const MERGE_QUEUE_AUTHOR = 'merge-queue';
/** How often a busy queue looks at its checks again. */
const POLL_MS = 15_000;
/** How long a queue waiting for CI (off, or out of budget) waits before trying again. */
const WAIT_MS = 5 * 60_000;

const TRIGGER: Trigger = {
  actor: MERGE_QUEUE_AUTHOR,
  actor_kind: 'system',
  origin: null,
  agent_id: null,
};

export interface QueueEntry {
  id: string;
  repo_id: string;
  base_ref: string;
  pull_id: number;
  position: number;
  priority: number;
  state: 'queued' | 'testing' | 'merged' | 'ejected' | 'dequeued';
  group_id: string | null;
  head_cs: string;
  revision: number;
  method: MergeMethod;
  reason: string | null;
  enqueued_by: string;
  principal: string;
  enqueued_at: number;
  updated_at: number;
}

export interface MergeGroupRow {
  id: string;
  repo_id: string;
  base_ref: string;
  mode: 'strict' | 'optimistic';
  base_cs: string;
  head_cs: string;
  pulls: string;
  state: string;
  ci_run_ids: string;
  revert_cs: string | null;
  reason: string | null;
  created_at: number;
  finished_at: number | null;
}

export const queueKeySchema = z.object({
  repo_id: z.string().min(1),
  base_ref: z.string().min(1),
});
export type QueueKey = z.infer<typeof queueKeySchema>;

/** `POST …/pulls/:id/queue` body. */
export const enqueueSchema = z.object({
  head_cs: z.string(),
  revision: z.int(),
  /** Defaults to the repository's default merge method. */
  method: z.enum(MERGE_METHODS).optional(),
  /** Higher lands first; equal priorities keep their order. */
  priority: z.int().min(0).max(10).default(0),
});

const enqueueOp = queueKeySchema.extend({
  pull_id: z.int(),
  body: enqueueSchema,
  principal: principalSchema,
});
const dequeueOp = queueKeySchema.extend({ pull_id: z.int(), reason: z.string() });

/** The Durable Object for one queue; `env.MERGE_QUEUE.idFromName(queueName(...))`. */
export function queueName(repoId: string, baseRef: string): string {
  return `${repoId}:${baseRef}`;
}

export function queueStub(env: Env, repoId: string, baseRef: string): DurableObjectStub {
  return env.MERGE_QUEUE.get(env.MERGE_QUEUE.idFromName(queueName(repoId, baseRef)));
}

/** Where the DO keeps its bisection width between ticks. */
export interface QueueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class MergeQueueDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** One operation at a time: building, landing and bisecting never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      const input: unknown = await request.json();
      const key = queueKeySchema.parse(input);
      await this.state.storage.put('key', key);
      let result: unknown = { ok: true };
      if (path === '/enqueue')
        result = await this.serial(() => enqueue(this.env, enqueueOp.parse(input)));
      else if (path === '/dequeue')
        result = await this.serial(() => dequeue(this.env, dequeueOp.parse(input)));
      else if (path !== '/kick')
        throw new ApiError(404, 'not_found', 'Unknown queue operation');
      await this.tick(key);
      return Response.json(result);
    } catch (err) {
      if (err instanceof ApiError)
        return Response.json(
          { error: { code: err.code, message: err.message, ...err.details } },
          { status: err.status },
        );
      if (err instanceof z.ZodError)
        return Response.json(
          { error: { code: 'invalid_request', message: 'Invalid queue request' } },
          { status: 400 },
        );
      console.error('merge queue operation failed', err);
      return Response.json(
        { error: { code: 'internal_error', message: 'Merge queue operation failed' } },
        { status: 500 },
      );
    }
  }

  async alarm(): Promise<void> {
    const key = await this.state.storage.get<QueueKey>('key');
    if (key) await this.tick(key);
  }

  /** Advance the queue; a busy queue looks again when its alarm fires. */
  private async tick(key: QueueKey): Promise<void> {
    let delay: number | null = POLL_MS;
    try {
      delay = await this.serial(() => processQueue(this.env, this.state.storage, key));
    } catch (err) {
      console.error('merge queue tick failed; the alarm retries', err);
    }
    if (delay !== null && (await this.state.storage.getAlarm()) === null)
      await this.state.storage.setAlarm(Date.now() + delay);
  }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

async function enqueue(
  env: Env,
  op: z.infer<typeof enqueueOp>,
): Promise<{ entry: PublicEntry }> {
  const pull = await getPull(env, op.repo_id, op.pull_id);
  const repo = await getRepo(env, op.repo_id);
  if (!repo || pull.base_ref !== op.base_ref)
    throw new ApiError(404, 'pull_not_found', 'Pull request not found');
  if (pull.state !== 'open')
    throw new ApiError(409, 'pull_closed', 'Only open pull requests can be queued.');
  if (op.body.head_cs !== pull.head_cs || op.body.revision !== pull.revision)
    throw new ApiError(
      409,
      'pull_stale',
      'Pull request revision changed. Refresh and try again.',
    );
  const gate = await queueGate(env, pull, op.principal, op.body.method ?? null);
  if (!gate.queue)
    throw new ApiError(
      409,
      'merge_queue_off',
      `${pull.base_ref} has no merge queue. Add a merge_queue rule to its ruleset.`,
    );
  if (gate.reasons.length > 0)
    throw new ApiError(409, 'merge_blocked', gate.reasons.join(' '));
  if (
    await q1(
      env,
      "SELECT 1 FROM merge_queue_entries WHERE pull_id = ? AND state IN ('queued','testing')",
      [pull.id],
    )
  )
    throw new ApiError(409, 'already_queued', 'This pull request is already queued.');
  const now = Date.now();
  const id = crypto.randomUUID();
  await run(
    env,
    `INSERT INTO merge_queue_entries (id, repo_id, base_ref, pull_id, position, priority, state,
      head_cs, revision, method, enqueued_by, principal, enqueued_at, updated_at)
    VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM merge_queue_entries
      WHERE repo_id = ? AND base_ref = ?), ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      repo.id,
      pull.base_ref,
      pull.id,
      repo.id,
      pull.base_ref,
      op.body.priority,
      pull.head_cs,
      pull.revision,
      gate.method,
      op.principal.userId,
      JSON.stringify(op.principal),
      now,
      now,
    ],
  );
  return { entry: await readEntry(env, id) };
}

/** An entry as the API shows it: without the stored principal. */
export type PublicEntry = Omit<QueueEntry, 'principal'>;

async function readEntry(env: Env, id: string): Promise<PublicEntry> {
  const row = await q1<QueueEntry>(
    env,
    'SELECT * FROM merge_queue_entries WHERE id = ?',
    [id],
  );
  if (!row) throw new ApiError(404, 'not_queued', 'Queue entry not found');
  const { principal: _, ...entry } = row;
  return entry;
}

async function dequeue(
  env: Env,
  op: z.infer<typeof dequeueOp>,
): Promise<{ entry: PublicEntry }> {
  const entry = await q1<QueueEntry>(
    env,
    `SELECT * FROM merge_queue_entries WHERE repo_id = ? AND base_ref = ? AND pull_id = ?
      AND state IN ('queued','testing')`,
    [op.repo_id, op.base_ref, op.pull_id],
  );
  if (!entry) throw new ApiError(404, 'not_queued', 'This pull request is not queued.');
  if (entry.group_id) {
    const group = await q1<MergeGroupRow>(
      env,
      'SELECT * FROM merge_groups WHERE id = ?',
      [entry.group_id],
    );
    if (group && group.state !== 'testing')
      throw new ApiError(409, 'already_landing', 'This pull request is landing now.');
    if (group) await cancelGroup(env, group, 'A pull request left the merge group.');
  }
  await setEntry(env, entry.id, 'dequeued', op.reason);
  return { entry: await readEntry(env, entry.id) };
}

async function setEntry(
  env: Env,
  id: string,
  state: QueueEntry['state'],
  reason: string | null = null,
): Promise<void> {
  await run(
    env,
    `UPDATE merge_queue_entries SET state = ?, reason = COALESCE(?, reason),
      group_id = CASE WHEN ? = 'queued' THEN NULL ELSE group_id END, updated_at = ? WHERE id = ?`,
    [state, reason, state, Date.now(), id],
  );
}

/** A comment from the queue in the pull request's conversation. */
async function comment(env: Env, pull: Pull, body: string): Promise<void> {
  await run(
    env,
    `INSERT INTO pull_reviews (pull_id, author_id, head_cs, decision, body, created_at, revision)
     VALUES (?, ?, ?, 'comment', ?, ?, ?)`,
    [pull.id, MERGE_QUEUE_AUTHOR, pull.head_cs, body, Date.now(), pull.revision],
  );
}

/**
 * Work queue (#59): the issues a pull request closes go from `in-review`
 * back to `ready` when the queue rejects it, so an agent picks them up again.
 */
async function reopenWork(env: Env, repo: RepoRecord, pull: Pull, reason: string) {
  for (const ref of parseReferences(pull.body)) {
    if (
      !ref.closes ||
      (ref.repo !== null && ref.repo.toLowerCase() !== repo.slug.toLowerCase())
    )
      continue;
    const item = await q1<{ issue_id: number }>(
      env,
      `SELECT w.issue_id FROM work_items w JOIN issues i ON i.id = w.issue_id
        WHERE i.repo_id = ? AND i.number = ? AND w.readiness = 'in-review'`,
      [repo.id, ref.number],
    );
    if (!item) continue;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE work_items SET readiness = 'ready', ready_at = ?, updated_at = ? WHERE issue_id = ? AND readiness = 'in-review'",
      ).bind(Date.now(), Date.now(), item.issue_id),
      workEventStatement(
        env,
        item.issue_id,
        MERGE_QUEUE_AUTHOR,
        'merge_queue_ejected',
        'in-review',
        'ready',
        reason.slice(0, 500),
      ),
    ]);
  }
}

/** Take an entry out of the queue for good: comment, audit, webhook, work queue. */
async function eject(
  env: Env,
  repo: RepoRecord,
  entry: QueueEntry,
  reason: string,
): Promise<void> {
  await setEntry(env, entry.id, 'ejected', reason);
  const pull = await getPull(env, repo.id, entry.pull_id);
  await comment(env, pull, `Removed from the merge queue: ${reason}`);
  await reopenWork(env, repo, pull, reason);
  await appendAudit(env, {
    action: 'merge_queue.eject',
    repo,
    actor: MERGE_QUEUE_ACTOR,
    target: { pull_id: pull.id, base_ref: entry.base_ref, reason },
  });
  await emitEvent(env, repo, {
    event: 'pull_request',
    action: 'dequeued',
    actor: MERGE_QUEUE_ACTOR,
    data: { pull_request: pull, reason },
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const pullIds = (g: MergeGroupRow): number[] => JSON.parse(g.pulls) as number[];
const runIds = (g: MergeGroupRow): string[] => JSON.parse(g.ci_run_ids) as string[];

async function groupEntries(env: Env, g: MergeGroupRow): Promise<QueueEntry[]> {
  return q<QueueEntry>(
    env,
    'SELECT * FROM merge_queue_entries WHERE group_id = ? ORDER BY priority DESC, position',
    [g.id],
  );
}

/** Move a group out of `from`; false when another tick already did. */
async function claim(
  env: Env,
  g: MergeGroupRow,
  from: string,
  to: string,
  extra: { reason?: string; revert_cs?: string } = {},
): Promise<boolean> {
  const final = ['merged', 'failed', 'cancelled', 'reverted'].includes(to);
  const res = await env.DB.prepare(
    `UPDATE merge_groups SET state = ?, reason = COALESCE(?, reason),
      revert_cs = COALESCE(?, revert_cs), finished_at = ? WHERE id = ? AND state = ?`,
  )
    .bind(
      to,
      extra.reason ?? null,
      extra.revert_cs ?? null,
      final ? Date.now() : null,
      g.id,
      from,
    )
    .run();
  if (res.meta.changes) g.state = to;
  return res.meta.changes > 0;
}

async function groupEvent(
  env: Env,
  repo: RepoRecord,
  g: MergeGroupRow,
  action: 'checks_requested' | 'destroyed',
  reason: string | null = null,
): Promise<void> {
  await emitEvent(env, repo, {
    event: 'merge_group',
    action,
    actor: MERGE_QUEUE_ACTOR,
    data: {
      merge_group: {
        id: g.id,
        base_ref: g.base_ref,
        base_cs: g.base_cs,
        head_cs: g.head_cs,
        mode: g.mode,
        pull_ids: pullIds(g),
      },
      ...(reason ? { reason } : {}),
    },
  });
}

/** Stop a group's checks and put its entries back in the queue in their order. */
async function cancelGroup(env: Env, g: MergeGroupRow, reason: string): Promise<void> {
  if (!(await claim(env, g, g.state, 'cancelled', { reason }))) return;
  for (const id of runIds(g)) await cancelPipeline(env, id, reason);
  await run(
    env,
    `UPDATE merge_queue_entries SET state = 'queued', group_id = NULL, updated_at = ?
      WHERE group_id = ? AND state = 'testing'`,
    [Date.now(), g.id],
  );
  const repo = await getRepo(env, g.repo_id);
  if (repo) await groupEvent(env, repo, g, 'destroyed', 'invalidated');
}

type Verdict = 'pending' | 'passed' | 'failed';

/** The group's `merge_group` pipelines: all passed, any failed, or still running. */
async function verdict(env: Env, g: MergeGroupRow): Promise<Verdict> {
  const ids = runIds(g);
  if (ids.length === 0) return 'passed';
  const runs = (await listPipelineRuns(env, g.repo_id, g.head_cs)).filter((r) =>
    ids.includes(r.id),
  );
  if (runs.length < ids.length || runs.some((r) => r.state === 'running'))
    return 'pending';
  return runs.every((r) => r.state === 'passed') ? 'passed' : 'failed';
}

/**
 * The entries that may still land as queued, after ejecting those whose pull
 * request changed or whose merge requirements no longer hold.
 */
async function landable(
  env: Env,
  repo: RepoRecord,
  entries: QueueEntry[],
): Promise<{ entry: QueueEntry; pull: Pull; principal: Principal }[]> {
  const out: { entry: QueueEntry; pull: Pull; principal: Principal }[] = [];
  for (const entry of entries) {
    const pull = await getPull(env, repo.id, entry.pull_id);
    if (
      pull.state !== 'open' ||
      pull.head_cs !== entry.head_cs ||
      pull.revision !== entry.revision
    ) {
      await eject(env, repo, entry, 'the pull request changed after it was queued.');
      continue;
    }
    const principal = principalSchema.parse(JSON.parse(entry.principal));
    const gate = await queueGate(env, pull, principal, entry.method);
    if (gate.reasons.length > 0) {
      await eject(env, repo, entry, gate.reasons.join(' '));
      continue;
    }
    out.push({ entry, pull, principal });
  }
  return out;
}

/**
 * Build the next group: the speculative merge of up to `size` entries on the
 * base head. Entries that conflict are ejected. Starts the group's checks.
 */
async function buildGroup(
  env: Env,
  repo: RepoRecord,
  key: QueueKey,
  rule: MergeQueueRule,
  size: number,
): Promise<MergeGroupRow | 'idle' | 'waiting'> {
  const queued = await q<QueueEntry>(
    env,
    `SELECT * FROM merge_queue_entries WHERE repo_id = ? AND base_ref = ? AND state = 'queued'
      ORDER BY priority DESC, position LIMIT ?`,
    [key.repo_id, key.base_ref, size],
  );
  if (queued.length === 0) return 'idle';
  const ref = await getRef(env, key.repo_id, key.base_ref);
  const base = ref ? await getChangeset(env, key.repo_id, ref.head) : null;
  if (!base) {
    for (const entry of queued)
      await eject(env, repo, entry, 'the target branch is gone.');
    return 'idle';
  }
  // its checks could not start: do not spend merges on a group that would wait
  if (!(await mergeGroupReady(env, repo.id, base.id, key.base_ref))) return 'waiting';
  let target: Changeset = base;
  const members: QueueEntry[] = [];
  for (const { entry, pull, principal } of await landable(env, repo, queued)) {
    const head = await getChangeset(env, repo.id, pull.head_cs);
    if (!head) {
      await eject(env, repo, entry, 'the proposed revision is missing.');
      continue;
    }
    try {
      target = await landPull(env, pull, entry.method, target, head, principal, {});
      members.push(entry);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      await eject(
        env,
        repo,
        entry,
        `it does not merge with the pull requests ahead of it (${err.message})`,
      );
    }
  }
  if (members.length === 0) return 'idle';
  const id = crypto.randomUUID();
  const runs = await mergeGroupPipelines(
    env,
    repo.id,
    target.id,
    key.base_ref,
    id,
    TRIGGER,
  );
  // the group has checks CI cannot run now (off, or out of budget): wait, never land untested
  if (runs === null) return 'waiting';
  const group: MergeGroupRow = {
    id,
    repo_id: repo.id,
    base_ref: key.base_ref,
    mode: rule.mode,
    base_cs: base.id,
    head_cs: target.id,
    pulls: JSON.stringify(members.map((e) => e.pull_id)),
    state: rule.mode === 'strict' ? 'testing' : 'landing',
    ci_run_ids: JSON.stringify(runs),
    revert_cs: null,
    reason: null,
    created_at: Date.now(),
    finished_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO merge_groups (id, repo_id, base_ref, mode, base_cs, head_cs, pulls, state,
        ci_run_ids, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      group.id,
      group.repo_id,
      group.base_ref,
      group.mode,
      group.base_cs,
      group.head_cs,
      group.pulls,
      group.state,
      group.ci_run_ids,
      group.created_at,
    ),
    ...members.map((e) =>
      env.DB.prepare(
        `UPDATE merge_queue_entries SET state = 'testing', group_id = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'`,
      ).bind(group.id, Date.now(), e.id),
    ),
  ]);
  await groupEvent(env, repo, group, 'checks_requested');
  return group;
}

/** A Hono-shaped context for code that links issues on behalf of a principal. */
function requestless(env: Env, principal: Principal): Context {
  const vars = new Map<string, unknown>([['principal', principal]]);
  return {
    env,
    get: (key: string) => vars.get(key),
    req: { header: () => undefined, raw: new Request('https://merge-queue.invalid/') },
  } as unknown as Context;
}

/**
 * Land a group with one CAS move of the base ref (in the ref's lock DO, which
 * also serialises pull request changes) and record it everywhere a merge is.
 * A group whose base moved or whose pull request changed goes back to the
 * queue to be rebuilt.
 */
async function landGroup(env: Env, repo: RepoRecord, g: MergeGroupRow): Promise<boolean> {
  const entries = await groupEntries(env, g);
  const ids = pullIds(g);
  const pulls = await Promise.all(ids.map((id) => getPull(env, repo.id, id)));
  const already = pulls.every((p) => p.state === 'merged' && p.merged_cs === g.head_cs);
  if (!already) {
    // approvals or rules can change while a group is tested
    for (const entry of entries) {
      const pull = pulls.find((p) => p.id === entry.pull_id)!;
      const principal = principalSchema.parse(JSON.parse(entry.principal));
      const gate = await queueGate(env, pull, principal, entry.method);
      if (gate.reasons.length === 0) continue;
      await cancelGroup(env, g, 'A pull request no longer meets its merge requirements.');
      await eject(env, repo, entry, gate.reasons.join(' '));
      return false;
    }
    const lock = env.REF_LOCK.get(env.REF_LOCK.idFromName(`${repo.id}:${g.base_ref}`));
    const res = await lock.fetch('https://ref-lock/queue-land', {
      method: 'POST',
      body: JSON.stringify({
        repo_id: repo.id,
        name: g.base_ref,
        from: g.base_cs,
        to: g.head_cs,
        pulls: ids.map((id) => {
          const e = entries.find((x) => x.pull_id === id)!;
          return { id, head_cs: e.head_cs, revision: e.revision, method: e.method };
        }),
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error: { code: string; pull_id?: number } };
      const stale = entries.find((e) => e.pull_id === body.error.pull_id);
      await cancelGroup(env, g, 'The target branch or a pull request changed.');
      if (stale)
        await eject(env, repo, stale, 'the pull request changed while it was landing.');
      return false;
    }
  }
  const final = g.mode === 'strict' ? 'merged' : 'landed';
  if (!(await claim(env, g, 'landing', final))) return true;
  await run(
    env,
    `UPDATE merge_queue_entries SET state = 'merged', updated_at = ? WHERE group_id = ?
      AND state = 'testing'`,
    [Date.now(), g.id],
  );
  await appendAudit(env, {
    action: 'merge_queue.land',
    repo,
    actor: MERGE_QUEUE_ACTOR,
    target: {
      group_id: g.id,
      base_ref: g.base_ref,
      from: g.base_cs,
      to: g.head_cs,
      pull_ids: ids,
      mode: g.mode,
    },
  });
  for (const pull of pulls) {
    const after = await getPull(env, repo.id, pull.id);
    await emitEvent(env, repo, {
      event: 'pull_request',
      action: 'closed',
      actor: MERGE_QUEUE_ACTOR,
      data: { pull_request: after },
    });
  }
  await emitRefUpdate(
    env,
    repo,
    {
      name: g.base_ref,
      from: g.base_cs,
      to: g.head_cs,
      commits: [g.head_cs],
      forced: false,
    },
    MERGE_QUEUE_ACTOR,
    null,
  );
  if (g.mode === 'strict') await groupEvent(env, repo, g, 'destroyed', 'merged');
  try {
    await pushPipelines(env, repo.id, TRIGGER, [
      { name: g.base_ref, from: g.base_cs, to: g.head_cs },
    ]);
  } catch (err) {
    console.error('merge queue: push pipelines not started', err);
  }
  // `Closes #N` closes issues (and so their work) once pulls land on the default branch,
  // with the permissions of whoever queued them
  if (g.base_ref === repo.default_branch && entries.length > 0) {
    const as = (e: QueueEntry): Context =>
      requestless(env, principalSchema.parse(JSON.parse(e.principal)));
    await linkLanded(as(entries[0]!), repo, g.base_cs, g.head_cs);
    for (const pull of pulls) {
      const entry = entries.find((e) => e.pull_id === pull.id);
      if (!entry) continue;
      const source = { kind: 'pull' as const, repo: repo.slug, ref: pull.number };
      await linkReferences(as(entry), repo, source, pull.body, true).catch(
        (err: unknown) =>
          console.error('merge queue: linking landed references failed', err),
      );
    }
  }
  return true;
}

/** A strict group failed: bisect, or eject the one pull request it held. */
async function failGroup(
  env: Env,
  store: QueueStore,
  repo: RepoRecord,
  g: MergeGroupRow,
): Promise<void> {
  const entries = await groupEntries(env, g);
  if (
    !(await claim(env, g, 'testing', 'failed', { reason: 'merge_group checks failed' }))
  )
    return;
  await groupEvent(env, repo, g, 'destroyed', 'checks_failed');
  if (entries.length === 1) {
    await eject(env, repo, entries[0]!, 'its merge group checks failed.');
    await store.delete('split');
    return;
  }
  await run(
    env,
    `UPDATE merge_queue_entries SET state = 'queued', group_id = NULL, updated_at = ?
      WHERE group_id = ? AND state = 'testing'`,
    [Date.now(), g.id],
  );
  await store.put('split', Math.floor(entries.length / 2));
}

const REVERT_AUTHOR = { name: 'Merge queue', email: `merge-queue@${USER_EMAIL_DOMAIN}` };

/**
 * An optimistic group failed after it landed: commit the inverse of the group
 * on the current head (a three-way revert, so later lands stay), move the
 * base ref to it and reopen the group's pull requests at a new revision.
 */
async function revertGroup(env: Env, repo: RepoRecord, g: MergeGroupRow): Promise<void> {
  if (g.state === 'landed' && !(await claim(env, g, 'landed', 'reverting'))) return;
  const ids = pullIds(g);
  const pulls = await Promise.all(ids.map((id) => getPull(env, repo.id, id)));
  let revertCs = g.revert_cs;
  if (pulls.some((p) => p.state === 'merged')) {
    const ref = await getRef(env, repo.id, g.base_ref);
    const [current, landed, base] = await Promise.all([
      ref ? getChangeset(env, repo.id, ref.head) : null,
      getChangeset(env, repo.id, g.head_cs),
      getChangeset(env, repo.id, g.base_cs),
    ]);
    if (!current || !landed || !base) {
      await claim(env, g, 'reverting', 'failed', {
        reason: 'The landed changesets are missing.',
      });
      return;
    }
    const inverse = await mergeTrees(
      env,
      repo.id,
      landed.root_tree,
      current.root_tree,
      base.root_tree,
    );
    if (inverse.conflicts.length > 0 || inverse.changes.length === 0) {
      await claim(env, g, 'reverting', 'failed', {
        reason:
          inverse.changes.length === 0 && inverse.conflicts.length === 0
            ? 'The branch no longer has the group changes; nothing to revert.'
            : 'The automatic revert conflicts with later changes; revert by hand.',
      });
      await appendAudit(env, {
        action: 'merge_queue.revert',
        repo,
        actor: MERGE_QUEUE_ACTOR,
        target: { group_id: g.id, base_ref: g.base_ref, conflicted: true },
      });
      return;
    }
    const numbers = pulls.map((p) => `#${p.number}`).join(', ');
    const revert = await commitChanges(env, repo.id, {
      first_parent: current.id,
      message: `Revert merge group ${g.id}\n\nPost-land checks failed. This reverts ${numbers}.\n`,
      author: REVERT_AUTHOR,
      changes: inverse.changes,
    });
    revertCs = revert.changeset.id;
    await run(env, 'UPDATE merge_groups SET revert_cs = ? WHERE id = ?', [
      revertCs,
      g.id,
    ]);
    const lock = env.REF_LOCK.get(env.REF_LOCK.idFromName(`${repo.id}:${g.base_ref}`));
    const res = await lock.fetch('https://ref-lock/queue-land', {
      method: 'POST',
      body: JSON.stringify({
        repo_id: repo.id,
        name: g.base_ref,
        from: current.id,
        to: revertCs,
        pulls: pulls.map((p) => ({
          id: p.id,
          head_cs: p.head_cs,
          revision: p.revision,
          method: p.merge_method ?? 'merge',
        })),
        reopen: true,
      }),
    });
    // the ref moved meanwhile: the next tick reverts on the new head
    if (!res.ok) return;
    await emitRefUpdate(
      env,
      repo,
      {
        name: g.base_ref,
        from: current.id,
        to: revertCs,
        commits: [revertCs],
        forced: false,
      },
      MERGE_QUEUE_ACTOR,
      null,
    );
    try {
      await pushPipelines(env, repo.id, TRIGGER, [
        { name: g.base_ref, from: current.id, to: revertCs },
      ]);
    } catch (err) {
      console.error('merge queue: push pipelines not started', err);
    }
  }
  if (
    !(await claim(env, g, 'reverting', 'reverted', { revert_cs: revertCs ?? undefined }))
  )
    return;
  const reason = `post-land checks failed, so the queue reverted it in ${revertCs?.slice(0, 12) ?? 'a revert changeset'}. Push a fix and queue it again.`;
  await appendAudit(env, {
    action: 'merge_queue.revert',
    repo,
    actor: MERGE_QUEUE_ACTOR,
    target: { group_id: g.id, base_ref: g.base_ref, revert_cs: revertCs, pull_ids: ids },
  });
  await groupEvent(env, repo, g, 'destroyed', 'reverted');
  for (const entry of await groupEntries(env, g)) {
    await eject(env, repo, entry, reason);
    await emitEvent(env, repo, {
      event: 'pull_request',
      action: 'reopened',
      actor: MERGE_QUEUE_ACTOR,
      data: { pull_request: await getPull(env, repo.id, entry.pull_id) },
    });
  }
}

/**
 * One pass over a queue: settle the groups in flight, then build (strict) or
 * land (optimistic) the next ones. Returns when to look again (ms), or null
 * when the queue has nothing in flight.
 */
export async function processQueue(
  env: Env,
  store: QueueStore,
  key: QueueKey,
): Promise<number | null> {
  const repo = await getRepo(env, key.repo_id);
  if (!repo) return null;
  const groups = await q<MergeGroupRow>(
    env,
    `SELECT * FROM merge_groups WHERE repo_id = ? AND base_ref = ? AND finished_at IS NULL
      ORDER BY created_at, rowid`,
    [key.repo_id, key.base_ref],
  );
  let strictBusy = false;
  for (const g of groups) {
    if (g.state === 'landing') {
      // crash recovery, or an optimistic group built by a tick that stopped short
      if (!(await landGroup(env, repo, g))) continue;
      if (g.mode === 'strict') continue;
    }
    if (g.state === 'reverting') {
      await revertGroup(env, repo, g);
      continue;
    }
    const result = await verdict(env, g);
    if (g.state === 'testing') {
      if (result === 'pending') strictBusy = true;
      else if (result === 'failed') await failGroup(env, store, repo, g);
      else if (
        (await claim(env, g, 'testing', 'landing')) &&
        !(await landGroup(env, repo, g))
      )
        continue;
    } else if (g.state === 'landed') {
      if (result === 'passed') {
        if (await claim(env, g, 'landed', 'merged'))
          await groupEvent(env, repo, g, 'destroyed', 'merged');
      } else if (result === 'failed') await revertGroup(env, repo, g);
    }
  }
  // the ruleset's merge_queue rule configures the queue; without one, entries wait
  const rule = await queueRule(env, repo, key.base_ref);
  if (rule === null) return null;
  if (strictBusy && rule.mode === 'strict') return POLL_MS;
  for (;;) {
    const split = (await store.get<number>('split')) ?? rule.max_batch;
    const built = await buildGroup(env, repo, key, rule, Math.min(split, rule.max_batch));
    if (built === 'waiting') return WAIT_MS;
    if (built === 'idle') {
      if (
        !(await q1(
          env,
          "SELECT 1 FROM merge_queue_entries WHERE repo_id = ? AND base_ref = ? AND state = 'queued'",
          [key.repo_id, key.base_ref],
        ))
      )
        await store.delete('split');
      const inFlight = await q1(
        env,
        'SELECT 1 FROM merge_groups WHERE repo_id = ? AND base_ref = ? AND finished_at IS NULL',
        [key.repo_id, key.base_ref],
      );
      return inFlight ? POLL_MS : null;
    }
    if (built.state === 'testing') {
      if (runIds(built).length > 0) return POLL_MS;
      // nothing to check: the group lands as built
      if (!(await claim(env, built, 'testing', 'landing'))) return POLL_MS;
    }
    // optimistic groups land at once; keep landing while entries remain
    if (!(await landGroup(env, repo, built))) return POLL_MS;
  }
}

async function queueRule(
  env: Env,
  repo: RepoRecord,
  baseRef: string,
): Promise<MergeQueueRule | null> {
  return mergeQueueRule(await rulesetsFor(env, repo), repo, baseRef);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface QueueView {
  base_ref: string;
  enabled: boolean;
  mode: MergeQueueRule['mode'] | null;
  max_batch: number | null;
  entries: (PublicEntry & { number: number; title: string })[];
  groups: (Omit<MergeGroupRow, 'pulls' | 'ci_run_ids'> & {
    pull_ids: number[];
    ci_run_ids: string[];
  })[];
}

/** Active entries in landing order, then the latest finished ones; recent groups. */
export async function queueView(
  env: Env,
  repo: RepoRecord,
  baseRef: string,
): Promise<QueueView> {
  const rule = await queueRule(env, repo, baseRef);
  const cols = `e.id, e.repo_id, e.base_ref, e.pull_id, e.position, e.priority, e.state,
    e.group_id, e.head_cs, e.revision, e.method, e.reason, e.enqueued_by, e.enqueued_at,
    e.updated_at, p.number, p.title`;
  const active = await q<PublicEntry & { number: number; title: string }>(
    env,
    `SELECT ${cols} FROM merge_queue_entries e JOIN pull_requests p ON p.id = e.pull_id
      WHERE e.repo_id = ? AND e.base_ref = ? AND e.state IN ('testing','queued')
      ORDER BY e.state = 'queued', e.priority DESC, e.position`,
    [repo.id, baseRef],
  );
  const recent = await q<PublicEntry & { number: number; title: string }>(
    env,
    `SELECT ${cols} FROM merge_queue_entries e JOIN pull_requests p ON p.id = e.pull_id
      WHERE e.repo_id = ? AND e.base_ref = ? AND e.state NOT IN ('testing','queued')
      ORDER BY e.updated_at DESC, e.position DESC LIMIT 20`,
    [repo.id, baseRef],
  );
  const groups = await q<MergeGroupRow>(
    env,
    `SELECT * FROM merge_groups WHERE repo_id = ? AND base_ref = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    [repo.id, baseRef],
  );
  return {
    base_ref: baseRef,
    enabled: rule !== null,
    mode: rule?.mode ?? null,
    max_batch: rule?.max_batch ?? null,
    entries: [...active, ...recent],
    groups: groups.map(({ pulls, ci_run_ids, ...g }) => ({
      ...g,
      pull_ids: JSON.parse(pulls) as number[],
      ci_run_ids: JSON.parse(ci_run_ids) as string[],
    })),
  };
}
