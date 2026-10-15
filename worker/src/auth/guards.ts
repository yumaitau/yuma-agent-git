import type { Context } from 'hono';
import type { RepoRecord } from '../db/client';
import { getRepo, getRepoBySlug } from '../db/repos';
import { apiError } from '../api/errors';
import {
  decide,
  pathDecider,
  restrictingDecision,
  type Perm,
  type RepoWithCreator,
} from './rbac';
import type { Principal } from './principal';

/**
 * Route guards — real RBAC (issue #14). Placeholders are gone; every guarded
 * route goes through `can()` and gets the contract error:
 *   - 401 when there is no principal at all (writes/admin)
 *   - 404 for reads the caller may not see — never leak repo existence
 *   - 403 `{code:'forbidden', denied_by}` when the caller can see the repo but
 *     lacks the permission (the denying path rule is named for the UI)
 *   - blame/log history denials are 403 (the repo is visible; the rule denies
 *     the `history` perm on that path)
 *   - whole-repo surfaces (content-addressed objects, exports, ref moves,
 *     pulls/CI) are 403 `whole_repository_required` for callers any path rule
 *     restricts: a hash or a changeset cannot be mapped to the paths it covers
 */

export type RepoLoad =
  { ok: true; repo: RepoWithCreator } | { ok: false; response: Response };

function principalOf(c: Context): Principal | null {
  return (c.get('principal') as Principal | null | undefined) ?? null;
}

async function decideOrResponse(
  c: Context,
  repo: RepoWithCreator,
  perm: Perm,
  path?: string,
): Promise<Response | null> {
  const principal = principalOf(c);
  const decision = await decide(c.env, repo, principal, perm, path);
  if (decision.allowed) return null;

  // never confirm the existence of repos the caller cannot read
  const canRead = (await decide(c.env, repo, principal, 'read')).allowed;
  if (!canRead) {
    return principal === null && perm !== 'read' && perm !== 'history'
      ? apiError(c, 401, 'unauthorized', 'authentication required')
      : apiError(c, 404, 'repo_not_found', `no repo ${repo.slug}`);
  }
  if (principal === null) {
    return apiError(c, 401, 'unauthorized', 'authentication required');
  }
  return apiError(c, 403, 'forbidden', 'insufficient permission', {
    ...(decision.deniedBy ? { denied_by: decision.deniedBy } : {}),
  });
}

async function loadWithPerm(c: Context, slug: string, perm: Perm): Promise<RepoLoad> {
  const repo = await getRepoBySlug(c.env, slug);
  if (!repo) {
    return {
      ok: false,
      response: apiError(c, 404, 'repo_not_found', `no repo ${slug}`),
    };
  }
  const denied = await decideOrResponse(c, repo, perm);
  if (denied) return { ok: false, response: denied };
  return { ok: true, repo };
}

/** Read access (404 on any denial — existence is never leaked). */
export function loadReadableRepo(c: Context, slug: string): Promise<RepoLoad> {
  return loadWithPerm(c, slug, 'read');
}

/** Read access when the caller already has the repo **id** (task/transcript). */
export async function loadReadableRepoById(c: Context, id: string): Promise<RepoLoad> {
  const repo = await getRepo(c.env, id);
  if (!repo) {
    return {
      ok: false,
      response: apiError(c, 404, 'repo_not_found', `no repo ${id}`),
    };
  }
  const denied = await decideOrResponse(c, repo, 'read');
  if (denied) return { ok: false, response: denied };
  return { ok: true, repo };
}

/** Write access by repo id. */
export async function loadWritableRepoById(c: Context, id: string): Promise<RepoLoad> {
  const repo = await getRepo(c.env, id);
  if (!repo) {
    return {
      ok: false,
      response: apiError(c, 404, 'repo_not_found', `no repo ${id}`),
    };
  }
  const denied = await decideOrResponse(c, repo, 'write');
  if (denied) return { ok: false, response: denied };
  return { ok: true, repo };
}

/** Write access (401 anonymous / 403 insufficient). */
export function loadWritableRepo(c: Context, slug: string): Promise<RepoLoad> {
  return loadWithPerm(c, slug, 'write');
}

/** Repo administration (members, path rules, connections). */
export function loadAdminRepo(c: Context, slug: string): Promise<RepoLoad> {
  return loadWithPerm(c, slug, 'admin');
}

/**
 * History surfaces (blame/log) on a specific path — the monorepo-security
 * gate: a caller needs `history` **or** `read`, but an explicit path-rule
 * denial of either perm is absolute (deny `history` on `secrets/` blocks
 * blame even when `read` is granted).
 */
