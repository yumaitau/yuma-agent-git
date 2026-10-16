import { z } from 'zod';
import type { Env } from '../env';
import { parseRepoRow, q, q1, run, type OrgRecord, type RepoRecord } from '../db/client';
import { createRepo, getRef, getRepo, getRepoBySlug } from '../db/repos';
import { appendAudit } from '../audit/record';
import { isAncestorDag } from '../core/ancestry';
import { ApiError } from '../core/errors';
import { ulid } from '../core/ids';
import { moveRefViaDO } from '../core/refs';
import { changesetForSha1 } from '../git/mapping';
import { parseCommit } from '../git/objects';
import { readPack, type PackedObject } from '../git/pack-reader';
import { forgeRefName, ingestPack, PUSH_LIMITS } from '../git/receive-pack';
import {
  fetchRemotePack,
  FetchClientError,
  lsRemote,
  type RemoteOptions,
  type RemoteRef,
} from '../git/fetch-client';
import { githubApi, installationToken } from './github';
import {
  checkRateLimit,
  GithubApiError,
  lfsPointer,
  META_PHASES,
  metaStep,
  RateLimitedError,
  READ_ONLY,
  warn,
  type MetaContext,
  type MetaPhase,
} from './github-meta';
import { nextPage } from './import';
import { startSecretScan } from '../security/secrets/history';

/**
 * Org-level bulk import from GitHub (issue #72). A job lists the source org's
 * repos, then imports each through the phases below, one bounded step per
 * queue message:
 *
 *  - `git`: the history over smart HTTP (protocol v2), through the push path
 *    (`ingestPack`), so every commit keeps its SHA. A commits-only fetch
 *    (`filter tree:0`) plans the history in chunks of `GIT_CHUNK` commits;
 *    each chunk is one fetch (`want` the chunk's last commit, `have` the
 *    earlier ones) and one checkpoint. Branches and tags move last, pull
 *    request heads are stored without refs (for the pulls phase)
 *  - then the metadata phases of github-meta.ts
 *
 * The job's `seq` names the one live chain of messages: a step runs only for
 * the current seq and the next message carries seq + 1, so duplicates and
 * stale messages drop out. Rate limits pause the chain (`rate_limited`, the
 * next message delayed to the reset). A repo whose step fails is marked
 * failed with its checkpoint kept; `resume` retries failed repos from there.
 *
 * Imported repos are new, private and org-owned; nothing else writes to them
 * while the job runs, so refs move as the system (like the existing import).
 */

export const PHASES = ['git', ...META_PHASES, 'done'] as const;
export type Phase = (typeof PHASES)[number];
export const GIT_CHUNK = 200;
const STEP_BUDGET_MS = 20_000;
const MAX_DELAY_S = 12 * 60 * 60;
/** Room for side-band framing around the largest pack a push may send. */
const MAX_REPLY_BYTES = PUSH_LIMITS.maxPackBytes + (PUSH_LIMITS.maxPackBytes >> 6) + 4096;

export const bulkImportSchema = z.object({
  source: z.literal('github'),
  github_org: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  installation_id: z.number().int().positive(),
  /** Repo names to import; omitted imports every repo the installation reaches. */
  repos: z
    .array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/))
    .min(1)
    .max(1000)
    .optional(),
});
export type BulkImportInput = z.infer<typeof bulkImportSchema>;

export type BulkImportMessage = { type: 'bulk_import'; job_id: string; seq: number };

