import type { Env } from '../env';
import { ulid } from '../core/ids';
import { C, T } from './schema';
import {
  parseRefRow,
  parseRepoRow,
  q,
  q1,
  run,
  type RefRecord,
  type RepoRecord,
} from './client';

export interface CreateRepoInput {
  slug: string;
  defaultBranch?: string;
  visibility?: 'private' | 'public';
  githubInstallationId?: number | null;
  githubRepoId?: number | null;
  /** Creating user — repo creators are admins (issue #14). */
  createdBy?: string | null;
}

/** Insert a repository row (id = ULID). */
export async function createRepo(
  env: Env,
  input: CreateRepoInput,
  now: number = Date.now(),
): Promise<RepoRecord> {
  const row = {
    id: ulid(now),
    slug: input.slug,
    created_by: input.createdBy ?? null,
    github_installation_id: input.githubInstallationId ?? null,
    github_repo_id: input.githubRepoId ?? null,
    default_branch: input.defaultBranch ?? 'main',
    created_at: now,
    visibility: input.visibility ?? 'private',
  };
  await run(
    env,
    `INSERT INTO ${T.repos}
       (${C.repos.id}, ${C.repos.slug}, ${C.repos.githubInstallationId},
        ${C.repos.githubRepoId}, ${C.repos.defaultBranch}, ${C.repos.createdAt},
        ${C.repos.visibility}, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.github_installation_id,
      row.github_repo_id,
      row.default_branch,
      row.created_at,
      row.visibility,
      row.created_by,
    ],
  );
  return parseRepoRow(row);
}

/** Look up a repository by its `owner/name` slug. */
export async function getRepoBySlug(env: Env, slug: string): Promise<RepoRecord | null> {
  const row = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.slug} = ?`, [slug]);
  return row ? parseRepoRow(row) : null;
}

/** Look up a repository by id. */
export async function getRepo(env: Env, id: string): Promise<RepoRecord | null> {
  const row = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [id]);
  return row ? parseRepoRow(row) : null;
}

/**
 * Raw ref write (upsert). Ref moves go through the `RefLockDO`
 * compare-and-swap (issue #5) — this helper is for seeding and migrations.
 */
export async function setRef(
  env: Env,
  repoId: string,
  name: string,
  head: string,
  now: number = Date.now(),
): Promise<void> {
  await run(
    env,
    `INSERT INTO ${T.refs}
       (${C.refs.repoId}, ${C.refs.name}, ${C.refs.head}, ${C.refs.updatedAt})
     VALUES (?, ?, ?, ?)
     ON CONFLICT (${C.refs.repoId}, ${C.refs.name})
     DO UPDATE SET ${C.refs.head} = excluded.${C.refs.head},
                   ${C.refs.updatedAt} = excluded.${C.refs.updatedAt}`,
    [repoId, name, head, now],
  );
}

/** Read a single ref row, or null when the ref does not exist. */
export async function getRef(
  env: Env,
  repoId: string,
  name: string,
): Promise<RefRecord | null> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = ?`,
    [repoId, name],
  );
  return row ? parseRefRow(row) : null;
}

/** All refs for a repo. */
export async function listRefs(env: Env, repoId: string): Promise<RefRecord[]> {
  const rows = await q(
    env,
    `SELECT * FROM ${T.refs} WHERE ${C.refs.repoId} = ? ORDER BY ${C.refs.name}`,
    [repoId],
  );
  return rows.map(parseRefRow);
}
