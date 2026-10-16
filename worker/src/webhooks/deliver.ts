import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ulid } from '../core/ids';
import { hmacHex } from '../audit/stream';
import { sha256Bytes } from '../auth/encoding';
import { decryptSecrets } from '../secrets/crypto';
import { HOOKS_FOR_REPO, hookBinds, parseEvents, type ForgeEvent } from './events';
import { buildPayload } from './payloads';

/**
 * Webhook delivery (issue #75). Each delivery is a row; an attempt claims it
 * with a short lease, so a duplicate queue message or a cron re-send never
 * sends twice at once. Failures retry with exponential backoff (30 seconds
 * doubling, at most 4 hours apart) for 24 hours, then the delivery is
 * failed; it can still be redelivered by hand. Every body is signed:
 * `X-Yag-Signature-256: sha256=HMAC(secret, body)`, plus
 * `X-Hub-Signature-256` with the same value for the GitHub format.
 *
 * SSRF: URLs must be https (http only with WEBHOOKS_ALLOW_HTTP=true) and may
 * not name a private, loopback, link-local, CGNAT, multicast, documentation
 * or metadata address, or a single-label or local name. Before each attempt
 * the host is also resolved over DNS-over-HTTPS and refused if any address is
 * blocked. Redirects are never followed.
 */

const LEASE_MS = 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Delay before retry `attempt` (1-based), in seconds. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 4 * 3600);
}

// --- SSRF -------------------------------------------------------------------

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256))
    return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function blockedV4(n: number): boolean {
  return V4_BLOCKED.some(
    ([net, bits]) =>
      Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(net)! / 2 ** (32 - bits)),
  );
}

/** Eight 16-bit groups, after the URL parser canonicalises the address. */
function v6(text: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${text}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const part = (p: string | undefined): number[] =>
    p ? p.split(':').map((h) => parseInt(h, 16)) : [];
  const [head, tail] = host.split('::');
  const a = part(head);
  const b = part(tail);
  const groups =
    tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return groups.length === 8 ? groups : null;
}

function blockedV6(g: number[]): boolean {
  const embedded = (g[6]! * 65536 + g[7]!) >>> 0;
  // ::, ::1, IPv4-compatible and IPv4-mapped (::ffff:a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff))
    return blockedV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return blockedV4(embedded); // NAT64
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local, including fd00:ec2::254
    (g[0]! & 0xffc0) === 0xfe80 || // link-local
    (g[0]! & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) // documentation
  );
}

/** Whether a URL host (as `URL.hostname` gives it) must never be called. */
export function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const groups = v6(host.slice(1, -1));
    return groups === null || blockedV6(groups);
  }
  const n = v4(host);
  if (n !== null) return blockedV4(n);
  if (!host.includes('.')) return true;
  return /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host);
}

/** Why a webhook URL is refused, or null when it may be used. */
export function webhookUrlProblem(env: Env, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Webhook URL is not a valid URL';
  }
  const http = url.protocol === 'http:' && env.WEBHOOKS_ALLOW_HTTP === 'true';
  if (url.protocol !== 'https:' && !http) return 'Webhook URLs must use https';
  if (url.username || url.password) return 'Webhook URLs cannot contain credentials';
  if (blockedHost(url.hostname))
    return 'Webhook URLs cannot point at private, loopback, link-local or metadata addresses';
  return null;
}

