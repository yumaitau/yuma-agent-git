import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv, Principal } from '../auth/principal';
import type { RepoRecord } from '../db/client';
import { q, q1 } from '../db/client';
import { getRepo, listRefs } from '../db/repos';
import { decide, pathDecider, restrictingDecision } from '../auth/rbac';
import { appendAudit } from '../audit/record';
import { decryptSecrets } from '../secrets/crypto';
import { githubApi, installationToken } from '../bridge/github';
import { isAncestorDag } from '../core/ancestry';
import { AGENT_PREFIX } from '../core/refs';
import { changesetForSha1, readGitObject } from '../git/mapping';
import { parseCommit } from '../git/objects';
import { PackError, readPack, type PackedObject } from '../git/pack-reader';
import { GitProtocolError } from '../git/pktline';
import { PUSH_LIMITS, receivePack } from '../git/receive-pack';
import { commitShas, fetchPack, gitRefName } from '../git/upload-pack';
import { requestMirrorSync, type MirrorMessage } from './queue';
import {
  fetchRemotePack,
  lsRemote,
  packOfFetchResponse,
  parseReportStatus,
  readCapped,
  receiveAdvert,
  receiveRequest,
  remoteUrlProblem,
  RemoteError,
  scrub,
  sendPack,
  ZERO_SHA,
  type RefCommand,
  type Remote,
} from './remote';

/**
 * Mirror syncs (issues #36, #73), one at a time per mirror (a D1 lease).
 *
 * Pull: list the remote's branches and tags, fetch what the forge lacks, and
 * land it through receive-pack (`git/receive-pack.ts`) as the mirror's
 * creator, so SHAs, rulesets, path rules and the audit trail are those of a
 * push. A ref is `diverged`, and left alone, when the forge moved it since
 * the mirror last wrote it and the remote's commit does not descend from the
 * forge's; an upstream force push over a ref the mirror owns is applied.
 *
 * Push: compare the forge's branches and tags with the remote's and push the
 * difference. A remote ref the forge cannot fast-forward is `diverged` and
 * left alone, unless the mirror has `force` (which also deletes remote refs
 * the forge lacks). Remote history is never rewritten otherwise.
 *
 * Agent work refs (`refs/agents/*`) are never mirrored. Annotated tags on a
 * pull remote are skipped: the forge stores lightweight tags only.
 */

export const LEASE_MS = 10 * 60_000;
const MAX_HAVES = 256;
const MAX_RESULTS = 200;

export const mirrorRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  direction: z.enum(['pull', 'push']),
  remote_url: z.string(),
  auth: z.enum(['none', 'token', 'github_app']),
  username: z.string().nullable(),
  credential_ciphertext: z.string().nullable(),
  key_owner: z.string().nullable(),
  key_version: z.number().nullable(),
  interval_s: z.number(),
  force: z.number(),
  enabled: z.number(),
  origin: z.string(),
  last_sync_at: z.number().nullable(),
  last_success_at: z.number().nullable(),
  last_error: z.string().nullable(),
  last_refs: z.string(),
  last_result: z.string(),
  lease_until: z.number().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type MirrorRow = z.infer<typeof mirrorRowSchema>;

export const mirrorAad = (id: string): string => `mirror|${id}`;

export const REF_STATUSES = [
  'created',
  'updated',
  'forced',
  'deleted',
  'unchanged',
  'diverged',
  'skipped',
  'failed',
] as const;
export interface RefResult {
  ref: string;
  status: (typeof REF_STATUSES)[number];
  detail?: string;
}
const CHANGED = new Set(['created', 'updated', 'forced', 'deleted']);

export interface SyncOutcome {
  ok: boolean;
  error: string | null;
  results: RefResult[];
}

/** A refusal worth showing the admin as is (no internals, no credential). */
class MirrorError extends Error {}

const refsSchema = z.record(z.string(), z.string());
export const parseRefs = (text: string): Record<string, string> =>
  refsSchema.parse(JSON.parse(text));
export const parseResults = (text: string): RefResult[] =>
  z
    .array(
      z.object({
        ref: z.string(),
        status: z.enum(REF_STATUSES),
        detail: z.string().optional(),
      }),
    )
    .parse(JSON.parse(text));

