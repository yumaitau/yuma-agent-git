import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import type { RepoRecord } from '../../db/client';
import { githubRepository } from '../../webhooks/payloads';
import {
  apiUrl,
  cursorOf,
  gh,
  iso,
  loadRepo,
  native,
  originOf,
  paged,
  PREFIX,
} from './native';
import type { Ctx } from './native';

/** GitHub `repository` object: the webhook shape (#75) plus the REST URLs. */
export async function ghRepo(c: Ctx, repo: RepoRecord, canAdmin?: boolean) {
  return {
    ...(await githubRepository(repo, originOf(c))),
    url: apiUrl(c, `/repos/${repo.slug}`),
    visibility: repo.visibility,
    created_at: iso(repo.created_at),
    ...(canAdmin === undefined ? {} : { permissions: { admin: canAdmin } }),
  };
}

export const reposRoutes = new Hono<AppEnv>();

reposRoutes.get(
  `${PREFIX}/repos/:owner/:repo`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    return c.json(await ghRepo(c, repo.record, repo.can_admin));
  }),
);

const listSchema = z.object({
  repos: z.array(z.looseObject({ id: z.string(), slug: z.string() })),
  next_cursor: z.string().nullable(),
});

reposRoutes.get(
  `${PREFIX}/user/repos`,
  gh(async (c) => {
    const { items: repos } = await paged(c, async (cursor) => {
      const data = listSchema.parse(
        await native(
          c,
          'GET',
          `/repos?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      return { items: data.repos as RepoRecord[], next: cursorOf(data.next_cursor) };
    });
    return c.json(await Promise.all(repos.map((r) => ghRepo(c, r))));
  }),
);
