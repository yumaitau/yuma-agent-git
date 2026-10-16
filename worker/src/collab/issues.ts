import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import type { Issue, Label } from '../../shared/issues';

/**
 * Issue storage (issue #38). Issues and pull requests share one per-repo
 * number sequence (`repo_counters`), so a `#N` reference names one of them.
 */

/** The next per-repo number for a new issue or pull request. */
export async function nextNumber(env: Env, repoId: string): Promise<number> {
  const row = await q1<{ last_number: number }>(
    env,
    `INSERT INTO repo_counters (repo_id, last_number) VALUES (?, 1)
     ON CONFLICT (repo_id) DO UPDATE SET last_number = last_number + 1
     RETURNING last_number`,
    [repoId],
  );
  if (!row) throw new ApiError(500, 'counter_failed', 'Could not allocate a number');
  return row.last_number;
}

/** Timeline actor: a person, or the token (agent) acting for one. */
export function actorKey(principal: Principal): string {
  return principal.kind === 'token'
    ? `agent:${principal.tokenId}`
    : `user:${principal.userId}`;
}

export const issueRowSchema = z.object({
  id: z.number(),
  repo_id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  state_reason: z.enum(['completed', 'not_planned', 'duplicate', 'reopened']).nullable(),
  author_id: z.string(),
  milestone_id: z.number().nullable(),
  locked: z.number(),
  pinned_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  closed_at: z.number().nullable(),
});
export type IssueRow = z.infer<typeof issueRowSchema>;

export async function getIssueRow(
  env: Env,
  repoId: string,
  number: number,
): Promise<IssueRow | null> {
  const row = await q1(env, 'SELECT * FROM issues WHERE repo_id = ? AND number = ?', [
    repoId,
    number,
  ]);
  return row ? issueRowSchema.parse(row) : null;
}

/** Issue rows plus labels, assignees and sub-issue progress (three queries). */
export async function hydrateIssues(env: Env, rows: IssueRow[]): Promise<Issue[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const [labels, assignees, progress] = await Promise.all([
    q<Label & { issue_id: number }>(
      env,
      `SELECT il.issue_id, l.id, l.name, l.color, l.description FROM issue_labels il
         JOIN labels l ON l.id = il.label_id
        WHERE il.issue_id IN (${marks}) ORDER BY l.name`,
      ids,
    ),
    q<{ issue_id: number; principal: string }>(
      env,
      `SELECT issue_id, principal FROM issue_assignees WHERE issue_id IN (${marks})
        ORDER BY principal`,
      ids,
    ),
    q<{ parent_id: number; total: number; done: number }>(
      env,
      `SELECT k.parent_id, COUNT(*) AS total,
              SUM(CASE WHEN i.state = 'closed' THEN 1 ELSE 0 END) AS done
         FROM issue_links k JOIN issues i ON i.id = k.child_id
        WHERE k.parent_id IN (${marks}) GROUP BY k.parent_id`,
      ids,
    ),
  ]);
  return rows.map((row) => {
    const sub = progress.find((p) => p.parent_id === row.id);
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state,
      state_reason: row.state_reason,
      author_id: row.author_id,
      milestone_id: row.milestone_id,
      locked: row.locked === 1,
      pinned: row.pinned_at !== null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
      labels: labels
        .filter((l) => l.issue_id === row.id)
        .map(({ id, name, color, description }) => ({ id, name, color, description })),
      assignees: assignees.filter((a) => a.issue_id === row.id).map((a) => a.principal),
      sub_issues: { total: sub?.total ?? 0, done: sub?.done ?? 0 },
    };
  });
}

/** A timeline event, as a statement so it commits with its change. */
export function eventStatement(
  env: Env,
  issueId: number,
  actor: string,
  kind: string,
  payload: Record<string, unknown> = {},
): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO issue_events (issue_id, actor, kind, payload, created_at) VALUES (?,?,?,?,?)',
  ).bind(issueId, actor, kind, JSON.stringify(payload), Date.now());
}