const mirrored = (ref: string): boolean =>
  ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/');

interface ForgeRef {
  cs: string;
  sha: string;
}

/** The forge's branches and tags by Git ref name, with their commit SHAs. */
export async function forgeRefs(
  env: Env,
  repoId: string,
): Promise<Map<string, ForgeRef>> {
  const refs = (await listRefs(env, repoId)).filter(
    (r) => !r.name.startsWith(AGENT_PREFIX) && mirrored(gitRefName(r.name)),
  );
  const shas = await commitShas(
    env,
    repoId,
    refs.map((r) => r.head),
  );
  return new Map(
    refs.map((r) => [
      gitRefName(r.name),
      { cs: r.head, sha: shas.get(r.head) as string },
    ]),
  );
}

/** The mirror acts as its creator: still active, still a whole-repo admin. */
async function checkAccess(env: Env, repo: RepoRecord, principal: Principal) {
  const user = await q1(env, 'SELECT 1 FROM users WHERE id = ? AND active = 1', [
    principal.userId,
  ]);
  const decision = user ? await decide(env, repo, principal, 'admin') : null;
  if (!decision?.allowed) {
    throw new MirrorError(
      "the mirror's creator is no longer an admin of this repository; recreate the mirror",
    );
  }
  const restricted = restrictingDecision(await pathDecider(env, repo, principal), [
    'read',
    'history',
    'write',
  ]);
  if (restricted) {
    throw new MirrorError(
      "permission rules restrict the mirror's creator; a mirror needs the whole repository",
    );
  }
}

/**
 * Why the GitHub App cannot reach `url` for `repo`, or null. The App's
 * installation covers many repositories, so a mirror may use it only for the
 * one GitHub repository this forge repo is connected to.
 */
export async function githubAppProblem(
  env: Env,
  repo: RepoRecord,
  url: string,
): Promise<string | null> {
  if (!repo.github_installation_id || !repo.github_repo_id)
    return 'connect the repository to the GitHub App first';
  const res = await githubApi(
    env,
    repo.github_installation_id,
    `/repositories/${repo.github_repo_id}`,
  );
  if (!res.ok) return 'the connected GitHub repository is not reachable via the App';
  const { full_name: fullName } = z
    .object({ full_name: z.string() })
    .parse(await res.json());
  const remote = new URL(url);
  const path = remote.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  return remote.host === 'github.com' &&
    path.toLowerCase() === `/${fullName.toLowerCase()}`
    ? null
    : `the GitHub App reaches only the connected repository, https://github.com/${fullName}.git`;
}

async function remoteOf(env: Env, repo: RepoRecord, mirror: MirrorRow): Promise<Remote> {
  const problem = remoteUrlProblem(mirror.remote_url);
  if (problem) throw new MirrorError(problem);
  if (mirror.auth === 'none') return { url: mirror.remote_url, basic: null };
  if (mirror.auth === 'github_app') {
    const appProblem = await githubAppProblem(env, repo, mirror.remote_url);
    if (appProblem) throw new MirrorError(appProblem);
    let token: string;
    try {
      // this repository only, and write only for a push mirror
      token = await installationToken(
        env,
        repo.github_installation_id as number,
        { contents: mirror.direction === 'push' ? 'write' : 'read', metadata: 'read' },
        Date.now(),
        [repo.github_repo_id as number],
      );
    } catch {
      throw new MirrorError('a GitHub App installation token could not be issued');
    }
    return {
      url: mirror.remote_url,
      basic: { username: 'x-access-token', password: token },
    };
  }
  if (!mirror.credential_ciphertext || !mirror.key_owner || mirror.key_version === null)
    throw new MirrorError('the mirror has no stored token');
  let password: string;
  try {
    [password = ''] = await decryptSecrets(env, [
      {
        owner: mirror.key_owner,
        keyVersion: mirror.key_version,
        aad: mirrorAad(mirror.id),
        ciphertext: mirror.credential_ciphertext,
      },
    ]);
  } catch {
    throw new MirrorError('the stored token could not be decrypted');
  }
  return {
    url: mirror.remote_url,
    basic: { username: mirror.username ?? 'x-access-token', password },
  };
}

