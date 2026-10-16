import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { loadWholeRepo } from '../auth/guards';
import { parseBody, sessionUser } from '../auth/owners';
import { requireRecentMfa } from '../auth/session';
import { recordAudit } from '../audit/record';
import { q, q1 } from '../db/client';
import type { RepoRecord } from '../db/client';
import { ApiError } from '../core/errors';
import { ulid } from '../core/ids';
import { encryptSecret } from '../secrets/crypto';
import { keyOwnerOf } from '../secrets/store';
import { remoteUrlProblem } from '../mirrors/remote';
import {
  githubAppProblem,
  mirrorAad,
  parseMirror,
  parseResults,
  syncMirror,
  type MirrorRow,
} from '../mirrors/sync';
import {
  enableConflict,
  getMigration,
  nextStates,
  transition,
  transitionChecks,
  transitionSchema,
} from '../mirrors/migration';
import { requestMirrorSync } from '../mirrors/queue';
import { errorResponse, readJsonBody } from './errors';

/**
 * Repository mirrors and cutover (issues #36, #73), for repo admins with a
 * browser session (API and agent tokens cannot read or change them):
 *
 *   GET|POST /repos/:repo/mirrors
 *   PATCH|DELETE /repos/:repo/mirrors/:id
 *   POST /repos/:repo/mirrors/:id/sync      sync now, returns the outcome
 *   GET|POST /repos/:repo/migration         cutover state and moves
 *
 * Mirror tokens are encrypted with the #50 envelope keys and never returned;
 * audit events name the remote's host only. Changes need a recent MFA
 * step-up when the user has a factor.
 */
export const mirrorsRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';

