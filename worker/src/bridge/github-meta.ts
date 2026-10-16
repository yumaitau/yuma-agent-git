import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, type RepoRecord } from '../db/client';
import { getRef } from '../db/repos';
import { TAG_PREFIX } from '../core/refs';
import { ulid } from '../core/ids';
import { ASSET_NAME, assetKey, CONTENT_TYPE } from '../api/releases';
import { upsertUser } from '../auth/session';
import { fieldsFromLabels } from '../collab/work';
import { changesetForSha1 } from '../git/mapping';
import { FetchClientError, readCapped } from '../git/fetch-client';
import { githubApi, installationToken } from './github';
import { nextPage } from './import';

/**
 * GitHub metadata import (issue #72): labels, milestones, issues (with
 * assignees, sub-issues and Factory work labels), pull requests, their
 * conversation comments, reviews and line comments, releases with assets, and
 * LFS objects. Each phase runs one page per step and returns a cursor, so the
 * bulk job (bulk-import.ts) checkpoints between pages and resumes after an
 * interruption. Every imported row is recorded in `github_import_map` under
 * its GitHub id, so a re-run skips what is already there.
 *
 * Issue and pull request numbers are kept, so `#12` still names the same
 * thing; `owner/repo#12` and GitHub URLs to repos in the same job are
 * rewritten to the forge org. GitHub accounts map to users by linked GitHub
 * identity or verified email, else to a placeholder user with the GitHub
 * identity linked, which the person claims by signing in with GitHub.
 *
 * Rate limits: a 429, or a 403 with `retry-after` or no quota left, throws
 * `RateLimitedError` with the time to resume; when the remaining quota drops
 * under `QUOTA_RESERVE`, the step finishes its page and asks the job to pause
 * until the reset.
 */

/** The installation token is narrowed to reads: the importer never writes. */
export const READ_ONLY = {
  contents: 'read',
  issues: 'read',
  metadata: 'read',
  pull_requests: 'read',
};
export const QUOTA_RESERVE = 100;
/** Release assets and LFS objects read into memory are capped. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const PER_PAGE = 100;
const PULLS_PER_STEP = 10;
const MAX_WARNINGS = 200;
const LFS_PER_STEP = 50;

export const META_PHASES = [
  'labels',
  'milestones',
  'issues',
  'sub_issues',
  'pulls',
  'comments',
  'reviews',
  'review_comments',
  'releases',
  'lfs',
] as const;
export type MetaPhase = (typeof META_PHASES)[number];

export class RateLimitedError extends Error {
  constructor(readonly resumeAt: number) {
    super(`GitHub rate limit reached; resuming at ${new Date(resumeAt).toISOString()}`);
    this.name = 'RateLimitedError';
  }
}

export class GithubApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`GitHub ${path}: HTTP ${status}`);
    this.name = 'GithubApiError';
  }
}

export type ImportWarning = Record<string, string | number>;

export interface MetaContext {
  env: Env;
  installationId: number;
  /** GitHub `owner/name`. */
  source: { owner: string; name: string };
  repo: RepoRecord;
  /** GitHub org → forge org for cross-repo references, repos in this job. */
  refs: { from: string; to: string; names: Set<string> };
  counts: Record<string, number>;
  warnings: ImportWarning[];
  /** Set when the quota is nearly spent: the job pauses until then. */
  pauseUntil: number | null;
  users: Map<number, string>;
  fetch?: typeof fetch;
}

export function warn(ctx: MetaContext, warning: ImportWarning): void {
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(warning);
  else ctx.counts.warnings_dropped = (ctx.counts.warnings_dropped ?? 0) + 1;
}

function count(ctx: MetaContext, key: string, n = 1): void {
  if (n > 0) ctx.counts[key] = (ctx.counts[key] ?? 0) + n;
}

// ---------------------------------------------------------------------------
// GitHub REST, rate-limit aware
// ---------------------------------------------------------------------------

/** Throws on rate limits; notes a low quota on the context. */
export function checkRateLimit(
  ctx: Pick<MetaContext, 'pauseUntil'>,
  res: Response,
  now = Date.now(),
): void {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0') * 1000;
  const retryAfter = Number(res.headers.get('retry-after') ?? '0');
  if (
    res.status === 429 ||
    (res.status === 403 && (retryAfter > 0 || remaining === '0'))
  ) {
    throw new RateLimitedError(
      retryAfter > 0 ? now + retryAfter * 1000 : reset > now ? reset : now + 60_000,
    );
  }
  if (remaining !== null && Number(remaining) < QUOTA_RESERVE && reset > now) {
    ctx.pauseUntil = Math.max(ctx.pauseUntil ?? 0, reset);
  }
}

async function ghGet(
  ctx: MetaContext,
  path: string,
): Promise<{ data: unknown; next: string | null; status: number }> {
  const res = await githubApi(ctx.env, ctx.installationId, path, {}, READ_ONLY);
  checkRateLimit(ctx, res);
  if (res.status === 404 || res.status === 410) {
    return { data: null, next: null, status: res.status };
  }
  if (!res.ok) throw new GithubApiError(path.split('?')[0] as string, res.status);
  return {
    data: (await res.json()) as unknown,
    next: nextPage(res.headers.get('link')),
    status: res.status,
  };
}

