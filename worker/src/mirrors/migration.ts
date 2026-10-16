import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv } from '../auth/principal';
import type { RepoRecord } from '../db/client';
import { q1 } from '../db/client';
import { getRef } from '../db/repos';
import { recordAudit } from '../audit/record';
import { githubApi } from '../bridge/github';
import { ApiError } from '../core/errors';
import { GitProtocolError } from '../git/pktline';
import { rulesetsFor } from '../policy/rulesets';
import { requestMirrorSync } from './queue';
import { forgeRefs, parseMirror, parseRefs, syncMirror, type MirrorRow } from './sync';

/**
 * Per-repo cutover from GitHub (issue #73):
 *
 *   github  ->  mirror  ->  dual  ->  cutover
 *     (GitHub only) (pull mirror) (push mirror) (GitHub archived)
 *
 * Each step can be undone by the step back. The state decides which of the
 * repo's two linked mirrors runs: the pull mirror only in `mirror`, the push
 * mirror only in `dual`. Every move is checked first and blocked with the
 * failing checks; moves that read mirror state sync that mirror first, so
 * "in sync" means now. `cutover` and its rollback archive and unarchive the
 * GitHub repository through the GitHub App, and need the admin to approve by
 * typing the repository's name each time.
 */

export const MIGRATION_STATES = ['github', 'mirror', 'dual', 'cutover'] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];

const NEXT: Record<MigrationState, MigrationState[]> = {
  github: ['mirror'],
  mirror: ['dual', 'github'],
  dual: ['cutover', 'mirror'],
  cutover: ['dual'],
};

