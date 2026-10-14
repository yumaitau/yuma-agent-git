import { Hono } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseRepoRow, q1, run } from '../db/client';
import { apiError, errorResponse } from './errors';
import { handleInstallationEvent } from '../bridge/github';

/**
 * GitHub webhook receiver (issue #13) — contract:
 *
 * 1. read the **raw body bytes once**
 * 2. verify `X-Hub-Signature-256` = `sha256=<HMAC(secret, raw)>` with WebCrypto
 *    BEFORE anything parses the body; failures are logged and **fire nothing**
 * 3. only then `JSON.parse`
 * 4. route by `X-GitHub-Event`; `push` hands off to the `git-import` queue for
 *    connected repos, unknown events are ignored
 * 5. always answer quickly; heavy work goes through queues
 */
export const webhooksRoutes = new Hono<{ Bindings: Env }>();

async function verifySignature(
  secret: string,
  raw: Uint8Array,
  header: string | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = hexToBytes(header.slice('sha256='.length));
  if (provided.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, provided as BufferSource, raw as BufferSource);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** HMAC-SHA256 header value for a raw body (exported for tests/tooling). */
export async function sign(secret: string, raw: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, raw as BufferSource);
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

webhooksRoutes.post('/webhooks/github', async (c) => {
  try {
    // 1. raw bytes, exactly once — verification must cover the whole body
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const deliveryId = c.req.header('x-github-delivery') ?? '';
    const event = c.req.header('x-github-event') ?? '';

    // 2. verify BEFORE parsing
    const valid = await verifySignature(
      c.env.GITHUB_WEBHOOK_SECRET ?? '',
      raw,
      c.req.header('x-hub-signature-256'),
    );
    if (!valid) {
      console.warn(
        'webhook: signature verification failed',
        JSON.stringify({ delivery_id: deliveryId, event }),
      );
      return apiError(c, 401, 'invalid_signature', 'HMAC verification failed');
    }

    // delivery dedupe — a replayed delivery id is a no-op
    if (deliveryId !== '') {
      const seen = await q1(
        c.env,
        `SELECT * FROM ${T.webhookDeliveries} WHERE delivery_id = ?`,
        [deliveryId],
      );
      if (seen) {
        return c.json({ ok: true, deduped: true }, 200);
      }
      await run(
        c.env,
        `INSERT INTO ${T.webhookDeliveries} (delivery_id, event, received_at, status) VALUES (?, ?, ?, ?)`,
        [deliveryId, event, Date.now(), 'received'],
      );
    }

    // 3. parse only now
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return apiError(c, 400, 'invalid_json', 'verified body is not JSON');
    }

    // 4. route
    switch (event) {
      case 'ping':
        return c.json({ ok: true, pong: true });

      case 'installation':
      case 'installation_repositories': {
        await handleInstallationEvent(c.env, payload);
        await run(
          c.env,
          `UPDATE ${T.webhookDeliveries} SET status = 'processed' WHERE delivery_id = ?`,
          [deliveryId],
        );
        return c.json({ ok: true });
      }

      case 'push': {
        const push = payload as {
          ref: string;
          after: string;
          repository?: { id: number; full_name: string };
          installation?: { id: number };
        };
        const githubRepoId = push.repository?.id;
        if (githubRepoId === undefined) return c.json({ ok: true, ignored: true });

        const connected = await q1(
          c.env,
          `SELECT * FROM ${T.repos} WHERE ${C.repos.githubRepoId} = ?`,
          [githubRepoId],
        );
        if (!connected) {
          // unconnected repo: nothing to sync, nothing to fire
          return c.json({ ok: true, ignored: true });
        }
        const repo = parseRepoRow(connected);
        await c.env.IMPORT_QUEUE.send({
          type: 'github_push',
          repo_id: repo.id,
          github_repo_id: githubRepoId,
          ref: push.ref,
          after: push.after,
        });
        await run(
          c.env,
          `UPDATE ${T.webhookDeliveries} SET status = 'queued' WHERE delivery_id = ?`,
          [deliveryId],
        );
        return c.json({ ok: true, queued: true });
      }

      default:
        return c.json({ ok: true, ignored: event });
    }
  } catch (err) {
    return errorResponse(c, err);
  }
});