const jobRow = z.object({
  id: z.string(),
  org_id: z.string(),
  source_org: z.string(),
  installation_id: z.number(),
  options: z
    .string()
    .transform((s) =>
      z.object({ repos: z.array(z.string()).optional() }).parse(JSON.parse(s)),
    ),
  status: z.enum(['queued', 'running', 'rate_limited', 'done', 'partial', 'failed']),
  seq: z.number(),
  listed: z.number(),
  list_cursor: z.string().nullable(),
  resume_at: z.number().nullable(),
  error: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type BulkJob = z.infer<typeof jobRow>;

const repoRow = z.object({
  job_id: z.string(),
  github_repo_id: z.number(),
  full_name: z.string(),
  repo_id: z.string().nullable(),
  phase: z.enum(PHASES),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  cursor: z.string().nullable(),
  counts: z
    .string()
    .transform((s) => z.record(z.string(), z.number()).parse(JSON.parse(s))),
  warnings: z
    .string()
    .transform((s) =>
      z
        .array(z.record(z.string(), z.union([z.string(), z.number()])))
        .parse(JSON.parse(s)),
    ),
  error: z.string().nullable(),
  updated_at: z.number(),
});
export type BulkRepo = z.infer<typeof repoRow>;

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export async function getBulkJob(env: Env, orgId: string, id: string): Promise<BulkJob> {
  const row = await q1(env, 'SELECT * FROM bulk_imports WHERE id = ? AND org_id = ?', [
    id,
    orgId,
  ]);
  if (!row) throw new ApiError(404, 'import_not_found', `no import ${id}`);
  return jobRow.parse(row);
}

export async function listBulkJobs(env: Env, orgId: string): Promise<BulkJob[]> {
  const rows = await q(
    env,
    'SELECT * FROM bulk_imports WHERE org_id = ? ORDER BY created_at DESC LIMIT 50',
    [orgId],
  );
  return rows.map((r) => jobRow.parse(r));
}

export async function bulkRepos(env: Env, jobId: string): Promise<BulkRepo[]> {
  const rows = await q(
    env,
    'SELECT * FROM bulk_import_repos WHERE job_id = ? ORDER BY full_name',
    [jobId],
  );
  return rows.map((r) => repoRow.parse(r));
}

/** The installation must be one the App webhook recorded, for this GitHub org. */
export async function startBulkImport(
  env: Env,
  org: OrgRecord,
  userId: string,
  input: BulkImportInput,
): Promise<BulkJob> {
  const installation = await q1<{ account_login: string }>(
    env,
    'SELECT account_login FROM installations WHERE installation_id = ?',
    [input.installation_id],
  );
  if (
    !installation ||
    installation.account_login.toLowerCase() !== input.github_org.toLowerCase()
  ) {
    throw new ApiError(
      400,
      'unknown_installation',
      `GitHub App installation ${input.installation_id} is not installed on ${input.github_org}`,
    );
  }
  const id = ulid();
  const now = Date.now();
  await run(
    env,
    `INSERT INTO bulk_imports (id, org_id, source_org, installation_id, options, status, seq,
       created_by, created_at, updated_at) VALUES (?,?,?,?,?,'queued',0,?,?,?)`,
    [
      id,
      org.id,
      input.github_org,
      input.installation_id,
      JSON.stringify(input.repos ? { repos: input.repos } : {}),
      userId,
      now,
      now,
    ],
  );
  await env.IMPORT_QUEUE.send({
    type: 'bulk_import',
    job_id: id,
    seq: 0,
  } satisfies BulkImportMessage);
  return getBulkJob(env, org.id, id);
}

/** Retry failed repos from their checkpoints and start a fresh chain of steps. */
export async function resumeBulkImport(env: Env, job: BulkJob): Promise<BulkJob> {
  if (job.status === 'done') {
    throw new ApiError(409, 'import_done', 'this import has finished; start a new one');
  }
  const now = Date.now();
  const seq = job.seq + 1;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bulk_import_repos SET status = 'running', error = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'failed'`,
    ).bind(now, job.id),
    env.DB.prepare(
      `UPDATE bulk_imports SET status = 'queued', seq = ?, error = NULL, resume_at = NULL,
         updated_at = ? WHERE id = ?`,
    ).bind(seq, now, job.id),
  ]);
  await env.IMPORT_QUEUE.send({
    type: 'bulk_import',
    job_id: job.id,
    seq,
  } satisfies BulkImportMessage);
  return getBulkJob(env, job.org_id, job.id);
}

async function setJob(
  env: Env,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  await run(
    env,
    `UPDATE bulk_imports SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...keys.map((k) => fields[k]), Date.now(), id],
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface StepOptions {
  budgetMs?: number;
  /** Commits per history chunk (tests use small ones). */
  chunk?: number;
  fetch?: typeof fetch;
}

/**
 * Run steps of one job until the budget is spent, then queue the next
 * message (delayed while rate limited). Stale or finished jobs are no-ops.
 */
export async function runBulkStep(
  env: Env,
  message: BulkImportMessage,
  opts: StepOptions = {},
): Promise<void> {
  const row = await q1(env, 'SELECT * FROM bulk_imports WHERE id = ?', [message.job_id]);
  if (!row) return;
  const job = jobRow.parse(row);
  if (job.seq !== message.seq || job.status === 'done' || job.status === 'partial')
    return;
  if (job.status === 'failed') return;
  await setJob(env, job.id, { status: 'running', resume_at: null });
  const deadline = Date.now() + (opts.budgetMs ?? STEP_BUDGET_MS);
  const names = new Set<string>();
  let pauseUntil: number | null = null;
  try {
    for (;;) {
      if (!job.listed) {
        const next = await listStep(env, job);
        job.list_cursor = next;
        job.listed = next === null ? 1 : 0;
        await setJob(env, job.id, { list_cursor: next, listed: job.listed });
      } else {
        const current = await q1(
          env,
          `SELECT * FROM bulk_import_repos WHERE job_id = ? AND status IN ('pending','running')
            ORDER BY full_name LIMIT 1`,
          [job.id],
        );
        if (!current) {
          const failed = await q1(
            env,
            "SELECT 1 AS x FROM bulk_import_repos WHERE job_id = ? AND status = 'failed'",
            [job.id],
          );
          await setJob(env, job.id, { status: failed ? 'partial' : 'done' });
          return;
        }
        if (names.size === 0) {
          for (const r of await bulkRepos(env, job.id)) {
            names.add((r.full_name.split('/')[1] ?? '').toLowerCase());
          }
        }
        pauseUntil = await repoStep(env, job, repoRow.parse(current), names, opts);
      }
      if (pauseUntil !== null || Date.now() >= deadline) break;
    }
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    pauseUntil = err.resumeAt;
  }
  const seq = job.seq + 1;
  const delay =
    pauseUntil === null
      ? 0
      : Math.min(MAX_DELAY_S, Math.max(1, Math.ceil((pauseUntil - Date.now()) / 1000)));
  await setJob(env, job.id, {
    seq,
    status: pauseUntil === null ? 'running' : 'rate_limited',
    resume_at: pauseUntil,
  });
  await env.IMPORT_QUEUE.send(
    { type: 'bulk_import', job_id: job.id, seq } satisfies BulkImportMessage,
    delay > 0 ? { delaySeconds: delay } : undefined,
  );
}

const ghRepo = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
});

