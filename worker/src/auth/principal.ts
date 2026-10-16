import type { Env } from '../env';
import type { UserRecord } from '../db/client';

/**
 * The authenticated caller (issue #12) — the object RBAC (#14) authorizes.
 *   - `user`: a human with a GitHub OAuth session cookie
 *   - `token`: a machine/agent bearer token, scoped and optionally bound to
 *     one repo
 *   - `agent`: an agent identity (#57) acting for the human `userId` through a
 *     short-lived exchanged token, bound to `repoIds` and agent `scopes`. RBAC
 *     resolves the human's role, so the agent gets the intersection.
 */
export type Principal =
  | { kind: 'user'; userId: string }
  | {
      kind: 'token';
      userId: string;
      tokenId: string;
      scopes: string[];
      repoId: string | null;
    }
  | {
      kind: 'agent';
      userId: string;
      agentId: string;
      jti: string;
      taskId: string | null;
      scopes: string[];
      repoIds: string[];
    };

export interface AppVariables {
  user: UserRecord | null;
  principal: Principal | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

export function hasScope(principal: Principal | null, scope: string): boolean {
  if (principal === null) return false;
  if (principal.kind === 'user') return true; // session principals are full users
  if (principal.kind === 'agent') {
    // API token repo scopes map onto agent `contents:` scopes
    if (scope === 'repo:read') return hasScope(principal, 'contents:read');
    if (scope === 'repo:write') return principal.scopes.includes('contents:write');
    if (scope === 'contents:read' && principal.scopes.includes('contents:write'))
      return true;
  }
  return principal.scopes.includes(scope);
}

/** Repos a machine principal is bound to; null means any the user can reach. */
export function boundRepos(principal: Principal | null): string[] | null {
  if (principal?.kind === 'token') return principal.repoId ? [principal.repoId] : null;
  if (principal?.kind === 'agent') return principal.repoIds;
  return null;
}

/**
 * The id a principal owns `refs/agents/<id>/` as: its agent identity, or for
 * API tokens with `agent:run` (before agent identities) the token id.
 */
export function agentIdOf(principal: Principal | null): string | null {
  if (principal?.kind === 'agent') return principal.agentId;
  if (principal?.kind === 'token' && principal.scopes.includes('agent:run'))
    return principal.tokenId;
  return null;
}
