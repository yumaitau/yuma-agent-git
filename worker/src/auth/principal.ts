import type { Env } from '../env';
import type { UserRecord } from '../db/client';

/**
 * The authenticated caller (issue #12) — the object RBAC (#14) authorizes.
 *   - `user`: a human with a GitHub OAuth session cookie
 *   - `token`: a machine/agent bearer token, scoped and optionally bound to
 *     one repo
 */
export type Principal =
  | { kind: 'user'; userId: string }
  | {
      kind: 'token';
      userId: string;
      tokenId: string;
      scopes: string[];
      repoId: string | null;
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
  return principal.scopes.includes(scope);
}
