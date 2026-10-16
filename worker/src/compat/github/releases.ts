import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import type { Release } from '../../../shared/releases';
import { ApiError } from '../../core/errors';
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
  shasOf,
  type Ctx,
  type Repo,
} from './native';
import { usersOf } from './users';

/**
 * Releases, mapped onto the native release routes (#54). Release and asset
 * ids are the forge's string ids. `upload_url` points at the native asset
 * upload, which takes the same `?name=` and raw body as GitHub's.
 */
export const releasesRoutes = new Hono<AppEnv>();
const REPO = `${PREFIX}/repos/:owner/:repo`;

async function ghReleases(c: Ctx, repo: Repo, releases: Release[]) {
  const shas = await shasOf(
    c,
    repo.record.id,
    releases.map((r) => r.target_cs),
  );
  const toUser = await usersOf(c, [
    ...releases.map((r) => `user:${r.created_by}`),
    ...releases.flatMap((r) => r.assets.map((a) => `user:${a.uploaded_by}`)),
  ]);
  const nativeBase = `${originOf(c)}/api/v1/repos/${repo.record.slug}/releases`;
  return Promise.all(
    releases.map(async (r) => ({
      id: r.id,
      node_id: `${repo.record.id}:release:${r.id}`,
      tag_name: r.tag,
      target_commitish: shas.get(r.target_cs),
      name: r.name,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      created_at: iso(r.created_at),
      published_at: iso(r.published_at),
      author: await toUser(`user:${r.created_by}`),
      url: apiUrl(c, `/repos/${repo.record.slug}/releases/${r.id}`),
      html_url: `${originOf(c)}/r/${repo.record.slug}/releases`,
      upload_url: `${nativeBase}/${r.id}/assets{?name,label}`,
      assets: await Promise.all(
        r.assets.map(async (a) => ({
          id: a.id,
          node_id: `${repo.record.id}:release_asset:${a.id}`,
          name: a.name,
          content_type: a.content_type,
          size: a.size,
          state: 'uploaded',
          digest: `sha256:${a.sha256}`,
          uploader: await toUser(`user:${a.uploaded_by}`),
          created_at: iso(a.created_at),
          browser_download_url: `${nativeBase}/${r.id}/assets/${a.id}`,
        })),
      ),
    })),
  );
}

async function one(c: Ctx, repo: Repo, path: string): Promise<Response> {
  const { release } = await native<{ release: Release }>(c, 'GET', `${repo.path}${path}`);
  return c.json((await ghReleases(c, repo, [release]))[0]);
}

const releaseList = z.object({
  releases: z.array(z.looseObject({ id: z.string() })),
  next_cursor: z.string().nullable(),
});

releasesRoutes.get(
  `${REPO}/releases`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const { items: releases } = await paged(c, async (cursor) => {
      const data = releaseList.parse(
        await native(
          c,
          'GET',
          `${repo.path}/releases?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      return {
        items: data.releases as unknown as Release[],
        next: cursorOf(data.next_cursor),
      };
    });
    return c.json(await ghReleases(c, repo, releases));
  }),
);

export const createReleaseBody = z.object({
  tag_name: z.string().min(1),
  target_commitish: z
    .string()
    .optional()
    .describe('Branch or commit for a new tag (default: the default branch)'),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  generate_release_notes: z.boolean().optional(),
});

releasesRoutes.post(
  `${REPO}/releases`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createReleaseBody, await ghBody(c));
    // Like GitHub, a missing tag is created at target_commitish.
    try {
      await native(c, 'GET', `${repo.path}/refs/refs/tags/${encodeURI(input.tag_name)}`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      await native(c, 'POST', `${repo.path}/tags`, {
        name: input.tag_name,
        target: await changesetOf(
          c,
          repo,
          input.target_commitish ?? repo.record.default_branch,
        ),
      });
    }
    const { release } = await native<{ release: Release }>(
      c,
      'POST',
      `${repo.path}/releases`,
      {
        tag: input.tag_name,
        name: input.name ?? undefined,
        body: input.body ?? undefined,
        draft: input.draft,
        prerelease: input.prerelease,
        generate_notes: input.generate_release_notes,
      },
    );
    return c.json((await ghReleases(c, repo, [release]))[0], 201);
  }),
);

releasesRoutes.get(
  `${REPO}/releases/latest`,
  gh(async (c) => one(c, await loadRepo(c), '/releases/latest')),
);

releasesRoutes.get(
  `${REPO}/releases/tags/:tag{.+}`,
  gh(async (c) =>
    one(c, await loadRepo(c), `/releases/tags/${encodeURI(param(c, 'tag'))}`),
  ),
);

releasesRoutes.get(
  `${REPO}/releases/:id`,
  gh(async (c) =>
    one(c, await loadRepo(c), `/releases/${encodeURIComponent(param(c, 'id'))}`),
  ),
);

export const updateReleaseBody = z.object({
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

releasesRoutes.patch(
  `${REPO}/releases/:id`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(updateReleaseBody, await ghBody(c));
    const { release } = await native<{ release: Release }>(
      c,
      'PATCH',
      `${repo.path}/releases/${encodeURIComponent(param(c, 'id'))}`,
      {
        name: input.name ?? undefined,
        body: input.body ?? undefined,
        draft: input.draft,
        prerelease: input.prerelease,
      },
    );
    return c.json((await ghReleases(c, repo, [release]))[0]);
  }),
);

releasesRoutes.delete(
  `${REPO}/releases/:id`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    await native(
      c,
      'DELETE',
      `${repo.path}/releases/${encodeURIComponent(param(c, 'id'))}`,
    );
    return c.body(null, 204);
  }),
);
