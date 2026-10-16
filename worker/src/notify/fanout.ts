import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q, q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ulid } from '../core/ids';
import type { Principal } from '../auth/principal';
import { can, pathDecider, restrictingDecision } from '../auth/rbac';
import { agentCanReview } from '../reviews/codeowners';
import { parseContext } from '../ci/context';
import type { ForgeEvent } from '../webhooks/events';
import {
  emailAddress,
  emailSender,
  listUnsubscribeHeaders,
  signUnsubscribe,
  unsubscribeUrl,
  type EmailSender,
} from './email';

/**
 * Notification fan-out (issue #44): a domain event from `emitEvent` becomes
 * one inbox row per recipient, and an email for those who want it at once.
 * Recipients come from the event (review requests, mentions, assignees,
 * environment reviewers, repo admins for security alerts), from thread
 * subscriptions (author, participants, manual) and from repo watchers.
 * Muting a thread or ignoring a repo silences it; the actor never hears
 * about their own action. Rows are keyed by event and recipient, so a
 * redelivered event adds nothing and an email is claimed before it is sent.
 */

/** Reasons, most specific first: a recipient with several gets the first enabled one. */
export const REASONS = [
  'review_requested',
  'mention',
  'assign',
  'approval_requested',
  'security_alert',
  'ci_failed',
  'queue_ejected',
  'work_claimed',
  'author',
  'comment',
  'manual',
  'subscribed',
] as const;
export type Reason = (typeof REASONS)[number];

export const EMAIL_MODES = ['off', 'instant', 'digest'] as const;
export interface Settings {
  email: (typeof EMAIL_MODES)[number];
  digest_hour: number;
  skip_weekends: boolean;
  disabled_reasons: Reason[];
}
export const DEFAULT_SETTINGS: Settings = {
  email: 'instant',
  digest_hour: 7,
  skip_weekends: false,
  disabled_reasons: [],
};

const settingsRow = z.object({
  email: z.enum(EMAIL_MODES),
  digest_hour: z.number(),
  skip_weekends: z.number(),
  disabled_reasons: z.string(),
});

export async function loadSettings(env: Env, principal: string): Promise<Settings> {
  const row = await q1(
    env,
    'SELECT email, digest_hour, skip_weekends, disabled_reasons FROM notification_settings WHERE principal = ?',
    [principal],
  );
  if (!row) return DEFAULT_SETTINGS;
  const s = settingsRow.parse(row);
  return {
    email: s.email,
    digest_hour: s.digest_hour,
    skip_weekends: s.skip_weekends === 1,
    disabled_reasons: z
      .array(z.enum(REASONS))
      .catch([])
      .parse(JSON.parse(s.disabled_reasons)),
  };
}

type SubjectType = 'pull' | 'issue' | 'ci_run' | 'secret_alert' | 'approval';
interface Subject {
  type: SubjectType;
  id: string;
  number: number | null;
  title: string;
  url: string;
}

/** Subjects that show code or CI, which need the whole repository as pulls do. */
const WHOLE = new Set<string>(['pull', 'ci_run', 'approval', 'secret_alert']);

/** May `who` see a notification about this kind of subject in `repo`? */
export async function canSee(
  env: Env,
  repo: RepoRecord,
  who: Principal,
  subjectType: string,
): Promise<boolean> {
  const perm = subjectType === 'secret_alert' ? 'admin' : 'read';
  if (!(await can(env, repo, who, perm))) return false;
  if (!WHOLE.has(subjectType)) return true;
  const decider = await pathDecider(env, repo, who);
  return (
    restrictingDecision(decider, perm === 'read' ? ['read'] : ['read', 'write']) === null
  );
}

/** A recipient key as a principal for the visibility check; agents are checked by owner. */
async function recipientCanSee(
  env: Env,
  repo: RepoRecord,
  key: string,
  subjectType: string,
): Promise<boolean> {
  const [kind, id] = key.split(':', 2) as [string, string];
  if (kind === 'user') {
    const user = await q1(env, 'SELECT 1 FROM users WHERE id = ? AND active = 1', [id]);
    return user !== null && canSee(env, repo, { kind: 'user', userId: id }, subjectType);
  }
  if (kind !== 'agent' || subjectType === 'secret_alert') return false;
  const agent = await q1<{
    owner_kind: string;
    owner_id: string;
    allowed_repos: string | null;
  }>(
    env,
    'SELECT owner_kind, owner_id, allowed_repos FROM agents WHERE id = ? AND disabled = 0',
    [id],
  );
  // the agent's own token is checked again, path rules included, when it lists
  return agent !== null && agentCanReview(env, repo, agent);
}