/** Each item of a list page, parsed; items that do not parse are warnings. */
function items<T>(
  ctx: MetaContext,
  kind: string,
  data: unknown,
  schema: z.ZodType<T>,
): T[] {
  if (!Array.isArray(data)) return [];
  const out: T[] = [];
  for (const raw of data) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    else
      warn(ctx, {
        kind,
        code: 'unparsed',
        message: parsed.error.issues[0]?.message ?? '',
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub shapes (only the fields the importer reads)
// ---------------------------------------------------------------------------

const ghUser = z.object({
  id: z.number(),
  login: z.string(),
  avatar_url: z.string().nullish(),
  type: z.string().optional(),
});
type GhUser = z.infer<typeof ghUser>;
const time = z.string().transform((s) => Date.parse(s));

const ghLabel = z.object({
  id: z.number(),
  name: z.string().min(1),
  color: z
    .string()
    .regex(/^[0-9a-fA-F]{6}$/)
    .catch('ededed'),
  description: z.string().nullish(),
});
const ghMilestone = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  due_on: time.nullish(),
  created_at: time,
});
const ghIssue = z.object({
  id: z.number(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullish(),
  user: ghUser.nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(ghUser).nullish(),
  milestone: z.object({ id: z.number() }).nullish(),
  locked: z.boolean().optional(),
  created_at: time,
  updated_at: time,
  closed_at: time.nullish(),
  pull_request: z.object({}).optional(),
  sub_issues_summary: z.object({ total: z.number() }).optional(),
});
const ghComment = z.object({
  id: z.number(),
  body: z.string().nullish(),
  user: ghUser.nullable(),
  created_at: time,
  updated_at: time,
  issue_url: z.string(),
});
const ghPull = z.object({
  id: z.number(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  user: ghUser.nullable(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ sha: z.string() }),
  created_at: time,
  updated_at: time,
  merged_at: time.nullish(),
  /** The commit a merge, squash or rebase left on the base branch. */
  merge_commit_sha: z.string().nullish(),
});
const ghReview = z.object({
  id: z.number(),
  user: ghUser.nullable(),
  body: z.string().nullish(),
  state: z.string(),
  commit_id: z.string().nullish(),
  submitted_at: time.nullish(),
});
const ghReviewComment = z.object({
  id: z.number(),
  pull_request_review_id: z.number().nullish(),
  in_reply_to_id: z.number().optional(),
  path: z.string(),
  line: z.number().nullish(),
  start_line: z.number().nullish(),
  original_line: z.number().nullish(),
  original_start_line: z.number().nullish(),
  side: z.enum(['LEFT', 'RIGHT']).nullish(),
  commit_id: z.string(),
  original_commit_id: z.string(),
  user: ghUser.nullable(),
  body: z.string(),
  created_at: time,
  pull_request_url: z.string(),
});
const ghRelease = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  target_commitish: z.string().nullish(),
  author: ghUser.nullish(),
  created_at: time,
  published_at: time.nullish(),
  assets: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      size: z.number(),
      content_type: z.string().nullish(),
    }),
  ),
});
const lfsBatch = z.object({
  objects: z.array(
    z.object({
      oid: z.string(),
      size: z.number(),
      actions: z
        .object({
          download: z
            .object({
              href: z.url(),
              header: z.record(z.string(), z.string()).optional(),
            })
            .optional(),
        })
        .optional(),
      error: z.object({ code: z.number(), message: z.string() }).optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Users and references
// ---------------------------------------------------------------------------

/** GitHub's stand-in for deleted accounts. */
const GHOST: GhUser = { id: 10137, login: 'ghost' };

/** The forge user for a GitHub account (matched, or a claimable placeholder). */
export async function mapUser(ctx: MetaContext, user: GhUser | null): Promise<string> {
  const gh = user ?? GHOST;
  const cached = ctx.users.get(gh.id);
  if (cached) return cached;
  const env = ctx.env;
  const seen = await q1<{ user_id: string }>(
    env,
    'SELECT user_id FROM github_import_users WHERE github_id = ?',
    [gh.id],
  );
  let userId = seen?.user_id ?? null;
  if (!userId) {
    let matchedBy: 'identity' | 'email' | 'placeholder' = 'identity';
    userId =
      (
        await q1<{ id: string }>(
          env,
          `SELECT id FROM users WHERE github_id = ?
           UNION SELECT user_id FROM user_identities WHERE provider = 'github' AND subject = ?
           LIMIT 1`,
          [gh.id, String(gh.id)],
        )
      )?.id ?? null;
    if (!userId) {
      // GitHub only publishes an email the account has verified; ours are
      // stored only when the identity provider verified them
      const email = gh.login.endsWith('[bot]') ? null : await publicEmail(ctx, gh.login);
      userId = email
        ? ((
            await q1<{ user_id: string }>(
              env,
              'SELECT user_id FROM user_identities WHERE email = ? LIMIT 1',
              [email.toLowerCase()],
            )
          )?.user_id ?? null)
        : null;
      matchedBy = 'email';
    }
    if (!userId) {
      userId = (
        await upsertUser(env, { id: gh.id, login: gh.login, avatar_url: gh.avatar_url })
      ).id;
      matchedBy = 'placeholder';
      count(ctx, 'placeholder_users');
    }
    await ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO github_import_users (github_id, login, user_id, matched_by, created_at)
       VALUES (?,?,?,?,?)`,
    )
      .bind(gh.id, gh.login, userId, matchedBy, Date.now())
      .run();
  }
  ctx.users.set(gh.id, userId);
  return userId;
}

async function publicEmail(ctx: MetaContext, login: string): Promise<string | null> {
  const { data } = await ghGet(ctx, `/users/${encodeURIComponent(login)}`);
  const parsed = z.object({ email: z.string().nullish() }).safeParse(data);
  return parsed.success ? (parsed.data.email ?? null) : null;
}

/**
 * `owner/repo#12` and GitHub issue or pull URLs that name a repo in this job
 * become `forge-org/repo#12`. Plain `#12` stays: numbers are kept.
 */
export function rewriteReferences(text: string, refs: MetaContext['refs']): string {
  const owner = refs.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const known = (name: string): boolean => refs.names.has(name.toLowerCase());
  return text
    .replace(
      new RegExp(
        `https://github\\.com/${owner}/([A-Za-z0-9._-]+)/(?:issues|pull)/(\\d+)(?:#[\\w-]+)?`,
        'gi',
      ),
      (match, name: string, n: string) =>
        known(name) ? `${refs.to}/${name}#${n}` : match,
    )
    .replace(
      new RegExp(`(^|[^\\w/.-])${owner}/([A-Za-z0-9._-]+)#(\\d+)`, 'gi'),
      (match, pre: string, name: string, n: string) =>
        known(name) ? `${pre}${refs.to}/${name}#${n}` : match,
    );
}

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

async function mapped(
  ctx: MetaContext,
  kind: string,
  ids: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await q<{ github_id: number; local_id: string }>(
      ctx.env,
      `SELECT github_id, local_id FROM github_import_map
        WHERE repo_id = ? AND kind = ? AND github_id IN (${chunk.map(() => '?').join(',')})`,
      [ctx.repo.id, kind, ...chunk],
    );
    for (const r of rows) out.set(r.github_id, r.local_id);
  }
  return out;
}

function mapStatement(
  ctx: MetaContext,
  kind: string,
  githubId: number,
  localSql: string,
  binds: unknown[],
): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO github_import_map (repo_id, kind, github_id, local_id)
     SELECT ?, ?, ?, CAST((${localSql}) AS TEXT) WHERE (${localSql}) IS NOT NULL`,
  ).bind(ctx.repo.id, kind, githubId, ...binds, ...binds);
}

function counterStatement(ctx: MetaContext, number: number): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `INSERT INTO repo_counters (repo_id, last_number) VALUES (?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
  ).bind(ctx.repo.id, number);
}

const repoPath = (ctx: MetaContext): string =>
  `/repos/${encodeURIComponent(ctx.source.owner)}/${encodeURIComponent(ctx.source.name)}`;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Run one step of `phase` from `cursor` (null: the start). Returns the next
 * cursor, or null when the phase is finished.
 */
export async function metaStep(
  ctx: MetaContext,
  phase: MetaPhase,
  cursor: string | null,
): Promise<string | null> {
  switch (phase) {
    case 'labels':
      return labelsStep(ctx, cursor ?? `${repoPath(ctx)}/labels?per_page=${PER_PAGE}`);
    case 'milestones':
      return milestonesStep(
        ctx,
        cursor ?? `${repoPath(ctx)}/milestones?state=all&per_page=${PER_PAGE}`,
      );
    case 'issues':
      return issuesStep(
        ctx,
        cursor ??
          `${repoPath(ctx)}/issues?state=all&sort=created&direction=asc&per_page=${PER_PAGE}`,
      );
    case 'sub_issues':
      return subIssuesStep(ctx, Number(cursor ?? '0'));
    case 'pulls':
      return pullsStep(
        ctx,
        cursor ??
          `${repoPath(ctx)}/pulls?state=all&sort=created&direction=asc&per_page=${PER_PAGE}`,
      );
    case 'comments':
      return commentsStep(
        ctx,
        cursor ??
          `${repoPath(ctx)}/issues/comments?sort=created&direction=asc&per_page=${PER_PAGE}`,
      );
    case 'reviews':
      return reviewsStep(ctx, Number(cursor ?? '0'));
    case 'review_comments':
      return reviewCommentsStep(
        ctx,
        cursor ??
          `${repoPath(ctx)}/pulls/comments?sort=created&direction=asc&per_page=${PER_PAGE}`,
      );
    case 'releases':
      return releasesStep(
        ctx,
        cursor ?? `${repoPath(ctx)}/releases?per_page=${PER_PAGE}`,
      );
    case 'lfs':
      return lfsStep(ctx);
  }
}

async function labelsStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const labels = items(ctx, 'label', page.data, ghLabel);
  const done = await mapped(
    ctx,
    'label',
    labels.map((l) => l.id),
  );
  const stmts: D1PreparedStatement[] = [];
  for (const label of labels) {
    if (done.has(label.id)) continue;
    stmts.push(
      ctx.env.DB.prepare(
        `INSERT INTO labels (repo_id, name, color, description) VALUES (?,?,?,?)
         ON CONFLICT (repo_id, name) DO NOTHING`,
      ).bind(ctx.repo.id, label.name, label.color.toLowerCase(), label.description ?? ''),
      mapStatement(
        ctx,
        'label',
        label.id,
        'SELECT id FROM labels WHERE repo_id = ? AND name = ?',
        [ctx.repo.id, label.name],
      ),
    );
  }
  if (stmts.length) await ctx.env.DB.batch(stmts);
  count(ctx, 'labels', stmts.length / 2);
  return page.next;
}

async function milestonesStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const milestones = items(ctx, 'milestone', page.data, ghMilestone);
  const done = await mapped(
    ctx,
    'milestone',
    milestones.map((m) => m.id),
  );
  const stmts: D1PreparedStatement[] = [];
  for (const m of milestones) {
    if (done.has(m.id)) continue;
    stmts.push(
      ctx.env.DB.prepare(
        `INSERT INTO milestones (repo_id, title, description, due_at, state, created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT (repo_id, title) DO NOTHING`,
      ).bind(
        ctx.repo.id,
        m.title,
        m.description ?? '',
        m.due_on ?? null,
        m.state,
        m.created_at,
      ),
      mapStatement(
        ctx,
        'milestone',
        m.id,
        'SELECT id FROM milestones WHERE repo_id = ? AND title = ?',
        [ctx.repo.id, m.title],
      ),
    );
  }
  if (stmts.length) await ctx.env.DB.batch(stmts);
  count(ctx, 'milestones', stmts.length / 2);
  return page.next;
}

const STATE_REASONS = new Set(['completed', 'not_planned', 'duplicate', 'reopened']);
const ISSUE_ID = 'SELECT id FROM issues WHERE repo_id = ? AND number = ?';

/** Issue or pull numbers already used in the repo (D1 binds at most 100 values). */
async function numbersTaken(ctx: MetaContext, numbers: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < numbers.length; i += 45) {
    const chunk = numbers.slice(i, i + 45);
    const marks = chunk.map(() => '?').join(',');
    const rows = await q<{ number: number }>(
      ctx.env,
      `SELECT number FROM issues WHERE repo_id = ? AND number IN (${marks})
       UNION SELECT number FROM pull_requests WHERE repo_id = ? AND number IN (${marks})`,
      [ctx.repo.id, ...chunk, ctx.repo.id, ...chunk],
    );
    for (const r of rows) out.add(r.number);
  }
  return out;
}

async function issuesStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const issues = items(ctx, 'issue', page.data, ghIssue).filter((i) => !i.pull_request);
  const done = await mapped(
    ctx,
    'issue',
    issues.map((i) => i.id),
  );
  const milestones = await mapped(
    ctx,
    'milestone',
    issues.flatMap((i) => (i.milestone ? [i.milestone.id] : [])),
  );
  const labelIds = new Map(
    (
      await q<{ id: number; name: string }>(
        ctx.env,
        'SELECT id, name FROM labels WHERE repo_id = ?',
        [ctx.repo.id],
      )
    ).map((l) => [l.name.toLowerCase(), l.id]),
  );
  const db = ctx.env.DB;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  let imported = 0;
  const fresh = issues.filter((i) => !done.has(i.id));
  const taken = await numbersTaken(
    ctx,
    fresh.map((i) => i.number),
  );
  for (const issue of fresh) {
    if (taken.has(issue.number)) {
      warn(ctx, { kind: 'issue', number: issue.number, code: 'number_taken' });
      continue;
    }
    imported++;
    const author = await mapUser(ctx, issue.user);
    const assignees: string[] = [];
    for (const a of issue.assignees ?? []) assignees.push(await mapUser(ctx, a));
    const milestone = issue.milestone ? milestones.get(issue.milestone.id) : undefined;
    const names = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const id = [ctx.repo.id, issue.number];
    stmts.push(
      db
        .prepare(
          `INSERT INTO issues (repo_id, number, title, body, state, state_reason, author_id,
             milestone_id, locked, created_at, updated_at, closed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ctx.repo.id,
          issue.number,
          issue.title.slice(0, 1000),
          rewriteReferences(issue.body ?? '', ctx.refs),
          issue.state,
          issue.state_reason && STATE_REASONS.has(issue.state_reason)
            ? issue.state_reason
            : null,
          author,
          milestone ? Number(milestone) : null,
          issue.locked ? 1 : 0,
          issue.created_at,
          issue.updated_at,
          issue.closed_at ?? null,
        ),
      mapStatement(ctx, 'issue', issue.id, ISSUE_ID, id),
      counterStatement(ctx, issue.number),
    );
    for (const name of names) {
      const label = labelIds.get(name.toLowerCase());
      if (label === undefined) {
        warn(ctx, {
          kind: 'issue',
          number: issue.number,
          code: 'label_missing',
          label: name,
        });
        continue;
      }
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) SELECT (${ISSUE_ID}), ?`,
          )
          .bind(...id, label),
      );
    }
    for (const user of new Set(assignees)) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO issue_assignees (issue_id, principal) SELECT (${ISSUE_ID}), ?`,
          )
          .bind(...id, `user:${user}`),
      );
    }
    // Factory labels (#59): `yuma:ready`, `yuma:risk:*` become work fields
    const fields = fieldsFromLabels(names);
    if (fields) {
      const readiness = issue.state === 'closed' ? 'done' : fields.readiness;
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO work_items (issue_id, repo_id, readiness, risk, plan, ready_at, updated_at)
             SELECT (${ISSUE_ID}), ?, ?, ?, ?, ?, ?`,
          )
          .bind(
            ...id,
            ctx.repo.id,
            readiness,
            fields.risk ?? 'medium',
            fields.plan ? 1 : 0,
            now,
            now,
          ),
        db
          .prepare(
            `INSERT INTO work_events (issue_id, actor, kind, from_readiness, to_readiness, reason, created_at)
             SELECT (${ISSUE_ID}), 'system', 'imported', NULL, ?, 'yuma: labels (GitHub import)', ?`,
          )
          .bind(...id, readiness, now),
      );
      count(ctx, 'work_items');
    }
    if ((issue.sub_issues_summary?.total ?? 0) > 0) {
      stmts.push(mapStatement(ctx, 'sub_issue_parent', issue.id, ISSUE_ID, id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  count(ctx, 'issues', imported);
  return page.next;
}

/** Sub-issue links, for parents seen in the issues phase (cursor: GitHub id). */
async function subIssuesStep(ctx: MetaContext, after: number): Promise<string | null> {
  const parents = await q<{ github_id: number; local_id: string; number: number }>(
    ctx.env,
    `SELECT m.github_id, m.local_id, i.number FROM github_import_map m
       JOIN issues i ON i.id = CAST(m.local_id AS INTEGER)
      WHERE m.repo_id = ? AND m.kind = 'sub_issue_parent' AND m.github_id > ?
      ORDER BY m.github_id LIMIT ?`,
    [ctx.repo.id, after, PULLS_PER_STEP],
  );
  if (parents.length === 0) return null;
  for (const parent of parents) {
    let path: string | null =
      `${repoPath(ctx)}/issues/${parent.number}/sub_issues?per_page=${PER_PAGE}`;
    let position = 0;
    while (path) {
      const page = await ghGet(ctx, path);
      const children = items(ctx, 'sub_issue', page.data, z.object({ id: z.number() }));
      const local = await mapped(
        ctx,
        'issue',
        children.map((c) => c.id),
      );
      const stmts: D1PreparedStatement[] = [];
      for (const child of children) {
        const id = local.get(child.id);
        if (!id) continue;
        stmts.push(
          ctx.env.DB.prepare(
            'INSERT OR IGNORE INTO issue_links (parent_id, child_id, position) VALUES (?,?,?)',
          ).bind(Number(parent.local_id), Number(id), position++),
        );
      }
      if (stmts.length) await ctx.env.DB.batch(stmts);
      count(ctx, 'sub_issue_links', stmts.length);
      path = page.next;
    }
  }
  return String((parents[parents.length - 1] as { github_id: number }).github_id);
}

async function pullsStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const pulls = items(ctx, 'pull', page.data, ghPull);
  const done = await mapped(
    ctx,
    'pull',
    pulls.map((p) => p.id),
  );
  const db = ctx.env.DB;
  const stmts: D1PreparedStatement[] = [];
  let imported = 0;
  for (const pull of pulls) {
    if (done.has(pull.id)) continue;
    const head = await changesetForSha1(ctx.env, ctx.repo.id, pull.head.sha);
    const base =
      (await changesetForSha1(ctx.env, ctx.repo.id, pull.base.sha)) ??
      (await getRef(ctx.env, ctx.repo.id, pull.base.ref))?.head ??
      null;
    if (!head || !base) {
      warn(ctx, { kind: 'pull', number: pull.number, code: 'commits_missing' });
      continue;
    }
    imported++;
    // release notes and issue links match a merged pull request by what landed
    const mergedCs =
      pull.merged_at && pull.merge_commit_sha
        ? await changesetForSha1(ctx.env, ctx.repo.id, pull.merge_commit_sha)
        : null;
    const state = pull.merged_at
      ? 'merged'
      : pull.state === 'closed'
        ? 'closed'
        : pull.draft
          ? 'draft'
          : 'open';
    const local = 'SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?';
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO pull_requests (repo_id, number, title, body, author_id, base_ref,
             base_cs, head_cs, state, created_at, updated_at, merged_at, merged_cs)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ctx.repo.id,
          pull.number,
          pull.title.slice(0, 200),
          rewriteReferences(pull.body ?? '', ctx.refs),
          await mapUser(ctx, pull.user),
          pull.base.ref,
          base,
          head,
          state,
          pull.created_at,
          pull.updated_at,
          pull.merged_at ?? null,
          mergedCs,
        ),
      mapStatement(ctx, 'pull', pull.id, local, [ctx.repo.id, pull.number]),
      counterStatement(ctx, pull.number),
    );
  }
  if (stmts.length) await db.batch(stmts);
  count(ctx, 'pulls', imported);
  return page.next;
}

