import type { Context } from 'hono';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';

/**
 * Authz guards — placeholders until RBAC lands (issue #14). Every route calls
 * these; #14 replaces the bodies with `can()` and deletes the TODOs.
 */

export async function requireRepoRead(
  _env: Env,
  _c: Context,
  _repo: RepoRecord,
): Promise<boolean> {
  return true; // TODO(issue #14): replace with RBAC
}

export async function requireRepoWrite(
  _env: Env,
  _c: Context,
  _repo: RepoRecord,
): Promise<boolean> {
  return true; // TODO(issue #14): replace with RBAC
}

/**
 * History/blame permission on a specific path — the monorepo-security hook
 * (deny `history` on `secrets/` while granting `read` elsewhere). Issue #14
 * enforces path_rules here.
 */
export async function requirePathHistory(
  _env: Env,
  _c: Context,
  _repo: RepoRecord,
  _path: string,
): Promise<boolean> {
  return true; // TODO(issue #14): replace with RBAC path_rules
}