interface Plan {
  subject: Subject;
  /** recipient → every reason that applies to it */
  targets: Map<string, Set<Reason>>;
  /** Thread subscriptions this event creates (participation). */
  join: Map<string, string>;
  /** Notify the thread's subscribers (only its authors), as `as` or their own reason. */
  subscribers: { authors?: boolean; as?: Reason } | null;
  watchers: boolean;
  /** Never notified (the actor); null for system events. */
  self: string | null;
}

function add(plan: Plan, key: string, reason: Reason): void {
  const reasons = plan.targets.get(key) ?? new Set<Reason>();
  reasons.add(reason);
  plan.targets.set(key, reasons);
}

/** Notify and subscribe: review requests, mentions, assignees. */
function involve(plan: Plan, key: string, reason: Reason): void {
  add(plan, key, reason);
  if (!plan.join.has(key)) plan.join.set(key, reason);
}

function senderKey(event: ForgeEvent): string | null {
  if (event.sender.kind === 'user') return `user:${event.sender.id}`;
  if (event.sender.kind === 'agent') return `agent:${event.sender.id}`;
  return event.sender.user_id ? `user:${event.sender.user_id}` : null;
}

const MENTION = /(?:^|[^\w@/.`-])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g;

/** `@login` mentions outside code, as user principals (at most 20). */
async function mentioned(env: Env, text: string | null | undefined): Promise<string[]> {
  if (!text) return [];
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const logins = [
    ...new Set([...prose.matchAll(MENTION)].map((m) => m[1]!.toLowerCase())),
  ];
  if (logins.length === 0) return [];
  const rows = await q<{ id: string }>(
    env,
    `SELECT id FROM users WHERE active = 1 AND lower(login) IN (${logins
      .slice(0, 20)
      .map(() => '?')
      .join(',')})`,
    logins.slice(0, 20),
  );
  return rows.map((r) => `user:${r.id}`);
}

/** Teams become their members (and their child teams' members, two levels down). */
async function expand(env: Env, principals: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const p of principals) {
    if (p.startsWith('user:') || p.startsWith('agent:')) out.add(p);
    if (!p.startsWith('team:')) continue;
    const members = await q<{ user_id: string }>(
      env,
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT ?, 0 UNION SELECT t.id, sub.depth + 1 FROM teams t
           JOIN sub ON t.parent_team_id = sub.id WHERE sub.depth < 2)
       SELECT DISTINCT user_id FROM team_members WHERE team_id IN (SELECT id FROM sub)`,
      [p.slice('team:'.length)],
    );
    for (const m of members) out.add(`user:${m.user_id}`);
  }
  return [...out];
}

const pullSchema = z.looseObject({
  id: z.number(),
  number: z.number().nullable(),
  title: z.string(),
  body: z.string().default(''),
  author_id: z.string(),
});
const issueSchema = z.looseObject({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().default(''),
  author_id: z.string(),
  assignees: z.array(z.string()).default([]),
});
const bodySchema = z.looseObject({ body: z.string() }).nullable().catch(null);

function pullSubject(repo: RepoRecord, pull: z.infer<typeof pullSchema>): Subject {
  return {
    type: 'pull',
    id: String(pull.id),
    number: pull.number,
    title: pull.title,
    url: `/r/${repo.slug}/pulls/${pull.id}`,
  };
}

function issueSubject(
  repo: RepoRecord,
  issue: { id: number; number: number; title: string },
): Subject {
  return {
    type: 'issue',
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    url: `/r/${repo.slug}/issues/${issue.number}`,
  };
}

/** Users who administer `repo`, as principals (a final `canSee` check still applies). */
async function repoAdmins(env: Env, repo: RepoRecord): Promise<string[]> {
  const rows = await q<{ id: string }>(
    env,
    `SELECT user_id AS id FROM repo_members WHERE repo_id = ?1 AND role = 'admin'
     UNION SELECT created_by FROM repos WHERE id = ?1 AND created_by IS NOT NULL
     UNION SELECT user_id FROM org_members WHERE org_id = ?2 AND role IN ('owner','admin')`,
    [repo.id, repo.owner_kind === 'org' ? repo.owner_id : null],
  );
  return rows.map((r) => `user:${r.id}`);
}

