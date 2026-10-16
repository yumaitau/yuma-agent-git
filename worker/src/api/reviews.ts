import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Principal } from '../auth/principal';
import type { RepoWithCreator } from '../auth/rbac';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { errorResponse, readJsonBody } from './errors';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import { linkReferences } from '../collab/references';
import { getPull, type Pull } from '../reviews/pulls';
import {
  authorKey,
  getThread,
  listThreads,
  parseSuggestion,
  reviewCommentInput,
} from '../reviews/threads';
import { autoCheck } from './collaboration';
import {
  agentCanReview,
  loadCodeowners,
  ownersOf,
  pullCodeowners,
  requestCodeOwners,
} from '../reviews/codeowners';
import { resolveRevision } from '../core/read';
import { requestAgentReviews } from '../reviews/agentLoop';
import { principalNames, resolveAssignees } from './issues';
import type { ReviewRequest, ReviewThread } from '../../shared/collaboration';

/**
 * Line-level review (issue #39): threads on lines of a pull request revision,
 * replies, resolution, suggested changes and review requests. Like the rest
 * of the pull request surface they need whole-repository access (comments
 * quote source lines); writes need `write` and, for agents, `pulls:write`.
 * Starting a thread and applying suggestions run in the target ref's Durable
 * Object with merges and revision updates (reviews/pulls.ts).
 */
export const reviewsRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}/pulls/:id';
reviewsRoutes.use(`${base}/*`, async (c, next) => {
  await next();
  c.header('cache-control', 'private, no-store');
});

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

const revisionFields = { head_cs: z.string(), revision: z.int() };
export const createThreadInput = reviewCommentInput.and(z.object(revisionFields));
export const replyInput = z.object({ body: z.string().trim().min(1).max(65536) });
export const resolutionInput = z.object({ resolved: z.boolean() });
export const applySuggestionsInput = z.object({
  comment_ids: z.array(z.int().positive()).min(1).max(50),
  message: z.string().trim().min(1).max(65536).optional(),
  ...revisionFields,
});
export const reviewersInput = z.object({
  reviewers: z.array(z.string().min(1).max(200)).max(15),
});

function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal') as Principal; // `/api/*` already refused anonymous callers
}

type Loaded = { repo: RepoWithCreator; pull: Pull };

/** The pull for a write: agents need `pulls:write`, and closed pulls take no changes. */
async function writablePull(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
): Promise<Loaded | Response> {
  const denied = requireAgentScope(c, 'pulls:write');
  if (denied) return denied;
  const pull = await getPull(c.env, repo.id, Number(c.req.param('id')));
  if (pull.state === 'merged' || pull.state === 'closed')
    throw new ApiError(409, 'pull_closed', 'This pull request is closed.');
  return { repo, pull };
}

/** Forward to the pull's ref-lock Durable Object (see `mutatePullLocked`). */
function locked(
  c: Context<AppEnv>,
  { repo, pull }: Loaded,
  action: string,
  body: unknown,
): Promise<Response> {
  const stub = c.env.REF_LOCK.get(
    c.env.REF_LOCK.idFromName(`${repo.id}:${pull.base_ref}`),
  );
  return stub.fetch(`https://ref-lock/pull/${action}`, {
    method: 'POST',
    body: JSON.stringify({
      repo_id: repo.id,
      id: pull.id,
      actor: principalOf(c).userId,
      principal: principalOf(c),
      body,
    }),
  });
}

async function oneThread(
  c: Context<AppEnv>,
  pull: Pull,
  id: number,
): Promise<ReviewThread> {
  const [thread] = await listThreads(c.env, pull, id);
  if (!thread) throw new ApiError(404, 'thread_not_found', 'Review thread not found');
  return thread;
}

function referenceSource(repo: RepoWithCreator, pull: Pull) {
  return { kind: 'pull' as const, repo: repo.slug, ref: pull.number };
}

