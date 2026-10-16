import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { appendQueued, type QueuedAppend } from './record';

/**
 * Audit streaming (issue #65). Delivery is cursor based: the `audit-stream`
 * queue carries "kick" messages (plus appends to retry, see `appendAudit`),
 * and the consumer ships events after `audit_stream_state.last_id` in id
 * order, advancing the cursor on success.
 * Order is preserved and a failed batch is retried from the same cursor.
 * The sink URL and secret are never logged or stored in the status row.
 */

export interface AuditSink {
  name: string;
  send(events: Record<string, unknown>[]): Promise<{ ok: boolean; status: string }>;
}

const BATCH = 100;
const MAX_BATCHES = 10;

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HTTPS sink: POST `{ events }` signed with
 * `x-yag-signature: sha256=HMAC(secret, "<x-yag-timestamp>.<body>")`.
 */
export function httpsSink(url: string, secret: string): AuditSink {
  return {
    name: 'https',
    async send(events) {
      const body = JSON.stringify({ source: 'yuma-agent-git', events });
      const timestamp = String(Date.now());
      try {
        const res = await fetch(url, {
          method: 'POST',
          // a redirect would forward the signed batch somewhere unreviewed
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'x-yag-timestamp': timestamp,
            'x-yag-signature': `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`,
          },
          body,
        });
        await res.body?.cancel();
        return {
          ok: res.status >= 200 && res.status < 300,
          status: `http_${res.status}`,
        };
      } catch {
        return { ok: false, status: 'network_error' };
      }
    },
  };
}

/** The configured sink, or null when streaming is off or misconfigured. */
export function configuredSink(env: Env): AuditSink | null {
  const url = env.AUDIT_STREAM_URL;
  const secret = env.AUDIT_STREAM_SECRET;
  if (!url || !secret || !url.startsWith('https://')) return null;
  return httpsSink(url, secret);
}

function parseTarget(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return text;
  }
}

/** Ship pending events in order. Returns false when the sink rejected a batch. */
export async function shipAuditEvents(env: Env, sink: AuditSink): Promise<boolean> {
  await run(env, 'INSERT OR IGNORE INTO audit_stream_state (sink) VALUES (?)', [
    sink.name,
  ]);
  for (let i = 0; i < MAX_BATCHES; i++) {
    const state = await q1<{ last_id: number }>(
      env,
      'SELECT last_id FROM audit_stream_state WHERE sink = ?',
      [sink.name],
    );
    const lastId = state?.last_id ?? 0;
    const rows = await q(
      env,
      'SELECT * FROM audit_events WHERE id > ? ORDER BY id LIMIT ?',
      [lastId, BATCH],
    );
    if (rows.length === 0) return true;
    const now = Date.now();
    const result = await sink.send(
      rows.map((row) => ({ ...row, target: parseTarget(row.target) })),
    );
    if (!result.ok) {
      await run(
        env,
        `UPDATE audit_stream_state SET last_attempt_at = ?, last_status = ?, failures = failures + 1
         WHERE sink = ?`,
        [now, result.status, sink.name],
      );
      return false;
    }
    // compare-and-set: an overlapping consumer never moves the cursor backwards
    await run(
      env,
      `UPDATE audit_stream_state
         SET last_id = ?, last_attempt_at = ?, last_success_at = ?, last_status = ?, failures = 0
       WHERE sink = ? AND last_id = ?`,
      [rows[rows.length - 1].id, now, now, result.status, sink.name, lastId],
    );
  }
  return true;
}

/** Queue consumer for `audit-stream`: messages are kicks; retry with backoff. */
export async function auditStreamQueue(batch: MessageBatch, env: Env): Promise<void> {
  // a per-message ack or retry takes precedence over the batch calls below
  for (const message of batch.messages) {
    const queued = (message.body as { append?: QueuedAppend }).append;
    if (!queued) continue;
    try {
      await appendQueued(env, queued);
      message.ack();
    } catch (err) {
      console.error('audit: queued append failed; retrying', err);
      message.retry({ delaySeconds: Math.min(900, 10 * 2 ** (message.attempts - 1)) });
    }
  }
  const sink = configuredSink(env);
  if (sink === null || (await shipAuditEvents(env, sink))) {
    batch.ackAll();
    return;
  }
  const attempts = Math.max(1, ...batch.messages.map((m) => m.attempts));
  batch.retryAll({ delaySeconds: Math.min(900, 10 * 2 ** (attempts - 1)) });
}

/** Cron: kick the stream so delivery resumes after dropped messages. */
export async function kickAuditStream(env: Env): Promise<void> {
  if (configuredSink(env) && env.AUDIT_QUEUE) await env.AUDIT_QUEUE.send({ kick: true });
}
