import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { hasScope, type AppEnv, type Principal } from '../auth/principal';
import { can, type RepoWithCreator } from '../auth/rbac';
import {
  loadAdminRepo,
  loadReadableRepo,
  loadTriageRepo,
  loadWritableRepo,
  pathReadFilter,
} from '../auth/guards';
import { errorResponse, readJsonBody } from './errors';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import {
  actorKey,
  eventStatement,
  getIssueRow,
  hydrateIssues,
  issueRowSchema,
  nextNumber,
  type IssueRow,
} from '../collab/issues';
import {
  linkReferences,
  referenceSourceSchema,
  sourceVisibility,
} from '../collab/references';
import { listTemplates } from '../collab/templates';
import { resetStaleApproval } from './work';
import type {
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueSummary,
  Label,
  Milestone,
} from '../../shared/issues';

/**
 * Issues (issue #38). Reading needs `read` on the repo; anyone who can read
 * may open issues and comment (tokens also need `repo:write`). Labels,
 * assignees, milestones, locks, pins and sub-issues need `triage`; authors
 * may edit, close and reopen their own issues. Labels and milestones are
 * managed with `write`, deleting an issue needs `admin`.
 */
export const issuesRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';
for (const path of [
  `${base}/issues`,
  `${base}/issues/*`,
  `${base}/labels`,
  `${base}/labels/*`,
  `${base}/milestones`,
  `${base}/milestones/*`,
  `${base}/issue-templates`,
]) {
  issuesRoutes.use(path, async (c, next) => {
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

/** Opening issues and commenting are writes: tokens need `repo:write` (agents `contents:write`). */
function requireWriteScope(c: Context<AppEnv>): void {
  const principal = principalOf(c);
  if (principal.kind !== 'user' && !hasScope(principal, 'repo:write'))
    throw new ApiError(403, 'insufficient_scope', 'Token requires repo:write');
}

function forbidden(message: string): ApiError {
  return new ApiError(403, 'forbidden', message);
}

const numberParam = z.coerce.number().int().positive().max(999_999_999);

/** The issue, or 404 (naming the pull request when `#N` is one). */
async function loadIssue(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  raw = c.req.param('number'),
): Promise<IssueRow> {
  const number = parse(numberParam, raw);
  const issue = await getIssueRow(c.env, repo.id, number);
  if (issue) return issue;
  const pull = await q1<{ id: number }>(
    c.env,
    'SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?',
    [repo.id, number],
  );
  if (pull)
    throw new ApiError(404, 'pull_request', `#${number} is a pull request`, {
      pull_id: pull.id,
    });
  throw new ApiError(404, 'issue_not_found', `No issue #${number}`);
}

const touch = (c: Context<AppEnv>, issue: IssueRow): D1PreparedStatement =>
  c.env.DB.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(
    Date.now(),
    issue.id,
  );

// ---------------------------------------------------------------------------
// Labels, assignees and milestones (validation shared by create and update)
// ---------------------------------------------------------------------------

const labelRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
});

async function resolveLabels(
  c: Context<AppEnv>,
  repoId: string,
  names: readonly string[],
): Promise<Label[]> {
  if (names.length === 0) return [];
  const rows = (
    await q(
      c.env,
      `SELECT id, name, color, description FROM labels
        WHERE repo_id = ? AND name IN (${names.map(() => '?').join(',')})`,
      [repoId, ...names],
    )
  ).map((r) => labelRowSchema.parse(r));
  const missing = names.filter(
    (n) => !rows.some((r) => r.name.toLowerCase() === n.toLowerCase()),
  );
  if (missing.length)
    throw new ApiError(400, 'unknown_label', `No label named ${missing.join(', ')}`);
  return rows;
}

/**
 * Normalise assignees to principals. A bare login means `user:<id>`. Users
 * and agent tokens must be able to read the repo; teams must belong to the
 * org that owns it.
 */
export async function resolveAssignees(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  inputs: readonly string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const input of inputs) {
    const [kind, id] = input.includes(':') ? input.split(':', 2) : ['login', input];
    let principal: string | null = null;
    if (kind === 'login' || kind === 'user') {
      const user = await q1<{ id: string }>(
        c.env,
        `SELECT id FROM users WHERE ${kind === 'login' ? 'login' : 'id'} = ?`,
        [id],
      );
      if (user && (await can(c.env, repo, { kind: 'user', userId: user.id }, 'read')))
        principal = `user:${user.id}`;
    } else if (kind === 'team') {
      const team = await q1<{ id: string }>(
        c.env,
        'SELECT id FROM teams WHERE id = ? AND org_id = ?',
        [id, repo.owner_kind === 'org' ? repo.owner_id : null],
      );
      if (team) principal = `team:${team.id}`;
    } else if (kind === 'agent') {
      const token = await q1<{ id: string; user_id: string }>(
        c.env,
        `SELECT id, user_id FROM api_tokens WHERE id = ? AND (repo_id IS NULL OR repo_id = ?)
           AND (expires_at IS NULL OR expires_at > ?)`,
        [id, repo.id, Date.now()],
      );
      if (
        token &&
        (await can(c.env, repo, { kind: 'user', userId: token.user_id }, 'read'))
      )
        principal = `agent:${token.id}`;
    }
    if (!principal)
      throw new ApiError(400, 'invalid_assignee', `${input} cannot be assigned here`);
    out.add(principal);
  }
  return [...out];
}

