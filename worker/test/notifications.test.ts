import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { emitCiRun } from '../src/ci/runs';
import { notifyQueue } from '../src/queues/notify';
import { sendDigests, sydneyClock } from '../src/notify/digest';
import { signUnsubscribe } from '../src/notify/email';
import type { ForgeEvent } from '../src/webhooks/events';
import type { Pull } from '../shared/collaboration';

/**
 * Notifications (issue #44): fan-out from domain events to inboxes and
 * email, idempotent on queue retries; thread mutes and repo watch levels;
 * agent inboxes; Australia/Sydney digests; signed unsubscribe links. The
 * email provider (PaperBoy over HTTPS) is a fetch stub, so nothing leaves
 * the test.
 */

const testEnv = env as unknown as TestEnv;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reviewer: Login;
let reader: Login;
let stranger: Login;
let repo: Awaited<ReturnType<typeof createRepo>>;
let head: string;
const author = { name: 'Ada', email: 'ada@example.com' };

let queued: ForgeEvent[] = [];
let mail: { to: string; subject: string; text: string; headers: Record<string, string> }[] =
  [];
let mailStatus = 200;
const realFetch = globalThis.fetch;

function bindings(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    NOTIFY_QUEUE: { send: async (body: ForgeEvent) => void queued.push(body) },
    EVENTS_QUEUE: undefined,
    NOTIFY_SIGNING_KEY: 'test-notify-key',
    PAPERBOY_API_URL: 'https://paperboy.test/api/send',
    PAPERBOY_API_KEY: 'pb-key',
    PAPERBOY_FROM: 'Yuma Git <git@yuma.test>',
    ...overrides,
  };
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in values) return values[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  as: { headers: Record<string, string> } | null = owner,
  e: Env = bindings(),
): Promise<Response> {
  return makeApp(e)(
    new Request(`https://forge.test${path}`, {
      method,
      headers: { ...(as?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** Run the `notifications` consumer over what was queued, `times` deliveries each. */
async function drain(times = 1, e: Env = bindings()): Promise<{ retried: number }> {
  const events = queued;
  queued = [];
  let retried = 0;
  for (let i = 0; i < times; i++) {
    const messages = events.map((body) => ({
      id: body.id,
      body,
      timestamp: new Date(),
      attempts: i + 1,
      ack: () => {},
      retry: () => void retried++,
    }));
    await notifyQueue(
      {
        queue: 'notifications',
        messages,
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch,
      e,
    );
  }
  return { retried };
}

interface Inbox {
  notifications: {
    id: string;
    repo: string;
    reason: string;
    event: string;
    unread: boolean;
    subject: { type: string; number: number | null; title: string; url: string };
  }[];
  unread_count: number;
  next_cursor: string | null;
}

async function inbox(as: { headers: Record<string, string> }, query = ''): Promise<Inbox> {
  return json<Inbox>(await call('GET', `/api/v1/notifications${query}`, undefined, as));
}

async function commit(parent: string | null, name: string): Promise<string> {
  return (
    await commitChanges(testEnv, repo.id, {
      first_parent: parent,
      message: name,
      author,
      changes: [{ path: name, op: 'add', content_b64: btoa('hello') }],
    })
  ).changeset.id;
}

async function openPull(as: { headers: Record<string, string> } = owner): Promise<Pull> {
  return (
    await json<{ pull: Pull }>(
      await call(
        'POST',
        '/api/v1/repos/team/project/pulls',
        { title: 'Proposed change', head_cs: head },
        as,
      ),
      201,
    )
  ).pull;
}

async function openIssue(title: string, body = ''): Promise<number> {
  return (
    await json<{ issue: { number: number } }>(
      await call('POST', '/api/v1/repos/team/project/issues', { title, body }),
      201,
    )
  ).issue.number;
}

async function setEmail(user: Login, email: string): Promise<void> {
  await run(
    testEnv,
    "INSERT INTO user_identities (provider, subject, user_id, email, linked_at) VALUES ('oidc:test', ?, ?, ?, ?)",
    [user.userId, user.userId, email, Date.now()],
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  queued = [];
  mail = [];
  mailStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url !== 'https://paperboy.test/api/send')
      throw new Error(`unexpected fetch ${req.url}`);
    expect(req.headers.get('authorization')).toBe('Bearer pb-key');
    if (mailStatus !== 200) return new Response('down', { status: mailStatus });
    mail.push((await req.json()) as (typeof mail)[number]);
    return Response.json({ ok: true });
  }) as typeof fetch;
  owner = await loginAs(testEnv, 4401, 'owner');
  reviewer = await loginAs(testEnv, 4402, 'reviewer');
  reader = await loginAs(testEnv, 4403, 'reader');
  stranger = await loginAs(testEnv, 4404, 'stranger');
  repo = await createRepo(testEnv, {
    slug: 'team/project',
    createdBy: owner.userId,
    visibility: 'private',
  });
  await run(
    testEnv,
    "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write'), (?, ?, 'read')",
    [repo.id, reviewer.userId, repo.id, reader.userId],
  );
  const base = await commit(null, 'base.txt');
  await setRef(testEnv, repo.id, 'main', base);
  head = await commit(base, 'change.txt');
  await setEmail(reviewer, 'reviewer@example.com');
  await setEmail(owner, 'owner@example.com');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fan-out and email', () => {
  it('a review request makes one notification and one email, never more on retries', async () => {
    const pull = await openPull();
    await drain();
    await json(
      await call('PUT', `/api/v1/repos/team/project/pulls/${pull.id}/reviewers`, {
        reviewers: ['reviewer'],
      }),
    );
    const events = queued;
    queued = [...events];
    await drain(3);
    expect(
      await q(testEnv, 'SELECT principal, reason FROM notifications ORDER BY id'),
    ).toEqual([{ principal: `user:${reviewer.userId}`, reason: 'review_requested' }]);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: 'reviewer@example.com',
      subject: '[team/project] Proposed change (#1)',
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect(mail[0]!.text).toContain(`https://forge.test/r/team/project/pulls/${pull.id}`);
    expect(mail[0]!.text).toContain('your review was requested');
    expect(mail[0]!.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/forge\.test\/notifications\/unsubscribe\?token=/,
    );

    // a failed send releases its claim; the retry sends exactly one email
    mail = [];
    mailStatus = 503;
    await call('PUT', `/api/v1/repos/team/project/pulls/${pull.id}/reviewers`, {
      reviewers: [],
    });
    await call('PUT', `/api/v1/repos/team/project/pulls/${pull.id}/reviewers`, {
      reviewers: ['reviewer'],
    });
    const again = queued.filter((e) => e.action === 'review_requested');
    queued = [...again];
    expect((await drain()).retried).toBe(1);
    expect(mail).toHaveLength(0);
    mailStatus = 200;
    queued = [...again];
    expect((await drain(2)).retried).toBe(0);
    expect(mail).toHaveLength(1);
    expect(await q(testEnv, 'SELECT id FROM notifications')).toHaveLength(2);
  });

  it('never notifies the actor, and email stays off without a signing key', async () => {
    const pull = await openPull();
    await drain();
    await json(
      await call(
        'PUT',
        `/api/v1/repos/team/project/pulls/${pull.id}/reviewers`,
        { reviewers: ['reviewer'] },
        owner,
        bindings({ NOTIFY_SIGNING_KEY: undefined }),
      ),
    );
    await drain(1, bindings({ NOTIFY_SIGNING_KEY: undefined }));
    expect(mail).toHaveLength(0);
    expect((await inbox(reviewer)).notifications).toHaveLength(1);
    expect((await inbox(owner)).notifications).toHaveLength(0);
  });

  it('mentions and comments reach participants and the mentioned, not code spans', async () => {
    const n = await openIssue('Crash on save', 'cc @reviewer and `@reader`');
    await drain();
    expect((await inbox(reviewer)).notifications).toMatchObject([
      { reason: 'mention', subject: { type: 'issue', number: n, title: 'Crash on save' } },
    ]);
    expect((await inbox(reader)).notifications).toHaveLength(0);
    // a reply from the reviewer reaches the author (a participant), not the reviewer
    await json(
      await call(
        'POST',
        `/api/v1/repos/team/project/issues/${n}/comments`,
        { body: 'On it' },
        reviewer,
      ),
      201,
    );
    await drain();
    expect((await inbox(owner)).notifications).toMatchObject([
      { reason: 'author', event: 'issue_comment' },
    ]);
    expect((await inbox(reviewer)).notifications).toHaveLength(1);
    // comment bodies never go out in email
    expect(mail.every((m) => !m.text.includes('On it'))).toBe(true);
  });

  it('users can mute a thread and stop getting updates for it', async () => {
    const n = await openIssue('Flaky test');
    await drain();
    const mute = await json<{ state: string }>(
      await call('PUT', `/api/v1/repos/team/project/issues/${n}/subscription`, {
        state: 'muted',
      }),
    );
    expect(mute.state).toBe('muted');
    await call(
      'POST',
      `/api/v1/repos/team/project/issues/${n}/comments`,
      { body: 'ping @owner' },
      reviewer,
    );
    await drain();
    expect((await inbox(owner)).notifications).toHaveLength(0);
    // a later participation does not undo the mute
    expect(
      await json<{ state: string }>(
        await call('GET', `/api/v1/repos/team/project/issues/${n}/subscription`),
      ),
    ).toEqual({ state: 'muted', reason: null });
    // subscribing again brings updates back
    await call('PUT', `/api/v1/repos/team/project/issues/${n}/subscription`, {
      state: 'subscribed',
    });
    await call(
      'POST',
      `/api/v1/repos/team/project/issues/${n}/comments`,
      { body: 'again' },
      reviewer,
    );
    await drain();
    expect((await inbox(owner)).notifications).toMatchObject([{ reason: 'manual' }]);
  });

  it('watching a repo hears new threads; ignoring it hears nothing, not even mentions', async () => {
    expect(
      await json(await call('GET', '/api/v1/repos/team/project/subscription', undefined, reader)),
    ).toEqual({ level: 'participating' });
    await json(
      await call(
        'PUT',
        '/api/v1/repos/team/project/subscription',
        { level: 'watching' },
        reader,
      ),
    );
    await json(
      await call(
        'PUT',
        '/api/v1/repos/team/project/subscription',
        { level: 'ignored' },
        reviewer,
      ),
    );
    await openIssue('New thing', 'hey @reviewer');
    await drain();
    expect((await inbox(reader)).notifications).toMatchObject([{ reason: 'subscribed' }]);
    expect((await inbox(reviewer)).notifications).toHaveLength(0);
  });

  it('a work queue claim notifies the thread subscribers', async () => {
    const n = await openIssue('Queue me');
    await drain();
    await run(
      testEnv,
      `INSERT INTO subscriptions (principal, subject_type, subject_id, reason, created_at)
       SELECT ?, 'issue', id, 'manual', 0 FROM issues WHERE number = ?`,
      [`user:${reader.userId}`, n],
    );
    const { notifyEvent } = await import('../src/notify/fanout');
    await notifyEvent(bindings(), {
      id: 'evt-claim-1',
      event: 'work_item',
      action: 'claimed',
      repo_id: repo.id,
      sender: { kind: 'user', id: reviewer.userId, user_id: reviewer.userId },
      origin: 'https://forge.test',
      at: Date.now(),
      data: { work_item: { number: n, title: 'Queue me', readiness: 'in-progress' } },
    });
    expect((await inbox(reader)).notifications).toMatchObject([
      { reason: 'work_claimed', event: 'work_item' },
    ]);
    expect((await inbox(owner)).notifications).toMatchObject([{ reason: 'work_claimed' }]);
  });
});

describe('inbox API', () => {
  it('marks read and done, counts unread, pages, and hides rows the caller cannot see', async () => {
    for (const title of ['one', 'two', 'three']) await openIssue(title, '@reader look');
    await drain();
    const all = await inbox(reader, '?limit=2');
    expect(all.notifications.map((n) => n.subject.title)).toEqual(['three', 'two']);
    expect(all.unread_count).toBe(3);
    const rest = await inbox(reader, `?limit=2&before=${all.next_cursor}`);
    expect(rest.notifications.map((n) => n.subject.title)).toEqual(['one']);
    expect(rest.next_cursor).toBeNull();

    const id = all.notifications[0]!.id;
    const read = await json<{ notification: { unread: boolean } }>(
      await call('PATCH', `/api/v1/notifications/${id}`, { read: true }, reader),
    );
    expect(read.notification.unread).toBe(false);
    expect((await inbox(reader)).unread_count).toBe(2);
    await json(await call('PATCH', `/api/v1/notifications/${id}`, { done: true }, reader));
    expect((await inbox(reader)).notifications).toHaveLength(2);
    expect((await inbox(reader, '?state=done')).notifications).toHaveLength(1);
    // someone else's notification is not found
    expect(
      (await call('PATCH', `/api/v1/notifications/${id}`, { read: true }, stranger)).status,
    ).toBe(404);
    await json(await call('POST', '/api/v1/notifications/read', undefined, reader));
    expect((await inbox(reader)).unread_count).toBe(0);
    expect((await call('PATCH', `/api/v1/notifications/${id}`, {}, reader)).status).toBe(400);

    // access revoked: the rows stay but are hidden
    await run(testEnv, 'DELETE FROM repo_members WHERE user_id = ?', [reader.userId]);
    expect(await inbox(reader)).toMatchObject({ notifications: [], unread_count: 0 });
    expect(
      (await call('GET', '/api/v1/notifications?repo=team/project', undefined, reader)).status,
    ).toBe(404);
  });

  it('refuses anonymous callers and stores per-user settings', async () => {
    expect((await call('GET', '/api/v1/notifications', undefined, null)).status).toBe(401);
    expect(
      await json(await call('GET', '/api/v1/notifications/settings', undefined, reviewer)),
    ).toMatchObject({
      settings: { email: 'instant', digest_hour: 7, skip_weekends: false },
      email_address: 'reviewer@example.com',
      email_available: true,
      digest_time_zone: 'Australia/Sydney',
    });
    const put = await json<{ settings: { reasons: Record<string, boolean> } }>(
      await call(
        'PUT',
        '/api/v1/notifications/settings',
        { email: 'digest', skip_weekends: true, reasons: { mention: false } },
        reviewer,
      ),
    );
    expect(put.settings).toMatchObject({ email: 'digest', skip_weekends: true });
    expect(put.settings.reasons).toMatchObject({ mention: false, review_requested: true });
    expect(
      (
        await call('PUT', '/api/v1/notifications/settings', { digest_hour: 24 }, reviewer)
      ).status,
    ).toBe(400);
    // a disabled reason makes no notification; digest mode sends no instant email
    await openIssue('Mention', '@reviewer');
    const pull = await openPull();
    await call('PUT', `/api/v1/repos/team/project/pulls/${pull.id}/reviewers`, {
      reviewers: ['reviewer'],
    });
    await drain();
    expect((await inbox(reviewer)).notifications).toMatchObject([
      { reason: 'review_requested' },
    ]);
    expect(mail).toHaveLength(0);
  });

  it('an agent principal sees CI failure notifications for its pull requests', async () => {
    const apiToken = (
      await createApiToken(testEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    const created = await json<{ id: string }>(
      await call('POST', '/api/v1/agents', { name: 'Codex', kind: 'codex' }),
      201,
    );
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: apiToken,
      agent_id: created.id,
      resource: 'team/project',
    });
    const exchanged = await json<{ access_token: string }>(
      await makeApp(bindings())(
        new Request('https://forge.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        }),
      ),
    );
    const agent = { headers: { authorization: `Bearer ${exchanged.access_token}` } };
    const pull = await openPull(agent);
    await drain();
    expect(
      await q(
        testEnv,
        "SELECT principal, reason FROM subscriptions WHERE subject_type = 'pull' ORDER BY principal",
      ),
    ).toEqual(
      expect.arrayContaining([{ principal: `agent:${created.id}`, reason: 'author' }]),
    );

    await run(
      testEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state, month,
                            reserved_micros, created_at, finished_at, context)
       VALUES ('run-1', ?, ?, 1, '{}', ?, 'failed', '2026-10', 0, ?, ?, ?)`,
      [
        repo.id,
        head,
        owner.userId,
        Date.now(),
        Date.now(),
        JSON.stringify({
          event: 'pull_request',
          ref: `refs/pull/${pull.id}/merge`,
          pull_id: pull.id,
          actor_kind: 'agent',
          origin: 'https://forge.test',
          agent_id: created.id,
        }),
      ],
    );
    await emitCiRun(bindings(), 'run-1', 'completed');
    await drain();
    const seen = await inbox(agent);
    expect(seen.notifications).toMatchObject([
      {
        reason: 'ci_failed',
        event: 'ci_run',
        subject: { type: 'pull', number: pull.number },
      },
    ]);
    // the delegating human has its own inbox
    expect((await inbox(owner)).notifications).toMatchObject([{ reason: 'ci_failed' }]);
    // agents mark their own notifications
    await json(
      await call(
        'PATCH',
        `/api/v1/notifications/${seen.notifications[0]!.id}`,
        { done: true },
        agent,
      ),
    );
    expect((await inbox(agent)).notifications).toHaveLength(0);
    // a passing run notifies nobody
    await run(testEnv, "UPDATE ci_runs SET state = 'passed' WHERE id = 'run-1'");
    await emitCiRun(bindings(), 'run-1', 'completed');
    await drain();
    expect(await q(testEnv, 'SELECT id FROM notifications')).toHaveLength(2);
  });
});

describe('digests', () => {
  // 2026-10-16 is a Friday; Sydney is on AEDT (UTC+11)
  const at = (iso: string): number => Date.parse(iso);

  async function digestUser(skipWeekends: boolean): Promise<void> {
    await json(
      await call(
        'PUT',
        '/api/v1/notifications/settings',
        { email: 'digest', skip_weekends: skipWeekends },
        reviewer,
      ),
    );
  }

  async function mention(title: string): Promise<void> {
    await openIssue(title, '@reviewer');
    await drain();
  }

  it('reads the Australia/Sydney clock', () => {
    expect(sydneyClock(at('2026-10-15T19:59:00Z'))).toEqual({
      date: '2026-10-16',
      hour: 6,
      weekend: false,
    });
    expect(sydneyClock(at('2026-10-16T20:00:00Z'))).toEqual({
      date: '2026-10-17',
      hour: 7,
      weekend: true,
    });
    // AEST in winter (UTC+10)
    expect(sydneyClock(at('2026-07-01T21:00:00Z')).hour).toBe(7);
  });

  it('sends once a day after 07:00 Australia/Sydney and skips weekends when asked', async () => {
    await digestUser(true);
    await mention('Thursday thing');
    expect(mail).toHaveLength(0);

    await sendDigests(bindings(), at('2026-10-15T19:59:00Z')); // Fri 06:59
    expect(mail).toHaveLength(0);
    await sendDigests(bindings(), at('2026-10-15T20:00:00Z')); // Fri 07:00
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: 'reviewer@example.com',
      subject: 'Yuma Git digest: 1 unread',
    });
    expect(mail[0]!.text).toContain('[team/project] Thursday thing (#1)');
    await sendDigests(bindings(), at('2026-10-16T05:00:00Z')); // Fri 16:00, again
    expect(mail).toHaveLength(1);

    await mention('Weekend thing');
    await sendDigests(bindings(), at('2026-10-16T21:00:00Z')); // Sat 08:00
    await sendDigests(bindings(), at('2026-10-17T21:00:00Z')); // Sun 08:00
    expect(mail).toHaveLength(1);
    await sendDigests(bindings(), at('2026-10-18T20:30:00Z')); // Mon 07:30
    expect(mail).toHaveLength(2);
    expect(mail[1]!.text).toContain('Weekend thing');
    expect(mail[1]!.text).not.toContain('Thursday thing');
  });

  it('sends on weekends when the setting is off, and retries a failed send', async () => {
    await digestUser(false);
    await mention('Saturday thing');
    mailStatus = 503;
    await sendDigests(bindings(), at('2026-10-16T21:00:00Z')); // Sat 08:00
    expect(mail).toHaveLength(0);
    mailStatus = 200;
    await sendDigests(bindings(), at('2026-10-16T21:01:00Z'));
    expect(mail).toHaveLength(1);
  });
});

describe('unsubscribe links', () => {
  it('a signed link stops email or mutes a thread; GET changes nothing', async () => {
    const e = bindings();
    const token = await signUnsubscribe(e, `user:${reviewer.userId}`, 'email');
    const url = `/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
    const shown = await call('GET', url, undefined, null);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain('<form method="post">');
    expect(
      await q1(testEnv, 'SELECT email FROM notification_settings WHERE principal = ?', [
        `user:${reviewer.userId}`,
      ]),
    ).toBeNull();
    expect((await call('POST', url, undefined, null)).status).toBe(200);
    expect(
      await q1(testEnv, 'SELECT email FROM notification_settings WHERE principal = ?', [
        `user:${reviewer.userId}`,
      ]),
    ).toEqual({ email: 'off' });

    // a tampered or foreign-key token does nothing
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(
      (await call('POST', `/notifications/unsubscribe?token=${forged}`, undefined, null))
        .status,
    ).toBe(400);
    const other = await signUnsubscribe(
      bindings({ NOTIFY_SIGNING_KEY: 'another-key' }),
      `user:${owner.userId}`,
      'email',
    );
    expect(
      (
        await call(
          'POST',
          `/notifications/unsubscribe?token=${encodeURIComponent(other)}`,
          undefined,
          null,
        )
      ).status,
    ).toBe(400);

    const n = await openIssue('Thread');
    await drain();
    const issue = await q1<{ id: number }>(testEnv, 'SELECT id FROM issues WHERE number = ?', [
      n,
    ]);
    const mute = await signUnsubscribe(e, `user:${owner.userId}`, `issue:${issue!.id}`);
    expect(
      (
        await call(
          'POST',
          `/notifications/unsubscribe?token=${encodeURIComponent(mute)}`,
          undefined,
          null,
        )
      ).status,
    ).toBe(200);
    expect(
      await json(
        await call('GET', `/api/v1/repos/team/project/issues/${n}/subscription`),
      ),
    ).toEqual({ state: 'muted', reason: null });
  });
});
