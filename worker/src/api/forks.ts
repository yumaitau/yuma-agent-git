import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { can } from '../auth/rbac';
import { recordAudit, actorOf } from '../audit/record';
import { createRepo } from '../db/repos';
import { parseRepoRow, q } from '../db/client';
import { emitEvent } from '../webhooks/events';
import { apiError, errorResponse, readJsonBody } from './errors';
import { newRepoOwner } from './repos';

/**
 * Forks (issue #36): `POST /repos/:repo/forks` makes a repo in the upstream's
 * network (core/network.ts). Content is shared, so a fork costs one repo row
 * plus a copy of the branch and tag refs, whatever the repository's size.
 * Pull requests from a fork go to the upstream with `head_repo`.
 */
export const forksRoutes = new Hono<AppEnv>();

export const createForkSchema = z.object({
  /** `owner/name`; defaults to the caller's login and the upstream's name. */
  slug: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'slug must be owner/name')
    .optional(),
  org: z.string().min(1).max(39).optional(),
});

forksRoutes.post('/repos/:repo{.+}/forks', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    // a fork carries every path, so path-restricted callers cannot fork
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const upstream = loaded.repo;
    const parsed = createForkSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid fork request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const slug = parsed.data.slug ?? `${user.login}/${upstream.slug.split('/')[1]}`;
    const owner = await newRepoOwner(c, user.id, slug, parsed.data.org);
    if (!owner.ok) return owner.response;
    // a fork never widens visibility: forks of private repos stay private
    const fork = await createRepo(c.env, {
      slug,
      visibility: upstream.visibility,
      defaultBranch: upstream.default_branch,
      createdBy: user.id,
      forkOf: upstream.id,
      ...(owner.org ? { ownerKind: 'org' as const, ownerId: owner.org.id } : {}),
    });
    const now = Date.now();
    // branches and tags only: agent work refs and merge queue refs stay behind
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE repos SET refs_mode = ?, merge_methods = ?, default_merge_method = ?
          WHERE id = ?`,
      ).bind(
        upstream.refs_mode ?? 'scion',
        JSON.stringify(upstream.merge_methods ?? ['merge', 'squash', 'rebase']),
        upstream.default_merge_method ?? 'merge',
        fork.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO refs (repo_id, name, head, updated_at)
         SELECT ?, name, head, ? FROM refs
          WHERE repo_id = ? AND (name NOT LIKE 'refs/%' OR name LIKE 'refs/tags/%')`,
      ).bind(fork.id, now, upstream.id),
      c.env.DB.prepare(
        `INSERT INTO tags (repo_id, name, target_cs, tagger, message, signature, created_at)
         SELECT ?, name, target_cs, tagger, message, signature, created_at
           FROM tags WHERE repo_id = ?`,
      ).bind(fork.id, upstream.id),
    ]);
    const repo = {
      ...fork,
      refs_mode: upstream.refs_mode ?? 'scion',
      merge_methods: upstream.merge_methods,
      default_merge_method: upstream.default_merge_method ?? 'merge',
    };
    const target = { upstream: upstream.slug, fork: repo.slug, fork_id: repo.id };
    await recordAudit(c, { action: 'repo.fork', repo: upstream, target });
    await emitEvent(c.env, upstream, {
      event: 'fork',
      action: 'created',
      actor: actorOf(c.get('principal')),
      origin: new URL(c.req.url).origin,
      data: { forkee: { id: repo.id, slug: repo.slug, visibility: repo.visibility } },
    });
    return c.json({ repo }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Forks of a repo the caller can read, newest first. */
forksRoutes.get('/repos/:repo{.+}/forks', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      'SELECT * FROM repos WHERE fork_of = ? ORDER BY created_at DESC LIMIT 200',
      [loaded.repo.id],
    );
    const forks = [];
    for (const row of rows) {
      const repo = parseRepoRow(row);
      if (await can(c.env, repo, c.get('principal'), 'read')) forks.push(repo);
    }
    return c.json({ forks });
  } catch (err) {
    return errorResponse(c, err);
  }
});