interface LocalPull {
  id: number;
  number: number;
  head_cs: string;
  revision: number;
}

async function pullByNumber(ctx: MetaContext, number: number): Promise<LocalPull | null> {
  return q1<LocalPull>(
    ctx.env,
    'SELECT id, number, head_cs, revision FROM pull_requests WHERE repo_id = ? AND number = ?',
    [ctx.repo.id, number],
  );
}

const trailingNumber = (url: string): number => Number(/\/(\d+)$/.exec(url)?.[1] ?? '0');

/** A row and its map entry in one batch: a crash never leaves one without the other. */
async function insertMapped(
  ctx: MetaContext,
  kind: string,
  githubId: number,
  insert: D1PreparedStatement,
): Promise<void> {
  await ctx.env.DB.batch([
    insert,
    mapStatement(ctx, kind, githubId, 'SELECT last_insert_rowid()', []),
  ]);
}

/** Conversation comments: on issues as comments, on pulls as comment reviews. */
async function commentsStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const comments = items(ctx, 'comment', page.data, ghComment);
  const done = await mapped(
    ctx,
    'issue_comment',
    comments.map((c) => c.id),
  );
  const db = ctx.env.DB;
  for (const comment of comments) {
    if (done.has(comment.id)) continue;
    const number = trailingNumber(comment.issue_url);
    const author = await mapUser(ctx, comment.user);
    const body = rewriteReferences(comment.body ?? '', ctx.refs);
    const issue = await q1<{ id: number }>(ctx.env, ISSUE_ID, [ctx.repo.id, number]);
    if (issue) {
      await insertMapped(
        ctx,
        'issue_comment',
        comment.id,
        db
          .prepare(
            `INSERT INTO issue_comments (issue_id, author_id, body, created_at, updated_at)
             VALUES (?,?,?,?,?)`,
          )
          .bind(issue.id, author, body, comment.created_at, comment.updated_at),
      );
      count(ctx, 'issue_comments');
      continue;
    }
    const pull = await pullByNumber(ctx, number);
    if (!pull) {
      warn(ctx, { kind: 'comment', number, code: 'target_missing' });
      continue;
    }
    await insertMapped(
      ctx,
      'issue_comment',
      comment.id,
      db
        .prepare(
          `INSERT INTO pull_reviews (pull_id, author_id, head_cs, decision, body, created_at, revision)
           VALUES (?,?,?,'comment',?,?,?)`,
        )
        .bind(pull.id, author, pull.head_cs, body, comment.created_at, pull.revision),
    );
    count(ctx, 'pull_comments');
  }
  return page.next;
}

