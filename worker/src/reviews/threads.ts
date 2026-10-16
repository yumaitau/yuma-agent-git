import { z } from 'zod';
import type { Env } from '../env';
import { q, q1 } from '../db/client';
import type { Principal } from '../auth/principal';
import { ApiError } from '../core/errors';
import { getChangeset, pathSchema } from '../core/changesets';
import { resolvePath } from '../core/trees';
import { getBlob } from '../core/blobs';
import { isAncestorDag, mergeBase } from '../core/ancestry';
import { diffOps, splitLines } from '../core/xdiff';
import type { Change } from '../core/commit';
import type { Pull, ReviewComment, ReviewThread } from '../../shared/collaboration';

/**
 * Line-level review threads (issue #39). A thread sits on lines of one file
 * as it reads at `anchor_cs`: the pull's head, or the left side of its diff
 * (the merge base, as the dashboard diff shows it). When the pull moves to a
 * new revision, `reanchorThreads` follows the lines through a line diff; a
 * thread whose lines changed is marked outdated and keeps its old anchor, so
 * it stays readable. A fenced `suggestion` block in a comment is replacement
 * text for the thread's lines, applied as a new changeset on the head.
 */

/** Files above this size take no line comments (the diff shows no text for them). */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RANGE = 500;
const MAX_THREADS = 1000;

export const reviewCommentInput = z
  .object({
    path: pathSchema,
    side: z.enum(['base', 'head']).default('head'),
    /** Last line of the range (1-based). */
    line: z.int().min(1),
    /** First line of a multi-line range; defaults to `line`. */
    start_line: z.int().min(1).optional(),
    body: z.string().trim().min(1).max(65536),
  })
  .refine((c) => (c.start_line ?? c.line) <= c.line, 'start_line must not follow line')
  .refine((c) => c.line - (c.start_line ?? c.line) < MAX_RANGE, 'range too long');
export type ReviewCommentInput = z.infer<typeof reviewCommentInput>;

/** Inline comments submitted with one review (each starts a thread). */
export const reviewCommentsInput = z.array(reviewCommentInput).max(100);

/** Who wrote a thread or comment: the agent itself when an agent or token acts. */
export function authorKey(principal: Principal): string {
  if (principal.kind === 'agent') return `agent:${principal.agentId}`;
  if (principal.kind === 'token') return `agent:${principal.tokenId}`;
  return `user:${principal.userId}`;
}

/** The replacement text of the first fenced `suggestion` block, or null. */
export function parseSuggestion(body: string): string | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const open = lines.findIndex((l) => /^\s*```suggestion\s*$/.test(l));
  if (open === -1) return null;
  const close = lines.findIndex((l, i) => i > open && /^\s*```\s*$/.test(l));
  if (close === -1) return null;
  return lines.slice(open + 1, close).join('\n');
}

interface FileLines {
  hash: string;
  mode?: string;
  /** Null when the file is too large to read line by line. */
  lines: string[] | null;
}

/** The file at `path` in changeset `cs`, split into lines, or null when absent. */
async function fileLines(
  env: Env,
  repoId: string,
  cs: string,
  path: string,
): Promise<FileLines | null> {
  const changeset = await getChangeset(env, repoId, cs);
  if (!changeset?.root_tree) return null;
  const entry = await resolvePath(env, repoId, changeset.root_tree, path.split('/'));
  if (entry?.kind !== 'blob') return null;
  if ((entry.size ?? 0) > MAX_FILE_BYTES)
    return { hash: entry.hash, mode: entry.mode, lines: null };
  const blob = await getBlob(env, repoId, entry.hash);
  if (!blob) return null;
  const lines =
    blob.size > MAX_FILE_BYTES
      ? null
      : splitLines(new TextDecoder().decode(blob.content));
  return { hash: entry.hash, mode: entry.mode, lines };
}

