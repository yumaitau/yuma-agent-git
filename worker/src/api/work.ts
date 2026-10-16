import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Principal } from '../auth/principal';
import type { RepoWithCreator } from '../auth/rbac';
import {
  loadReadableRepo,
  loadTriageRepo,
  loadWritableRepo,
  requireAgentScope,
} from '../auth/guards';
import { AGENT_KINDS } from '../auth/agents';
import { errorResponse, readJsonBody } from './errors';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import { getIssueRow, type IssueRow } from '../collab/issues';
import {
  DEFAULT_LEASE_S,
  MAX_LEASE_S,
  claimNext,
  claimantOf,
  expireLeases,
  fieldsFromLabels,
  isApprover,
  listWork,
  renewLease,
  workEventStatement,
  workEvents,
} from '../collab/work';
import { READINESS, RISKS, SIZES, type Readiness, type Risk } from '../../shared/work';

/**
 * Work queue (issue #59): readiness, risk, size, agent kind, priority and
 * `waits-on` dependencies on issues, claimed atomically with a lease. Reading
 * needs `read`; editing fields needs `triage`; claiming, heartbeats and
 * releases need `write`. Agent tokens also need `queue:claim`. Only people
 * with triage, or agents granted `queue:approve`, may mark work `ready` or
 * change its risk, and a body edit by anyone else sends ready work back to
 * `needs-prep` (see `resetStaleApproval`).
 */
export const workRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';
for (const path of [`${base}/work`, `${base}/work/*`]) {
  workRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'private, no-store');
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}

function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal') as Principal; // `/api/*` already refused anonymous callers
}

async function loadIssue(c: Context<AppEnv>, repo: RepoWithCreator): Promise<IssueRow> {
  const number = parse(z.coerce.number().int().positive(), c.req.param('number'));
  const issue = await getIssueRow(c.env, repo.id, number);
  if (!issue) throw new ApiError(404, 'issue_not_found', `No issue #${number}`);
  return issue;
}

async function itemOf(c: Context<AppEnv>, repo: RepoWithCreator, issue: IssueRow) {
  const [item] = await listWork(c.env, repo.id, { issueId: issue.id });
  return item ?? null;
}

const leaseSeconds = z.number().int().min(30).max(MAX_LEASE_S);

export const workListQuery = z.object({
  readiness: z.enum(READINESS).optional(),
  risk: z.enum(RISKS).optional(),
  claimed_by: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

workRoutes.get(`${base}/work`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = parse(workListQuery, c.req.query());
    const items = await listWork(c.env, loaded.repo.id, {
      readiness: query.readiness,
      risk: query.risk,
      claimedBy: query.claimed_by,
      limit: query.limit,
    });
    return c.json({ items });
  } catch (err) {
    return errorResponse(c, err);
  }
});