reviewsRoutes.get(`${base}/threads`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const pull = await getPull(c.env, repo.repo.id, Number(c.req.param('id')));
    const threads = await listThreads(c.env, pull);
    return c.json({
      threads,
      names: await principalNames(
        c,
        threads.flatMap((t) => [
          t.author,
          ...(t.resolved_by ? [t.resolved_by] : []),
          ...t.comments.map((x) => x.author),
        ]),
      ),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** The `pull_request_review_thread` webhook event (#75); returns the thread. */
async function emitThread(
  c: Context<AppEnv>,
  loaded: Loaded,
  action: 'created' | 'replied' | 'resolved' | 'unresolved',
  id: number,
): Promise<ReviewThread> {
  const thread = await oneThread(c, loaded.pull, id);
  await emitEvent(c.env, loaded.repo, {
    event: 'pull_request_review_thread',
    action,
    actor: actorOf(c.get('principal')),
    origin: new URL(c.req.url).origin,
    data: { pull_request: loaded.pull, thread },
  });
  return thread;
}

reviewsRoutes.post(`${base}/threads`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const loaded = await writablePull(c, repo.repo);
    if (loaded instanceof Response) return loaded;
    const input = parse(createThreadInput, await readJsonBody(c));
    const response = await locked(c, loaded, 'thread', input);
    if (!response.ok) return new Response(response.body, response);
    const { thread_id } = (await response.json()) as { thread_id: number };
    await recordAudit(c, {
      action: 'pull.thread.create',
      repo: loaded.repo,
      target: { pull_id: loaded.pull.id, thread_id, path: input.path, side: input.side },
    });
    await linkReferences(
      c,
      loaded.repo,
      referenceSource(loaded.repo, loaded.pull),
      input.body,
    );
    return c.json({ thread: await emitThread(c, loaded, 'created', thread_id) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

reviewsRoutes.post(`${base}/threads/:thread/replies`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const loaded = await writablePull(c, repo.repo);
    if (loaded instanceof Response) return loaded;
    const thread = await getThread(c.env, loaded.pull, Number(c.req.param('thread')));
    const { body } = parse(replyInput, await readJsonBody(c));
    const suggestion = parseSuggestion(body);
    if (suggestion !== null && thread.side !== 'head')
      throw new ApiError(
        400,
        'invalid_suggestion',
        'Suggest changes on lines of the proposed revision',
      );
    await recordAudit(
      c,
      {
        action: 'pull.thread.reply',
        repo: loaded.repo,
        target: { pull_id: loaded.pull.id, thread_id: thread.id },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO review_comments (thread_id, author, body, suggestion_patch, created_at)
           VALUES (?,?,?,?,?)`,
        ).bind(thread.id, authorKey(principalOf(c)), body, suggestion, Date.now()),
      ],
    );
    await linkReferences(c, loaded.repo, referenceSource(loaded.repo, loaded.pull), body);
    return c.json({ thread: await emitThread(c, loaded, 'replied', thread.id) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

reviewsRoutes.put(`${base}/threads/:thread/resolution`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const loaded = await writablePull(c, repo.repo);
    if (loaded instanceof Response) return loaded;
    const thread = await getThread(c.env, loaded.pull, Number(c.req.param('thread')));
    const { resolved } = parse(resolutionInput, await readJsonBody(c));
    await recordAudit(
      c,
      {
        action: resolved ? 'pull.thread.resolve' : 'pull.thread.unresolve',
        repo: loaded.repo,
        target: { pull_id: loaded.pull.id, thread_id: thread.id },
      },
      [
        c.env.DB.prepare(
          'UPDATE review_threads SET resolved_by = ?, resolved_at = ? WHERE id = ?',
        ).bind(
          resolved ? authorKey(principalOf(c)) : null,
          resolved ? Date.now() : null,
          thread.id,
        ),
      ],
    );
    const action = resolved ? 'resolved' : 'unresolved';
    return c.json({ thread: await emitThread(c, loaded, action, thread.id) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

reviewsRoutes.post(`${base}/suggestions/apply`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const loaded = await writablePull(c, repo.repo);
    if (loaded instanceof Response) return loaded;
    const input = parse(applySuggestionsInput, await readJsonBody(c));
    const response = await locked(c, loaded, 'apply_suggestions', input);
    if (!response.ok) return new Response(response.body, response);
    const data = (await response.json()) as { pull: Pull; changeset: { id: string } };
    await recordAudit(c, {
      action: 'pull.suggestion.apply',
      repo: loaded.repo,
      target: {
        pull_id: loaded.pull.id,
        comment_ids: input.comment_ids,
        changeset: data.changeset.id,
      },
    });
    await requestCodeOwners(c, loaded.repo, data.pull);
    await requestAgentReviews(
      c.env,
      loaded.repo,
      data.pull,
      actorOf(c.get('principal')),
      new URL(c.req.url).origin,
    );
    return c.json({ ...data, ci: await autoCheck(c, loaded.repo, data.pull) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function reviewRequests(
  c: Context<AppEnv>,
  pull: Pull,
): Promise<{ review_requests: ReviewRequest[]; names: Record<string, string> }> {
  const rows = await q<ReviewRequest>(
    c.env,
    `SELECT principal, requested_by, state, created_at, updated_at FROM review_requests
      WHERE pull_id = ? ORDER BY created_at, principal`,
    [pull.id],
  );
  return {
    review_requests: rows,
    names: await principalNames(
      c,
      rows.flatMap((r) => [r.principal, r.requested_by]),
    ),
  };
}

/**
 * Normalise reviewers to principals: people, teams and API tokens as issue
 * assignees are (#38), plus agent identities (#57) that may work on the repo.
 */
async function resolveReviewers(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  pull: Pull,
  inputs: readonly string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const input of inputs) {
    const id = input.startsWith('agent:') ? input.slice(6) : null;
    const agent =
      id === null
        ? null
        : await q1<{
            owner_kind: string;
            owner_id: string;
            allowed_repos: string | null;
          }>(
            c.env,
            'SELECT owner_kind, owner_id, allowed_repos FROM agents WHERE id = ? AND disabled = 0',
            [id],
          );
    if (agent) {
      if (!(await agentCanReview(c.env, repo, agent)))
        throw new ApiError(400, 'invalid_reviewer', `${input} cannot review here`);
      out.add(`agent:${id}`);
      continue;
    }
    const [principal] = await resolveAssignees(c, repo, [input]);
    if (principal === `user:${pull.author_id}`)
      throw new ApiError(
        400,
        'invalid_reviewer',
        'Authors cannot review their own pull requests',
      );
    out.add(principal!);
  }
  return [...out];
}

reviewsRoutes.get(`${base}/reviewers`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const pull = await getPull(c.env, repo.repo.id, Number(c.req.param('id')));
    return c.json(await reviewRequests(c, pull));
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Replace the requested reviewers; a request already answered keeps its state. */
reviewsRoutes.put(`${base}/reviewers`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const loaded = await writablePull(c, repo.repo);
    if (loaded instanceof Response) return loaded;
    const { reviewers } = parse(reviewersInput, await readJsonBody(c));
    const wanted = await resolveReviewers(c, loaded.repo, loaded.pull, reviewers);
    const current = (
      await q<{ principal: string }>(
        c.env,
        'SELECT principal FROM review_requests WHERE pull_id = ?',
        [loaded.pull.id],
      )
    ).map((r) => r.principal);
    const added = wanted.filter((p) => !current.includes(p));
    const removed = current.filter((p) => !wanted.includes(p));
    if (added.length + removed.length > 0) {
      const now = Date.now();
      const by = authorKey(principalOf(c));
      await recordAudit(
        c,
        {
          action: 'pull.reviewers.update',
          repo: loaded.repo,
          target: { pull_id: loaded.pull.id, added, removed },
        },
        [
          ...added.map((p) =>
            c.env.DB.prepare(
              `INSERT INTO review_requests (pull_id, principal, requested_by, state, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', ?, ?)`,
            ).bind(loaded.pull.id, p, by, now, now),
          ),
          ...removed.map((p) =>
            c.env.DB.prepare(
              'DELETE FROM review_requests WHERE pull_id = ? AND principal = ?',
            ).bind(loaded.pull.id, p),
          ),
        ],
      );
    }
    return c.json(await reviewRequests(c, loaded.pull));
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Owners of each file the pull request changes and whether one approved (#40). */
reviewsRoutes.get(`${base}/codeowners`, async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const pull = await getPull(c.env, repo.repo.id, Number(c.req.param('id')));
    const owned = await pullCodeowners(c.env, repo.repo, pull);
    return c.json({
      ...owned,
      names: await principalNames(
        c,
        owned.files.flatMap((f) => f.owners),
      ),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * The CODEOWNERS file at a revision (#40; default: the default branch), its
 * rules with resolved owners and its errors, and with `path` that path's
 * owners. Whole-repository read, since the file names paths across the tree.
 * Registered after the pull route: `:repo{.+}` would also match `…/pulls/:id`.
 */
reviewsRoutes.get('/repos/:repo{.+}/codeowners', async (c) => {
  try {
    const repo = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!repo.ok) return repo.response;
    const rev = c.req.query('rev') ?? `ref:${repo.repo.default_branch}`;
    const cs = await resolveRevision(c.env, repo.repo.id, rev);
    const codeowners = await loadCodeowners(c.env, repo.repo, cs.id);
    const path = c.req.query('path');
    c.header('cache-control', 'private, no-store');
    return c.json({
      ...codeowners,
      ...(path === undefined ? {} : { owners: ownersOf(codeowners, path) }),
      names: await principalNames(
        c,
        codeowners.rules.flatMap((r) => r.owners),
      ),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
