import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { can, type RepoWithCreator } from '../auth/rbac';
import { appendAudit } from '../audit/record';
import { q } from '../db/client';
import { actorKey } from './issues';
import {
  READINESS,
  RISKS,
  SIZES,
  type Readiness,
  type Risk,
  type WorkEvent,
  type WorkItem,
} from '../../shared/work';

/**
 * Work queue storage (issue #59). A claim is one conditional UPDATE: D1
 * serialises writes, so the highest-priority claimable item goes to exactly
 * one caller and every other concurrent claim sees it already `claimed`.
 * Leases that are not renewed return the item to `ready` with `attempts + 1`,
 * on the next claim in that repo or the cron sweep, whichever comes first.
 */

export const DEFAULT_LEASE_S = 10 * 60;
export const MAX_LEASE_S = 60 * 60;

/** Who holds a claim: the person, the agent identity, or the API token. */
export function claimantOf(principal: Principal): string {
  return principal.kind === 'agent' ? `agent:${principal.agentId}` : actorKey(principal);
}

/**
 * Who may approve work (move it to `ready`, change risk): people with triage,
 * and agent tokens with an explicit `queue:approve` grant. API tokens never.
 */
export async function isApprover(
  env: Env,
  repo: RepoWithCreator,
  principal: Principal,
): Promise<boolean> {
  if (principal.kind === 'token') return false;
  if (principal.kind === 'agent' && !principal.scopes.includes('queue:approve'))
    return false;
  return can(env, repo, principal, 'triage');
}

/** Risk levels up to and including `max`. */
export function risksUpTo(max: Risk): Risk[] {
  return RISKS.slice(0, RISKS.indexOf(max) + 1);
}

/** SQL: dependency `d` is still open (its issue is open and its work is not done). */
const OPEN_DEPENDENCY = `di.state = 'open' AND (dw.readiness IS NULL OR dw.readiness <> 'done')`;
const DEPENDENCY_JOINS = `JOIN issues di ON di.id = d.depends_on_issue_id
       LEFT JOIN work_items dw ON dw.issue_id = d.depends_on_issue_id`;

const workRowSchema = z.object({
  issue_id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  readiness: z.enum(READINESS),
  risk: z.enum(RISKS),
  size: z.enum(SIZES).nullable(),
  agent_kind: z.string().nullable(),
  priority: z.number(),
  plan: z.number(),
  ready_at: z.number().nullable(),
  claimed_by: z.string().nullable(),
  lease_expires_at: z.number().nullable(),
  attempts: z.number(),
  updated_at: z.number(),
});

export interface WorkFilter {
  issueId?: number;
  readiness?: Readiness;
  risk?: Risk;
  claimedBy?: string;
  limit?: number;
}