/**
 * Run receive-pack on `body` as `principal`, inside a Hono context of its
 * own so the push path (audit, webhooks, issue links, CI) sees an ordinary
 * request from the forge's origin. Upstream secrets raise alerts (#66) but
 * never stop the mirror.
 */
async function land(
  env: Env,
  repo: RepoRecord,
  principal: Principal,
  origin: string,
  body: Uint8Array,
): Promise<Map<string, string | null>> {
  const inner = new Hono<AppEnv>();
  let report: Uint8Array | null = null;
  let failure: unknown = null;
  inner.post('*', async (c) => {
    c.set('principal', principal);
    c.set('user', null);
    try {
      report = await receivePack(c, repo, body, { secretAlertsOnly: true });
    } catch (err) {
      failure = err;
    }
    return c.body(null, 204);
  });
  await inner.fetch(
    new Request(`${origin}/${repo.slug}.git/git-receive-pack`, {
      method: 'POST',
      headers: { 'user-agent': 'yuma-agent-git-mirror' },
    }),
    env,
  );
  if (failure) throw failure;
  if (!report) throw new Error('receive-pack returned nothing');
  return parseReportStatus(report).refs;
}

/** Whether `from` (a forge commit) is an ancestor of `to` (fetched or stored). */
async function descends(
  env: Env,
  repoId: string,
  objects: Map<string, PackedObject>,
  from: string,
  to: string,
): Promise<boolean> {
  const fromCs = await changesetForSha1(env, repoId, from);
  const queue = [to];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const sha = queue[i] as string;
    if (sha === from) return true;
    const object = objects.get(sha);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.body).parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
      continue;
    }
    const cs = await changesetForSha1(env, repoId, sha);
    if (cs && fromCs && (cs === fromCs || (await isAncestorDag(env, repoId, fromCs, cs))))
      return true;
  }
  return false;
}

interface Pass {
  results: RefResult[];
  /** The mirror's new `last_refs`. */
  refs: Record<string, string>;
}

interface PullUpdate {
  ref: string;
  from: string | null;
  to: string | null;
  /** The forge moved this ref itself: apply only as a fast-forward. */
  own: boolean;
}

async function pull(
  env: Env,
  repo: RepoRecord,
  principal: Principal,
  mirror: MirrorRow,
  remote: Remote,
): Promise<Pass> {
  const theirs = await lsRemote(remote);
  const last = parseRefs(mirror.last_refs);
  const forge = await forgeRefs(env, repo.id);
  const force = mirror.force === 1;
  const results: RefResult[] = [];
  const updates: PullUpdate[] = [];
  const refs: Record<string, string> = {};

  for (const [ref, remoteRef] of theirs) {
    if (remoteRef.peeled) {
      results.push({ ref, status: 'skipped', detail: 'annotated tags are not mirrored' });
      continue;
    }
    const here = forge.get(ref);
    if (here?.sha === remoteRef.sha) {
      results.push({ ref, status: 'unchanged' });
      refs[ref] = remoteRef.sha;
      continue;
    }
    updates.push({
      ref,
      from: here?.sha ?? null,
      to: remoteRef.sha,
      own: here !== undefined && here.sha !== last[ref] && !force,
    });
  }
  for (const [ref, here] of forge) {
    // only refs the mirror wrote are deleted with the remote's
    if (theirs.has(ref) || last[ref] === undefined) continue;
    if (here.sha !== last[ref] && !force) {
      results.push({
        ref,
        status: 'diverged',
        detail: 'deleted on the remote but moved on the forge',
      });
      refs[ref] = last[ref] as string;
      continue;
    }
    updates.push({ ref, from: here.sha, to: null, own: false });
  }

  const wants: string[] = [];
  for (const u of updates) {
    if (u.to && !wants.includes(u.to) && !(await changesetForSha1(env, repo.id, u.to)))
      wants.push(u.to);
  }
  const haves = [...new Set([...forge.values()].map((r) => r.sha))].slice(0, MAX_HAVES);
  const pack = wants.length > 0 ? await fetchRemotePack(remote, wants, haves) : null;

  let going = updates;
  if (updates.some((u) => u.own)) {
    const objects = pack
      ? await readPack(pack, PUSH_LIMITS, async (sha) => readGitObject(env, repo.id, sha))
      : new Map<string, PackedObject>();
    going = [];
    for (const u of updates) {
      if (u.own && !(await descends(env, repo.id, objects, u.from!, u.to!))) {
        results.push({
          ref: u.ref,
          status: 'diverged',
          detail: 'the forge has commits the remote does not; turn on force to overwrite',
        });
        if (last[u.ref]) refs[u.ref] = last[u.ref] as string;
        continue;
      }
      going.push(u);
    }
  }
  if (going.length > 0) {
    const commands: RefCommand[] = going.map((u) => ({
      ref: u.ref,
      oldSha: u.from ?? ZERO_SHA,
      newSha: u.to ?? ZERO_SHA,
    }));
    const report = await land(
      env,
      repo,
      principal,
      mirror.origin,
      receiveRequest(commands, ['report-status', 'agent=yuma-agent-git-mirror'], pack),
    );
    for (const u of going) {
      const refusal = report.has(u.ref) ? report.get(u.ref) : 'no status reported';
      if (refusal) {
        results.push({ ref: u.ref, status: 'failed', detail: refusal });
        if (last[u.ref]) refs[u.ref] = last[u.ref] as string;
        continue;
      }
      results.push({
        ref: u.ref,
        status: u.to === null ? 'deleted' : u.from === null ? 'created' : 'updated',
      });
      if (u.to) refs[u.ref] = u.to;
    }
  }
  return { results, refs };
}

