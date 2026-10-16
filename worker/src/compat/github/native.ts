import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import { ApiError } from '../../core/errors';
import { errorResponse } from '../../api/errors';
import { commitShas } from '../../git/upload-pack';
import { GitProtocolError } from '../../git/pktline';
import { changesetForSha1 } from '../../git/mapping';
import { lookupRevId } from '../../core/read';
import type { RepoRecord } from '../../db/client';

/**
 * GitHub REST compatibility (issue #74). The layer is thin by design: every
 * request is translated into one or more native `/api/v1` calls made as the
 * caller, with the caller's own credentials, so RBAC, path rules, org SSO,
 * agent scopes, guardrails, audit and webhook events apply exactly as they
 * do on the native routes. This module only maps shapes.
 */

export const PREFIX = '/api/github/v3';

export type Ctx = Context<AppEnv>;

/** Call a native `/api/v1` route as the caller; non-2xx throws its error. */
export async function native<T = Record<string, unknown>>(
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  for (const name of ['authorization', 'cookie', 'user-agent', 'cf-connecting-ip']) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  if (body !== undefined) headers.set('content-type', 'application/json');
  // lazy: app.ts mounts this module
  const { app } = await import('../../app');
  const res = await app.fetch(
    new Request(`${new URL(c.req.url).origin}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    c.env,
    c.executionCtx,
  );
  const json: unknown = (res.headers.get('content-type') ?? '').includes('json')
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const error = z
      .object({ error: z.looseObject({ code: z.string(), message: z.string() }) })
      .safeParse(json);
    if (!error.success)
      throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
    const { code, message, ...details } = error.data.error;
    throw new ApiError(res.status, code, message, details);
  }
  return json as T;
}

/**
 * Route wrapper: errors keep the native `{ error: { code, message } }`
 * envelope (with `denied_by` and friends) and gain GitHub's top-level
 * `message`, which Octokit and gh print.
 */
export function gh(fn: (c: Ctx) => Promise<Response>): Handler<AppEnv> {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      const res = errorResponse(c, err);
      const body = (await res.json()) as { error: { message: string } };
      return c.json(
        { message: body.error.message, ...body },
        res.status as ContentfulStatusCode,
      );
    }
  };
}

/** Parse a GitHub-shaped request with zod; GitHub answers 422 to bad input. */
export function parseGh<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      422,
      'validation_failed',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

export async function ghBody(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'Problems parsing JSON');
  }
}

const repoSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  default_branch: z.string(),
  created_at: z.number(),
  visibility: z.enum(['private', 'public']),
  owner_kind: z.enum(['user', 'org']).optional(),
  owner_id: z.string().nullable().optional(),
});

export interface Repo {
  record: RepoRecord;
  /** `/api/v1/repos/<owner>/<name>`-relative path prefix. */
  path: string;
  can_admin: boolean;
}

/**
 * Read the repository through the native route first: a caller who cannot
 * read it gets the native 404 before any lookup below can tell them more.
 */
export async function loadRepo(
  c: Ctx,
  slug = `${param(c, 'owner')}/${param(c, 'repo')}`,
): Promise<Repo> {
  const path = `/repos/${slug}`;
  const data = z
    .object({ repo: repoSchema, can_admin: z.boolean() })
    .parse(await native(c, 'GET', path));
  return { record: data.repo as RepoRecord, path, can_admin: data.can_admin };
}

/** A path parameter (the `gh` wrapper erases the route's param types). */
export const param = (c: Ctx, name: string): string => c.req.param(name) ?? '';
export const originOf = (c: Ctx): string => new URL(c.req.url).origin;
export const apiUrl = (c: Ctx, path: string): string => `${originOf(c)}${PREFIX}${path}`;
export const iso = (ms: number | null | undefined): string | null =>
  ms == null ? null : new Date(ms).toISOString();

/** Changeset ids → Git commit SHA-1s (computed on demand, as Git clients see them). */
export async function shasOf(
  c: Ctx,
  repoId: string,
  ids: string[],
): Promise<Map<string, string>> {
  try {
    return await commitShas(c.env, repoId, ids);
  } catch (err) {
    if (err instanceof GitProtocolError)
      throw new ApiError(503, 'git_ids_pending', err.message);
    throw err;
  }
}

export async function shaOf(c: Ctx, repoId: string, id: string): Promise<string> {
  return (await shasOf(c, repoId, [id])).get(id) as string;
}

/**
 * A GitHub `ref` (a commit SHA-1, a branch or a tag; changeset ids work too)
 * → changeset id. Call after `loadRepo`, which checked the caller may read.
 */
export async function changesetOf(c: Ctx, repo: Repo, ref: string): Promise<string> {
  const id = /^[0-9a-f]{40}$/.test(ref)
    ? await changesetForSha1(c.env, repo.record.id, ref)
    : await lookupRevId(c.env, repo.record.id, ref.replace(/^refs\/heads\//, ''));
  if (id === null)
    throw new ApiError(404, 'revision_not_found', `No commit found for ${ref}`);
  return id;
}

/**
 * GitHub page-number pagination over a native cursor list: walks native
 * pages until it holds page × per_page + 1 matching items (at most 20
 * native pages), then sets a `Link: rel="next"` header when there is more,
 * as Octokit's paginate expects. `seen` counts the matches walked and
 * `complete` says the walk reached the end of the list.
 */
export async function paged<T>(
  c: Ctx,
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
): Promise<{ items: T[]; seen: number; complete: boolean }> {
  const perPage = Math.min(Math.max(Number(c.req.query('per_page') ?? 30) || 30, 1), 100);
  const page = Math.max(Number(c.req.query('page') ?? 1) || 1, 1);
  const want = page * perPage + 1;
  const items: T[] = [];
  let cursor: string | null = null;
  for (let walked = 0; walked < 20 && items.length < want; walked++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    cursor = result.next;
    if (cursor === null) break;
  }
  if (items.length > page * perPage) {
    const next = new URL(c.req.url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    c.header('link', `<${next.toString()}>; rel="next"`);
  }
  return {
    items: items.slice((page - 1) * perPage, page * perPage),
    seen: items.length,
    complete: cursor === null,
  };
}

/** Native list cursors are numbers or strings; carry them as strings. */
export const cursorOf = (next: string | number | null | undefined): string | null =>
  next === null || next === undefined ? null : String(next);