/** Who hears about `event`, or null when it notifies nobody. */
async function planFor(
  env: Env,
  repo: RepoRecord,
  event: ForgeEvent,
): Promise<Plan | null> {
  const d = event.data;
  const self = senderKey(event);
  const plan = (subject: Subject): Plan => ({
    subject,
    targets: new Map(),
    join: new Map(),
    subscribers: null,
    watchers: false,
    self,
  });
  const action = event.action ?? '';
  switch (event.event) {
    case 'pull_request': {
      const pull = pullSchema.parse(d['pull_request']);
      const p = plan(pullSubject(repo, pull));
      if (action === 'opened') {
        // the author, and the agent that opened it, follow it (#57 agents wake on CI)
        p.join.set(`user:${pull.author_id}`, 'author');
        if (event.sender.kind === 'agent')
          p.join.set(`agent:${event.sender.id}`, 'author');
        for (const m of await mentioned(env, pull.body)) involve(p, m, 'mention');
        p.watchers = true;
      } else if (action === 'review_requested') {
        const reviewers = z.array(z.string()).parse(d['requested_reviewers']);
        for (const r of await expand(env, reviewers)) involve(p, r, 'review_requested');
      } else if (action === 'dequeued' && typeof d['reason'] === 'string') {
        p.subscribers = { authors: true, as: 'queue_ejected' };
      } else if (['closed', 'reopened', 'ready_for_review'].includes(action)) {
        p.subscribers = {};
        p.watchers = true;
      } else return null;
      return p;
    }
    case 'pull_request_review':
    case 'pull_request_review_thread': {
      if (
        event.event === 'pull_request_review_thread' &&
        !['created', 'replied'].includes(action)
      )
        return null;
      const p = plan(pullSubject(repo, pullSchema.parse(d['pull_request'])));
      const text =
        event.event === 'pull_request_review'
          ? bodySchema.parse(d['review'])?.body
          : z
              .looseObject({ comments: z.array(z.looseObject({ body: z.string() })) })
              .parse(d['thread'])
              .comments.at(-1)?.body;
      if (self) p.join.set(self, 'comment');
      for (const m of await mentioned(env, text)) involve(p, m, 'mention');
      p.subscribers = {};
      p.watchers = true;
      return p;
    }
    case 'issues':
    case 'issue_comment': {
      const issue = issueSchema.parse(d['issue']);
      const p = plan(issueSubject(repo, issue));
      if (event.event === 'issue_comment') {
        if (self) p.join.set(self, 'comment');
        for (const m of await mentioned(env, bodySchema.parse(d['comment'])?.body))
          involve(p, m, 'mention');
        p.subscribers = {};
        p.watchers = true;
      } else if (action === 'opened') {
        p.join.set(`user:${issue.author_id}`, 'author');
        for (const a of await expand(env, issue.assignees)) involve(p, a, 'assign');
        for (const m of await mentioned(env, issue.body)) involve(p, m, 'mention');
        p.watchers = true;
      } else if (action === 'assigned') {
        const assignees = z.array(z.string()).parse(d['assignees']);
        for (const a of await expand(env, assignees)) involve(p, a, 'assign');
      } else if (action === 'closed' || action === 'reopened') {
        p.subscribers = {};
        p.watchers = true;
      } else return null;
      return p;
    }
    case 'work_item': {
      if (action !== 'claimed') return null;
      const item = z.looseObject({ number: z.number() }).parse(d['work_item']);
      const issue = await q1<{ id: number; number: number; title: string }>(
        env,
        'SELECT id, number, title FROM issues WHERE repo_id = ? AND number = ?',
        [repo.id, item.number],
      );
      if (!issue) return null;
      const p = plan(issueSubject(repo, issue));
      p.subscribers = { as: 'work_claimed' };
      return p;
    }
    case 'ci_run': {
      const ci = z
        .looseObject({ id: z.string(), state: z.string(), ref: z.string().nullable() })
        .parse(d['ci_run']);
      if (action !== 'completed' || !['failed', 'timed_out'].includes(ci.state))
        return null;
      const row = await q1<{ requested_by: string; context: string | null }>(
        env,
        'SELECT requested_by, context FROM ci_runs WHERE id = ?',
        [ci.id],
      );
      const context = parseContext(row?.context);
      const pull = context?.pull_id
        ? await q1(
            env,
            'SELECT id, number, title, body, author_id FROM pull_requests WHERE id = ? AND repo_id = ?',
            [context.pull_id, repo.id],
          )
        : null;
      const p = plan(
        pull
          ? pullSubject(repo, pullSchema.parse(pull))
          : {
              type: 'ci_run',
              id: ci.id,
              number: null,
              title: `CI failed on ${ci.ref ?? 'a revision'}`,
              url: `/r/${repo.slug}/ci`,
            },
      );
      // a failure is news to whoever started the run too
      p.self = null;
      if (pull) p.subscribers = { authors: true, as: 'ci_failed' };
      if (row) add(p, `user:${row.requested_by}`, 'ci_failed');
      if (context?.agent_id) add(p, `agent:${context.agent_id}`, 'ci_failed');
      return p;
    }
    case 'secret_scanning_alert': {
      if (action !== 'created') return null;
      const alert = z
        .looseObject({ id: z.number(), detector: z.string() })
        .parse(d['alert']);
      const p = plan({
        type: 'secret_alert',
        id: String(alert.id),
        number: null,
        // the detector name only: never the path or the value
        title: `Possible ${alert.detector} secret pushed`,
        url: `/r/${repo.slug}/secret-scanning`,
      });
      for (const a of await repoAdmins(env, repo)) add(p, a, 'security_alert');
      return p;
    }
    case 'agent_approval': {
      if (action !== 'requested') return null;
      const approval = z
        .looseObject({ id: z.string(), action: z.string() })
        .parse(d['approval']);
      const p = plan({
        type: 'approval',
        id: approval.id,
        number: null,
        title: `An agent's ${approval.action} is waiting for approval`,
        url: '/settings',
      });
      // repo admins decide (api/guardrails.ts)
      for (const a of await repoAdmins(env, repo)) add(p, a, 'approval_requested');
      return p;
    }
    case 'environment_approval': {
      if (action !== 'requested') return null;
      const approval = z
        .looseObject({ id: z.string(), environment: z.string() })
        .parse(d['approval']);
      const reviewers = z
        .array(z.looseObject({ type: z.enum(['user', 'team']), id: z.string() }))
        .parse(d['reviewers']);
      const p = plan({
        type: 'approval',
        id: approval.id,
        number: null,
        title: `Deployment to ${approval.environment} is waiting for approval`,
        url: `/r/${repo.slug}/ci`,
      });
      for (const r of await expand(
        env,
        reviewers.map((x) => `${x.type}:${x.id}`),
      ))
        add(p, r, 'approval_requested');
      return p;
    }
    default:
      return null;
  }
}