export const transitionSchema = z.object({
  to: z.enum(MIGRATION_STATES),
  /** The pull mirror from GitHub; remembered once given. */
  pull_mirror_id: z.string().min(1).optional(),
  /** The push mirror to GitHub; remembered once given. */
  push_mirror_id: z.string().min(1).optional(),
  /** Moves that archive or unarchive on GitHub: the repository's `owner/name`. */
  confirm: z.string().optional(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export interface Migration {
  state: MigrationState;
  pull_mirror_id: string | null;
  push_mirror_id: string | null;
  updated_by: string | null;
  updated_at: number | null;
}

export interface Check {
  name: string;
  ok: boolean;
  message: string;
}

export async function getMigration(env: Env, repoId: string): Promise<Migration> {
  const row = await q1<Migration>(
    env,
    'SELECT state, pull_mirror_id, push_mirror_id, updated_by, updated_at FROM repo_migrations WHERE repo_id = ?',
    [repoId],
  );
  return (
    row ?? {
      state: 'github',
      pull_mirror_id: null,
      push_mirror_id: null,
      updated_by: null,
      updated_at: null,
    }
  );
}

export function nextStates(state: MigrationState): MigrationState[] {
  return NEXT[state];
}

async function mirrorOf(
  env: Env,
  repoId: string,
  id: string | null,
): Promise<MirrorRow | null> {
  if (!id) return null;
  const row = await q1(env, 'SELECT * FROM mirrors WHERE id = ? AND repo_id = ?', [
    id,
    repoId,
  ]);
  return row ? parseMirror(row) : null;
}

function pass(name: string, message: string): Check {
  return { name, ok: true, message };
}
function fail(name: string, message: string): Check {
  return { name, ok: false, message };
}

function mirrorCheck(
  name: string,
  mirror: MirrorRow | null,
  direction: 'pull' | 'push',
): Check {
  if (!mirror) return fail(name, `link a ${direction} mirror (${direction}_mirror_id)`);
  if (mirror.direction !== direction)
    return fail(name, `mirror ${mirror.id} is a ${mirror.direction} mirror`);
  if (direction === 'push' && mirror.auth === 'none')
    return fail(name, 'the push mirror needs a token or the GitHub App to push');
  return pass(
    name,
    `${direction} mirror ${mirror.id} to ${new URL(mirror.remote_url).host}`,
  );
}

/** The latest attempt of `mirror` succeeded, with nothing diverged or refused. */
function syncedCheck(name: string, mirror: MirrorRow | null): Check {
  if (!mirror) return fail(name, 'no mirror is linked');
  if (mirror.last_success_at === null || mirror.last_success_at !== mirror.last_sync_at)
    return fail(
      name,
      mirror.last_error
        ? `the last sync failed: ${mirror.last_error}`
        : 'the mirror has not synced yet',
    );
  return pass(name, 'the last sync succeeded');
}

/** The push mirror's remote holds every forge branch and tag at the forge's SHA. */
async function remoteMatches(env: Env, repo: RepoRecord, mirror: MirrorRow | null) {
  const synced = syncedCheck('push_mirror_synced', mirror);
  if (!synced.ok || !mirror) return synced;
  let forge;
  try {
    forge = await forgeRefs(env, repo.id);
  } catch (err) {
    if (err instanceof GitProtocolError) return fail('push_mirror_synced', err.message);
    throw err;
  }
  const remote = parseRefs(mirror.last_refs);
  const behind = [...forge].filter(([ref, here]) => remote[ref] !== here.sha);
  if (behind.length > 0)
    return fail(
      'push_mirror_synced',
      `the remote is behind on ${behind
        .slice(0, 5)
        .map(([ref]) => ref)
        .join(', ')}`,
    );
  return pass('push_mirror_synced', 'every branch and tag is on the remote');
}

async function rulesetsCheck(env: Env, repo: RepoRecord): Promise<Check> {
  const active = (await rulesetsFor(env, repo)).filter((r) => r.enforcement === 'active');
  return active.length > 0
    ? pass('rulesets', `${active.length} active ruleset(s)`)
    : fail('rulesets', 'add at least one active ruleset before the forge is primary');
}

async function membersCheck(env: Env, repo: RepoRecord): Promise<Check> {
  const org = repo.owner_kind === 'org' ? (repo.owner_id ?? '') : '';
  const row = await q1<{ n: number }>(
    env,
    `SELECT (SELECT count(*) FROM repo_members WHERE repo_id = ?1 AND user_id != ?2)
          + (SELECT count(*) FROM team_repos WHERE repo_id = ?1)
          + (SELECT count(*) FROM orgs WHERE id = ?3 AND base_role != 'none')
          + (SELECT count(*) FROM org_members
              WHERE org_id = ?3 AND user_id != ?2 AND role IN ('owner', 'admin')) AS n`,
    [repo.id, repo.created_by ?? '', org],
  );
  return (row?.n ?? 0) > 0
    ? pass('members', 'people other than the creator have access')
    : fail('members', 'grant the team access (members, teams or an org base role)');
}

async function ciCheck(env: Env, repo: RepoRecord): Promise<Check> {
  const head = await getRef(env, repo.id, repo.default_branch);
  if (!head) return fail('ci', `${repo.default_branch} has no commits`);
  const run = await q1<{ state: string }>(
    env,
    'SELECT state FROM ci_runs WHERE repo_id = ? AND head_cs = ? ORDER BY created_at DESC LIMIT 1',
    [repo.id, head.head],
  );
  if (run?.state === 'passed')
    return pass('ci', `forge CI passed on ${repo.default_branch}`);
  return fail(
    'ci',
    run
      ? `the latest forge CI run on ${repo.default_branch} is ${run.state}`
      : `run forge CI on the ${repo.default_branch} head first`,
  );
}

function approvalCheck(repo: RepoRecord, confirm: string | undefined): Check {
  return confirm === repo.slug
    ? pass('approval', 'approved by an admin')
    : fail('approval', `this changes GitHub; confirm with "${repo.slug}"`);
}

function githubAppCheck(repo: RepoRecord): Check {
  return repo.github_installation_id && repo.github_repo_id
    ? pass('github_app', 'connected to the GitHub App')
    : fail('github_app', 'connect the repository to the GitHub App');
}

/** Checks for `from` -> `to` against the mirrors' recorded state. */
export async function transitionChecks(
  env: Env,
  repo: RepoRecord,
  from: MigrationState,
  to: MigrationState,
  ids: { pull: string | null; push: string | null },
  confirm?: string,
): Promise<Check[]> {
  const pull = await mirrorOf(env, repo.id, ids.pull);
  const push = await mirrorOf(env, repo.id, ids.push);
  if (from === 'github' && to === 'mirror')
    return [mirrorCheck('pull_mirror', pull, 'pull')];
  if (from === 'mirror' && to === 'dual') {
    const pulled = syncedCheck('pull_mirror_synced', pull);
    return [
      mirrorCheck('pull_mirror', pull, 'pull'),
      pulled,
      mirrorCheck('push_mirror', push, 'push'),
      await rulesetsCheck(env, repo),
      await membersCheck(env, repo),
      await ciCheck(env, repo),
    ];
  }
  if (from === 'dual' && to === 'cutover') {
    return [
      await remoteMatches(env, repo, push),
      githubAppCheck(repo),
      approvalCheck(repo, confirm),
    ];
  }
  if (from === 'cutover' && to === 'dual') {
    return [
      mirrorCheck('push_mirror', push, 'push'),
      githubAppCheck(repo),
      approvalCheck(repo, confirm),
    ];
  }
  if (from === 'dual' && to === 'mirror') {
    return [
      await remoteMatches(env, repo, push),
      mirrorCheck('pull_mirror', pull, 'pull'),
    ];
  }
  return []; // mirror -> github: stop pulling
}

async function setArchived(env: Env, repo: RepoRecord, archived: boolean): Promise<void> {
  const installation = repo.github_installation_id as number;
  const info = await githubApi(env, installation, `/repositories/${repo.github_repo_id}`);
  if (!info.ok)
    throw new ApiError(
      502,
      'github_error',
      'GitHub repository not reachable via the App',
    );
  const { full_name: fullName } = z
    .object({ full_name: z.string() })
    .parse(await info.json());
  const res = await githubApi(env, installation, `/repos/${fullName}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok)
    throw new ApiError(
      502,
      'github_error',
      `GitHub refused to ${archived ? 'archive' : 'unarchive'} ${fullName} (HTTP ${res.status})`,
    );
}

/** Move the repo to `input.to`: sync, check, change GitHub, then record. */
export async function transition(
  c: Context<AppEnv>,
  repo: RepoRecord,
  input: TransitionInput,
): Promise<{ migration: Migration; checks: Check[] }> {
  const env = c.env;
  const current = await getMigration(env, repo.id);
  const from = current.state;
  const to = input.to;
  if (!NEXT[from].includes(to))
    throw new ApiError(
      409,
      'invalid_transition',
      `cannot move from ${from} to ${to}; next: ${NEXT[from].join(', ')}`,
    );
  const ids = {
    pull: input.pull_mirror_id ?? current.pull_mirror_id,
    push: input.push_mirror_id ?? current.push_mirror_id,
  };

  // checks that read a mirror's state sync it first
  const checks: Check[] = [];
  const syncFirst =
    from === 'mirror' && to === 'dual' ? ids.pull : from === 'dual' ? ids.push : null;
  if (syncFirst && (await mirrorOf(env, repo.id, syncFirst))) {
    const outcome = await syncMirror(env, syncFirst);
    if (outcome === 'busy')
      checks.push(
        fail('sync', 'a sync of this mirror is running; try again in a minute'),
      );
    if (outcome === 'skipped') checks.push(fail('sync', 'the mirror is disabled'));
  }
  checks.push(...(await transitionChecks(env, repo, from, to, ids, input.confirm)));
  const failing = checks.filter((check) => !check.ok);
  if (failing.length > 0)
    throw new ApiError(
      409,
      'transition_blocked',
      `cannot move to ${to}: ${failing.map((check) => check.message).join('; ')}`,
      { checks },
    );

  if (to === 'cutover') await setArchived(env, repo, true);
  if (from === 'cutover') await setArchived(env, repo, false);

  const now = Date.now();
  const userId = c.get('principal')?.userId as string;
  const migration: Migration = {
    state: to,
    pull_mirror_id: ids.pull,
    push_mirror_id: ids.push,
    updated_by: userId,
    updated_at: now,
  };
  const enable = (id: string | null, on: boolean) =>
    env.DB.prepare(
      'UPDATE mirrors SET enabled = ?, updated_at = ? WHERE id = ? AND repo_id = ?',
    ).bind(on ? 1 : 0, now, id, repo.id);
  await recordAudit(
    c,
    {
      action: 'repo.migration',
      repo,
      target: {
        from,
        to,
        pull_mirror_id: ids.pull,
        push_mirror_id: ids.push,
        checks: checks.map((check) => check.name),
        github: to === 'cutover' ? 'archived' : from === 'cutover' ? 'unarchived' : null,
      },
    },
    [
      env.DB.prepare(
        `INSERT INTO repo_migrations (repo_id, state, pull_mirror_id, push_mirror_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET state = excluded.state,
           pull_mirror_id = excluded.pull_mirror_id, push_mirror_id = excluded.push_mirror_id,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(repo.id, to, ids.pull, ids.push, userId, now),
      enable(ids.pull, to === 'mirror'),
      enable(ids.push, to === 'dual'),
    ],
  );
  const started = to === 'mirror' ? ids.pull : to === 'dual' ? ids.push : null;
  if (started) await requestMirrorSync(env, [started]);
  return { migration, checks };
}

/** Whether the migration state lets `mirror` be enabled. */
export function enableConflict(migration: Migration, mirror: MirrorRow): string | null {
  if (mirror.id === migration.pull_mirror_id && migration.state !== 'mirror')
    return `the cutover runs this pull mirror only in the mirror state (now ${migration.state})`;
  if (mirror.id === migration.push_mirror_id && migration.state !== 'dual')
    return `the cutover runs this push mirror only in the dual state (now ${migration.state})`;
  return null;
}
