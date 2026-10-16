import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import type { Pull, Review } from '../../../shared/collaboration';
import { MERGE_METHODS } from '../../../shared/collaboration';
import { ApiError } from '../../core/errors';
import { q1 } from '../../db/client';
import { githubPull } from '../../webhooks/payloads';
import {
  apiUrl,
  changesetOf,
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
  shaOf,
  type Ctx,
  type Repo,
} from './native';
import { ghRepo } from './repos';
import { usersOf } from './users';

/** Pull requests and reviews, mapped onto the native pull routes (#38, #39, #42). */
export const pullsRoutes = new Hono<AppEnv>();
const REPO = `${PREFIX}/repos/:owner/:repo`;

interface PullDetail {
  pull: Pull;
  reviews: Review[];
  gate: { mergeable: boolean; reasons: string[] };
}

/**
 * GitHub addresses pull requests by number; native routes by row id. The
 * lookup runs after `loadRepo`, so only readers of the repo reach it.
 */
async function pullPath(c: Ctx, repo: Repo): Promise<string> {
  const row = await q1<{ id: number }>(
    c.env,
    'SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?',
    [repo.record.id, Number(param(c, 'number'))],
  );
  if (!row) throw new ApiError(404, 'pull_not_found', 'Pull request not found');
  return `${repo.path}/pulls/${row.id}`;
}

/** The webhook `pull_request` shape (#75) plus REST URLs and the head/base repos. */
export async function ghPull(c: Ctx, repo: Repo, pull: Pull, gate?: PullDetail['gate']) {
  const base = await githubPull(c.env, repo.record, pull, originOf(c));
  const repository = await ghRepo(c, repo.record);
  const url = apiUrl(c, `/repos/${repo.record.slug}/pulls/${pull.number}`);
  const owner = repo.record.slug.split('/')[0];
  const side = (s: { ref: string; sha: unknown }, cs: string) => ({
    ...s,
    label: `${owner}:${s.ref}`,
    changeset: cs,
    repo: repository,
  });
  const head = base['head'] as { ref: string; sha: string };
  return {
    ...base,
    html_url: base['html_url'] as string,
    url,
    issue_url: apiUrl(c, `/repos/${repo.record.slug}/issues/${pull.number}`),
    statuses_url: apiUrl(c, `/repos/${repo.record.slug}/commits/${head.sha}/statuses`),
    head: side(head, pull.head_cs),
    base: side(base['base'] as { ref: string; sha: string }, pull.base_cs),
    merge_commit_sha: pull.merged_cs
      ? await shaOf(c, repo.record.id, pull.merged_cs)
      : null,
    ...(gate
      ? {
          mergeable: gate.mergeable,
          mergeable_state: gate.mergeable ? 'clean' : 'blocked',
        }
      : {}),
  };
}

const STATES = {
  open: ['open', 'draft'],
  closed: ['closed', 'merged'],
  all: ['open', 'draft', 'closed', 'merged'],
} as const;

export const listPullsQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  base: z.string().optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const pullList = z.object({
  pulls: z.array(z.looseObject({ id: z.number(), state: z.string() })),
  next_cursor: z.number().nullable(),
});

/**
 * Pull requests in a GitHub state (`open`, `closed`, `all`) that `keep`
 * accepts, page by page.
 */
export function listPulls(
  c: Ctx,
  repo: Repo,
  state: keyof typeof STATES,
  keep: (pull: Pull) => boolean = () => true,
) {
  const wanted: readonly string[] = STATES[state];
  return paged(c, async (cursor) => {
    const data = pullList.parse(
      await native(c, 'GET', `${repo.path}/pulls${cursor ? `?before=${cursor}` : ''}`),
    );
    return {
      items: (data.pulls as unknown as Pull[]).filter(
        (p) => wanted.includes(p.state) && keep(p),
      ),
      next: cursorOf(data.next_cursor),
    };
  });
}

pullsRoutes.get(
  `${REPO}/pulls`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const query = parseGh(listPullsQuery, c.req.query());
    const { items } = await listPulls(
      c,
      repo,
      query.state ?? 'open',
      (p) => !query.base || p.base_ref === query.base,
    );
    return c.json(await Promise.all(items.map((p) => ghPull(c, repo, p))));
  }),
);

export const createPullBody = z.object({
  title: z.string(),
  head: z.string().min(1).describe('Branch (or `owner:branch`) holding the changes'),
  base: z.string().min(1).describe('Must be the default branch'),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  maintainer_can_modify: z.boolean().optional(),
});

pullsRoutes.post(
  `${REPO}/pulls`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createPullBody, await ghBody(c));
    if (input.base !== repo.record.default_branch)
      throw new ApiError(
        422,
        'validation_failed',
        `Pull requests target the default branch (${repo.record.default_branch})`,
      );
    const head = input.head.includes(':') ? input.head.split(':')[1]! : input.head;
    const { pull } = await native<{ pull: Pull }>(c, 'POST', `${repo.path}/pulls`, {
      title: input.title,
      body: input.body ?? '',
      head_cs: await changesetOf(c, repo, head),
      draft: input.draft ?? false,
    });
    return c.json(await ghPull(c, repo, pull), 201);
  }),
);

