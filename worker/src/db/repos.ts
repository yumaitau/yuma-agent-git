import type { Env } from '../env';
import { ulid } from '../core/ids';
import { forkRepoId } from '../core/network';
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
  /** Org-owned repos (issue #26) carry the org id; default is the slug prefix. */
  ownerKind?: 'user' | 'org';
  ownerId?: string;
  /** Fork (issue #36): the upstream repo id; the fork joins its network. */
  forkOf?: string;
}

/** Insert a repository row (id = ULID). */
export async function createRepo(
  env: Env,
  input: CreateRepoInput,
  now: number = Date.now(),
): Promise<RepoRecord> {
  const row = {
    id: input.forkOf ? forkRepoId(input.forkOf, now) : ulid(now),
    slug: input.slug,
    created_by: input.createdBy ?? null,
    github_installation_id: input.githubInstallationId ?? null,
    github_repo_id: input.githubRepoId ?? null,
    default_branch: input.defaultBranch ?? 'main',
    created_at: now,
    visibility: input.visibility ?? 'private',
    // new repos take Git ref rules; the migration default keeps pilots on 'scion'
    refs_mode: 'git' as const,
    owner_kind: input.ownerKind ?? 'user',
    owner_id: input.ownerId ?? (input.slug.split('/')[0] as string),
    // column defaults (migration 0023), so the record matches the stored row
    merge_methods: '["merge","squash","rebase"]',
    default_merge_method: 'merge' as const,
    // set by the fork route (migration 0045); older schemas lack the column
    fork_of: input.forkOf ?? null,
  };
  await run(
    env,
    `INSERT INTO ${T.repos}
       (${C.repos.id}, ${C.repos.slug}, ${C.repos.githubInstallationId},
        ${C.repos.githubRepoId}, ${C.repos.defaultBranch}, ${C.repos.createdAt},
        ${C.repos.visibility}, created_by, refs_mode, ${C.repos.ownerKind}, ${C.repos.ownerId})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.github_installation_id,
      row.github_repo_id,
      row.default_branch,
      row.created_at,
      row.visibility,
      row.created_by,
      row.refs_mode,
      row.owner_kind,
      row.owner_id,
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

/**
 * One page of refs, keyset-paginated on name: the `(repo_id, name)` primary
 * key serves both the prefix range and the cursor. Agent work refs stay
 * hidden unless the prefix asks for `refs/agents/` (as Git's `ls-refs` does).
 */
export async function listRefsPage(
  env: Env,
  repoId: string,
  opts: { prefix: string; after: string; limit: number },
): Promise<RefRecord[]> {
  const { prefix } = opts;
  // smallest string above every name that starts with prefix
  const upper =
    prefix === ''
      ? null
      : prefix.slice(0, -1) +
        String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const rows = await q(
    env,
    `SELECT * FROM ${T.refs}
      WHERE ${C.refs.repoId} = ? AND ${C.refs.name} >= ? AND ${C.refs.name} > ?
        AND (? IS NULL OR ${C.refs.name} < ?)
        AND (? = 1 OR ${C.refs.name} NOT LIKE 'refs/agents/%')
      ORDER BY ${C.refs.name}
      LIMIT ?`,
    [
      repoId,
      prefix,
      opts.after,
      upper,
      upper,
      prefix.startsWith('refs/agents/') ? 1 : 0,
      opts.limit,
    ],
  );
  return rows.map(parseRefRow);
}