async function checkMilestone(
  c: Context<AppEnv>,
  repoId: string,
  id: number | null,
): Promise<void> {
  if (id === null) return;
  const row = await q1(c.env, 'SELECT id FROM milestones WHERE id = ? AND repo_id = ?', [
    id,
    repoId,
  ]);
  if (!row) throw new ApiError(400, 'unknown_milestone', `No milestone ${id}`);
}

async function setLabels(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  issue: IssueRow,
  names: readonly string[],
): Promise<void> {
  const wanted = await resolveLabels(c, repo.id, names);
  const current = (
    await q(
      c.env,
      `SELECT l.id, l.name, l.color, l.description FROM issue_labels il
         JOIN labels l ON l.id = il.label_id WHERE il.issue_id = ?`,
      [issue.id],
    )
  ).map((r) => labelRowSchema.parse(r));
  const added = wanted.filter((l) => !current.some((x) => x.id === l.id));
  const removed = current.filter((l) => !wanted.some((x) => x.id === l.id));
  if (added.length + removed.length === 0) return;
  const actor = actorKey(principalOf(c));
  const db = c.env.DB;
  await recordAudit(
    c,
    {
      action: 'issue.update',
      repo,
      target: {
        number: issue.number,
        change: 'labels',
        added: added.map((l) => l.name),
        removed: removed.map((l) => l.name),
      },
    },
    [
      ...added.flatMap((l) => [
        db
          .prepare('INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)')
          .bind(issue.id, l.id),
        eventStatement(c.env, issue.id, actor, 'labeled', { label: l.name }),
      ]),
      ...removed.flatMap((l) => [
        db
          .prepare('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?')
          .bind(issue.id, l.id),
        eventStatement(c.env, issue.id, actor, 'unlabeled', { label: l.name }),
      ]),
      touch(c, issue),
    ],
  );
}

async function setAssignees(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  issue: IssueRow,
  inputs: readonly string[],
): Promise<void> {
  const wanted = await resolveAssignees(c, repo, inputs);
  const current = (
    await q<{ principal: string }>(
      c.env,
      'SELECT principal FROM issue_assignees WHERE issue_id = ?',
      [issue.id],
    )
  ).map((r) => r.principal);
  const added = wanted.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !wanted.includes(p));
  if (added.length + removed.length === 0) return;
  const actor = actorKey(principalOf(c));
  const db = c.env.DB;
  await recordAudit(
    c,
    {
      action: 'issue.update',
      repo,
      target: { number: issue.number, change: 'assignees', added, removed },
    },
    [
      ...added.flatMap((p) => [
        db
          .prepare('INSERT INTO issue_assignees (issue_id, principal) VALUES (?, ?)')
          .bind(issue.id, p),
        eventStatement(c.env, issue.id, actor, 'assigned', { assignee: p }),
      ]),
      ...removed.flatMap((p) => [
        db
          .prepare('DELETE FROM issue_assignees WHERE issue_id = ? AND principal = ?')
          .bind(issue.id, p),
        eventStatement(c.env, issue.id, actor, 'unassigned', { assignee: p }),
      ]),
      touch(c, issue),
    ],
  );
}

const MAX_SUB_ISSUES = 100;