async function push(
  env: Env,
  repo: RepoRecord,
  mirror: MirrorRow,
  remote: Remote,
): Promise<Pass> {
  const advert = await receiveAdvert(remote);
  const forge = await forgeRefs(env, repo.id);
  const force = mirror.force === 1;
  const results: RefResult[] = [];
  const commands: (RefCommand & { status: RefResult['status'] })[] = [];

  for (const [ref, here] of forge) {
    const there = advert.refs.get(ref);
    if (there === here.sha) {
      results.push({ ref, status: 'unchanged' });
      continue;
    }
    if (there === undefined) {
      commands.push({ ref, oldSha: ZERO_SHA, newSha: here.sha, status: 'created' });
      continue;
    }
    const thereCs = await changesetForSha1(env, repo.id, there);
    const ff =
      thereCs !== null &&
      (thereCs === here.cs || (await isAncestorDag(env, repo.id, thereCs, here.cs)));
    if (!ff && !force) {
      results.push({
        ref,
        status: 'diverged',
        detail: 'the remote has commits the forge does not; turn on force to overwrite',
      });
      continue;
    }
    commands.push({
      ref,
      oldSha: there,
      newSha: here.sha,
      status: ff ? 'updated' : 'forced',
    });
  }
  if (force) {
    for (const [ref, there] of advert.refs) {
      if (!forge.has(ref))
        commands.push({ ref, oldSha: there, newSha: ZERO_SHA, status: 'deleted' });
    }
  }

  const refs: Record<string, string> = Object.fromEntries(advert.refs);
  if (commands.length === 0) return { results, refs };
  const wants = [
    ...new Set(commands.filter((c) => c.newSha !== ZERO_SHA).map((c) => c.newSha)),
  ];
  let pack: Uint8Array | null = null;
  if (wants.length > 0) {
    const haves = [...new Set(advert.refs.values())].slice(0, MAX_HAVES);
    const stream = await fetchPack(env, repo.id, [
      ...wants.map((w) => `want ${w}`),
      ...haves.map((h) => `have ${h}`),
      'done',
    ]);
    pack = packOfFetchResponse(await readCapped(new Response(stream)));
  }
  const report = await sendPack(remote, advert, commands, pack);
  for (const c of commands) {
    const refusal = report.has(c.ref) ? report.get(c.ref) : 'no status reported';
    if (refusal) {
      results.push({ ref: c.ref, status: 'failed', detail: refusal });
      continue;
    }
    results.push({ ref: c.ref, status: c.status });
    if (c.newSha === ZERO_SHA) delete refs[c.ref];
    else refs[c.ref] = c.newSha;
  }
  return { results, refs };
}

function summary(results: RefResult[]): string | null {
  const bad = results.filter((r) => r.status === 'failed' || r.status === 'diverged');
  if (bad.length === 0) return null;
  const named = bad
    .slice(0, 3)
    .map((r) => `${r.ref} ${r.status}: ${r.detail ?? ''}`.trim())
    .join('; ');
  return `${bad.length} ref(s) not mirrored: ${named}`.slice(0, 1000);
}

