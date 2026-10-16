import { z } from 'zod';
import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { sha256Hex } from '../core/hashing';
import type { Principal } from './principal';

/** App installation tokens (issue #75): see apps.ts. Kept apart so token resolution has no app imports. */
export const APP_TOKEN_PREFIX = 'yagis_';

export const hashAppToken = (raw: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(raw));

const appTokenRowSchema = z.object({
  installation_id: z.string(),
  scopes: z.string(),
  app_id: z.string(),
  installed_by: z.string(),
  auth_method: z.string().nullable(),
});

/** Resolve a raw `yagis_` token; null when unknown, expired, uninstalled or the installer is inactive. */
export async function resolveAppToken(
  env: Env,
  raw: string,
  now: number = Date.now(),
): Promise<Principal | null> {
  const row = await q1(
    env,
    `SELECT t.installation_id, t.scopes, i.app_id, i.installed_by, i.auth_method
       FROM app_tokens t
       JOIN app_installations i ON i.id = t.installation_id
       JOIN users u ON u.id = i.installed_by
      WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1`,
    [await hashAppToken(raw), now],
  );
  if (!row) return null;
  const token = appTokenRowSchema.parse(row);
  const repos = await q<{ repo_id: string }>(
    env,
    'SELECT repo_id FROM app_installation_repos WHERE installation_id = ?',
    [token.installation_id],
  );
  return {
    kind: 'agent',
    userId: token.installed_by,
    agentId: token.app_id,
    jti: token.installation_id,
    taskId: null,
    scopes: JSON.parse(token.scopes) as string[],
    repoIds: repos.map((r) => r.repo_id),
    authMethod: token.auth_method,
  };
}