/** One page of the source org's repos into `bulk_import_repos`. */
async function listStep(env: Env, job: BulkJob): Promise<string | null> {
  const path =
    job.list_cursor ??
    `/orgs/${encodeURIComponent(job.source_org)}/repos?type=all&sort=full_name&per_page=100`;
  const res = await githubApi(env, job.installation_id, path, {}, READ_ONLY);
  checkRateLimit({ pauseUntil: null }, res);
  if (!res.ok) throw new GithubApiError(path.split('?')[0] as string, res.status);
  const page = z.array(ghRepo).parse(await res.json());
  const wanted = job.options.repos
    ? new Set(job.options.repos.map((r) => r.toLowerCase()))
    : null;
  const now = Date.now();
  const stmts = page
    .filter((r) => r.owner.login.toLowerCase() === job.source_org.toLowerCase())
    .filter((r) => !wanted || wanted.has(r.name.toLowerCase()))
    .map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO bulk_import_repos (job_id, github_repo_id, full_name, updated_at)
         VALUES (?,?,?,?)`,
      ).bind(job.id, r.id, r.full_name, now),
    );
  if (stmts.length) await env.DB.batch(stmts);
  return nextPage(res.headers.get('link'));
}

/** One step of one repo; returns when the job should pause, if it should. */
async function repoStep(
  env: Env,
  job: BulkJob,
  row: BulkRepo,
  names: Set<string>,
  opts: StepOptions,
): Promise<number | null> {
  const [owner, name] = row.full_name.split('/') as [string, string];
  const ctx: MetaContext = {
    env,
    installationId: job.installation_id,
    source: { owner, name },
    repo: undefined as unknown as RepoRecord,
    refs: { from: job.source_org, to: '', names },
    counts: { ...row.counts },
    warnings: [...row.warnings],
    pauseUntil: null,
    users: new Map(),
    fetch: opts.fetch,
  };
  let phase = row.phase;
  let cursor = row.cursor;
  let error: string | null = null;
  try {
    const repo = await importTarget(env, job, row);
    ctx.repo = repo;
    ctx.refs.to = repo.slug.split('/')[0] as string;
    cursor =
      phase === 'git'
        ? await gitStep(ctx, cursor, opts)
        : await metaStep(ctx, phase as MetaPhase, cursor);
    if (cursor === null) {
      // history secret scan (#66): alerts only, the import never waits on it
      if (phase === 'git')
        await startSecretScan(env, repo.id, { kind: 'system', id: 'import' });
      phase = PHASES[PHASES.indexOf(phase) + 1] ?? 'done';
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      await saveRepo(env, row, phase, cursor, ctx, 'running', null);
      throw err;
    }
    error = err instanceof Error ? err.message : String(err);
    console.error('bulk import: repo step failed', row.full_name, phase, err);
  }
  await saveRepo(
    env,
    row,
    phase,
    cursor,
    ctx,
    error ? 'failed' : phase === 'done' ? 'done' : 'running',
    error,
  );
  return ctx.pauseUntil;
}

async function saveRepo(
  env: Env,
  row: BulkRepo,
  phase: Phase,
  cursor: string | null,
  ctx: MetaContext,
  status: BulkRepo['status'],
  error: string | null,
): Promise<void> {
  await run(
    env,
    `UPDATE bulk_import_repos SET phase = ?, cursor = ?, counts = ?, warnings = ?, status = ?,
       error = ?, repo_id = COALESCE(repo_id, ?), updated_at = ?
     WHERE job_id = ? AND github_repo_id = ?`,
    [
      phase,
      cursor,
      JSON.stringify(ctx.counts),
      JSON.stringify(ctx.warnings),
      status,
      error,
      ctx.repo?.id ?? null,
      Date.now(),
      row.job_id,
      row.github_repo_id,
    ],
  );
}

/**
 * The forge repo for a source repo: the one this job created, else a new
 * private repo `<org>/<name>`. A repo already holding that slug is never
 * written to.
 */
async function importTarget(env: Env, job: BulkJob, row: BulkRepo): Promise<RepoRecord> {
  if (row.repo_id) {
    const repo = await getRepo(env, row.repo_id);
    if (repo) return repo;
  }
  const org = await q1<{ slug: string }>(env, 'SELECT slug FROM orgs WHERE id = ?', [
    job.org_id,
  ]);
  const slug = `${org?.slug ?? ''}/${row.full_name.split('/')[1] ?? ''}`;
  const existing = await getRepoBySlug(env, slug);
  if (existing) {
    // an earlier import of this org from the same GitHub repo: carry on there
    const earlier = await q1(
      env,
      `SELECT 1 AS x FROM bulk_import_repos r JOIN bulk_imports j ON j.id = r.job_id
        WHERE j.org_id = ? AND r.github_repo_id = ? AND r.repo_id = ?`,
      [job.org_id, row.github_repo_id, existing.id],
    );
    if (!earlier) {
      throw new Error(`${slug} already exists; rename or remove it, then resume`);
    }
    await run(
      env,
      'UPDATE bulk_import_repos SET repo_id = ? WHERE job_id = ? AND github_repo_id = ?',
      [existing.id, row.job_id, row.github_repo_id],
    );
    return existing;
  }
  const repo = await createRepo(env, {
    slug,
    createdBy: job.created_by,
    ownerKind: 'org',
    ownerId: job.org_id,
  });
  await run(
    env,
    'UPDATE bulk_import_repos SET repo_id = ? WHERE job_id = ? AND github_repo_id = ?',
    [repo.id, row.job_id, row.github_repo_id],
  );
  await appendAudit(env, {
    action: 'repo.create',
    repo,
    actor: { kind: 'user', id: job.created_by },
    target: { slug, visibility: repo.visibility, import: job.id, source: row.full_name },
  });
  return repo;
}

// ---------------------------------------------------------------------------
// Git phase
// ---------------------------------------------------------------------------

const gitCursor = z.object({
  head: z.string().nullable(),
  tips: z.array(
    z.object({ name: z.string(), sha: z.string(), peeled: z.string().optional() }),
  ),
  plan: z.array(z.string()),
  done: z.number(),
  /** Tips a previous import already stored: sent as haves. */
  known: z.array(z.string()),
});
type GitCursor = z.infer<typeof gitCursor>;

const target = (ref: RemoteRef): string => ref.peeled ?? ref.sha;

async function remote(ctx: MetaContext, opts: StepOptions): Promise<RemoteOptions> {
  const token = await installationToken(ctx.env, ctx.installationId, READ_ONLY);
  return {
    url: `https://github.com/${ctx.source.owner}/${ctx.source.name}.git`,
    headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
    maxBytes: MAX_REPLY_BYTES,
    fetch: opts.fetch,
  };
}

