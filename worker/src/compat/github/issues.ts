import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import type { Issue, IssueComment, IssueDetail, Label } from '../../../shared/issues';
import {
  apiUrl,
  cursorOf,
  gh,
  ghBody,
  iso,
  loadRepo,
  native,
  originOf,
  paged,
  parseGh,
  param,
  PREFIX,
  type Ctx,
  type Repo,
} from './native';
import { usersOf, type GhUser } from './users';

/** Issues, issue comments and labels, mapped onto the native issue routes (#38). */
export const issuesRoutes = new Hono<AppEnv>();
const REPO = `${PREFIX}/repos/:owner/:repo`;

export function ghLabel(c: Ctx, repo: Repo, label: Label) {
  return {
    id: label.id,
    node_id: `${repo.record.id}:label:${label.id}`,
    url: apiUrl(c, `/repos/${repo.record.slug}/labels/${encodeURIComponent(label.name)}`),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function ghIssue(c: Ctx, repo: Repo, issue: Issue, user: (principal: string) => GhUser) {
  const url = apiUrl(c, `/repos/${repo.record.slug}/issues/${issue.number}`);
  const assignees = issue.assignees.map(user);
  return {
    id: issue.id,
    // the webhook payload's node id (#75), so both surfaces agree
    node_id: `${repo.record.id}:issue:${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    locked: issue.locked,
    user: user(`user:${issue.author_id}`),
    labels: issue.labels.map((l) => ghLabel(c, repo, l)),
    assignee: assignees[0] ?? null,
    assignees,
    milestone:
      issue.milestone_id === null
        ? null
        : { id: issue.milestone_id, number: issue.milestone_id },
    url,
    repository_url: apiUrl(c, `/repos/${repo.record.slug}`),
    comments_url: `${url}/comments`,
    labels_url: `${url}/labels{/name}`,
    html_url: `${originOf(c)}/r/${repo.record.slug}/issues/${issue.number}`,
    created_at: iso(issue.created_at),
    updated_at: iso(issue.updated_at),
    closed_at: iso(issue.closed_at),
  };
}

/** Map a page of issues with one login lookup. */
export async function ghIssues(c: Ctx, repo: Repo, issues: Issue[]) {
  const principals = issues.flatMap((i) => [`user:${i.author_id}`, ...i.assignees]);
  const toUser = await usersOf(c, principals);
  const users = new Map<string, GhUser>();
  for (const p of new Set(principals)) users.set(p, await toUser(p));
  return issues.map((i) => ghIssue(c, repo, i, (p) => users.get(p) as GhUser));
}

async function ghComment(c: Ctx, repo: Repo, issue: number, comment: IssueComment) {
  const toUser = await usersOf(c, [`user:${comment.author_id}`]);
  return {
    id: comment.id,
    node_id: `${repo.record.id}:issue_comment:${comment.id}`,
    body: comment.body,
    user: await toUser(`user:${comment.author_id}`),
    url: apiUrl(c, `/repos/${repo.record.slug}/issues/comments/${comment.id}`),
    issue_url: apiUrl(c, `/repos/${repo.record.slug}/issues/${issue}`),
    html_url: `${originOf(c)}/r/${repo.record.slug}/issues/${issue}#comment-${comment.id}`,
    created_at: iso(comment.created_at),
    updated_at: iso(comment.updated_at),
  };
}

export const listIssuesQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.string().optional().describe('Comma-separated label names (all must match)'),
  assignee: z.string().optional().describe('A login, or `none`'),
  milestone: z.string().optional().describe('A milestone number, or `none`'),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const issueList = z.object({
  issues: z.array(z.looseObject({ number: z.number() })),
  next_cursor: z.number().nullable(),
});

/** The native list query for GitHub's issue filters (also used by search). */
export function nativeIssueQuery(filters: {
  state?: string;
  labels?: string;
  assignee?: string;
  milestone?: string;
}): URLSearchParams {
  const params = new URLSearchParams({ limit: '100', state: filters.state ?? 'open' });
  if (filters.labels) params.set('label', filters.labels);
  if (filters.assignee && filters.assignee !== '*')
    params.set('assignee', filters.assignee);
  if (filters.milestone && filters.milestone !== '*')
    params.set('milestone', filters.milestone);
  return params;
}

/**
 * Issues matching the native filters (and `keep`), page by page (GitHub
 * `page`/`per_page`).
 */
export function listIssues(
  c: Ctx,
  repo: Repo,
  params: URLSearchParams,
  keep: (issue: Issue) => boolean = () => true,
) {
  return paged(c, async (cursor) => {
    const query = new URLSearchParams(params);
    if (cursor !== null) query.set('before', cursor);
    const data = issueList.parse(await native(c, 'GET', `${repo.path}/issues?${query}`));
    return {
      items: (data.issues as unknown as Issue[]).filter(keep),
      next: cursorOf(data.next_cursor),
    };
  });
}

issuesRoutes.get(
  `${REPO}/issues`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const query = parseGh(listIssuesQuery, c.req.query());
    const { items } = await listIssues(c, repo, nativeIssueQuery(query));
    return c.json(await ghIssues(c, repo, items));
  }),
);

