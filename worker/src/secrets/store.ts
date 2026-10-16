import type { Env } from '../env';
import { q, run } from '../db/client';
import { ApiError } from '../core/errors';
import type { RepoRecord } from '../db/client';
import { MIN_MASK_LENGTH } from '../ci/mask';
import { decryptSecrets, encryptSecret } from './crypto';

/**
 * Secrets and variables (issue #50) at three scopes. A job sees, for each
 * name, the most specific value: environment, then repository, then org.
 * Secret values are write-only: nothing here returns a value to an API caller.
 */
export type ScopeKind = 'org' | 'repo' | 'environment';
export interface Scope {
  scope: ScopeKind;
  /** orgs.id for `org`; repos.id for `repo` and `environment`. */
  ownerId: string;
  /** '' unless scope is `environment`. */
  environment: string;
  /** Data-key owner: `org:<id>` or `user:<login>`. */
  keyOwner: string;
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const ENVIRONMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = /^(GITHUB_|ACTIONS_|RUNNER_|YAG_)|^(CI|HOME|PATH|DOCKER_HOST)$/;
const MAX_SECRET_BYTES = 48 * 1024;
const MAX_VARIABLE_BYTES = 48 * 1024;

type RepoOwner = Pick<RepoRecord, 'id' | 'slug' | 'owner_kind' | 'owner_id'>;

/** Data-key owner of a repo: its org, else the user namespace in its slug. */
export function keyOwnerOf(repo: RepoOwner): string {
  return repo.owner_kind === 'org' && repo.owner_id
    ? `org:${repo.owner_id}`
    : `user:${repo.slug.split('/')[0]}`;
}

export function repoScope(repo: RepoOwner, environment: string | null): Scope {
  return {
    scope: environment ? 'environment' : 'repo',
    ownerId: repo.id,
    environment: environment ?? '',
    keyOwner: keyOwnerOf(repo),
  };
}

export function orgScope(orgId: string): Scope {
  return { scope: 'org', ownerId: orgId, environment: '', keyOwner: `org:${orgId}` };
}

/** Validate and normalise a secret or variable name (stored upper case). */
export function checkName(raw: string): string {
  const name = raw.toUpperCase();
  if (!NAME_RE.test(name) || RESERVED.test(name))
    throw new ApiError(
      400,
      'invalid_name',
      'Use letters, digits and underscores, not starting with a digit. GITHUB_, ACTIONS_, RUNNER_ and YAG_ prefixes are reserved.',
    );
  return name;
}

function aad(scope: Scope, name: string): string {
  return `${scope.scope}|${scope.ownerId}|${scope.environment}|${name}`;
}

export interface SecretMeta {
  name: string;
  created_by: string;
  updated_at: number;
}

export async function putSecret(
  env: Env,
  scope: Scope,
  name: string,
  value: string,
  actor: string,
): Promise<SecretMeta> {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (value.trim().length < MIN_MASK_LENGTH || bytes > MAX_SECRET_BYTES)
    throw new ApiError(
      400,
      'invalid_secret_value',
      `Secret values must be ${MIN_MASK_LENGTH} characters to 48 KiB so logs can mask them.`,
    );
  const sealed = await encryptSecret(env, scope.keyOwner, aad(scope, name), value);
  const now = Date.now();
  await run(
    env,
    `INSERT INTO secrets (scope, owner_id, environment, name, ciphertext, key_owner, key_version, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, owner_id, environment, name) DO UPDATE SET
       ciphertext = excluded.ciphertext, key_owner = excluded.key_owner,
       key_version = excluded.key_version, created_by = excluded.created_by,
       updated_at = excluded.updated_at`,
    [
      scope.scope,
      scope.ownerId,
      scope.environment,
      name,
      sealed.ciphertext,
      scope.keyOwner,
      sealed.keyVersion,
      actor,
      now,
    ],
  );
  return { name, created_by: actor, updated_at: now };
}

export interface VariableRow extends SecretMeta {
  value: string;
}

export async function putVariable(
  env: Env,
  scope: Scope,
  name: string,
  value: string,
  actor: string,
): Promise<VariableRow> {
  if (new TextEncoder().encode(value).byteLength > MAX_VARIABLE_BYTES)
    throw new ApiError(400, 'invalid_variable_value', 'Variables are limited to 48 KiB.');
  const now = Date.now();
  await run(
    env,
    `INSERT INTO variables (scope, owner_id, environment, name, value, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, owner_id, environment, name) DO UPDATE SET
       value = excluded.value, created_by = excluded.created_by, updated_at = excluded.updated_at`,
    [scope.scope, scope.ownerId, scope.environment, name, value, actor, now],
  );
  return { name, value, created_by: actor, updated_at: now };
}

/** Delete one secret or variable; false when it did not exist. */
export async function deleteEntry(
  env: Env,
  table: 'secrets' | 'variables',
  scope: Scope,
  name: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM ${table} WHERE scope = ? AND owner_id = ? AND environment = ? AND name = ?`,
  )
    .bind(scope.scope, scope.ownerId, scope.environment, name)
    .run();
  return result.meta.changes > 0;
}

export function listSecrets(env: Env, scope: Scope): Promise<SecretMeta[]> {
  return q<SecretMeta>(
    env,
    'SELECT name, created_by, updated_at FROM secrets WHERE scope = ? AND owner_id = ? AND environment = ? ORDER BY name',
    [scope.scope, scope.ownerId, scope.environment],
  );
}

export function listVariables(env: Env, scope: Scope): Promise<VariableRow[]> {
  return q<VariableRow>(
    env,
    'SELECT name, value, created_by, updated_at FROM variables WHERE scope = ? AND owner_id = ? AND environment = ? ORDER BY name',
    [scope.scope, scope.ownerId, scope.environment],
  );
}

const PRECEDENCE: Record<ScopeKind, number> = { org: 0, repo: 1, environment: 2 };

/** SQL + binds selecting the org, repo and (optional) environment scopes of a repo. */
function scopesOf(repo: RepoRecord, environment: string | null): [string, unknown[]] {
  return [
    `((scope = 'org' AND owner_id = ?) OR (scope = 'repo' AND owner_id = ?)
      OR (scope = 'environment' AND owner_id = ? AND environment = ?))`,
    [
      repo.owner_kind === 'org' ? (repo.owner_id ?? '') : '',
      repo.id,
      repo.id,
      environment ?? '',
    ],
  ];
}

function mostSpecific<T extends { name: string; scope: ScopeKind }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const held = best.get(row.name);
    if (!held || PRECEDENCE[row.scope] > PRECEDENCE[held.scope]) best.set(row.name, row);
  }
  return [...best.values()];
}

/**
 * The values a job in `repo` (and `environment`, once cleared) receives:
 * every variable, and the secrets named in `secretNames`.
 */
export async function resolveForJob(
  env: Env,
  repo: RepoRecord,
  environment: string | null,
  secretNames: readonly string[],
): Promise<{ secrets: Record<string, string>; variables: Record<string, string> }> {
  const [where, binds] = scopesOf(repo, environment);
  const variables = mostSpecific(
    await q<{ name: string; scope: ScopeKind; value: string }>(
      env,
      `SELECT name, scope, value FROM variables WHERE ${where}`,
      binds,
    ),
  );
  const wanted = new Set(secretNames.map((n) => n.toUpperCase()));
  const secretRows = wanted.size
    ? mostSpecific(
        await q<{
          name: string;
          scope: ScopeKind;
          owner_id: string;
          environment: string;
          ciphertext: string;
          key_owner: string;
          key_version: number;
        }>(env, `SELECT * FROM secrets WHERE ${where}`, binds),
      ).filter((row) => wanted.has(row.name))
    : [];
  const values = await decryptSecrets(
    env,
    secretRows.map((row) => ({
      owner: row.key_owner,
      keyVersion: row.key_version,
      aad: aad(
        {
          scope: row.scope,
          ownerId: row.owner_id,
          environment: row.environment,
          keyOwner: row.key_owner,
        },
        row.name,
      ),
      ciphertext: row.ciphertext,
    })),
  );
  return {
    secrets: Object.fromEntries(secretRows.map((row, i) => [row.name, values[i]!])),
    variables: Object.fromEntries(variables.map((row) => [row.name, row.value])),
  };
}