/**
 * Commits in parents-first order from a commits-only pack, cut every `chunk`
 * commits. Fetching chunk k with chunks < k as haves brings only its share.
 */
export function planChunks(
  objects: Map<string, PackedObject>,
  tips: string[],
  chunk: number,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const tip of tips) {
    const stack: { sha: string; next: number; parents: string[] }[] = [];
    const enter = (sha: string): void => {
      const object = objects.get(sha);
      if (seen.has(sha) || object?.type !== 'commit') return;
      seen.add(sha);
      stack.push({ sha, next: 0, parents: parseCommit(object.body).parents });
    };
    enter(tip);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as (typeof stack)[number];
      if (top.next < top.parents.length) {
        enter(top.parents[top.next++] as string);
        continue;
      }
      stack.pop();
      order.push(top.sha);
    }
  }
  return order.filter((_, i) => (i + 1) % chunk === 0 && i + 1 < order.length);
}

async function gitStep(
  ctx: MetaContext,
  raw: string | null,
  opts: StepOptions,
): Promise<string | null> {
  const env = ctx.env;
  const repo = ctx.repo;
  const options = await remote(ctx, opts);
  if (raw === null) {
    const listed = await lsRemote(options, ['refs/heads/', 'refs/tags/', 'refs/pull/']);
    const tips = listed.refs.filter(
      (r) => !r.name.startsWith('refs/pull/') || r.name.endsWith('/head'),
    );
    if (tips.length === 0) return null; // empty repository
    const shas = [...new Set(tips.map(target))];
    const known: string[] = [];
    for (const sha of shas) {
      if (await changesetForSha1(env, repo.id, sha)) known.push(sha);
    }
    let plan: string[] = [];
    try {
      const commitsOnly = await fetchRemotePack(options, shas, known, 'tree:0');
      const objects = await readPack(commitsOnly, PUSH_LIMITS, async () => null);
      plan = planChunks(objects, shas, opts.chunk ?? GIT_CHUNK);
    } catch (err) {
      // no partial clone on the remote: one fetch for the whole history
      if (!(err instanceof FetchClientError)) throw err;
      warn(ctx, { kind: 'git', code: 'no_chunk_plan', message: err.message });
    }
    const cursor: GitCursor = { head: listed.head, tips, plan, done: 0, known };
    return JSON.stringify(cursor);
  }
  const cursor = gitCursor.parse(JSON.parse(raw));
  const final = cursor.done >= cursor.plan.length;
  const wants = final
    ? [...new Set(cursor.tips.map(target))]
    : [cursor.plan[cursor.done] as string];
  const pack = await fetchRemotePack(options, wants, [
    ...cursor.known,
    ...cursor.plan.slice(0, cursor.done),
  ]);
  const { objects } = await ingestPack(env, repo.id, pack, wants);
  await recordLfsPointers(ctx, objects);
  ctx.counts.git_objects = (ctx.counts.git_objects ?? 0) + objects.size;
  if (!final) {
    cursor.done++;
    return JSON.stringify(cursor);
  }
  await moveRefs(ctx, cursor);
  return null;
}