export const mirrorInputSchema = z.object({
  direction: z.enum(['pull', 'push']),
  remote_url: z.string().min(1).max(2048),
  auth: z.enum(['none', 'token', 'github_app']).default('none'),
  /** HTTP Basic user for `token` (default `x-access-token`, as GitHub expects). */
  username: z.string().min(1).max(100).optional(),
  /** Write-only; required for `token`. */
  token: z.string().min(1).max(4096).optional(),
  interval_s: z.number().int().min(60).max(86_400).default(300),
  /** Overwrite diverged refs (push mirrors also delete remote refs the forge lacks). */
  force: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export const mirrorPatchSchema = z.object({
  remote_url: z.string().min(1).max(2048).optional(),
  auth: z.enum(['none', 'token', 'github_app']).optional(),
  username: z.string().min(1).max(100).optional(),
  token: z.string().min(1).max(4096).optional(),
  interval_s: z.number().int().min(60).max(86_400).optional(),
  force: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export function publicMirror(m: MirrorRow, now = Date.now()) {
  return {
    id: m.id,
    direction: m.direction,
    remote_url: m.remote_url,
    auth: m.auth,
    username: m.username,
    has_token: m.credential_ciphertext !== null,
    interval_s: m.interval_s,
    force: m.force === 1,
    enabled: m.enabled === 1,
    syncing: (m.lease_until ?? 0) > now,
    last_sync_at: m.last_sync_at,
    last_success_at: m.last_success_at,
    last_error: m.last_error,
    last_result: parseResults(m.last_result),
    created_by: m.created_by,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

const host = (url: string): string => new URL(url).host;

async function checkRemote(
  env: Env,
  repo: RepoRecord,
  url: string,
  auth: MirrorRow['auth'],
): Promise<void> {
  const problem = remoteUrlProblem(url);
  if (problem) throw new ApiError(400, 'invalid_remote_url', problem);
  if (auth === 'github_app') {
    if (!repo.github_installation_id || !repo.github_repo_id)
      throw new ApiError(
        400,
        'not_connected',
        'connect the repository to the GitHub App first',
      );
    const appProblem = await githubAppProblem(env, repo, url);
    if (appProblem) throw new ApiError(400, 'invalid_remote_url', appProblem);
  }
}

async function loadMirror(c: Context<AppEnv>, repo: RepoRecord): Promise<MirrorRow> {
  const row = await q1(c.env, 'SELECT * FROM mirrors WHERE id = ? AND repo_id = ?', [
    c.req.param('id'),
    repo.id,
  ]);
  if (!row) throw new ApiError(404, 'mirror_not_found', 'Mirror not found');
  return parseMirror(row);
}

const noStore = { 'cache-control': 'private, no-store' };

mirrorsRoutes.get(`${base}/mirrors`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      'SELECT * FROM mirrors WHERE repo_id = ? ORDER BY created_at',
      [loaded.repo.id],
    );
    const now = Date.now();
    return c.json(
      { mirrors: rows.map((r) => publicMirror(parseMirror(r), now)) },
      200,
      noStore,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.post(`${base}/mirrors`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const repo = loaded.repo;
    const input = parseBody(mirrorInputSchema, await readJsonBody(c));
    await checkRemote(c.env, repo, input.remote_url, input.auth);
    if ((input.auth === 'token') !== (input.token !== undefined))
      throw new ApiError(
        400,
        'invalid_request',
        'a token is given exactly when auth is token',
      );
    const now = Date.now();
    const id = `mir_${ulid(now)}`;
    const keyOwner = keyOwnerOf(repo);
    const sealed = input.token
      ? await encryptSecret(c.env, keyOwner, mirrorAad(id), input.token)
      : null;
    const row: MirrorRow = {
      id,
      repo_id: repo.id,
      direction: input.direction,
      remote_url: input.remote_url,
      auth: input.auth,
      username: input.auth === 'token' ? (input.username ?? null) : null,
      credential_ciphertext: sealed?.ciphertext ?? null,
      key_owner: sealed ? keyOwner : null,
      key_version: sealed?.keyVersion ?? null,
      interval_s: input.interval_s,
      force: input.force ? 1 : 0,
      enabled: input.enabled ? 1 : 0,
      origin: new URL(c.req.url).origin,
      last_sync_at: null,
      last_success_at: null,
      last_error: null,
      last_refs: '{}',
      last_result: '[]',
      lease_until: null,
      created_by: sessionUser(c),
      created_at: now,
      updated_at: now,
    };
    await recordAudit(
      c,
      {
        action: 'mirror.create',
        repo,
        target: {
          mirror_id: id,
          direction: row.direction,
          host: host(row.remote_url),
          auth: row.auth,
          force: input.force,
          interval_s: row.interval_s,
        },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO mirrors (id, repo_id, direction, remote_url, auth, username,
             credential_ciphertext, key_owner, key_version, interval_s, force, enabled,
             origin, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id,
          row.repo_id,
          row.direction,
          row.remote_url,
          row.auth,
          row.username,
          row.credential_ciphertext,
          row.key_owner,
          row.key_version,
          row.interval_s,
          row.force,
          row.enabled,
          row.origin,
          row.created_by,
          row.created_at,
          row.updated_at,
        ),
      ],
    );
    if (row.enabled) await requestMirrorSync(c.env, [id]);
    return c.json({ mirror: publicMirror(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.patch(`${base}/mirrors/:id`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const repo = loaded.repo;
    const mirror = await loadMirror(c, repo);
    const input = parseBody(mirrorPatchSchema, await readJsonBody(c));
    const auth = input.auth ?? mirror.auth;
    const url = input.remote_url ?? mirror.remote_url;
    await checkRemote(c.env, repo, url, auth);
    if (input.token !== undefined && auth !== 'token')
      throw new ApiError(400, 'invalid_request', 'a token is only used with auth token');
    const keepToken = auth === 'token' && input.token === undefined;
    if (keepToken && mirror.credential_ciphertext === null)
      throw new ApiError(400, 'invalid_request', 'auth token needs a token');
    // the stored token was given for the old remote: never send it anywhere else
    if (keepToken && url !== mirror.remote_url)
      throw new ApiError(
        400,
        'invalid_request',
        'changing the remote URL needs the token again',
      );
    if (input.enabled) {
      const conflict = enableConflict(await getMigration(c.env, repo.id), mirror);
      if (conflict) throw new ApiError(409, 'migration_conflict', conflict);
    }
    const keyOwner = keyOwnerOf(repo);
    const sealed = input.token
      ? await encryptSecret(c.env, keyOwner, mirrorAad(mirror.id), input.token)
      : null;
    const next: MirrorRow = {
      ...mirror,
      remote_url: url,
      auth,
      username: auth === 'token' ? (input.username ?? mirror.username) : null,
      credential_ciphertext: sealed
        ? sealed.ciphertext
        : keepToken
          ? mirror.credential_ciphertext
          : null,
      key_owner: sealed ? keyOwner : keepToken ? mirror.key_owner : null,
      key_version: sealed ? sealed.keyVersion : keepToken ? mirror.key_version : null,
      interval_s: input.interval_s ?? mirror.interval_s,
      force: input.force === undefined ? mirror.force : input.force ? 1 : 0,
      enabled: input.enabled === undefined ? mirror.enabled : input.enabled ? 1 : 0,
      // a different remote starts from scratch: nothing is known about it
      last_refs: url === mirror.remote_url ? mirror.last_refs : '{}',
      updated_at: Date.now(),
    };
    await recordAudit(
      c,
      {
        action: 'mirror.update',
        repo,
        target: {
          mirror_id: mirror.id,
          host: host(next.remote_url),
          changed: Object.keys(input).filter((k) => k !== 'token'),
          token_changed: input.token !== undefined,
        },
      },
      [
        c.env.DB.prepare(
          `UPDATE mirrors SET remote_url = ?, auth = ?, username = ?, credential_ciphertext = ?,
             key_owner = ?, key_version = ?, interval_s = ?, force = ?, enabled = ?,
             last_refs = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(
          next.remote_url,
          next.auth,
          next.username,
          next.credential_ciphertext,
          next.key_owner,
          next.key_version,
          next.interval_s,
          next.force,
          next.enabled,
          next.last_refs,
          next.updated_at,
          mirror.id,
        ),
      ],
    );
    return c.json({ mirror: publicMirror(next) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.delete(`${base}/mirrors/:id`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const repo = loaded.repo;
    const mirror = await loadMirror(c, repo);
    const migration = await getMigration(c.env, repo.id);
    if (
      migration.state !== 'github' &&
      [migration.pull_mirror_id, migration.push_mirror_id].includes(mirror.id)
    )
      throw new ApiError(
        409,
        'migration_conflict',
        `the cutover uses this mirror (state ${migration.state}); move back to github first`,
      );
    await recordAudit(
      c,
      {
        action: 'mirror.delete',
        repo,
        target: { mirror_id: mirror.id, host: host(mirror.remote_url) },
      },
      [c.env.DB.prepare('DELETE FROM mirrors WHERE id = ?').bind(mirror.id)],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.post(`${base}/mirrors/:id/sync`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mirror = await loadMirror(c, loaded.repo);
    const outcome = await syncMirror(c.env, mirror.id);
    if (outcome === 'busy')
      throw new ApiError(409, 'mirror_busy', 'a sync of this mirror is already running');
    if (outcome === 'skipped')
      throw new ApiError(409, 'mirror_disabled', 'enable the mirror to sync it');
    const row = parseMirror(
      await q1(c.env, 'SELECT * FROM mirrors WHERE id = ?', [mirror.id]),
    );
    return c.json({ ok: outcome.ok, error: outcome.error, mirror: publicMirror(row) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.get(`${base}/migration`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const migration = await getMigration(c.env, repo.id);
    const ids = { pull: migration.pull_mirror_id, push: migration.push_mirror_id };
    const transitions = [];
    for (const to of nextStates(migration.state)) {
      transitions.push({
        to,
        checks: await transitionChecks(c.env, repo, migration.state, to, ids),
      });
    }
    return c.json({ ...migration, transitions }, 200, noStore);
  } catch (err) {
    return errorResponse(c, err);
  }
});

mirrorsRoutes.post(`${base}/migration`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(transitionSchema, await readJsonBody(c));
    return c.json(await transition(c, loaded.repo, input));
  } catch (err) {
    return errorResponse(c, err);
  }
});