const labelName = z
  .union([z.string(), z.object({ name: z.string() })])
  .transform((l) => (typeof l === 'string' ? l : l.name));

export const createIssueBody = z.object({
  title: z.string(),
  body: z.string().nullable().optional(),
  labels: z.array(labelName).optional(),
  assignee: z.string().nullable().optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().int().nullable().optional(),
});

issuesRoutes.post(
  `${REPO}/issues`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createIssueBody, await ghBody(c));
    const { issue } = await native<{ issue: Issue }>(c, 'POST', `${repo.path}/issues`, {
      title: input.title,
      body: input.body ?? '',
      labels: input.labels ?? [],
      assignees: input.assignees ?? (input.assignee ? [input.assignee] : []),
      milestone_id: input.milestone ?? null,
    });
    return c.json((await ghIssues(c, repo, [issue]))[0], 201);
  }),
);

async function detail(c: Ctx, repo: Repo): Promise<IssueDetail> {
  return native<IssueDetail>(
    c,
    'GET',
    `${repo.path}/issues/${encodeURIComponent(param(c, 'number'))}`,
  );
}

issuesRoutes.get(
  `${REPO}/issues/:number`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { issue, comments } = await detail(c, repo);
    return c.json({
      ...(await ghIssues(c, repo, [issue]))[0],
      comments: comments.length,
    });
  }),
);

export const updateIssueBody = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']).optional(),
  state_reason: z
    .enum(['completed', 'not_planned', 'duplicate', 'reopened'])
    .nullable()
    .optional(),
  milestone: z.number().int().nullable().optional(),
  labels: z.array(labelName).optional(),
  assignees: z.array(z.string()).optional(),
});

issuesRoutes.patch(
  `${REPO}/issues/:number`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(updateIssueBody, await ghBody(c));
    const path = `${repo.path}/issues/${encodeURIComponent(param(c, 'number'))}`;
    let { issue } = await native<{ issue: Issue }>(c, 'PATCH', path, {
      title: input.title,
      body: input.body ?? undefined,
      state: input.state,
      // `reopened` is what reopening records; the forge sets it itself
      state_reason:
        input.state_reason === 'reopened' ? undefined : (input.state_reason ?? undefined),
      milestone_id: input.milestone,
    });
    if (input.labels !== undefined)
      ({ issue } = await native<{ issue: Issue }>(c, 'PUT', `${path}/labels`, {
        labels: input.labels,
      }));
    if (input.assignees !== undefined)
      ({ issue } = await native<{ issue: Issue }>(c, 'PUT', `${path}/assignees`, {
        assignees: input.assignees,
      }));
    return c.json((await ghIssues(c, repo, [issue]))[0]);
  }),
);

issuesRoutes.get(
  `${REPO}/issues/:number/comments`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { issue, comments } = await detail(c, repo);
    return c.json(
      await Promise.all(comments.map((x) => ghComment(c, repo, issue.number, x))),
    );
  }),
);

export const commentBody = z.object({ body: z.string() });

issuesRoutes.post(
  `${REPO}/issues/:number/comments`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(commentBody, await ghBody(c));
    const number = Number(param(c, 'number'));
    const { comment } = await native<{ comment: IssueComment }>(
      c,
      'POST',
      `${repo.path}/issues/${number}/comments`,
      input,
    );
    return c.json(await ghComment(c, repo, number, comment), 201);
  }),
);

export const issueLabelsBody = z.object({ labels: z.array(labelName) });

/** POST adds labels (GitHub semantics), PUT replaces them; both end in the native PUT. */
for (const method of ['post', 'put'] as const) {
  issuesRoutes[method](
    `${REPO}/issues/:number/labels`,
    gh(async (c) => {
      const repo = await loadRepo(c);
      const input = parseGh(issueLabelsBody, await ghBody(c));
      const current =
        method === 'post' ? (await detail(c, repo)).issue.labels.map((l) => l.name) : [];
      const { issue } = await native<{ issue: Issue }>(
        c,
        'PUT',
        `${repo.path}/issues/${encodeURIComponent(param(c, 'number'))}/labels`,
        { labels: [...new Set([...current, ...input.labels])] },
      );
      return c.json(issue.labels.map((l) => ghLabel(c, repo, l)));
    }),
  );
}

issuesRoutes.get(
  `${REPO}/labels`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { labels } = await native<{ labels: Label[] }>(c, 'GET', `${repo.path}/labels`);
    return c.json(labels.map((l) => ghLabel(c, repo, l)));
  }),
);

export const createLabelBody = z.object({
  name: z.string(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
});

issuesRoutes.post(
  `${REPO}/labels`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createLabelBody, await ghBody(c));
    const { label } = await native<{ label: Label }>(c, 'POST', `${repo.path}/labels`, {
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
    });
    return c.json(ghLabel(c, repo, label), 201);
  }),
);