const DECISIONS: Record<string, 'approve' | 'request_changes' | 'comment'> = {
  APPROVED: 'approve',
  CHANGES_REQUESTED: 'request_changes',
  COMMENTED: 'comment',
  DISMISSED: 'comment',
};

/** Reviews, a few pulls per step (cursor: the last pull's GitHub id). */
async function reviewsStep(ctx: MetaContext, after: number): Promise<string | null> {
  const pulls = await q<{ github_id: number } & LocalPull>(
    ctx.env,
    `SELECT m.github_id, p.id, p.number, p.head_cs, p.revision FROM github_import_map m
       JOIN pull_requests p ON p.id = CAST(m.local_id AS INTEGER)
      WHERE m.repo_id = ? AND m.kind = 'pull' AND m.github_id > ?
      ORDER BY m.github_id LIMIT ?`,
    [ctx.repo.id, after, PULLS_PER_STEP],
  );
  if (pulls.length === 0) return null;
  for (const pull of pulls) {
    let path: string | null =
      `${repoPath(ctx)}/pulls/${pull.number}/reviews?per_page=${PER_PAGE}`;
    while (path) {
      const page = await ghGet(ctx, path);
      const reviews = items(ctx, 'review', page.data, ghReview);
      const done = await mapped(
        ctx,
        'review',
        reviews.map((r) => r.id),
      );
      for (const review of reviews) {
        const decision = DECISIONS[review.state];
        if (done.has(review.id) || !decision) continue;
        const head =
          (review.commit_id
            ? await changesetForSha1(ctx.env, ctx.repo.id, review.commit_id)
            : null) ?? pull.head_cs;
        await insertMapped(
          ctx,
          'review',
          review.id,
          ctx.env.DB.prepare(
            `INSERT INTO pull_reviews (pull_id, author_id, head_cs, decision, body, created_at, revision)
             VALUES (?,?,?,?,?,?,?)`,
          ).bind(
            pull.id,
            await mapUser(ctx, review.user),
            head,
            decision,
            rewriteReferences(review.body ?? '', ctx.refs),
            review.submitted_at ?? Date.now(),
            pull.revision,
          ),
        );
        if (review.state === 'DISMISSED') {
          warn(ctx, {
            kind: 'review',
            number: pull.number,
            code: 'dismissed_as_comment',
          });
        }
        count(ctx, 'reviews');
      }
      path = page.next;
    }
  }
  return String((pulls[pulls.length - 1] as { github_id: number }).github_id);
}