export async function guardPathHistory(
  c: Context,
  repo: RepoWithCreator,
  path: string,
): Promise<Response | null> {
  const principal = principalOf(c);
  const history = await decide(c.env, repo, principal, 'history', path);
  const read = await decide(c.env, repo, principal, 'read', path);
  const denied = [history, read].find((d) => d.deniedBy?.effect === 'deny');
  if (denied) {
    return apiError(c, 403, 'forbidden', 'path rule denies history on this path', {
      denied_by: denied.deniedBy,
    });
  }
  if (history.allowed || read.allowed) return null;
  return decideOrResponse(c, repo, 'history', path);
}

/** Read permission on a specific path (path rules engaged). */
export async function guardPathRead(
  c: Context,
  repo: RepoWithCreator,
  path: string,
): Promise<Response | null> {
  return decideOrResponse(c, repo, 'read', path);
}

/**
 * Whole-repository access: the repo-level `permission` **and** no path rule
 * restricting the caller anywhere (`read` for reads; `read` + `write` for
 * writes/admin). For surfaces that can expose or replace any source path —
 * objects by hash, exports, ref moves, pull requests, CI logs and scripts.
 */
export async function loadWholeRepo(
  c: Context,
  permission: 'read' | 'write' | 'admin',
  slug: string,
): Promise<RepoLoad> {
  const loaded = await (
    permission === 'admin'
      ? loadAdminRepo
      : permission === 'write'
        ? loadWritableRepo
        : loadReadableRepo
  )(c, slug);
  if (!loaded.ok) return loaded;
  const principal = principalOf(c);
  if (principal?.kind === 'token') {
    if (principal.repoId && principal.repoId !== loaded.repo.id)
      return {
        ok: false,
        response: apiError(c, 404, 'repo_not_found', 'Repository not found'),
      };
    const scope = permission === 'read' ? 'repo:read' : 'repo:write';
    if (!principal.scopes.includes(scope))
      return {
        ok: false,
        response: apiError(c, 403, 'insufficient_scope', `Token requires ${scope}`),
      };
  }
  const decider = await pathDecider(c.env, loaded.repo, principal);
  const restricted = restrictingDecision(
    decider,
    permission === 'read' ? ['read'] : ['read', 'write'],
  );
  if (restricted) {
    return {
      ok: false,
      response: apiError(
        c,
        403,
        'whole_repository_required',
        'This operation requires access to the whole repository, including paths covered by permission rules.',
        restricted.deniedBy ? { denied_by: restricted.deniedBy } : {},
      ),
    };
  }
  return loaded;
}

/**
 * `write` on every path a commit touches (path rules engaged, one rules load
 * for the whole batch). 403 names the first denied path and its rule.
 */
export async function guardPathsWrite(
  c: Context,
  repo: RepoWithCreator,
  paths: readonly string[],
): Promise<Response | null> {
  const decider = await pathDecider(c.env, repo, principalOf(c));
  if (decider.rules.length === 0) return null; // repo-level write already held
  for (const path of paths) {
    const decision = decider.decide('write', path);
    if (decision.allowed) continue;
    return apiError(c, 403, 'forbidden', `path rule denies write on ${path}`, {
      path,
      ...(decision.deniedBy ? { denied_by: decision.deniedBy } : {}),
    });
  }
  return null;
}

/**
 * Per-path `read` predicate for listing surfaces (recursive trees, diffs,
 * changed paths): rules load once, then each check is in-memory. Entries the
 * caller may not read are dropped and counted, never 403'd wholesale.
 */
export async function pathReadFilter(
  c: Context,
  repo: RepoWithCreator,
): Promise<(path: string) => boolean> {
  const decider = await pathDecider(c.env, repo, principalOf(c));
  if (decider.rules.length === 0) return () => true;
  return (path) => decider.decide('read', path).allowed;
}

/**
 * A changeset as `canRead` may see it: unreadable `changed_files` dropped and
 * counted in `omitted_paths_count` (absent when nothing was dropped).
 */
export function visibleChangeset<T extends { changed_files: { path: string }[] }>(
  cs: T,
  canRead: (path: string) => boolean,
): T & { omitted_paths_count?: number } {
  const changed = cs.changed_files.filter((f) => canRead(f.path));
  const omitted = cs.changed_files.length - changed.length;
  return omitted === 0
    ? cs
    : { ...cs, changed_files: changed, omitted_paths_count: omitted };
}

export type { RepoRecord };