async function addSubIssue(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  parent: IssueRow,
  child: IssueRow,
): Promise<void> {
  if (child.id === parent.id)
    throw new ApiError(400, 'invalid_sub_issue', 'An issue cannot be its own sub-issue');
  const linked = await q1<{ parent_id: number }>(
    c.env,
    'SELECT parent_id FROM issue_links WHERE child_id = ?',
    [child.id],
  );
  if (linked)
    throw new ApiError(409, 'already_parented', `#${child.number} already has a parent`);
  // The child must not be an ancestor of the parent (no cycles).
  const cycle = await q1(
    c.env,
    `WITH RECURSIVE up(id, depth) AS (
       SELECT ?, 0
       UNION SELECT k.parent_id, up.depth + 1 FROM issue_links k
        JOIN up ON k.child_id = up.id WHERE up.depth < 20)
     SELECT 1 FROM up WHERE id = ?`,
    [parent.id, child.id],
  );
  if (cycle)
    throw new ApiError(
      409,
      'sub_issue_cycle',
      `#${child.number} is above #${parent.number}`,
    );
  const count = await q1<{ n: number; last: number | null }>(
    c.env,
    'SELECT COUNT(*) AS n, MAX(position) AS last FROM issue_links WHERE parent_id = ?',
    [parent.id],
  );
  if ((count?.n ?? 0) >= MAX_SUB_ISSUES)
    throw new ApiError(409, 'sub_issue_limit', `At most ${MAX_SUB_ISSUES} sub-issues`);
  const actor = actorKey(principalOf(c));
  await recordAudit(
    c,
    {
      action: 'issue.update',
      repo,
      target: { number: parent.number, change: 'sub_issues', added: child.number },
    },
    [
      c.env.DB.prepare(
        'INSERT INTO issue_links (parent_id, child_id, position) VALUES (?, ?, ?)',
      ).bind(parent.id, child.id, (count?.last ?? 0) + 1),
      eventStatement(c.env, parent.id, actor, 'sub_issue_added', {
        number: child.number,
      }),
      eventStatement(c.env, child.id, actor, 'parent_added', { number: parent.number }),
      touch(c, parent),
    ],
  );
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const listQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  label: z.string().max(500).optional(),
  assignee: z.string().max(200).optional(),
  milestone: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  before: numberParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

issuesRoutes.get(`${base}/issues`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const query = parse(listQuery, c.req.query());
    const where = ['i.repo_id = ?'];
    const params: unknown[] = [repo.id];
    if (query.state !== 'all') {
      where.push('i.state = ?');
      params.push(query.state);
    }
    if (query.before !== undefined) {
      where.push('i.number < ?');
      params.push(query.before);
    }
    const labelNames = (query.label ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const label of await resolveLabels(c, repo.id, labelNames)) {
      where.push(
        'EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label_id = ?)',
      );
      params.push(label.id);
    }
    if (query.assignee === 'none') {
      where.push('NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id)');
    } else if (query.assignee !== undefined) {
      const [principal] = await resolveAssignees(c, repo, [query.assignee]);
      where.push(
        'EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id AND a.principal = ?)',
      );
      params.push(principal);
    }
    if (query.milestone === 'none') where.push('i.milestone_id IS NULL');
    else if (query.milestone !== undefined) {
      where.push('i.milestone_id = ?');
      params.push(query.milestone);
    }
    const rows = (
      await q(
        c.env,
        `SELECT i.* FROM issues i WHERE ${where.join(' AND ')}
          ORDER BY i.number DESC LIMIT ?`,
        [...params, query.limit + 1],
      )
    ).map((r) => issueRowSchema.parse(r));
    const page = rows.slice(0, query.limit);
    const pinned =
      query.before === undefined
        ? (
            await q(
              c.env,
              `SELECT * FROM issues WHERE repo_id = ? AND pinned_at IS NOT NULL
                ORDER BY pinned_at`,
              [repo.id],
            )
          ).map((r) => issueRowSchema.parse(r))
        : [];
    return c.json({
      issues: await hydrateIssues(c.env, page),
      pinned: await hydrateIssues(c.env, pinned),
      next_cursor: rows.length > query.limit ? page[page.length - 1]!.number : null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const createIssue = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(65536).default(''),
  labels: z.array(z.string().min(1).max(50)).max(50).default([]),
  assignees: z.array(z.string().min(1).max(200)).max(10).default([]),
  milestone_id: z.number().int().positive().nullable().default(null),
  /** Open as a sub-issue of this issue number. */
  parent: z.number().int().positive().optional(),
});

issuesRoutes.post(`${base}/issues`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    requireWriteScope(c);
    const repo = loaded.repo;
    const input = parse(createIssue, await readJsonBody(c));
    // Like GitHub, labels, assignees, milestone and parent from someone
    // without triage (a template, say) are not applied.
    const triage = await can(c.env, repo, principalOf(c), 'triage');
    const parent =
      triage && input.parent !== undefined
        ? await loadIssue(c, repo, String(input.parent))
        : null;
    if (triage) {
      await resolveLabels(c, repo.id, input.labels);
      await resolveAssignees(c, repo, input.assignees);
      await checkMilestone(c, repo.id, input.milestone_id);
    }
    const number = await nextNumber(c.env, repo.id);
    const now = Date.now();
    await recordAudit(c, { action: 'issue.create', repo, target: { number } }, [
      c.env.DB.prepare(
        `INSERT INTO issues (repo_id, number, title, body, author_id, milestone_id,
             created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        repo.id,
        number,
        input.title,
        input.body,
        principalOf(c).userId,
        triage ? input.milestone_id : null,
        now,
        now,
      ),
    ]);
    let issue = (await getIssueRow(c.env, repo.id, number)) as IssueRow;
    if (triage) {
      await setLabels(c, repo, issue, input.labels);
      await setAssignees(c, repo, issue, input.assignees);
      if (parent) await addSubIssue(c, repo, parent, issue);
      issue = (await getIssueRow(c.env, repo.id, number)) as IssueRow;
    }
    await linkReferences(
      c,
      repo,
      { kind: 'issue', repo: repo.slug, ref: number },
      input.body,
    );
    const [hydrated] = await hydrateIssues(c.env, [issue]);
    return c.json({ issue: hydrated }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

const eventPayload = z.record(z.string(), z.unknown());

/** Display names for the principals on a page: logins, team slugs. */
export async function principalNames(
  c: Context<AppEnv>,
  principals: Iterable<string>,
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const users: string[] = [];
  const teams: string[] = [];
  for (const p of new Set(principals)) {
    const [kind, id] = p.split(':', 2) as [string, string];
    names[p] = p;
    if (kind === 'user') users.push(id);
    if (kind === 'team') teams.push(id);
  }
  const marks = (xs: string[]): string => xs.map(() => '?').join(',');
  if (users.length)
    for (const u of await q<{ id: string; login: string }>(
      c.env,
      `SELECT id, login FROM users WHERE id IN (${marks(users)})`,
      users,
    ))
      names[`user:${u.id}`] = u.login;
  if (teams.length)
    for (const t of await q<{ id: string; slug: string; org: string }>(
      c.env,
      `SELECT t.id, t.slug, o.slug AS org FROM teams t JOIN orgs o ON o.id = t.org_id
        WHERE t.id IN (${marks(teams)})`,
      teams,
    ))
      names[`team:${t.id}`] = `${t.org}/${t.slug}`;
  return names;
}

issuesRoutes.get(`${base}/issues/:number`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const row = await loadIssue(c, repo);
    const [issue] = await hydrateIssues(c.env, [row]);
    const [comments, rawEvents, parent, subIssues, milestone] = await Promise.all([
      q<IssueComment>(
        c.env,
        `SELECT id, author_id, body, created_at, updated_at FROM issue_comments
          WHERE issue_id = ? ORDER BY id LIMIT 500`,
        [row.id],
      ),
      q<{ id: number; actor: string; kind: string; payload: string; created_at: number }>(
        c.env,
        'SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id LIMIT 500',
        [row.id],
      ),
      q1<IssueSummary>(
        c.env,
        `SELECT p.number, p.title, p.state FROM issue_links k
           JOIN issues p ON p.id = k.parent_id WHERE k.child_id = ?`,
        [row.id],
      ),
      q<IssueSummary>(
        c.env,
        `SELECT i.number, i.title, i.state FROM issue_links k
           JOIN issues i ON i.id = k.child_id WHERE k.parent_id = ? ORDER BY k.position`,
        [row.id],
      ),
      row.milestone_id === null
        ? null
        : q1<Milestone>(
            c.env,
            'SELECT id, title, description, due_at, state, created_at FROM milestones WHERE id = ?',
            [row.milestone_id],
          ),
    ]);
    const visible = sourceVisibility(c.env, principalOf(c));
    const events: IssueEvent[] = [];
    for (const e of rawEvents) {
      const payload = eventPayload.parse(JSON.parse(e.payload));
      const source = referenceSourceSchema.safeParse(payload.source);
      if (source.success && !(await visible(source.data))) continue;
      events.push({ ...e, payload });
    }
    const detail: IssueDetail = {
      issue: issue!,
      comments,
      events,
      parent,
      sub_issues: subIssues,
      milestone,
      can_triage: await can(c.env, repo, principalOf(c), 'triage'),
      names: await principalNames(c, [
        `user:${row.author_id}`,
        ...issue!.assignees,
        ...comments.map((x) => `user:${x.author_id}`),
        ...events.map((x) => x.actor),
      ]),
    };
    return c.json(detail);
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const commentInput = z.object({ body: z.string().trim().min(1).max(65536) });
export const labelsInput = z.object({
  labels: z.array(z.string().min(1).max(50)).max(50),
});
export const assigneesInput = z.object({
  assignees: z.array(z.string().min(1).max(200)).max(10),
});
export const flagInput = z.object({ on: z.boolean() });
export const subIssueInput = z.object({ number: z.number().int().positive() });
export const subIssueOrderInput = z.object({
  order: z.array(z.number().int().positive()).max(MAX_SUB_ISSUES),
});

export const updateIssue = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  state: z.enum(['open', 'closed']).optional(),
  state_reason: z.enum(['completed', 'not_planned', 'duplicate']).optional(),
  milestone_id: z.number().int().positive().nullable().optional(),
});

issuesRoutes.patch(`${base}/issues/:number`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    requireWriteScope(c);
    const repo = loaded.repo;
    const issue = await loadIssue(c, repo);
    const input = parse(updateIssue, await readJsonBody(c));
    const principal = principalOf(c);
    const triage = await can(c.env, repo, principal, 'triage');
    if (!triage && issue.author_id !== principal.userId)
      throw forbidden('Only the author or triagers can change this issue');
    if (!triage && input.milestone_id !== undefined)
      throw forbidden('Setting a milestone needs triage access');
    if (input.milestone_id !== undefined)
      await checkMilestone(c, repo.id, input.milestone_id);
    const actor = actorKey(principal);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    const db = c.env.DB;
    if (input.title !== undefined && input.title !== issue.title) {
      stmts.push(
        db
          .prepare('UPDATE issues SET title = ? WHERE id = ?')
          .bind(input.title, issue.id),
        eventStatement(c.env, issue.id, actor, 'renamed', {
          from: issue.title,
          to: input.title,
        }),
      );
    }
    if (input.body !== undefined && input.body !== issue.body)
      stmts.push(
        db.prepare('UPDATE issues SET body = ? WHERE id = ?').bind(input.body, issue.id),
      );
    if (input.state === 'closed' && issue.state === 'open') {
      const reason = input.state_reason ?? 'completed';
      stmts.push(
        db
          .prepare(
            "UPDATE issues SET state = 'closed', state_reason = ?, closed_at = ? WHERE id = ?",
          )
          .bind(reason, now, issue.id),
        eventStatement(c.env, issue.id, actor, 'closed', { state_reason: reason }),
      );
    } else if (input.state === 'open' && issue.state === 'closed') {
      stmts.push(
        db
          .prepare(
            "UPDATE issues SET state = 'open', state_reason = 'reopened', closed_at = NULL WHERE id = ?",
          )
          .bind(issue.id),
        eventStatement(c.env, issue.id, actor, 'reopened'),
      );
    }
    if (input.milestone_id !== undefined && input.milestone_id !== issue.milestone_id) {
      stmts.push(
        db
          .prepare('UPDATE issues SET milestone_id = ? WHERE id = ?')
          .bind(input.milestone_id, issue.id),
        eventStatement(c.env, issue.id, actor, 'milestoned', {
          milestone_id: input.milestone_id,
        }),
      );
    }
    if (stmts.length) {
      await recordAudit(
        c,
        {
          action: 'issue.update',
          repo,
          target: {
            number: issue.number,
            change: 'edit',
            fields: Object.keys(input),
            ...(input.state ? { state: input.state } : {}),
          },
        },
        [...stmts, touch(c, issue)],
      );
    }
    if (input.body !== undefined)
      await linkReferences(
        c,
        repo,
        { kind: 'issue', repo: repo.slug, ref: issue.number },
        input.body,
      );
    if (input.body !== undefined && input.body !== issue.body)
      await resetStaleApproval(c, repo, issue);
    const [hydrated] = await hydrateIssues(c.env, [
      (await getIssueRow(c.env, repo.id, issue.number)) as IssueRow,
    ]);
    return c.json({ issue: hydrated });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.delete(`${base}/issues/:number`, async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const issue = await loadIssue(c, loaded.repo);
    const db = c.env.DB;
    // The number is never reused: repo_counters only grows.
    await recordAudit(
      c,
      {
        action: 'issue.delete',
        repo: loaded.repo,
        target: { number: issue.number, title: issue.title },
      },
      [
        ...[
          'DELETE FROM issue_comments WHERE issue_id = ?',
          'DELETE FROM issue_labels WHERE issue_id = ?',
          'DELETE FROM issue_assignees WHERE issue_id = ?',
          'DELETE FROM issue_events WHERE issue_id = ?',
          'DELETE FROM issue_links WHERE parent_id = ?1 OR child_id = ?1',
          'DELETE FROM work_events WHERE issue_id = ?',
          'DELETE FROM work_dependencies WHERE issue_id = ?1 OR depends_on_issue_id = ?1',
          'DELETE FROM work_items WHERE issue_id = ?',
          'DELETE FROM issues WHERE id = ?',
        ].map((sql) => db.prepare(sql).bind(issue.id)),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.post(`${base}/issues/:number/comments`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    requireWriteScope(c);
    const repo = loaded.repo;
    const issue = await loadIssue(c, repo);
    const { body } = parse(commentInput, await readJsonBody(c));
    if (issue.locked && !(await can(c.env, repo, principalOf(c), 'triage')))
      throw new ApiError(423, 'issue_locked', 'This issue is locked to triagers');
    const now = Date.now();
    await recordAudit(
      c,
      { action: 'issue.comment', repo, target: { number: issue.number } },
      [
        c.env.DB.prepare(
          `INSERT INTO issue_comments (issue_id, author_id, body, created_at, updated_at)
           VALUES (?,?,?,?,?)`,
        ).bind(issue.id, principalOf(c).userId, body, now, now),
        touch(c, issue),
      ],
    );
    await linkReferences(
      c,
      repo,
      { kind: 'issue', repo: repo.slug, ref: issue.number },
      body,
    );
    const comment = await q1<IssueComment>(
      c.env,
      `SELECT id, author_id, body, created_at, updated_at FROM issue_comments
        WHERE issue_id = ? ORDER BY id DESC LIMIT 1`,
      [issue.id],
    );
    return c.json({ comment }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.put(`${base}/issues/:number/labels`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const issue = await loadIssue(c, loaded.repo);
    const { labels } = parse(labelsInput, await readJsonBody(c));
    await setLabels(c, loaded.repo, issue, labels);
    const [hydrated] = await hydrateIssues(c.env, [issue]);
    return c.json({ issue: hydrated });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.put(`${base}/issues/:number/assignees`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const issue = await loadIssue(c, loaded.repo);
    const { assignees } = parse(assigneesInput, await readJsonBody(c));
    await setAssignees(c, loaded.repo, issue, assignees);
    const [hydrated] = await hydrateIssues(c.env, [issue]);
    return c.json({ issue: hydrated });
  } catch (err) {
    return errorResponse(c, err);
  }
});

const MAX_PINNED = 3;

for (const flag of ['lock', 'pin'] as const) {
  issuesRoutes.put(`${base}/issues/:number/${flag}`, async (c) => {
    try {
      const loaded = await loadTriageRepo(c, c.req.param('repo'));
      if (!loaded.ok) return loaded.response;
      const repo = loaded.repo;
      const issue = await loadIssue(c, repo);
      const { on } = parse(flagInput, await readJsonBody(c));
      const was = flag === 'lock' ? issue.locked === 1 : issue.pinned_at !== null;
      if (on !== was) {
        if (flag === 'pin' && on) {
          const pinned = await q1<{ n: number }>(
            c.env,
            'SELECT COUNT(*) AS n FROM issues WHERE repo_id = ? AND pinned_at IS NOT NULL',
            [repo.id],
          );
          if ((pinned?.n ?? 0) >= MAX_PINNED)
            throw new ApiError(409, 'pin_limit', `At most ${MAX_PINNED} pinned issues`);
        }
        const column = flag === 'lock' ? 'locked' : 'pinned_at';
        const value = flag === 'lock' ? (on ? 1 : 0) : on ? Date.now() : null;
        const kind = `${on ? '' : 'un'}${flag === 'lock' ? 'locked' : 'pinned'}`;
        await recordAudit(
          c,
          {
            action: 'issue.update',
            repo,
            target: { number: issue.number, change: kind },
          },
          [
            c.env.DB.prepare(`UPDATE issues SET ${column} = ? WHERE id = ?`).bind(
              value,
              issue.id,
            ),
            eventStatement(c.env, issue.id, actorKey(principalOf(c)), kind),
            touch(c, issue),
          ],
        );
      }
      const [hydrated] = await hydrateIssues(c.env, [
        (await getIssueRow(c.env, repo.id, issue.number)) as IssueRow,
      ]);
      return c.json({ issue: hydrated });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

issuesRoutes.post(`${base}/issues/:number/sub-issues`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const parent = await loadIssue(c, loaded.repo);
    const { number } = parse(subIssueInput, await readJsonBody(c));
    await addSubIssue(
      c,
      loaded.repo,
      parent,
      await loadIssue(c, loaded.repo, String(number)),
    );
    return c.json({ ok: true }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.delete(`${base}/issues/:number/sub-issues/:child`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const parent = await loadIssue(c, loaded.repo);
    const child = await loadIssue(c, loaded.repo, c.req.param('child'));
    const actor = actorKey(principalOf(c));
    const linked = await q1(
      c.env,
      'SELECT 1 FROM issue_links WHERE parent_id = ? AND child_id = ?',
      [parent.id, child.id],
    );
    if (!linked)
      throw new ApiError(
        404,
        'sub_issue_not_found',
        `#${child.number} is not a sub-issue`,
      );
    await recordAudit(
      c,
      {
        action: 'issue.update',
        repo: loaded.repo,
        target: { number: parent.number, change: 'sub_issues', removed: child.number },
      },
      [
        c.env.DB.prepare(
          'DELETE FROM issue_links WHERE parent_id = ? AND child_id = ?',
        ).bind(parent.id, child.id),
        eventStatement(c.env, parent.id, actor, 'sub_issue_removed', {
          number: child.number,
        }),
        eventStatement(c.env, child.id, actor, 'parent_removed', {
          number: parent.number,
        }),
        touch(c, parent),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.put(`${base}/issues/:number/sub-issues`, async (c) => {
  try {
    const loaded = await loadTriageRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const parent = await loadIssue(c, loaded.repo);
    const { order } = parse(subIssueOrderInput, await readJsonBody(c));
    const children = await q<{ id: number; number: number }>(
      c.env,
      `SELECT i.id, i.number FROM issue_links k JOIN issues i ON i.id = k.child_id
        WHERE k.parent_id = ?`,
      [parent.id],
    );
    const sorted = (xs: number[]): string => [...xs].sort((a, b) => a - b).join(',');
    if (sorted(order) !== sorted(children.map((x) => x.number)))
      throw new ApiError(400, 'invalid_order', 'List every sub-issue exactly once');
    await recordAudit(
      c,
      {
        action: 'issue.update',
        repo: loaded.repo,
        target: { number: parent.number, change: 'sub_issue_order', order },
      },
      [
        ...order.map((n, i) =>
          c.env.DB.prepare(
            'UPDATE issue_links SET position = ? WHERE parent_id = ? AND child_id = ?',
          ).bind(i + 1, parent.id, children.find((x) => x.number === n)!.id),
        ),
        touch(c, parent),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.get(`${base}/issue-templates`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const canRead = await pathReadFilter(c, loaded.repo);
    return c.json(await listTemplates(c.env, loaded.repo, canRead));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Labels and milestones
// ---------------------------------------------------------------------------

issuesRoutes.get(`${base}/labels`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const labels = await q<Label>(
      c.env,
      'SELECT id, name, color, description FROM labels WHERE repo_id = ? ORDER BY name',
      [loaded.repo.id],
    );
    return c.json({ labels });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const createLabel = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[^,]+$/, 'Label names cannot contain commas'),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/, 'Colour must be six hex digits')
    .transform((s) => s.replace('#', '').toLowerCase()),
  description: z.string().max(100).default(''),
});

issuesRoutes.post(`${base}/labels`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const input = parse(createLabel, await readJsonBody(c));
    if (
      await q1(c.env, 'SELECT 1 FROM labels WHERE repo_id = ? AND name = ?', [
        loaded.repo.id,
        input.name,
      ])
    )
      throw new ApiError(409, 'label_exists', `Label ${input.name} already exists`);
    await recordAudit(
      c,
      { action: 'label.create', repo: loaded.repo, target: { name: input.name } },
      [
        c.env.DB.prepare(
          'INSERT INTO labels (repo_id, name, color, description) VALUES (?,?,?,?)',
        ).bind(loaded.repo.id, input.name, input.color, input.description),
      ],
    );
    const [label] = await resolveLabels(c, loaded.repo.id, [input.name]);
    return c.json({ label }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.delete(`${base}/labels/:name`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const [label] = await resolveLabels(c, loaded.repo.id, [c.req.param('name')]);
    await recordAudit(
      c,
      { action: 'label.delete', repo: loaded.repo, target: { name: label!.name } },
      [
        c.env.DB.prepare('DELETE FROM issue_labels WHERE label_id = ?').bind(label!.id),
        c.env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(label!.id),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

issuesRoutes.get(`${base}/milestones`, async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const milestones = await q<
      Milestone & { open_issues: number; closed_issues: number }
    >(
      c.env,
      `SELECT m.id, m.title, m.description, m.due_at, m.state, m.created_at,
              SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END) AS open_issues,
              SUM(CASE WHEN i.state = 'closed' THEN 1 ELSE 0 END) AS closed_issues
         FROM milestones m LEFT JOIN issues i ON i.milestone_id = m.id
        WHERE m.repo_id = ? GROUP BY m.id ORDER BY m.state DESC, m.due_at, m.id`,
      [loaded.repo.id],
    );
    return c.json({ milestones });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const milestoneInput = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  due_at: z.number().int().positive().nullable().default(null),
});

issuesRoutes.post(`${base}/milestones`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const input = parse(milestoneInput, await readJsonBody(c));
    if (
      await q1(c.env, 'SELECT 1 FROM milestones WHERE repo_id = ? AND title = ?', [
        loaded.repo.id,
        input.title,
      ])
    )
      throw new ApiError(
        409,
        'milestone_exists',
        `Milestone ${input.title} already exists`,
      );
    await recordAudit(
      c,
      { action: 'milestone.create', repo: loaded.repo, target: { title: input.title } },
      [
        c.env.DB.prepare(
          `INSERT INTO milestones (repo_id, title, description, due_at, created_at)
           VALUES (?,?,?,?,?)`,
        ).bind(loaded.repo.id, input.title, input.description, input.due_at, Date.now()),
      ],
    );
    const milestone = await q1<Milestone>(
      c.env,
      `SELECT id, title, description, due_at, state, created_at FROM milestones
        WHERE repo_id = ? AND title = ?`,
      [loaded.repo.id, input.title],
    );
    return c.json({ milestone }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Keys are fixed by the schema, so they are safe to name in the UPDATE.
export const updateMilestone = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    due_at: z.number().int().positive().nullable().optional(),
    state: z.enum(['open', 'closed']).optional(),
  })
  .strict();

issuesRoutes.patch(`${base}/milestones/:id`, async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const id = parse(numberParam, c.req.param('id'));
    await checkMilestone(c, loaded.repo.id, id);
    const input = parse(updateMilestone, await readJsonBody(c));
    const fields = Object.entries(input).filter(([, v]) => v !== undefined);
    if (fields.length) {
      await recordAudit(
        c,
        {
          action: 'milestone.update',
          repo: loaded.repo,
          target: { id, fields: fields.map(([k]) => k) },
        },
        [
          c.env.DB.prepare(
            `UPDATE milestones SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
          ).bind(...fields.map(([, v]) => v), id),
        ],
      );
    }
    const milestone = await q1<Milestone>(
      c.env,
      'SELECT id, title, description, due_at, state, created_at FROM milestones WHERE id = ?',
      [id],
    );
    return c.json({ milestone });
  } catch (err) {
    return errorResponse(c, err);
  }
});