/** Line comments as review threads; replies join their root comment's thread. */
async function reviewCommentsStep(
  ctx: MetaContext,
  path: string,
): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const comments = items(ctx, 'review_comment', page.data, ghReviewComment);
  const done = await mapped(
    ctx,
    'review_comment',
    comments.map((c) => c.id),
  );
  const reviews = await mapped(
    ctx,
    'review',
    comments.flatMap((c) => (c.pull_request_review_id ? [c.pull_request_review_id] : [])),
  );
  for (const comment of comments) {
    if (done.has(comment.id)) continue;
    const number = trailingNumber(comment.pull_request_url);
    const pull = await pullByNumber(ctx, number);
    if (!pull) {
      warn(ctx, { kind: 'review_comment', number, code: 'pull_missing' });
      continue;
    }
    const author = `user:${await mapUser(ctx, comment.user)}`;
    // a root comment's thread may exist from a step that stopped before its comment
    const root = comment.in_reply_to_id ?? comment.id;
    let thread = (await mapped(ctx, 'review_thread', [root])).get(root);
    if (!thread) {
      if (root !== comment.id) {
        warn(ctx, { kind: 'review_comment', number, code: 'reply_without_thread' });
      }
      const current = comment.line != null;
      const end = comment.line ?? comment.original_line ?? 1;
      const start = Math.min(
        (current ? comment.start_line : comment.original_start_line) ?? end,
        end,
      );
      const commit = current ? comment.commit_id : comment.original_commit_id;
      const anchor =
        (await changesetForSha1(ctx.env, ctx.repo.id, commit)) ?? pull.head_cs;
      const original =
        (await changesetForSha1(ctx.env, ctx.repo.id, comment.original_commit_id)) ??
        pull.head_cs;
      await insertMapped(
        ctx,
        'review_thread',
        comment.id,
        ctx.env.DB.prepare(
          `INSERT INTO review_threads (pull_id, path, side, start_line, end_line, revision,
             anchor_cs, original_head_cs, outdated, author, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          pull.id,
          comment.path,
          comment.side === 'LEFT' ? 'base' : 'head',
          start,
          end,
          pull.revision,
          anchor,
          original,
          current ? 0 : 1,
          author,
          comment.created_at,
        ),
      );
      thread = (await mapped(ctx, 'review_thread', [comment.id])).get(comment.id);
      count(ctx, 'review_threads');
    }
    const review = comment.pull_request_review_id
      ? reviews.get(comment.pull_request_review_id)
      : undefined;
    await insertMapped(
      ctx,
      'review_comment',
      comment.id,
      ctx.env.DB.prepare(
        `INSERT INTO review_comments (thread_id, author, body, review_id, created_at)
         VALUES (?,?,?,?,?)`,
      ).bind(
        Number(thread),
        author,
        rewriteReferences(comment.body, ctx.refs),
        review ? Number(review) : null,
        comment.created_at,
      ),
    );
    count(ctx, 'review_comments');
  }
  return page.next;
}

/**
 * Releases as GitHub had them, assets stored in R2 under a cap. A release
 * whose tag was imported also becomes a forge release (#54) with its assets,
 * in the same batch, so a re-run never half-maps one.
 */
async function releasesStep(ctx: MetaContext, path: string): Promise<string | null> {
  const page = await ghGet(ctx, path);
  const releases = items(ctx, 'release', page.data, ghRelease);
  for (const release of releases) {
    const exists = await q1(
      ctx.env,
      'SELECT 1 AS x FROM imported_releases WHERE repo_id = ? AND github_id = ?',
      [ctx.repo.id, release.id],
    );
    if (exists) continue;
    const tag = await getRef(ctx.env, ctx.repo.id, `${TAG_PREFIX}${release.tag_name}`);
    const releaseId = tag ? ulid(release.created_at) : null;
    const assets: Record<string, unknown>[] = [];
    const mapped: {
      id: string;
      name: string;
      type: string;
      size: number;
      sha256: string;
    }[] = [];
    for (const asset of release.assets) {
      const assetId = ulid();
      const forge = releaseId !== null && ASSET_NAME.test(asset.name);
      const key = forge
        ? assetKey(ctx.repo.id, releaseId, assetId)
        : `imports/${ctx.repo.id}/releases/${release.id}/${asset.id}`;
      const stored =
        asset.size <= MAX_DOWNLOAD_BYTES ? await downloadAsset(ctx, asset.id, key) : null;
      const type =
        asset.content_type && CONTENT_TYPE.test(asset.content_type)
          ? asset.content_type
          : 'application/octet-stream';
      if (stored && forge)
        mapped.push({
          id: assetId,
          name: asset.name,
          type,
          size: stored.size,
          sha256: stored.sha256,
        });
      else if (stored && releaseId !== null)
        warn(ctx, {
          kind: 'release_asset',
          tag: release.tag_name,
          name: asset.name,
          code: 'bad_name',
        });
      if (!stored) {
        warn(ctx, {
          kind: 'release_asset',
          tag: release.tag_name,
          name: asset.name,
          code: asset.size > MAX_DOWNLOAD_BYTES ? 'too_large' : 'download_failed',
        });
      }
      assets.push({
        github_id: asset.id,
        name: asset.name,
        size: asset.size,
        content_type: asset.content_type ?? 'application/octet-stream',
        key: stored ? key : null,
      });
    }
    const author = await mapUser(ctx, release.author ?? null);
    const body = rewriteReferences(release.body ?? '', ctx.refs);
    const statements = [
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO imported_releases (repo_id, github_id, tag_name, name, body, draft,
           prerelease, target_commitish, target_cs, author_id, assets, created_at, published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        ctx.repo.id,
        release.id,
        release.tag_name,
        release.name ?? null,
        body,
        release.draft ? 1 : 0,
        release.prerelease ? 1 : 0,
        release.target_commitish ?? null,
        tag?.head ?? null,
        author,
        JSON.stringify(assets),
        release.created_at,
        release.published_at ?? null,
      ),
    ];
    if (tag && releaseId !== null) {
      const by = author ? `user:${author}` : 'system:import';
      const published = release.draft
        ? null
        : (release.published_at ?? release.created_at);
      statements.push(
        // a tag that already has a forge release keeps it
        ctx.env.DB.prepare(
          `INSERT OR IGNORE INTO releases (id, repo_id, tag, target_cs, name, body, draft,
             prerelease, created_by, created_at, updated_at, published_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          releaseId,
          ctx.repo.id,
          release.tag_name,
          tag.head,
          release.name || release.tag_name,
          body,
          release.draft ? 1 : 0,
          release.prerelease ? 1 : 0,
          by,
          release.created_at,
          release.created_at,
          published,
        ),
        ...mapped.map((a) =>
          ctx.env.DB.prepare(
            `INSERT INTO release_assets (id, release_id, repo_id, name, content_type, size,
               sha256, uploaded_by, created_at)
             SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM releases WHERE id = ?)`,
          ).bind(
            a.id,
            releaseId,
            ctx.repo.id,
            a.name,
            a.type,
            a.size,
            a.sha256,
            by,
            release.created_at,
            releaseId,
          ),
        ),
      );
    } else {
      warn(ctx, { kind: 'release', tag: release.tag_name, code: 'tag_missing' });
    }
    await ctx.env.DB.batch(statements);
    count(ctx, 'releases');
    count(ctx, 'release_assets', assets.filter((a) => a.key).length);
  }
  return page.next;
}

