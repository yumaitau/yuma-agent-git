import { z } from 'zod';
import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { sha256Hex } from '../core/hashing';
import type { Principal } from './principal';
import { INSTANCE_SCOPE } from '../policy/pause';

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

/**
 * Agents paused (#62) on the instance, the app owner's org or the org of a
 * repo installation `i` holds; `a` is its app.
 */
const PAUSED = `EXISTS (
  SELECT 1 FROM agent_pauses p
   WHERE p.scope_id = '${INSTANCE_SCOPE}'
      OR (a.owner_kind = 'org' AND p.scope_id = a.owner_id)
      OR p.scope_id IN (
           SELECT r.owner_id FROM app_installation_repos ir
             JOIN repos r ON r.id = ir.repo_id
            WHERE ir.installation_id = i.id AND r.owner_kind = 'org'))`;

/** Whether the kill switch stops installation `id`. */
export async function installationPaused(env: Env, id: string): Promise<boolean> {
  const row = await q1(
    env,
    `SELECT 1 FROM app_installations i JOIN apps a ON a.id = i.app_id
      WHERE i.id = ? AND ${PAUSED}`,
    [id],
  );
  return row !== null;
}

/**
 * Resolve a raw `yagis_` token; null when unknown, expired, uninstalled, the
 * installer is inactive or agents are paused.
 */
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
       JOIN apps a ON a.id = i.app_id
       JOIN users u ON u.id = i.installed_by
      WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1 AND NOT ${PAUSED}`,
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
