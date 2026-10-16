import type { Env } from '../env';
import { q, run } from '../db/client';
import { getRepo } from '../db/repos';
import type { RepoRecord } from '../db/client';
import { canSee } from './fanout';
import {
  emailAddress,
  emailSender,
  listUnsubscribeHeaders,
  signUnsubscribe,
  unsubscribeUrl,
  type EmailSender,
} from './email';

/**
 * Daily digests (issue #44). The minute cron sends each `digest` principal
 * one email of its unread, not yet emailed notifications once the
 * Australia/Sydney clock passes their digest hour (07:00 by default). With
 * `skip_weekends` a Saturday or Sunday digest is skipped and Monday's carries
 * the weekend. The day is claimed before sending and released on failure, so
 * the next minute retries and a digest is never sent twice in a day.
 */

const SYDNEY = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** The Australia/Sydney date (`YYYY-MM-DD`), hour and whether it is a weekend. */
export function sydneyClock(now: number): { date: string; hour: number; weekend: boolean } {
  const parts = Object.fromEntries(
    SYDNEY.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    hour: Number(parts['hour']),
    weekend: parts['weekday'] === 'Sat' || parts['weekday'] === 'Sun',
  };
}

const PER_SWEEP = 25;
const PER_DIGEST = 50;

interface Item {
  id: string;
  repo_id: string;
  subject_type: string;
  number: number | null;
  title: string;
  url: string;
  origin: string | null;
  reason: string;
}

export async function sendDigests(env: Env, now = Date.now()): Promise<void> {
  const sender = emailSender(env);
  if (!sender) return;
  const clock = sydneyClock(now);
  const due = await q<{ principal: string; skip_weekends: number; digest_sent_on: string | null }>(
    env,
    `SELECT principal, skip_weekends, digest_sent_on FROM notification_settings
      WHERE email = 'digest' AND principal LIKE 'user:%' AND digest_hour <= ?
        AND (digest_sent_on IS NULL OR digest_sent_on < ?) LIMIT ${PER_SWEEP}`,
    [clock.hour, clock.date],
  );
  for (const row of due) {
    const claimed = await env.DB.prepare(
      `UPDATE notification_settings SET digest_sent_on = ?
        WHERE principal = ? AND (digest_sent_on IS NULL OR digest_sent_on < ?)`,
    )
      .bind(clock.date, row.principal, clock.date)
      .run();
    if (!claimed.meta.changes) continue;
    if (row.skip_weekends === 1 && clock.weekend) continue;
    try {
      await digestFor(env, sender, row.principal, now);
    } catch (err) {
      console.error('notifications: digest not sent; retrying next sweep', err);
      await run(env, 'UPDATE notification_settings SET digest_sent_on = ? WHERE principal = ?', [
        row.digest_sent_on,
        row.principal,
      ]);
    }
  }
}

async function digestFor(
  env: Env,
  sender: EmailSender,
  principal: string,
  now: number,
): Promise<void> {
  const userId = principal.slice('user:'.length);
  const to = await emailAddress(env, userId);
  if (!to) return;
  const rows = await q<Item>(
    env,
    `SELECT id, repo_id, subject_type, number, title, url, origin, reason FROM notifications
      WHERE principal = ? AND emailed_at IS NULL AND read_at IS NULL AND done_at IS NULL
      ORDER BY id DESC LIMIT 200`,
    [principal],
  );
  // access may have changed since the notification was made
  const repos = new Map<string, RepoRecord | null>();
  const items: (Item & { slug: string })[] = [];
  for (const row of rows) {
    if (!repos.has(row.repo_id)) repos.set(row.repo_id, await getRepo(env, row.repo_id));
    const repo = repos.get(row.repo_id);
    if (repo && (await canSee(env, repo, { kind: 'user', userId }, row.subject_type)))
      items.push({ ...row, slug: repo.slug });
  }
  const origin = items.find((i) => i.origin)?.origin;
  if (items.length === 0 || !origin) return;
  const stopAll = unsubscribeUrl(origin, await signUnsubscribe(env, principal, 'email'));
  const listed = items.slice(0, PER_DIGEST);
  const lines = [
    `You have ${items.length} unread notification${items.length === 1 ? '' : 's'}.`,
    '',
    ...listed.map(
      (i) =>
        `- [${i.slug}] ${i.title}${i.number === null ? '' : ` (#${i.number})`}: ${origin}${i.url}`,
    ),
  ];
  if (items.length > listed.length)
    lines.push(`...and ${items.length - listed.length} more in your inbox: ${origin}/inbox`);
  lines.push('', `Change digest settings: ${origin}/inbox`, `Stop notification email: ${stopAll}`);
  await sender.send({
    to,
    subject: `Yuma Git digest: ${items.length} unread`,
    text: lines.join('\n'),
    headers: listUnsubscribeHeaders(stopAll),
  });
  const ids = items.map((i) => i.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await run(
      env,
      `UPDATE notifications SET emailed_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`,
      [now, ...chunk],
    );
  }
}