const dnsSchema = z.object({
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** Whether a name resolves to any blocked address (DNS-over-HTTPS). Throws when DNS fails. */
export async function resolvesToBlocked(hostname: string): Promise<boolean> {
  if (hostname.startsWith('[') || v4(hostname) !== null) return false; // checked as a literal
  for (const type of ['A', 'AAAA']) {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) throw new Error(`DNS lookup failed with ${res.status}`);
    for (const answer of dnsSchema.parse(await res.json()).Answer ?? []) {
      if (answer.type === 1) {
        const n = v4(answer.data);
        if (n === null || blockedV4(n)) return true;
      } else if (answer.type === 28) {
        const groups = v6(answer.data);
        if (groups === null || blockedV6(groups)) return true;
      }
    }
  }
  return false;
}

// --- rows -------------------------------------------------------------------

export const hookRowSchema = z.object({
  id: z.string(),
  scope: z.enum(['repo', 'org', 'app']),
  owner_id: z.string(),
  url: z.string(),
  secret_ciphertext: z.string(),
  key_owner: z.string(),
  key_version: z.number(),
  events: z.string(),
  format: z.enum(['yag', 'github']),
  active: z.number(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type HookRow = z.infer<typeof hookRowSchema>;

export const deliveryRowSchema = z.object({
  id: z.string(),
  webhook_id: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  repo_id: z.string().nullable(),
  payload: z.string(),
  status: z.enum(['pending', 'retrying', 'succeeded', 'failed']),
  attempts: z.number(),
  response_code: z.number().nullable(),
  error: z.string().nullable(),
  next_attempt_at: z.number().nullable(),
  created_at: z.number(),
  last_attempt_at: z.number().nullable(),
  redelivery_of: z.string().nullable(),
});
export type DeliveryRow = z.infer<typeof deliveryRowSchema>;

/** AES-GCM additional data binding a hook's secret to its row. */
export const hookAad = (id: string): string => `webhook|${id}`;

// --- fan-out and attempts ---------------------------------------------------

function insertDelivery(
  env: Env,
  row: Omit<DeliveryRow, 'attempts' | 'response_code' | 'error' | 'last_attempt_at'>,
  verb = 'INSERT',
): D1PreparedStatement {
  return env.DB.prepare(
    `${verb} INTO webhook_deliveries_out
       (id, webhook_id, event, action, repo_id, payload, status, next_attempt_at, created_at, redelivery_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.webhook_id,
    row.event,
    row.action,
    row.repo_id,
    row.payload,
    row.status,
    row.next_attempt_at,
    row.created_at,
    row.redelivery_of,
  );
}

/**
 * One delivery per subscribed hook, written in one batch. Returns their ids.
 * An id is derived from the event and the hook, so a queue redelivery finds
 * the rows the first try wrote and attempts those again instead of new ones.
 */
export async function fanOut(env: Env, event: ForgeEvent): Promise<string[]> {
  const repo = await getRepo(env, event.repo_id);
  if (!repo) return [];
  const hooks = (
    await q(env, `SELECT * FROM webhooks WHERE ${HOOKS_FOR_REPO}`, hookBinds(repo))
  ).map((r) => hookRowSchema.parse(r));
  const built = new Map<string, Awaited<ReturnType<typeof buildPayload>>>();
  const inserts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  const now = Date.now();
  for (const hook of hooks) {
    if (!parseEvents(hook.events).includes(event.event)) continue;
    if (!built.has(hook.format))
      built.set(hook.format, await buildPayload(env, event, hook.format));
    const payload = built.get(hook.format);
    if (!payload) continue;
    const seed = new TextEncoder().encode(`${event.id}|${hook.id}`);
    const id = event.id
      ? ulid(event.at, (await sha256Bytes(seed)).slice(0, 16))
      : ulid(now);
    ids.push(id);
    inserts.push(
      insertDelivery(
        env,
        {
          id,
          webhook_id: hook.id,
          event: payload.name,
          action: event.action,
          repo_id: repo.id,
          payload: payload.body,
          status: 'pending',
          next_attempt_at: now,
          created_at: now,
          redelivery_of: null,
        },
        'INSERT OR IGNORE',
      ),
    );
  }
  if (inserts.length > 0) await env.DB.batch(inserts);
  return ids;
}

interface Outcome {
  ok: boolean;
  /** Retrying cannot help (the address is refused). */
  permanent?: boolean;
  code: number | null;
  error: string | null;
}

async function send(env: Env, hook: HookRow, delivery: DeliveryRow): Promise<Outcome> {
  const problem = webhookUrlProblem(env, hook.url);
  if (problem) return { ok: false, permanent: true, code: null, error: 'blocked_url' };
  try {
    if (await resolvesToBlocked(new URL(hook.url).hostname))
      return { ok: false, permanent: true, code: null, error: 'blocked_address' };
  } catch {
    return { ok: false, code: null, error: 'dns_error' };
  }
  let secret: string;
  try {
    [secret = ''] = await decryptSecrets(env, [
      {
        owner: hook.key_owner,
        keyVersion: hook.key_version,
        aad: hookAad(hook.id),
        ciphertext: hook.secret_ciphertext,
      },
    ]);
  } catch {
    return { ok: false, code: null, error: 'secret_unavailable' };
  }
  const signature = `sha256=${await hmacHex(secret, delivery.payload)}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'yuma-agent-git-hookshot',
    'x-yag-event': delivery.event,
    'x-yag-delivery': delivery.id,
    'x-yag-hook-id': hook.id,
    'x-yag-signature-256': signature,
  };
  if (hook.format === 'github') {
    headers['x-github-event'] = delivery.event;
    headers['x-github-delivery'] = delivery.id;
    headers['x-github-hook-id'] = hook.id;
    headers['x-hub-signature-256'] = signature;
  }
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: delivery.payload,
      // a redirect could lead anywhere, including a private address
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    const ok = res.status >= 200 && res.status < 300;
    return { ok, code: res.status, error: ok ? null : `http_${res.status}` };
  } catch {
    return { ok: false, code: null, error: 'network_error' };
  }
}

/** Attempt one delivery if it is due and not already being attempted. */
export async function attemptDelivery(env: Env, id: string): Promise<void> {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE webhook_deliveries_out
        SET attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
      WHERE id = ? AND status IN ('pending', 'retrying') AND next_attempt_at <= ?
      RETURNING *`,
  )
    .bind(now, now + LEASE_MS, id, now + 5_000)
    .first();
  if (!claimed) return;
  const delivery = deliveryRowSchema.parse(claimed);
  const row = await q1(env, 'SELECT * FROM webhooks WHERE id = ?', [delivery.webhook_id]);
  const hook = row ? hookRowSchema.parse(row) : null;
  const outcome: Outcome =
    hook && hook.active === 1
      ? await send(env, hook, delivery)
      : { ok: false, permanent: true, code: null, error: 'webhook_inactive' };
  const delay = backoffSeconds(delivery.attempts);
  const retry =
    !outcome.ok &&
    !outcome.permanent &&
    now + delay * 1000 - delivery.created_at <= RETRY_WINDOW_MS;
  await run(
    env,
    `UPDATE webhook_deliveries_out SET status = ?, response_code = ?, error = ?, next_attempt_at = ?
      WHERE id = ?`,
    [
      outcome.ok ? 'succeeded' : retry ? 'retrying' : 'failed',
      outcome.code,
      outcome.error,
      retry ? now + delay * 1000 : null,
      id,
    ],
  );
  // the cron sweep re-sends a retry whose message is lost
  if (retry)
    await env.EVENTS_QUEUE?.send({ type: 'delivery', id }, { delaySeconds: delay }).catch(
      () => undefined,
    );
}

/** Queue the same body again as a new delivery. */
export async function redeliver(env: Env, original: DeliveryRow): Promise<DeliveryRow> {
  const now = Date.now();
  const row: DeliveryRow = {
    ...original,
    id: ulid(now),
    status: 'pending',
    attempts: 0,
    response_code: null,
    error: null,
    next_attempt_at: now,
    created_at: now,
    last_attempt_at: null,
    redelivery_of: original.id,
  };
  await insertDelivery(env, row).run();
  await env.EVENTS_QUEUE?.send({ type: 'delivery', id: row.id }).catch(() => undefined);
  return row;
}

/** Cron: drop old rows and re-send deliveries whose message or lease was lost. */
export async function sweepDeliveries(env: Env, now: number = Date.now()): Promise<void> {
  await run(env, 'DELETE FROM webhook_deliveries_out WHERE created_at < ?', [
    now - KEEP_MS,
  ]);
  if (!env.EVENTS_QUEUE) return;
  const due = await q<{ id: string }>(
    env,
    `SELECT id FROM webhook_deliveries_out
      WHERE status IN ('pending', 'retrying') AND next_attempt_at < ? LIMIT 50`,
    [now - LEASE_MS],
  );
  for (const { id } of due) await env.EVENTS_QUEUE.send({ type: 'delivery', id });
}