workRoutes.get(`${base}/work/:number`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const issue = await loadIssue(c, loaded.repo);
    const item = await itemOf(c, loaded.repo, issue);
    if (!item)
      throw new ApiError(404, 'work_not_found', `#${issue.number} is not queued`);
    return c.json({ item, events: await workEvents(c.env, issue.id) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const updateWork = z.object({
  readiness: z.enum(READINESS).exclude(['claimed']).optional(),
  risk: z.enum(RISKS).optional(),
  size: z.enum(SIZES).nullable().optional(),
  agent_kind: z.enum(AGENT_KINDS).nullable().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  plan: z.boolean().optional(),
  /** Issue numbers in this repo the item waits on (replaces the list). */
  depends_on: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Dependency issue ids for `numbers`, refusing unknown issues and cycles. */
async function resolveDependencies(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  issue: IssueRow,
  numbers: readonly number[],
): Promise<number[]> {
  const unique = [...new Set(numbers)];
  if (unique.length === 0) return [];
  if (unique.includes(issue.number))
    throw new ApiError(400, 'invalid_dependency', 'An issue cannot wait on itself');
  const rows = await q<{ id: number; number: number }>(
    c.env,
    `SELECT id, number FROM issues WHERE repo_id = ?
        AND number IN (${unique.map(() => '?').join(',')})`,
    [repo.id, ...unique],
  );
  const missing = unique.filter((n) => !rows.some((r) => r.number === n));
  if (missing.length)
    throw new ApiError(
      400,
      'unknown_issue',
      `No issue ${missing.map((n) => `#${n}`).join(', ')}`,
    );
  const ids = rows.map((r) => r.id);
  const cycle = await q1(
    c.env,
    `WITH RECURSIVE down(id, depth) AS (
       SELECT value, 0 FROM json_each(?)
       UNION SELECT d.depends_on_issue_id, down.depth + 1 FROM work_dependencies d
        JOIN down ON d.issue_id = down.id WHERE down.depth < 50)
     SELECT 1 FROM down WHERE id = ? LIMIT 1`,
    [JSON.stringify(ids), issue.id],
  );
  if (cycle)
    throw new ApiError(409, 'dependency_cycle', `#${issue.number} would wait on itself`);
  return ids;
}

workRoutes.put(`${base}/work/:number`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'queue:claim');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const issue = await loadIssue(c, repo);
    const input = parse(updateWork, await readJsonBody(c));
    const principal = principalOf(c);
    const current = await itemOf(c, repo, issue);
    const from: Readiness = current?.readiness ?? 'draft';
    const approving =
      (input.readiness === 'ready' && from !== 'ready') ||
      (input.risk !== undefined && input.risk !== (current?.risk ?? 'medium'));
    if (approving && !(await isApprover(c.env, repo, principal)))
      throw new ApiError(
        403,
        'approval_required',
        'Only people with triage, or agents granted queue:approve, can mark work ready or change its risk',
      );
    const deps =
      input.depends_on === undefined
        ? undefined
        : await resolveDependencies(c, repo, issue, input.depends_on);

    const db = c.env.DB;
    const now = Date.now();
    const actor = claimantOf(principal);
    const sets = ['updated_at = ?'];
    const values: unknown[] = [now];
    for (const key of ['risk', 'size', 'agent_kind', 'priority'] as const) {
      if (input[key] === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(input[key]);
    }
    if (input.plan !== undefined) {
      sets.push('plan = ?');
      values.push(input.plan ? 1 : 0);
    }
    const to =
      input.readiness !== undefined && input.readiness !== from ? input.readiness : null;
    if (to) {
      // a new readiness always ends any claim; `claimed` is only reachable by claiming
      sets.push('readiness = ?', 'claimed_by = NULL', 'lease_expires_at = NULL');
      values.push(to);
      if (to === 'ready') {
        sets.push('ready_at = ?');
        values.push(now);
      }
    }
    const stmts = [
      db
        .prepare(
          'INSERT OR IGNORE INTO work_items (issue_id, repo_id, updated_at) VALUES (?,?,?)',
        )
        .bind(issue.id, repo.id, now),
      db
        .prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE issue_id = ?`)
        .bind(...values, issue.id),
      ...(to
        ? [
            workEventStatement(
              c.env,
              issue.id,
              actor,
              'readiness',
              from,
              to,
              input.reason ?? null,
            ),
          ]
        : []),
      ...(deps === undefined
        ? []
        : [
            db.prepare('DELETE FROM work_dependencies WHERE issue_id = ?').bind(issue.id),
            ...deps.map((id) =>
              db
                .prepare(
                  'INSERT INTO work_dependencies (issue_id, depends_on_issue_id) VALUES (?, ?)',
                )
                .bind(issue.id, id),
            ),
          ]),
    ];
    await recordAudit(
      c,
      {
        action: 'work.update',
        repo,
        target: {
          number: issue.number,
          fields: Object.keys(input),
          ...(to ? { from, readiness: to, reason: input.reason ?? null } : {}),
          ...(input.risk ? { risk: input.risk } : {}),
        },
      },
      stmts,
    );
    return c.json({ item: await itemOf(c, repo, issue) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const claimWork = z.object({
  lease_seconds: leaseSeconds.optional(),
  /** Highest risk to take; agents are also capped by their own `max_risk`. */
  max_risk: z.enum(RISKS).optional(),
  /** Skip items that need a different agent kind (agents always send their own). */
  agent_kind: z.enum(AGENT_KINDS).optional(),
});

const agentQueueRow = z.object({
  kind: z.string(),
  max_risk: z.enum(RISKS),
});

workRoutes.post(`${base}/work/claim`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'queue:claim');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const input = parse(claimWork, await readJsonBody(c));
    const principal = principalOf(c);
    let maxRisk: Risk = input.max_risk ?? 'high';
    let agentKind: string | null = input.agent_kind ?? null;
    if (principal.kind === 'agent') {
      const agent = agentQueueRow.parse(
        await q1(c.env, 'SELECT kind, max_risk FROM agents WHERE id = ?', [
          principal.agentId,
        ]),
      );
      agentKind = agent.kind;
      if (RISKS.indexOf(agent.max_risk) < RISKS.indexOf(maxRisk))
        maxRisk = agent.max_risk;
    }
    await expireLeases(c.env, Date.now(), repo.id);
    const claimant = claimantOf(principal);
    const issueId = await claimNext(c.env, repo.id, {
      claimant,
      leaseMs: (input.lease_seconds ?? DEFAULT_LEASE_S) * 1000,
      maxRisk,
      agentKind,
    });
    if (issueId === null) return c.json({ item: null });
    const [item] = await listWork(c.env, repo.id, { issueId });
    await recordAudit(
      c,
      {
        action: 'work.claim',
        repo,
        target: {
          number: item!.number,
          claimed_by: claimant,
          risk: item!.risk,
          lease_expires_at: item!.lease_expires_at,
        },
      },
      [workEventStatement(c.env, issueId, claimant, 'claimed', 'ready', 'claimed')],
    );
    return c.json({ item });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const heartbeatWork = z.object({ lease_seconds: leaseSeconds.optional() });

workRoutes.post(`${base}/work/:number/heartbeat`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'queue:claim');
    if (scoped) return scoped;
    const issue = await loadIssue(c, loaded.repo);
    const input = parse(heartbeatWork, await readJsonBody(c));
    const expires = await renewLease(
      c.env,
      issue.id,
      claimantOf(principalOf(c)),
      (input.lease_seconds ?? DEFAULT_LEASE_S) * 1000,
    );
    if (expires === null)
      throw new ApiError(
        409,
        'lease_lost',
        `You do not hold a live claim on #${issue.number}`,
      );
    return c.json({ number: issue.number, lease_expires_at: expires });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const releaseWork = z.object({
  /** `ready` gives the item back (counts an attempt); the rest end the claim. */
  outcome: z.enum(['ready', 'in-review', 'blocked', 'done']),
  reason: z.string().trim().max(500).optional(),
});

workRoutes.post(`${base}/work/:number/release`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'queue:claim');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const issue = await loadIssue(c, repo);
    const input = parse(releaseWork, await readJsonBody(c));
    const claimant = claimantOf(principalOf(c));
    const released = await c.env.DB.prepare(
      `UPDATE work_items
          SET readiness = ?, claimed_by = NULL, lease_expires_at = NULL,
              attempts = attempts + ?, updated_at = ?
        WHERE issue_id = ? AND readiness = 'claimed' AND claimed_by = ?
        RETURNING attempts`,
    )
      .bind(
        input.outcome,
        input.outcome === 'ready' ? 1 : 0,
        Date.now(),
        issue.id,
        claimant,
      )
      .first();
    if (!released)
      throw new ApiError(
        409,
        'lease_lost',
        `You do not hold a claim on #${issue.number}`,
      );
    const reason = input.reason ?? null;
    await recordAudit(
      c,
      {
        action: 'work.release',
        repo,
        target: { number: issue.number, readiness: input.outcome, reason },
      },
      [
        workEventStatement(
          c.env,
          issue.id,
          claimant,
          'released',
          'claimed',
          input.outcome,
          reason,
        ),
      ],
    );
    return c.json({ item: await itemOf(c, repo, issue) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const importLabels = z.object({
  /** Factory's label prefix (`yuma` reads `yuma:ready`, `yuma:risk:low`, …). */
  prefix: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,40}$/)
    .default('yuma'),
});

const labelledIssue = z.object({
  id: z.number(),
  number: z.number(),
  state: z.enum(['open', 'closed']),
  labels: z.string(),
});

/**
 * Label compatibility (#72 imports call `fieldsFromLabels` too): turn
 * `<prefix>:*` labels on this repo's issues into work fields. Claimed items
 * are left alone; closed issues are `done`. Approvers only, since it can mark
 * work ready.
 */
workRoutes.post(`${base}/work/import-labels`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'queue:approve');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const { prefix } = parse(importLabels, await readJsonBody(c));
    if (!(await isApprover(c.env, repo, principalOf(c))))
      throw new ApiError(
        403,
        'approval_required',
        'Importing labels can mark work ready',
      );
    const issues = (
      await q(
        c.env,
        `SELECT i.id, i.number, i.state, GROUP_CONCAT(l.name, char(10)) AS labels
           FROM issues i JOIN issue_labels il ON il.issue_id = i.id
           JOIN labels l ON l.id = il.label_id
          WHERE i.repo_id = ? AND l.name LIKE ?
          GROUP BY i.id ORDER BY i.number LIMIT 500`,
        [repo.id, `${prefix}:%`],
      )
    ).map((r) => labelledIssue.parse(r));
    const existing = await listWork(c.env, repo.id);
    const db = c.env.DB;
    const now = Date.now();
    const actor = claimantOf(principalOf(c));
    const stmts: D1PreparedStatement[] = [];
    const imported: number[] = [];
    for (const issue of issues) {
      const fields = fieldsFromLabels(issue.labels.split('\n'), prefix);
      if (!fields) continue;
      const readiness: Readiness = issue.state === 'closed' ? 'done' : fields.readiness;
      const current = existing.find((w) => w.number === issue.number);
      if (current?.readiness === 'claimed') continue;
      const risk = fields.risk ?? current?.risk ?? 'medium';
      if (
        current &&
        current.readiness === readiness &&
        current.risk === risk &&
        current.plan === fields.plan
      )
        continue;
      imported.push(issue.number);
      stmts.push(
        db
          .prepare(
            `INSERT INTO work_items (issue_id, repo_id, readiness, risk, plan, ready_at, updated_at)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT (issue_id) DO UPDATE SET
               readiness = excluded.readiness, risk = excluded.risk, plan = excluded.plan,
               ready_at = CASE WHEN work_items.readiness = 'ready' THEN work_items.ready_at
                               ELSE excluded.ready_at END,
               updated_at = excluded.updated_at
             WHERE work_items.readiness <> 'claimed'`,
          )
          .bind(issue.id, repo.id, readiness, risk, fields.plan ? 1 : 0, now, now),
        workEventStatement(
          c.env,
          issue.id,
          actor,
          'imported',
          current?.readiness ?? null,
          readiness,
          `${prefix}: labels`,
        ),
      );
    }
    if (stmts.length)
      await recordAudit(
        c,
        { action: 'work.import', repo, target: { prefix, numbers: imported } },
        stmts,
      );
    return c.json({ imported });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * Factory's stale-approval rule: a body edit by someone who could not have
 * approved the item sends ready work back to `needs-prep`. Called by the
 * issue edit route after the new body is saved.
 */
export async function resetStaleApproval(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  issue: IssueRow,
): Promise<void> {
  const principal = principalOf(c);
  if (await isApprover(c.env, repo, principal)) return;
  const reset = await c.env.DB.prepare(
    `UPDATE work_items SET readiness = 'needs-prep', updated_at = ?
      WHERE issue_id = ? AND readiness = 'ready' RETURNING issue_id`,
  )
    .bind(Date.now(), issue.id)
    .first();
  if (!reset) return;
  const reason = 'body edited after approval';
  await recordAudit(
    c,
    {
      action: 'work.update',
      repo,
      target: { number: issue.number, from: 'ready', readiness: 'needs-prep', reason },
    },
    [
      workEventStatement(
        c.env,
        issue.id,
        claimantOf(principal),
        'readiness',
        'ready',
        'needs-prep',
        reason,
      ),
    ],
  );
}
