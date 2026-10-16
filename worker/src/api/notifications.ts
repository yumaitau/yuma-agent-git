import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { boundRepos, type AppEnv, type Principal } from '../auth/principal';
import type { RepoRecord } from '../db/client';
import { loadReadableRepo, loadWholeRepo } from '../auth/guards';
import { apiError, errorResponse, readJsonBody } from './errors';
import { q, q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import {
  canSee,
  DEFAULT_SETTINGS,
  EMAIL_MODES,
  loadSettings,
  REASONS,
  type Settings,
} from '../notify/fanout';
import { emailAddress, emailSender, verifyUnsubscribe } from '../notify/email';
import { principalNames } from './issues';

/**
 * Notifications (issue #44): the caller's inbox, read and done marks,
 * preferences, repo watch levels and thread subscriptions. A user (or an API
 * token acting for one) has the inbox `user:<id>`; an agent token has its
 * agent's own, `agent:<id>`, so agents can poll for review requests and CI
 * failures on their pull requests. Every row is shown only while the caller
 * can still see its subject, so revoked access or a repo-bound token hides
 * notifications instead of leaking titles. These are the caller's own
 * settings: nothing here changes a repository, so nothing is audited.
 */
export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.use('/notifications', noStore);
notificationsRoutes.use('/notifications/*', noStore);
async function noStore(c: Context<AppEnv>, next: () => Promise<void>): Promise<void> {
  await next();
  c.header('cache-control', 'private, no-store');
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}

function callerOf(c: Context<AppEnv>): Principal {
  const principal = c.get('principal') as Principal; // `/api/*` refused anonymous callers
  // a self-hosted runner's clone token is a repository credential, not a person
  if (principal.kind === 'token' && principal.ciRunId)
    throw new ApiError(403, 'forbidden', 'Runner tokens have no notifications');
  return principal;
}

/** The inbox a principal reads: its agent's own, or its human's. */
export function inboxOf(principal: Principal): string {
  return principal.kind === 'agent'
    ? `agent:${principal.agentId}`
    : `user:${principal.userId}`;
}

/** `canSee` per repo and subject type, memoised for one request. */
function visibility(c: Context<AppEnv>, who: Principal) {
  const repos = new Map<string, Promise<RepoRecord | null>>();
  const seen = new Map<string, Promise<boolean>>();
  return {
    repo: (id: string): Promise<RepoRecord | null> => {
      if (!repos.has(id)) repos.set(id, getRepo(c.env, id));
      return repos.get(id)!;
    },
    async can(repoId: string, subjectType: string): Promise<boolean> {
      const key = `${repoId}\n${subjectType}`;
      if (!seen.has(key))
        seen.set(
          key,
          this.repo(repoId).then((r) => (r ? canSee(c.env, r, who, subjectType) : false)),
        );
      return seen.get(key)!;
    },
  };
}

interface NotificationRow {
  id: string;
  repo_id: string;
  subject_type: string;
  subject_id: string;
  number: number | null;
  title: string;
  url: string;
  reason: string;
  event: string;
  action: string | null;
  actor: string | null;
  created_at: number;
  read_at: number | null;
  done_at: number | null;
}

export const listNotificationsQuery = z.object({
  state: z
    .enum(['inbox', 'unread', 'done'])
    .default('inbox')
    .describe('`inbox`: not done; `unread`: not read or done; `done`'),
  repo: z.string().max(200).optional().describe('Only this repository (`owner/name`)'),
  before: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional()
    .describe('Notification id cursor (`next_cursor`)'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

notificationsRoutes.get('/notifications', async (c) => {
  try {
    const who = callerOf(c);
    const query = parse(listNotificationsQuery, c.req.query());
    const where = ['principal = ?'];
    const params: unknown[] = [inboxOf(who)];
    if (query.state === 'done') where.push('done_at IS NOT NULL');
    else where.push('done_at IS NULL');
    if (query.state === 'unread') where.push('read_at IS NULL');
    // unread across the inbox (or the one repo), for the bell
    const unreadWhere = ['principal = ?', 'done_at IS NULL', 'read_at IS NULL'];
    const unreadParams: unknown[] = [inboxOf(who)];
    if (query.repo !== undefined) {
      const loaded = await loadReadableRepo(c, query.repo);
      if (!loaded.ok) return loaded.response;
      for (const w of [where, unreadWhere]) w.push('repo_id = ?');
      params.push(loaded.repo.id);
      unreadParams.push(loaded.repo.id);
    }
    if (query.before !== undefined) {
      where.push('id < ?');
      params.push(query.before);
    }
    const rows = await q<NotificationRow>(
      c.env,
      `SELECT id, repo_id, subject_type, subject_id, number, title, url, reason, event, action,
              actor, created_at, read_at, done_at
         FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      [...params, query.limit + 1],
    );
    const page = rows.slice(0, query.limit);
    const vis = visibility(c, who);
    const shown: (NotificationRow & { slug: string })[] = [];
    for (const row of page) {
      if (!(await vis.can(row.repo_id, row.subject_type))) continue;
      shown.push({ ...row, slug: (await vis.repo(row.repo_id))!.slug });
    }
    const unread = await q<{ repo_id: string; subject_type: string; n: number }>(
      c.env,
      `SELECT repo_id, subject_type, COUNT(*) AS n FROM notifications
        WHERE ${unreadWhere.join(' AND ')} GROUP BY repo_id, subject_type`,
      unreadParams,
    );
    let unreadCount = 0;
    for (const u of unread) if (await vis.can(u.repo_id, u.subject_type)) unreadCount += u.n;
    return c.json({
      notifications: shown.map((n) => view(n)),
      names: await principalNames(
        c,
        shown.flatMap((n) => (n.actor ? [n.actor] : [])),
      ),
      unread_count: unreadCount,
      next_cursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

function view(n: NotificationRow & { slug: string }) {
  return {
    id: n.id,
    repo: n.slug,
    reason: n.reason,
    event: n.event,
    action: n.action,
    actor: n.actor,
    subject: {
      type: n.subject_type,
      id: n.subject_id,
      number: n.number,
      title: n.title,
      url: n.url,
    },
    unread: n.read_at === null,
    created_at: n.created_at,
    read_at: n.read_at,
    done_at: n.done_at,
  };
}

export const updateNotification = z
  .object({ read: z.boolean().optional(), done: z.boolean().optional() })
  .refine((v) => v.read !== undefined || v.done !== undefined, 'Set read or done');

notificationsRoutes.patch('/notifications/:id', async (c) => {
  try {
    const who = callerOf(c);
    const input = parse(updateNotification, await readJsonBody(c));
    const row = await q1<NotificationRow>(
      c.env,
      'SELECT * FROM notifications WHERE id = ? AND principal = ?',
      [c.req.param('id'), inboxOf(who)],
    );
    if (!row || !(await visibility(c, who).can(row.repo_id, row.subject_type)))
      return apiError(c, 404, 'notification_not_found', 'Notification not found');
    const now = Date.now();
    // done implies read; marking unread brings a done notification back to the inbox
    const read = input.done === true ? true : input.read;
    const done = input.read === false ? false : input.done;
    await run(
      c.env,
      `UPDATE notifications SET
         read_at = CASE WHEN ?1 IS NULL THEN read_at WHEN ?1 = 1 THEN COALESCE(read_at, ?3) ELSE NULL END,
         done_at = CASE WHEN ?2 IS NULL THEN done_at WHEN ?2 = 1 THEN COALESCE(done_at, ?3) ELSE NULL END
       WHERE id = ?4`,
      [read === undefined ? null : read ? 1 : 0, done === undefined ? null : done ? 1 : 0, now, row.id],
    );
    const after = (await q1<NotificationRow>(c.env, 'SELECT * FROM notifications WHERE id = ?', [
      row.id,
    ]))!;
    const repo = (await getRepo(c.env, row.repo_id))!;
    return c.json({ notification: view({ ...after, slug: repo.slug }) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Mark the whole inbox read (only the bound repositories, for a bound token). */
notificationsRoutes.post('/notifications/read', async (c) => {
  try {
    const who = callerOf(c);
    const bound = boundRepos(who);
    if (bound !== null && bound.length === 0) return c.json({ ok: true });
    await run(
      c.env,
      `UPDATE notifications SET read_at = ? WHERE principal = ? AND read_at IS NULL AND done_at IS NULL
         ${bound === null ? '' : `AND repo_id IN (${bound.map(() => '?').join(',')})`}`,
      [Date.now(), inboxOf(who), ...(bound ?? [])],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function settingsView(c: Context<AppEnv>, who: Principal, settings: Settings) {
  return {
    settings: {
      email: settings.email,
      digest_hour: settings.digest_hour,
      skip_weekends: settings.skip_weekends,
      reasons: Object.fromEntries(
        REASONS.map((r) => [r, !settings.disabled_reasons.includes(r)]),
      ),
    },
    // where email would go, and whether the forge can send any
    email_address: who.kind === 'agent' ? null : await emailAddress(c.env, who.userId),
    email_available: emailSender(c.env) !== null,
    digest_time_zone: 'Australia/Sydney',
  };
}

notificationsRoutes.get('/notifications/settings', async (c) => {
  try {
    const who = callerOf(c);
    return c.json(await settingsView(c, who, await loadSettings(c.env, inboxOf(who))));
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const notificationSettingsInput = z
  .object({
    email: z.enum(EMAIL_MODES).optional(),
    digest_hour: z.int().min(0).max(23).optional().describe('Australia/Sydney hour'),
    skip_weekends: z.boolean().optional(),
    reasons: z
      .partialRecord(z.enum(REASONS), z.boolean())
      .optional()
      .describe('`false` turns a reason off'),
  })
  .strict();

notificationsRoutes.put('/notifications/settings', async (c) => {
  try {
    const who = callerOf(c);
    const input = parse(notificationSettingsInput, await readJsonBody(c));
    const key = inboxOf(who);
    const current = await loadSettings(c.env, key);
    const disabled = new Set(current.disabled_reasons);
    for (const [reason, on] of Object.entries(input.reasons ?? {}))
      if (on) disabled.delete(reason as Settings['disabled_reasons'][number]);
      else disabled.add(reason as Settings['disabled_reasons'][number]);
    const next: Settings = {
      email: input.email ?? current.email,
      digest_hour: input.digest_hour ?? current.digest_hour,
      skip_weekends: input.skip_weekends ?? current.skip_weekends,
      disabled_reasons: REASONS.filter((r) => disabled.has(r)),
    };
    await run(
      c.env,
      `INSERT INTO notification_settings (principal, email, digest_hour, skip_weekends, disabled_reasons, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (principal) DO UPDATE SET email = excluded.email, digest_hour = excluded.digest_hour,
         skip_weekends = excluded.skip_weekends, disabled_reasons = excluded.disabled_reasons,
         updated_at = excluded.updated_at`,
      [
        key,
        next.email,
        next.digest_hour,
        next.skip_weekends ? 1 : 0,
        JSON.stringify(next.disabled_reasons),
        Date.now(),
      ],
    );
    return c.json(await settingsView(c, who, next));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Subscriptions. Thread routes come first: `:repo{.+}` would also match them.
// ---------------------------------------------------------------------------

export const threadSubscriptionInput = z.object({
  state: z
    .enum(['subscribed', 'muted', 'none'])
    .describe('`muted` stops every update for the thread; `none` drops back to the default'),
});
type ThreadState = z.infer<typeof threadSubscriptionInput>['state'];

/** The thread for a subscription route, after the repo guard pulls and issues need. */
async function loadThread(
  c: Context<AppEnv>,
  kind: 'pull' | 'issue',
): Promise<{ type: 'pull' | 'issue'; id: string } | Response> {
  const slug = c.req.param('repo')!;
  const loaded =
    kind === 'pull' ? await loadWholeRepo(c, 'read', slug) : await loadReadableRepo(c, slug);
  if (!loaded.ok) return loaded.response;
  const raw = kind === 'pull' ? c.req.param('id') : c.req.param('number');
  const n = z.coerce.number().int().positive().max(999_999_999).safeParse(raw);
  const row = !n.success
    ? null
    : await q1<{ id: number }>(
        c.env,
        kind === 'pull'
          ? 'SELECT id FROM pull_requests WHERE repo_id = ? AND id = ?'
          : 'SELECT id FROM issues WHERE repo_id = ? AND number = ?',
        [loaded.repo.id, n.data],
      );
  if (!row)
    return kind === 'pull'
      ? apiError(c, 404, 'pull_not_found', 'Pull request not found')
      : apiError(c, 404, 'issue_not_found', 'Issue not found');
  return { type: kind, id: String(row.id) };
}

async function threadState(
  c: Context<AppEnv>,
  who: Principal,
  thread: { type: string; id: string },
): Promise<{ state: ThreadState; reason: string | null }> {
  const row = await q1<{ reason: string }>(
    c.env,
    'SELECT reason FROM subscriptions WHERE principal = ? AND subject_type = ? AND subject_id = ?',
    [inboxOf(who), thread.type, thread.id],
  );
  if (!row) return { state: 'none', reason: null };
  return row.reason === 'muted'
    ? { state: 'muted', reason: null }
    : { state: 'subscribed', reason: row.reason };
}

for (const [kind, path] of [
  ['pull', '/repos/:repo{.+}/pulls/:id/subscription'],
  ['issue', '/repos/:repo{.+}/issues/:number/subscription'],
] as const) {
  notificationsRoutes.get(path, async (c) => {
    try {
      const who = callerOf(c);
      const thread = await loadThread(c, kind);
      if (thread instanceof Response) return thread;
      return c.json(await threadState(c, who, thread));
    } catch (err) {
      return errorResponse(c, err);
    }
  });
  notificationsRoutes.put(path, async (c) => {
    try {
      const who = callerOf(c);
      const thread = await loadThread(c, kind);
      if (thread instanceof Response) return thread;
      const { state } = parse(threadSubscriptionInput, await readJsonBody(c));
      const key = inboxOf(who);
      if (state === 'none')
        await run(
          c.env,
          'DELETE FROM subscriptions WHERE principal = ? AND subject_type = ? AND subject_id = ?',
          [key, thread.type, thread.id],
        );
      else
        await run(
          c.env,
          // subscribing keeps a participation reason (author, comment, ...); a mute replaces it
          `INSERT INTO subscriptions (principal, subject_type, subject_id, reason, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (principal, subject_type, subject_id) DO UPDATE SET reason = ?4
             WHERE ?4 = 'muted' OR subscriptions.reason = 'muted'`,
          [key, thread.type, thread.id, state === 'muted' ? 'muted' : 'manual', Date.now()],
        );
      return c.json(await threadState(c, who, thread));
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

export const watchInput = z.object({
  level: z
    .enum(['watching', 'participating', 'ignored'])
    .describe(
      '`watching`: all activity; `participating`: threads you are in and mentions (the default); `ignored`: nothing',
    ),
});

async function watchLevel(c: Context<AppEnv>, who: Principal, repoId: string) {
  const row = await q1<{ reason: string }>(
    c.env,
    "SELECT reason FROM subscriptions WHERE principal = ? AND subject_type = 'repo' AND subject_id = ?",
    [inboxOf(who), repoId],
  );
  return { level: row?.reason ?? 'participating' };
}

notificationsRoutes.get('/repos/:repo{.+}/subscription', async (c) => {
  try {
    const who = callerOf(c);
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return c.json(await watchLevel(c, who, loaded.repo.id));
  } catch (err) {
    return errorResponse(c, err);
  }
});

notificationsRoutes.put('/repos/:repo{.+}/subscription', async (c) => {
  try {
    const who = callerOf(c);
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const { level } = parse(watchInput, await readJsonBody(c));
    if (level === 'participating')
      await run(
        c.env,
        "DELETE FROM subscriptions WHERE principal = ? AND subject_type = 'repo' AND subject_id = ?",
        [inboxOf(who), loaded.repo.id],
      );
    else
      await run(
        c.env,
        `INSERT INTO subscriptions (principal, subject_type, subject_id, reason, created_at)
         VALUES (?, 'repo', ?, ?, ?)
         ON CONFLICT (principal, subject_type, subject_id) DO UPDATE SET reason = excluded.reason`,
        [inboxOf(who), loaded.repo.id, level, Date.now()],
      );
    return c.json(await watchLevel(c, who, loaded.repo.id));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Unsubscribe links in notification email: no sign-in, the signed token is
// the credential. GET only shows a button, so link scanners change nothing;
// the POST (also RFC 8058 one-click) applies it.
// ---------------------------------------------------------------------------

export const unsubscribeRoutes = new Hono<AppEnv>();

function page(c: Context<AppEnv>, status: 200 | 400, title: string, body: string): Response {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}button{padding:.5rem 1rem}</style>
</head><body><h1>${title}</h1>${body}</body></html>`,
    status,
    {
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  );
}

const INVALID = '<p>This link is not valid. Change your notification settings in the forge.</p>';

unsubscribeRoutes.get('/notifications/unsubscribe', async (c) => {
  const token = c.req.query('token') ?? '';
  const request = await verifyUnsubscribe(c.env, token);
  if (!request) return page(c, 400, 'Link not valid', INVALID);
  const what =
    request.s === 'email' ? 'Stop all notification email' : 'Mute this thread';
  return page(
    c,
    200,
    what,
    `<form method="post"><button type="submit">${what}</button></form>`,
  );
});

unsubscribeRoutes.post('/notifications/unsubscribe', async (c) => {
  const request = await verifyUnsubscribe(c.env, c.req.query('token') ?? '');
  if (!request) return page(c, 400, 'Link not valid', INVALID);
  const now = Date.now();
  if (request.s === 'email') {
    await run(
      c.env,
      `INSERT INTO notification_settings (principal, email, disabled_reasons, updated_at)
       VALUES (?, 'off', ?, ?)
       ON CONFLICT (principal) DO UPDATE SET email = 'off', updated_at = excluded.updated_at`,
      [request.p, JSON.stringify(DEFAULT_SETTINGS.disabled_reasons), now],
    );
    return page(c, 200, 'Unsubscribed', '<p>You will get no more notification email.</p>');
  }
  const [type, id] = request.s.split(':', 2) as [string, string];
  await run(
    c.env,
    `INSERT INTO subscriptions (principal, subject_type, subject_id, reason, created_at)
     VALUES (?, ?, ?, 'muted', ?)
     ON CONFLICT (principal, subject_type, subject_id) DO UPDATE SET reason = 'muted'`,
    [request.p, type, id, now],
  );
  return page(c, 200, 'Thread muted', '<p>You will get no more updates about it.</p>');
});