async function recordLfsPointers(
  ctx: MetaContext,
  objects: Map<string, PackedObject>,
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const object of objects.values()) {
    if (object.type !== 'blob') continue;
    const pointer = lfsPointer(object.body);
    if (!pointer) continue;
    stmts.push(
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO lfs_objects (repo_id, oid, size, status, updated_at)
         VALUES (?,?,?,'pending',?)`,
      ).bind(ctx.repo.id, pointer.oid, pointer.size, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 100)
    await ctx.env.DB.batch(stmts.slice(i, i + 100));
  if (stmts.length)
    ctx.counts.lfs_pointers = (ctx.counts.lfs_pointers ?? 0) + stmts.length;
}

/** Branches and tags to their imported changesets; HEAD's branch is the default. */
async function moveRefs(ctx: MetaContext, cursor: GitCursor): Promise<void> {
  const env = ctx.env;
  const repo = ctx.repo;
  for (const tip of cursor.tips) {
    if (tip.name.startsWith('refs/pull/')) continue;
    let name: string;
    try {
      name = forgeRefName(tip.name, repo.refs_mode ?? 'git');
    } catch (err) {
      warn(ctx, {
        kind: 'ref',
        ref: tip.name,
        code: 'invalid_name',
        message: String(err),
      });
      continue;
    }
    const cs = await changesetForSha1(env, repo.id, target(tip));
    if (!cs) {
      warn(ctx, { kind: 'ref', ref: tip.name, code: 'commit_missing' });
      continue;
    }
    if (tip.peeled) {
      // annotated tag objects are not stored yet: the tag points at its commit
      warn(ctx, { kind: 'ref', ref: tip.name, code: 'annotated_tag_as_lightweight' });
    }
    const current = (await getRef(env, repo.id, name))?.head ?? null;
    if (current === cs) continue;
    if (current !== null && !(await isAncestorDag(env, repo.id, current, cs))) {
      warn(ctx, { kind: 'ref', ref: tip.name, code: 'diverged' });
      continue;
    }
    await moveRefViaDO(env, repo.id, name, { from: current, to: cs, via: 'import' });
    ctx.counts[tip.name.startsWith('refs/tags/') ? 'tags' : 'branches'] =
      (ctx.counts[tip.name.startsWith('refs/tags/') ? 'tags' : 'branches'] ?? 0) + 1;
  }
  const head = cursor.head?.startsWith('refs/heads/')
    ? cursor.head.slice('refs/heads/'.length)
    : null;
  if (head && head !== repo.default_branch) {
    await run(env, 'UPDATE repos SET default_branch = ? WHERE id = ?', [head, repo.id]);
    const updated = await q1(env, 'SELECT * FROM repos WHERE id = ?', [repo.id]);
    if (updated) ctx.repo = parseRepoRow(updated);
  }
}