const isThread = (t: SubjectType): t is 'pull' | 'issue' => t === 'pull' || t === 'issue';

/** Fan an event out to inboxes and instant email. Throws (to retry) only on storage or send failures. */
export async function notifyEvent(env: Env, event: ForgeEvent): Promise<void> {
  const repo = await getRepo(env, event.repo_id);
  if (!repo) return;
  const plan = await planFor(env, repo, event);
  if (!plan || !event.id) return;
  const { subject } = plan;
  const seen = new Map<string, boolean>();
  const visible = async (key: string): Promise<boolean> => {
    if (!seen.has(key))
      seen.set(key, await recipientCanSee(env, repo, key, subject.type));
    return seen.get(key)!;
  };
  const now = Date.now();
  const silenced = new Set<string>();
  if (isThread(subject.type)) {
    // join first: an existing subscription (a mute included) is kept as it is
    for (const [key, reason] of plan.join) {
      if (!(await visible(key))) continue;
      await run(
        env,
        `INSERT INTO subscriptions (principal, subject_type, subject_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [key, subject.type, subject.id, reason, now],
      );
    }
    const subs = await q<{ principal: string; reason: string }>(
      env,
      'SELECT principal, reason FROM subscriptions WHERE subject_type = ? AND subject_id = ?',
      [subject.type, subject.id],
    );
    for (const s of subs) {
      if (s.reason === 'muted') silenced.add(s.principal);
      else if (plan.subscribers && (!plan.subscribers.authors || s.reason === 'author'))
        add(
          plan,
          s.principal,
          plan.subscribers.as ??
            (s.reason === 'author' || s.reason === 'manual' ? s.reason : 'comment'),
        );
    }
  }
  const watch = await q<{ principal: string; reason: string }>(
    env,
    "SELECT principal, reason FROM subscriptions WHERE subject_type = 'repo' AND subject_id = ?",
    [repo.id],
  );
  for (const w of watch) {
    if (w.reason === 'ignored') silenced.add(w.principal);
    else if (plan.watchers) add(plan, w.principal, 'subscribed');
  }

  const sender = emailSender(env);
  for (const [key, reasons] of plan.targets) {
    if (key === plan.self || silenced.has(key) || !(await visible(key))) continue;
    const settings = await loadSettings(env, key);
    const reason = REASONS.find(
      (r) => reasons.has(r) && !settings.disabled_reasons.includes(r),
    );
    if (!reason) continue;
    await run(
      env,
      `INSERT INTO notifications (id, principal, event_id, repo_id, subject_type, subject_id, number,
         title, url, origin, reason, event, action, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, principal) DO NOTHING`,
      [
        ulid(now),
        key,
        event.id,
        repo.id,
        subject.type,
        subject.id,
        subject.number,
        subject.title.slice(0, 300),
        subject.url,
        event.origin,
        reason,
        event.event,
        event.action,
        senderKey(event),
        now,
      ],
    );
    if (sender && settings.email === 'instant' && key.startsWith('user:') && event.origin)
      await emailNow(env, sender, repo, event, key, subject, reason);
  }
}

const WHY: Record<Reason, string> = {
  review_requested: 'your review was requested',
  mention: 'you were mentioned',
  assign: 'you were assigned',
  approval_requested: 'your approval is needed',
  security_alert: 'you administer this repository',
  ci_failed: 'a CI run failed on your work',
  queue_ejected: 'your pull request left the merge queue',
  work_claimed: 'you follow this work',
  author: 'you opened it',
  comment: 'you are taking part',
  manual: 'you subscribed',
  subscribed: 'you watch this repository',
};

const VERBS: Record<string, string> = {
  'pull_request.opened': 'opened',
  'pull_request.closed': 'closed',
  'pull_request.reopened': 'reopened',
  'pull_request.ready_for_review': 'marked ready for review',
  'pull_request.review_requested': 'requested your review on',
  'pull_request.dequeued': 'removed from the merge queue',
  'pull_request_review.submitted': 'reviewed',
  'pull_request_review_thread.created': 'commented on',
  'pull_request_review_thread.replied': 'replied on',
  'issues.opened': 'opened',
  'issues.closed': 'closed',
  'issues.reopened': 'reopened',
  'issues.assigned': 'assigned you to',
  'issue_comment.created': 'commented on',
  'work_item.claimed': 'claimed',
  'ci_run.completed': 'reported a failed CI run on',
  'secret_scanning_alert.created': 'reported',
  'environment_approval.requested': 'asked for approval of',
  'agent_approval.requested': 'asked for approval of',
};

async function actorName(env: Env, key: string | null): Promise<string> {
  const [kind, id] = (key ?? '').split(':', 2);
  const row =
    kind === 'user'
      ? await q1<{ name: string }>(env, 'SELECT login AS name FROM users WHERE id = ?', [
          id,
        ])
      : kind === 'agent'
        ? await q1<{ name: string }>(env, 'SELECT name FROM agents WHERE id = ?', [id])
        : null;
  return row?.name ?? 'Yuma Git';
}

/** One email for one new notification; claimed first so a retry never sends it twice. */
async function emailNow(
  env: Env,
  sender: EmailSender,
  repo: RepoRecord,
  event: ForgeEvent,
  key: string,
  subject: Subject,
  reason: Reason,
): Promise<void> {
  const to = await emailAddress(env, key.slice('user:'.length));
  if (!to || !event.origin) return;
  const row = await q1<{ id: string }>(
    env,
    'SELECT id FROM notifications WHERE event_id = ? AND principal = ? AND read_at IS NULL',
    [event.id, key],
  );
  if (!row) return;
  const claimed = await env.DB.prepare(
    'UPDATE notifications SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL',
  )
    .bind(Date.now(), row.id)
    .run();
  if (!claimed.meta.changes) return;
  const origin = event.origin;
  const stopAll = unsubscribeUrl(origin, await signUnsubscribe(env, key, 'email'));
  const verb = VERBS[`${event.event}.${event.action}`] ?? 'updated';
  const ref = subject.number === null ? '' : ` #${subject.number}`;
  const lines = [
    `${await actorName(env, senderKey(event))} ${verb}${ref} in ${repo.slug}: ${subject.title}`,
    '',
    `Open it: ${origin}${subject.url}`,
    '',
    `You are getting this because ${WHY[reason]}.`,
  ];
  if (isThread(subject.type)) {
    const mute = await signUnsubscribe(env, key, `${subject.type}:${subject.id}`);
    lines.push(`Mute this thread: ${unsubscribeUrl(origin, mute)}`);
  }
  lines.push(`Stop notification email: ${stopAll}`);
  try {
    await sender.send({
      to,
      subject: `[${repo.slug}] ${subject.title}${subject.number === null ? '' : ` (#${subject.number})`}`,
      text: lines.join('\n'),
      headers: listUnsubscribeHeaders(stopAll),
    });
  } catch (err) {
    // release the claim so the queue's retry sends it
    await run(env, 'UPDATE notifications SET emailed_at = NULL WHERE id = ?', [row.id]);
    throw err;
  }
}