pullsRoutes.get(
  `${REPO}/pulls/:number`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { pull, gate } = await native<PullDetail>(c, 'GET', await pullPath(c, repo));
    return c.json(await ghPull(c, repo, pull, gate));
  }),
);

export const updatePullBody = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']).optional(),
});

pullsRoutes.patch(
  `${REPO}/pulls/:number`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(updatePullBody, await ghBody(c));
    const { pull } = await native<{ pull: Pull }>(
      c,
      'POST',
      `${await pullPath(c, repo)}/update`,
      { title: input.title, body: input.body ?? undefined, state: input.state },
    );
    return c.json(await ghPull(c, repo, pull));
  }),
);

pullsRoutes.get(
  `${REPO}/pulls/:number/merge`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { pull } = await native<PullDetail>(c, 'GET', await pullPath(c, repo));
    return c.body(null, pull.state === 'merged' ? 204 : 404);
  }),
);

export const mergePullBody = z.object({
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  sha: z.string().optional().describe('Merge only if the head is still this commit'),
  merge_method: z.enum(MERGE_METHODS).optional(),
});

pullsRoutes.put(
  `${REPO}/pulls/:number/merge`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(mergePullBody, await ghBody(c));
    const path = await pullPath(c, repo);
    const { pull } = await native<PullDetail>(c, 'GET', path);
    if (input.sha && input.sha !== (await shaOf(c, repo.record.id, pull.head_cs)))
      throw new ApiError(
        409,
        'pull_stale',
        'Head branch was modified. Review and try the merge again.',
      );
    const merged = await native<{ pull: Pull }>(c, 'POST', `${path}/merge`, {
      head_cs: pull.head_cs,
      revision: pull.revision,
      method: input.merge_method,
      commit_title: input.commit_title,
      commit_message: input.commit_message,
    });
    return c.json({
      sha: await shaOf(c, repo.record.id, merged.pull.merged_cs ?? merged.pull.head_cs),
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }),
);

const REVIEW_STATES: Record<string, string> = {
  approve: 'APPROVED',
  request_changes: 'CHANGES_REQUESTED',
  comment: 'COMMENTED',
};

async function ghReviews(c: Ctx, repo: Repo, pull: Pull, reviews: Review[]) {
  const who = (r: Review): string =>
    r.agent_id ? `agent:${r.agent_id}` : `user:${r.author_id}`;
  const toUser = await usersOf(c, reviews.map(who));
  const url = apiUrl(c, `/repos/${repo.record.slug}/pulls/${pull.number}`);
  return Promise.all(
    reviews.map(async (r) => ({
      id: r.id,
      node_id: `${repo.record.id}:review:${r.id}`,
      user: await toUser(who(r)),
      body: r.body,
      state: REVIEW_STATES[r.decision] ?? 'COMMENTED',
      commit_id: await shaOf(c, repo.record.id, r.head_cs),
      submitted_at: iso(r.created_at),
      pull_request_url: url,
      html_url: `${originOf(c)}/r/${repo.record.slug}/pulls/${pull.id}`,
    })),
  );
}

pullsRoutes.get(
  `${REPO}/pulls/:number/reviews`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { pull, reviews } = await native<PullDetail>(c, 'GET', await pullPath(c, repo));
    return c.json(await ghReviews(c, repo, pull, reviews));
  }),
);

export const createReviewBody = z.object({
  body: z.string().optional(),
  event: z
    .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
    .describe('Required: pending (draft) reviews are not supported'),
  commit_id: z.string().optional().describe('Must be the current head commit'),
  comments: z
    .array(
      z.object({
        path: z.string(),
        body: z.string(),
        line: z.int().min(1),
        side: z.enum(['LEFT', 'RIGHT']).optional(),
        start_line: z.int().min(1).optional(),
      }),
    )
    .optional(),
});

pullsRoutes.post(
  `${REPO}/pulls/:number/reviews`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createReviewBody, await ghBody(c));
    const path = await pullPath(c, repo);
    const { pull } = await native<PullDetail>(c, 'GET', path);
    if (
      input.commit_id &&
      input.commit_id !== (await shaOf(c, repo.record.id, pull.head_cs))
    )
      throw new ApiError(409, 'pull_stale', 'Review the current head commit');
    await native(c, 'POST', `${path}/review`, {
      head_cs: pull.head_cs,
      revision: pull.revision,
      decision: input.event.toLowerCase(),
      body: input.body ?? '',
      comments: input.comments?.map((x) => ({
        path: x.path,
        body: x.body,
        line: x.line,
        start_line: x.start_line,
        side: x.side === 'LEFT' ? 'base' : 'head',
      })),
    });
    const { reviews } = await native<PullDetail>(c, 'GET', path);
    const caller = c.get('principal')?.userId;
    const mine = reviews.filter((r) => r.author_id === caller).pop();
    if (!mine) throw new ApiError(500, 'internal_error', 'review not recorded');
    return c.json((await ghReviews(c, repo, pull, [mine]))[0]);
  }),
);
