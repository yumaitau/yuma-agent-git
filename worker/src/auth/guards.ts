import type { Context } from 'hono';
import type { RepoRecord } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { apiError } from '../api/errors';
import { decide, type Perm, type RepoWithCreator } from './rbac';
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

export type { RepoRecord };