/** Work items in a repo with their dependencies, best claim first. */
export async function listWork(
  env: Env,
  repoId: string,
  filter: WorkFilter = {},
): Promise<WorkItem[]> {
  const where = ['w.repo_id = ?'];
  const params: unknown[] = [repoId];
  for (const [column, value] of [
    ['w.issue_id', filter.issueId],
    ['w.readiness', filter.readiness],
    ['w.risk', filter.risk],
    ['w.claimed_by', filter.claimedBy],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  const rows = (
    await q(
      env,
      `SELECT w.*, i.number, i.title, i.state FROM work_items w
         JOIN issues i ON i.id = w.issue_id
        WHERE ${where.join(' AND ')}
        ORDER BY w.priority DESC, w.ready_at, i.number LIMIT ?`,
      [...params, filter.limit ?? 500],
    )
  ).map((r) => workRowSchema.parse(r));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.issue_id);
  const deps = await q<{ issue_id: number; number: number; open: number }>(
    env,
    `SELECT d.issue_id, di.number, (${OPEN_DEPENDENCY}) AS open
       FROM work_dependencies d ${DEPENDENCY_JOINS}
      WHERE d.issue_id IN (${ids.map(() => '?').join(',')}) ORDER BY di.number`,
    ids,
  );
  return rows.map(({ issue_id: id, plan, ...row }) => {
    const mine = deps.filter((d) => d.issue_id === id);
    return {
      ...row,
      plan: plan === 1,
      depends_on: mine.map((d) => d.number),
      waiting_on: mine.filter((d) => d.open === 1).map((d) => d.number),
    };
  });
}

export async function workEvents(env: Env, issueId: number): Promise<WorkEvent[]> {
  return q<WorkEvent>(
    env,
    `SELECT id, actor, kind, from_readiness, to_readiness, reason, created_at
       FROM work_events WHERE issue_id = ? ORDER BY id DESC LIMIT 100`,
    [issueId],
  );
}

/** A readiness history row, as a statement so it commits with its audit event. */
export function workEventStatement(
  env: Env,
  issueId: number,
  actor: string,
  kind: string,
  from: Readiness | null,
  to: Readiness | null,
  reason: string | null = null,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO work_events (issue_id, actor, kind, from_readiness, to_readiness, reason,
                              created_at) VALUES (?,?,?,?,?,?,?)`,
  ).bind(issueId, actor, kind, from, to, reason, Date.now());
}

export interface ClaimOptions {
  claimant: string;
  leaseMs: number;
  maxRisk: Risk;
  /** Only items needing no agent kind or this one; null skips the check. */
  agentKind: string | null;
  now?: number;
}

/**
 * Atomically claim the best ready item in a repo: highest priority, then
 * longest ready, whose issue is open, whose dependencies are all closed and
 * whose risk is within `maxRisk`. Returns the claimed issue id or null.
 */
export async function claimNext(
  env: Env,
  repoId: string,
  opts: ClaimOptions,
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  const risks = risksUpTo(opts.maxRisk);
  const row = await env.DB.prepare(
    `UPDATE work_items
        SET readiness = 'claimed', claimed_by = ?, lease_expires_at = ?, updated_at = ?
      WHERE readiness = 'ready' AND issue_id = (
        SELECT w.issue_id FROM work_items w JOIN issues i ON i.id = w.issue_id
         WHERE w.repo_id = ? AND w.readiness = 'ready' AND i.state = 'open'
           AND w.risk IN (${risks.map(() => '?').join(',')})
           AND (? IS NULL OR w.agent_kind IS NULL OR w.agent_kind = ?)
           AND NOT EXISTS (SELECT 1 FROM work_dependencies d ${DEPENDENCY_JOINS}
                            WHERE d.issue_id = w.issue_id AND ${OPEN_DEPENDENCY})
         ORDER BY w.priority DESC, w.ready_at, w.issue_id LIMIT 1)
      RETURNING issue_id`,
  )
    .bind(
      opts.claimant,
      now + opts.leaseMs,
      now,
      repoId,
      ...risks,
      opts.agentKind,
      opts.agentKind,
    )
    .first<{ issue_id: number }>();
  return row?.issue_id ?? null;
}

/** Extend a live lease the claimant still holds. False when it was lost. */
export async function renewLease(
  env: Env,
  issueId: number,
  claimant: string,
  leaseMs: number,
  now = Date.now(),
): Promise<number | null> {
  const row = await env.DB.prepare(
    `UPDATE work_items SET lease_expires_at = ?, updated_at = ?
      WHERE issue_id = ? AND readiness = 'claimed' AND claimed_by = ?
        AND lease_expires_at > ?
      RETURNING lease_expires_at`,
  )
    .bind(now + leaseMs, now, issueId, claimant, now)
    .first<{ lease_expires_at: number }>();
  return row?.lease_expires_at ?? null;
}

/**
 * Return expired claims to `ready` with `attempts + 1` (all repos, or one).
 * Each item flips with a conditional UPDATE, so a heartbeat that lands first
 * keeps its lease; the system actor's audit event follows the change.
 */
export async function expireLeases(
  env: Env,
  now = Date.now(),
  repoId?: string,
): Promise<number> {
  const expired = await q<{
    issue_id: number;
    number: number;
    repo_id: string;
    slug: string;
    claimed_by: string;
  }>(
    env,
    `SELECT w.issue_id, i.number, w.repo_id, r.slug, w.claimed_by FROM work_items w
       JOIN issues i ON i.id = w.issue_id JOIN repos r ON r.id = w.repo_id
      WHERE w.readiness = 'claimed' AND w.lease_expires_at <= ?
        AND (? IS NULL OR w.repo_id = ?) LIMIT 100`,
    [now, repoId ?? null, repoId ?? null],
  );
  let count = 0;
  for (const item of expired) {
    const flipped = await env.DB.prepare(
      `UPDATE work_items
          SET readiness = 'ready', claimed_by = NULL, lease_expires_at = NULL,
              attempts = attempts + 1, updated_at = ?
        WHERE issue_id = ? AND readiness = 'claimed' AND claimed_by = ?
          AND lease_expires_at <= ?
        RETURNING attempts`,
    )
      .bind(now, item.issue_id, item.claimed_by, now)
      .first<{ attempts: number }>();
    if (!flipped) continue;
    count++;
    const reason = `lease of ${item.claimed_by} expired without a heartbeat`;
    await appendAudit(
      env,
      {
        action: 'work.expire',
        repo: { id: item.repo_id, slug: item.slug },
        actor: { kind: 'system', id: 'work-queue' },
        target: {
          number: item.number,
          claimed_by: item.claimed_by,
          attempts: flipped.attempts,
          readiness: 'ready',
          reason,
        },
      },
      {},
      [
        workEventStatement(
          env,
          item.issue_id,
          'system',
          'expired',
          'claimed',
          'ready',
          reason,
        ),
      ],
    ).catch((err: unknown) => console.error('work queue: expiry audit failed', err));
  }
  return count;
}

export interface LabelFields {
  readiness: Readiness;
  risk?: Risk;
  plan: boolean;
}

/**
 * Factory label compatibility: `<prefix>:ready`, `<prefix>:risk:*`,
 * `<prefix>:plan`, `<prefix>:waits-on` and `<prefix>:done` as work fields.
 * Null when the issue carries no label with the prefix. The highest risk
 * label wins, and done beats waits-on beats ready.
 */
export function fieldsFromLabels(
  labels: readonly string[],
  prefix = 'yuma',
): LabelFields | null {
  const p = `${prefix.toLowerCase()}:`;
  const names = labels
    .map((l) => l.toLowerCase())
    .filter((l) => l.startsWith(p))
    .map((l) => l.slice(p.length));
  if (names.length === 0) return null;
  const risk = [...RISKS].reverse().find((r) => names.includes(`risk:${r}`));
  const readiness: Readiness = names.includes('done')
    ? 'done'
    : names.includes('waits-on')
      ? 'blocked'
      : names.includes('ready')
        ? 'ready'
        : 'needs-prep';
  return { readiness, plan: names.includes('plan'), ...(risk ? { risk } : {}) };
}