export function parseMirror(row: unknown): MirrorRow {
  return mirrorRowSchema.parse(row);
}

/**
 * Sync one mirror now. `busy` while another sync holds it; `skipped` when it
 * is gone or disabled. Errors are recorded on the mirror, never thrown.
 */
export async function syncMirror(
  env: Env,
  id: string,
): Promise<SyncOutcome | 'busy' | 'skipped'> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE mirrors SET lease_until = ?, last_sync_at = ?
      WHERE id = ? AND enabled = 1 AND (lease_until IS NULL OR lease_until < ?)`,
  )
    .bind(now + LEASE_MS, now, id, now)
    .run();
  if (claim.meta.changes === 0) {
    const row = await q1<{ enabled: number }>(
      env,
      'SELECT enabled FROM mirrors WHERE id = ?',
      [id],
    );
    return row?.enabled === 1 ? 'busy' : 'skipped';
  }
  const mirror = parseMirror(await q1(env, 'SELECT * FROM mirrors WHERE id = ?', [id]));
  const repo = await getRepo(env, mirror.repo_id);
  let remote: Remote | null = null;
  let pass: Pass | null = null;
  let error: string | null;
  try {
    if (!repo) throw new MirrorError('the repository no longer exists');
    const principal: Principal = { kind: 'user', userId: mirror.created_by };
    await checkAccess(env, repo, principal);
    remote = await remoteOf(env, repo, mirror);
    pass =
      mirror.direction === 'pull'
        ? await pull(env, repo, principal, mirror, remote)
        : await push(env, repo, mirror, remote);
    error = summary(pass.results);
  } catch (err) {
    const known =
      err instanceof MirrorError ||
      err instanceof RemoteError ||
      err instanceof GitProtocolError ||
      err instanceof PackError;
    if (!known) console.error('mirrors: sync failed', id, err);
    const message = known ? err.message : 'internal error; the next sync retries';
    error = remote ? scrub(message, remote) : message;
  }
  const results = (pass?.results ?? []).slice(0, MAX_RESULTS);
  await env.DB.prepare(
    `UPDATE mirrors SET lease_until = NULL, last_error = ?, last_result = ?,
        last_refs = coalesce(?, last_refs),
        last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END
      WHERE id = ?`,
  )
    .bind(
      error,
      JSON.stringify(results),
      pass ? JSON.stringify(pass.refs) : null,
      error === null ? 1 : 0,
      now,
      id,
    )
    .run();
  const changed = results.filter((r) => CHANGED.has(r.status));
  if (repo && (changed.length > 0 || error !== null)) {
    await appendAudit(env, {
      action: 'mirror.sync',
      repo,
      actor: { kind: 'system', id: `mirror:${id}`, onBehalfOf: mirror.created_by },
      target: {
        mirror_id: id,
        direction: mirror.direction,
        host: new URL(mirror.remote_url).host,
        ok: error === null,
        error,
        refs: changed.slice(0, 50),
      },
    });
  }
  return { ok: error === null, error, results };
}

/** Cron: queue every enabled mirror whose interval has passed. */
export async function scheduleMirrors(env: Env, now: number = Date.now()): Promise<void> {
  const due = await q<{ id: string }>(
    env,
    `SELECT id FROM mirrors
      WHERE enabled = 1 AND (lease_until IS NULL OR lease_until < ?1)
        AND (last_sync_at IS NULL OR last_sync_at + interval_s * 1000 <= ?1)
      ORDER BY last_sync_at LIMIT 100`,
    [now],
  );
  await requestMirrorSync(
    env,
    due.map((r) => r.id),
  );
}

/** `mirror-sync` consumer: a held mirror is retried shortly, not dropped. */
export async function mirrorQueue(
  batch: MessageBatch<MirrorMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await syncMirror(env, message.body.mirror_id);
      if (outcome === 'busy') message.retry({ delaySeconds: 30 });
      else message.ack();
    } catch (err) {
      console.error('mirror-sync: sync could not be recorded', err);
      message.retry({ delaySeconds: 60 });
    }
  }
}
