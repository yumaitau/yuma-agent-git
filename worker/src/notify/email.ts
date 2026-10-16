import { z } from 'zod';
import type { Env } from '../env';
import { q1 } from '../db/client';
import { b64urlDecode, b64urlEncode } from '../auth/encoding';

/**
 * Notification email (issue #44). The sender is pluggable: PaperBoy over
 * HTTPS when `PAPERBOY_API_URL`, `PAPERBOY_API_KEY` and `PAPERBOY_FROM` are
 * set, else a Cloudflare Email Routing `send_email` binding (`EMAIL`, with
 * `NOTIFY_EMAIL_FROM`). Every message carries a signed unsubscribe link, so
 * nothing is sent without `NOTIFY_SIGNING_KEY`. Bodies hold titles and links
 * only, never comment text, file contents or secret values.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** The configured sender, or null when email is not set up. */
export function emailSender(env: Env): EmailSender | null {
  if (!env.NOTIFY_SIGNING_KEY) return null;
  const { PAPERBOY_API_URL: url, PAPERBOY_API_KEY: key, PAPERBOY_FROM: from } = env;
  if (url && key && from) {
    if (!URL.canParse(url) || new URL(url).protocol !== 'https:') return null;
    return {
      async send(message) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, ...message }),
        });
        if (!res.ok) throw new Error(`email provider answered ${res.status}`);
      },
    };
  }
  const binding = env.EMAIL;
  const sender = env.NOTIFY_EMAIL_FROM;
  if (binding && sender) {
    return {
      async send(message) {
        await binding.send({ from: sender, ...message });
      },
    };
  }
  return null;
}

/** A user's most recently linked verified address, or null. */
export async function emailAddress(env: Env, userId: string): Promise<string | null> {
  const row = await q1<{ email: string }>(
    env,
    `SELECT i.email FROM user_identities i JOIN users u ON u.id = i.user_id AND u.active = 1
      WHERE i.user_id = ? AND i.email IS NOT NULL ORDER BY i.linked_at DESC LIMIT 1`,
    [userId],
  );
  return row?.email ?? null;
}

/** `email`: stop all notification email. `pull:<id>` / `issue:<id>`: mute that thread. */
const unsubscribeSchema = z.object({
  v: z.literal(1),
  p: z.string().regex(/^(user|agent):[\w-]+$/),
  s: z.string().regex(/^(email|(pull|issue):\d+)$/),
});
export type Unsubscribe = z.infer<typeof unsubscribeSchema>;

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`notify-unsubscribe:${env.NOTIFY_SIGNING_KEY}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signUnsubscribe(
  env: Env,
  principal: string,
  scope: string,
): Promise<string> {
  const body = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ v: 1, p: principal, s: scope })),
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

/** The token's request, or null when it is malformed or not ours. */
export async function verifyUnsubscribe(
  env: Env,
  token: string,
): Promise<Unsubscribe | null> {
  if (!env.NOTIFY_SIGNING_KEY) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env),
      b64urlDecode(mac),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const parsed = unsubscribeSchema.safeParse(
      JSON.parse(new TextDecoder().decode(b64urlDecode(body))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** RFC 8058 one-click headers for a message whose "stop all" link is `url`. */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