/** Per-call cache: threads on one file read it once. */
function fileCache(
  env: Env,
  repoId: string,
): (cs: string, path: string) => Promise<FileLines | null> {
  const cache = new Map<string, Promise<FileLines | null>>();
  return (cs, path) => {
    const key = `${cs}:${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = fileLines(env, repoId, cs, path);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** The left side of the pull's diff: its merge base, as `diffRevisions` computes it. */
export async function leftOf(env: Env, pull: Pull): Promise<string | null> {
  if (await isAncestorDag(env, pull.repo_id, pull.base_cs, pull.head_cs))
    return pull.base_cs;
  if (await isAncestorDag(env, pull.repo_id, pull.head_cs, pull.base_cs))
    return pull.head_cs;
  return mergeBase(env, pull.repo_id, pull.base_cs, pull.head_cs);
}

/**
 * Statements that start one thread per comment on the pull's current
 * revision. `inReview`: the comments belong to the review inserted just
 * before them in the same batch.
 */
export async function threadStatements(
  env: Env,
  pull: Pull,
  author: string,
  comments: readonly ReviewCommentInput[],
  inReview: boolean,
): Promise<D1PreparedStatement[]> {
  if (comments.length === 0) return [];
  const count = await q1<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM review_threads WHERE pull_id = ?',
    [pull.id],
  );
  if ((count?.n ?? 0) + comments.length > MAX_THREADS)
    throw new ApiError(409, 'too_many_threads', 'This pull request has too many threads');
  const read = fileCache(env, pull.repo_id);
  const left = comments.some((c) => c.side === 'base') ? await leftOf(env, pull) : null;
  const now = Date.now();
  const out: D1PreparedStatement[] = [];
  for (const comment of comments) {
    const anchor = comment.side === 'head' ? pull.head_cs : left;
    const file = anchor === null ? null : await read(anchor, comment.path);
    if (!anchor || !file)
      throw new ApiError(
        400,
        'invalid_anchor',
        `${comment.path} does not exist on the ${comment.side} side`,
      );
    if (file.lines === null)
      throw new ApiError(
        400,
        'file_too_large',
        `${comment.path} is too large to comment on`,
      );
    if (comment.line > file.lines.length)
      throw new ApiError(
        400,
        'invalid_anchor',
        `${comment.path} has ${file.lines.length} lines on the ${comment.side} side`,
      );
    const suggestion = parseSuggestion(comment.body);
    if (suggestion !== null && comment.side !== 'head')
      throw new ApiError(
        400,
        'invalid_suggestion',
        'Suggest changes on lines of the proposed revision',
      );
    out.push(
      env.DB.prepare(
        `INSERT INTO review_threads (pull_id, path, side, start_line, end_line, revision,
           anchor_cs, original_head_cs, author, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        pull.id,
        comment.path,
        comment.side,
        comment.start_line ?? comment.line,
        comment.line,
        pull.revision,
        anchor,
        pull.head_cs,
        author,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO review_comments (thread_id, author, body, suggestion_patch, review_id, created_at)
         VALUES (last_insert_rowid(), ?, ?, ?, ${
           inReview ? '(SELECT MAX(id) FROM pull_reviews WHERE pull_id = ?)' : 'NULL'
         }, ?)`,
      ).bind(...[author, comment.body, suggestion, ...(inReview ? [pull.id] : []), now]),
    );
  }
  return out;
}

interface ThreadRow {
  id: number;
  pull_id: number;
  path: string;
  side: 'base' | 'head';
  start_line: number;
  end_line: number;
  revision: number;
  anchor_cs: string;
  original_head_cs: string;
  outdated: number;
  author: string;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
}

/** Where lines `start..end` of `from` sit in `to`, or null when any of them changed. */
function moveRange(
  from: FileLines | null,
  to: FileLines | null,
  start: number,
  end: number,
): [number, number] | null {
  if (!from || !to) return null;
  if (from.hash === to.hash) return [start, end];
  if (from.lines === null || to.lines === null) return null;
  const map = new Int32Array(from.lines.length).fill(-1);
  for (const op of diffOps(from.lines, to.lines)) if (op.type === 'eq') map[op.a] = op.b;
  const first = map[start - 1] ?? -1;
  if (first === -1) return null;
  for (let i = start; i < end; i++) if (map[i] !== first + (i - start + 1)) return null;
  return [first + 1, first + 1 + (end - start)];
}

/**
 * Follow the pull's live threads to its current revision. Runs in the ref
 * DO after the revision changes, so no thread is started in between.
 */
export async function reanchorThreads(env: Env, pull: Pull): Promise<void> {
  const threads = await q<ThreadRow>(
    env,
    'SELECT * FROM review_threads WHERE pull_id = ? AND outdated = 0 AND revision < ?',
    [pull.id, pull.revision],
  );
  if (threads.length === 0) return;
  const read = fileCache(env, pull.repo_id);
  const left = threads.some((t) => t.side === 'base') ? await leftOf(env, pull) : null;
  const statements: D1PreparedStatement[] = [];
  for (const t of threads) {
    const target = t.side === 'head' ? pull.head_cs : left;
    const moved =
      target === null
        ? null
        : target === t.anchor_cs
          ? ([t.start_line, t.end_line] as [number, number])
          : moveRange(
              await read(t.anchor_cs, t.path),
              await read(target, t.path),
              t.start_line,
              t.end_line,
            );
    statements.push(
      moved
        ? env.DB.prepare(
            'UPDATE review_threads SET start_line = ?, end_line = ?, anchor_cs = ?, revision = ? WHERE id = ?',
          ).bind(moved[0], moved[1], target, pull.revision, t.id)
        : env.DB.prepare('UPDATE review_threads SET outdated = 1 WHERE id = ?').bind(
            t.id,
          ),
    );
  }
  await env.DB.batch(statements);
}

/** The pull's threads (or just thread `only`) with comments and anchored lines. */
export async function listThreads(
  env: Env,
  pull: Pull,
  only?: number,
): Promise<ReviewThread[]> {
  const filter = only === undefined ? '' : ' AND t.id = ?';
  const params = only === undefined ? [pull.id] : [pull.id, only];
  const [rows, comments] = await Promise.all([
    q<ThreadRow>(
      env,
      `SELECT t.* FROM review_threads t WHERE t.pull_id = ?${filter} ORDER BY t.id LIMIT ${MAX_THREADS}`,
      params,
    ),
    q<ReviewComment>(
      env,
      `SELECT c.* FROM review_comments c JOIN review_threads t ON t.id = c.thread_id
        WHERE t.pull_id = ?${filter} ORDER BY c.id`,
      params,
    ),
  ]);
  const read = fileCache(env, pull.repo_id);
  const out: ReviewThread[] = [];
  for (const row of rows) {
    const lines = (await read(row.anchor_cs, row.path))?.lines;
    out.push({
      ...row,
      outdated: row.outdated === 1,
      snippet: lines ? lines.slice(row.start_line - 1, row.end_line).join('') : null,
      comments: comments.filter((c) => c.thread_id === row.id),
    });
  }
  return out;
}

export async function getThread(env: Env, pull: Pull, id: number): Promise<ThreadRow> {
  const row = await q1<ThreadRow>(
    env,
    'SELECT * FROM review_threads WHERE pull_id = ? AND id = ?',
    [pull.id, id],
  );
  if (!row) throw new ApiError(404, 'thread_not_found', 'Review thread not found');
  return row;
}

export async function unresolvedThreads(env: Env, pullId: number): Promise<number> {
  const row = await q1<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM review_threads WHERE pull_id = ? AND resolved_at IS NULL',
    [pullId],
  );
  return row?.n ?? 0;
}

function base64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The file changes that apply the suggestions in `commentIds` to the pull's
 * head. Each must sit on a live head-side thread anchored on the current
 * head; ranges in one file must not overlap.
 */
export async function suggestionChanges(
  env: Env,
  pull: Pull,
  commentIds: readonly number[],
): Promise<{ changes: Change[]; threadIds: number[] }> {
  const rows = await q<
    ThreadRow & { suggestion_patch: string | null; comment_id: number }
  >(
    env,
    `SELECT t.*, c.id AS comment_id, c.suggestion_patch FROM review_comments c
       JOIN review_threads t ON t.id = c.thread_id
      WHERE t.pull_id = ? AND c.id IN (${commentIds.map(() => '?').join(',')})`,
    [pull.id, ...commentIds],
  );
  if (rows.length !== new Set(commentIds).size)
    throw new ApiError(404, 'comment_not_found', 'Review comment not found');
  const byPath = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.suggestion_patch === null)
      throw new ApiError(
        400,
        'no_suggestion',
        `Comment ${row.comment_id} has no suggestion`,
      );
    if (row.side !== 'head' || row.outdated || row.anchor_cs !== pull.head_cs)
      throw new ApiError(
        409,
        'suggestion_outdated',
        `The lines comment ${row.comment_id} suggests changes to have changed`,
      );
    byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
  }
  const read = fileCache(env, pull.repo_id);
  const changes: Change[] = [];
  for (const [path, list] of byPath) {
    const file = await read(pull.head_cs, path);
    if (!file?.lines)
      throw new ApiError(409, 'suggestion_outdated', `${path} cannot be edited here`);
    const lines = [...file.lines];
    list.sort((a, b) => b.start_line - a.start_line);
    for (const [i, row] of list.entries()) {
      const prior = list[i - 1];
      if (prior && row.end_line >= prior.start_line)
        throw new ApiError(400, 'suggestion_conflict', `Suggestions overlap in ${path}`);
      const last = lines[row.end_line - 1] ?? '';
      const eol = (lines[row.start_line - 1] ?? '').endsWith('\r\n') ? '\r\n' : '\n';
      const text = row.suggestion_patch as string;
      const replacement =
        text === ''
          ? []
          : text
              .split('\n')
              .map((l, k, all) =>
                k < all.length - 1 || last.endsWith('\n') ? `${l}${eol}` : l,
              );
      lines.splice(row.start_line - 1, row.end_line - row.start_line + 1, ...replacement);
    }
    const mode = file.mode as '100644' | '100755' | '120000' | undefined;
    changes.push({ path, op: 'mod', content_b64: base64(lines.join('')), mode });
  }
  return { changes, threadIds: [...new Set(rows.map((r) => r.id))] };
}