/** Asset bytes: the API answers with a redirect to storage, followed without auth. */
async function downloadAsset(
  ctx: MetaContext,
  assetId: number,
  key: string,
): Promise<{ size: number; sha256: string } | null> {
  const res = await githubApi(
    ctx.env,
    ctx.installationId,
    `${repoPath(ctx)}/releases/assets/${assetId}`,
    { headers: { accept: 'application/octet-stream' }, redirect: 'manual' },
    READ_ONLY,
  );
  checkRateLimit(ctx, res);
  const location = res.headers.get('location');
  const body =
    res.status >= 300 && res.status < 400 && location
      ? await (ctx.fetch ?? fetch)(location)
      : res;
  if (!body.ok) return null;
  const bytes = await capped(body);
  if (!bytes) return null;
  await ctx.env.OBJECTS.put(key, bytes);
  return { size: bytes.length, sha256: await sha256Hex(bytes) };
}

/** The body, or null when it is over the download cap (read as a stream). */
async function capped(res: Response): Promise<Uint8Array | null> {
  try {
    return await readCapped(res, MAX_DOWNLOAD_BYTES);
  } catch (err) {
    if (err instanceof FetchClientError) return null;
    throw err;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** LFS objects named by pointers in the imported history, via the batch API. */
async function lfsStep(ctx: MetaContext): Promise<string | null> {
  const pending = await q<{ oid: string; size: number }>(
    ctx.env,
    `SELECT oid, size FROM lfs_objects WHERE repo_id = ? AND status = 'pending'
      ORDER BY oid LIMIT ?`,
    [ctx.repo.id, LFS_PER_STEP],
  );
  if (pending.length === 0) return null;
  const set = async (oid: string, status: string): Promise<void> => {
    await ctx.env.DB.prepare(
      'UPDATE lfs_objects SET status = ?, updated_at = ? WHERE repo_id = ? AND oid = ?',
    )
      .bind(status, Date.now(), ctx.repo.id, oid)
      .run();
  };
  const small = pending.filter((p) => p.size <= MAX_DOWNLOAD_BYTES);
  for (const big of pending.filter((p) => p.size > MAX_DOWNLOAD_BYTES)) {
    warn(ctx, { kind: 'lfs', oid: big.oid, code: 'too_large', size: big.size });
    await set(big.oid, 'too_large');
  }
  if (small.length === 0) return 'more';
  const token = await installationToken(ctx.env, ctx.installationId, READ_ONLY);
  const res = await (ctx.fetch ?? fetch)(
    `https://github.com/${ctx.source.owner}/${ctx.source.name}.git/info/lfs/objects/batch`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.git-lfs+json',
        'content-type': 'application/vnd.git-lfs+json',
        authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
      },
      body: JSON.stringify({
        operation: 'download',
        transfers: ['basic'],
        objects: small.map((p) => ({ oid: p.oid, size: p.size })),
      }),
    },
  );
  checkRateLimit(ctx, res);
  if (!res.ok) throw new GithubApiError('LFS batch', res.status);
  const batch = lfsBatch.parse(await res.json());
  for (const want of small) {
    const object = batch.objects.find((o) => o.oid === want.oid);
    const action = object?.actions?.download;
    let status = 'missing';
    if (action) {
      const got = await (ctx.fetch ?? fetch)(action.href, {
        headers: action.header ?? {},
      });
      const bytes = got.ok ? await capped(got) : null;
      if (bytes && bytes.length === want.size && (await sha256Hex(bytes)) === want.oid) {
        await ctx.env.OBJECTS.put(`lfs/${ctx.repo.id}/${want.oid}`, bytes);
        status = 'stored';
      }
    }
    if (status === 'missing') warn(ctx, { kind: 'lfs', oid: want.oid, code: 'missing' });
    else count(ctx, 'lfs_objects');
    await set(want.oid, status);
  }
  return 'more';
}

/** `oid` and `size` of a Git LFS pointer file, or null for any other blob. */
export function lfsPointer(body: Uint8Array): { oid: string; size: number } | null {
  if (body.length > 1024) return null;
  const text = new TextDecoder().decode(body);
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n')) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}
