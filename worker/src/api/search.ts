import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { boundRepos, hasScope, type AppEnv } from '../auth/principal';
import { pathDecider } from '../auth/rbac';
import { loadReadableRepo, requireAgentScope } from '../auth/guards';
import { parseRepoRow, q } from '../db/client';
import { ApiError } from '../core/errors';
import { lookupRev } from '../core/read';
import { searchCode, searchPaths, type SearchScope } from '../core/search';
import { apiError, errorResponse } from './errors';
import { VISIBLE_REPOS_SQL, visibleReposParams } from './repos';

/**
 * Code search and the file finder (issue #45) across every repo the caller
 * can read. Each repo is decided with `can()` and every file with its path
 * rules, so a path-restricted file never appears. `rev` (a changeset id or
 * ref) needs `repo`; without it the default branch is searched.
 */
export const searchRoutes = new Hono<AppEnv>();

/** Repos one search spans at most; narrow with `repo` past it. */
export const MAX_SEARCH_REPOS = 200;

const flag = z.enum(['0', '1']).optional();
const common = {
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
    .optional(),
  path: z.string().min(1).max(400).optional(),
  lang: z.string().min(1).max(40).optional(),
  rev: z.string().min(1).max(300).optional(),
};

export const codeSearchQuery = z.object({
  q: z.string().min(1).max(200),
  regex: flag,
  case: flag,
  ...common,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const pathSearchQuery = z.object({
  q: z.string().min(1).max(200),
  ...common,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

type Scoped =
  | { ok: true; scopes: SearchScope[]; reposTruncated: boolean }
  | { ok: false; response: Response };

async function scopesFor(
  c: Context<AppEnv>,
  slug: string | undefined,
  rev: string | undefined,
): Promise<Scoped> {
  const principal = c.get('principal');
  const scoped = requireAgentScope(c, 'contents:read');
  if (scoped) return { ok: false, response: scoped };
  if (
    principal &&
    principal.kind !== 'user' &&
    !hasScope(principal, 'repo:read') &&
    !hasScope(principal, 'repo:write')
  )
    return {
      ok: false,
      response: apiError(
        c,
        403,
        'insufficient_scope',
        'Token requires repository access',
      ),
    };

  if (slug !== undefined) {
    const loaded = await loadReadableRepo(c, slug);
    if (!loaded.ok) return loaded;
    let cs = null;
    if (rev !== undefined) {
      cs = await lookupRev(c.env, loaded.repo.id, rev);
      if (cs === null)
        return {
          ok: false,
          response: apiError(c, 404, 'revision_not_found', `no revision ${rev}`),
        };
    }
    const decider = await pathDecider(c.env, loaded.repo, principal);
    return {
      ok: true,
      scopes: [{ repo: loaded.repo, decider, rev: cs }],
      reposTruncated: false,
    };
  }
  if (rev !== undefined)
    return {
      ok: false,
      response: apiError(c, 400, 'invalid_request', '`rev` needs `repo`'),
    };

  const bound = boundRepos(principal);
  const rows = await q(
    c.env,
    `${VISIBLE_REPOS_SQL}
     WHERE (? IS NULL OR id IN (SELECT value FROM json_each(?)))
     ORDER BY slug LIMIT ?`,
    [
      ...visibleReposParams(principal?.userId ?? ''),
      bound === null ? null : JSON.stringify(bound),
      bound === null ? null : JSON.stringify(bound),
      MAX_SEARCH_REPOS + 1,
    ],
  );
  const repos = rows.slice(0, MAX_SEARCH_REPOS).map((row) => parseRepoRow(row));
  const decided = await Promise.all(
    repos.map(async (repo): Promise<SearchScope | null> => {
      const decider = await pathDecider(c.env, repo, principal);
      return decider.decide('read').allowed ? { repo, decider, rev: null } : null;
    }),
  );
  return {
    ok: true,
    scopes: decided.filter((s): s is SearchScope => s !== null),
    reposTruncated: rows.length > MAX_SEARCH_REPOS,
  };
}

searchRoutes.get('/search/code', async (c) => {
  try {
    const query = parse(codeSearchQuery, c.req.query());
    const scoped = await scopesFor(c, query.repo, query.rev);
    if (!scoped.ok) return scoped.response;
    const out = await searchCode(c.env, scoped.scopes, {
      q: query.q,
      regex: query.regex === '1',
      caseSensitive: query.case === '1',
      path: query.path,
      lang: query.lang,
      limit: query.limit,
    });
    return c.json({ ...out, repos_truncated: scoped.reposTruncated }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

searchRoutes.get('/search/paths', async (c) => {
  try {
    const query = parse(pathSearchQuery, c.req.query());
    const scoped = await scopesFor(c, query.repo, query.rev);
    if (!scoped.ok) return scoped.response;
    const out = await searchPaths(c.env, scoped.scopes, {
      q: query.q,
      path: query.path,
      lang: query.lang,
      limit: query.limit,
    });
    return c.json({ ...out, repos_truncated: scoped.reposTruncated }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
