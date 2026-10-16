import { z } from 'zod';
import { Hono } from 'hono';
import type { Env } from '../env';
import { q1, run } from '../db/client';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { b64urlDecode, b64urlEncode } from './encoding';
import { markSessionMfa, requireRecentMfa } from './session';
import type { AppEnv } from './principal';

/**
 * TOTP second factor (issue #27, RFC 6238): HMAC-SHA1, 6 digits, 30-second
 * steps, one step of clock drift either way, and each step accepted once.
 * Seeds are AES-GCM encrypted under the `TOTP_ENCRYPTION_KEY` Worker secret
 * (bound to the user id) and are shown to the user exactly once.
 */

const STEP_S = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** HOTP (RFC 4226) code for one counter value. */
export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32));
  msg.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new DataView(await crypto.subtle.sign('HMAC', key, msg.buffer));
  const offset = mac.getUint8(19) & 0x0f;
  const bin = mac.getUint32(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The time step `code` matches (±1 step, newer than `lastStep`), or null. */
export async function matchTotp(
  secret: Uint8Array,
  code: string,
  lastStep: number,
  now: number = Date.now(),
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / STEP_S);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    const expected = await hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0) return step;
  }
  return null;
}

async function seedKey(env: Env): Promise<CryptoKey | null> {
  if (!env.TOTP_ENCRYPTION_KEY) return null;
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(env.TOTP_ENCRYPTION_KEY),
  );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealSeed(
  key: CryptoKey,
  userId: string,
  seed: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) },
    key,
    seed as BufferSource,
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

async function openSeed(
  key: CryptoKey,
  userId: string,
  sealed: string,
): Promise<Uint8Array> {
  const [iv = '', ct = ''] = sealed.split('.');
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64urlDecode(iv) as BufferSource,
      additionalData: new TextEncoder().encode(userId),
    },
    key,
    b64urlDecode(ct) as BufferSource,
  );
  return new Uint8Array(plain);
}

const totpRowSchema = z.object({
  user_id: z.string(),
  secret_enc: z.string(),
  confirmed_at: z.number().nullable(),
  last_step: z.number(),
});

async function loadTotp(
  env: Env,
  userId: string,
): Promise<z.infer<typeof totpRowSchema> | null> {
  const row = await q1(env, 'SELECT * FROM totp_secrets WHERE user_id = ?', [userId]);
  return row ? totpRowSchema.parse(row) : null;
}

const codeSchema = z.object({ code: z.string().min(1).max(12) });

// ---------------------------------------------------------------------------
// Routes (session only)
// ---------------------------------------------------------------------------

export const totpRoutes = new Hono<AppEnv>();

/** Start enrolment: a fresh seed, returned once, unconfirmed until a code checks out. */
totpRoutes.post('/api/v1/me/totp', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const key = await seedKey(c.env);
    if (!key) {
      return apiError(c, 500, 'not_configured', 'authenticator apps are not configured');
    }
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const existing = await loadTotp(c.env, user.id);
    if (existing?.confirmed_at != null) {
      return apiError(c, 409, 'totp_enrolled', 'remove the current authenticator first');
    }
    const seed = crypto.getRandomValues(new Uint8Array(20));
    await run(
      c.env,
      `INSERT OR REPLACE INTO totp_secrets (user_id, secret_enc, confirmed_at, last_step, created_at)
       VALUES (?, ?, NULL, 0, ?)`,
      [user.id, await sealSeed(key, user.id, seed), Date.now()],
    );
    const secret = base32Encode(seed);
    const label = encodeURIComponent(`Yuma:${user.login}`);
    return c.json(
      {
        secret,
        otpauth_uri: `otpauth://totp/${label}?secret=${secret}&issuer=Yuma&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`,
      },
      201,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

totpRoutes.post('/api/v1/me/totp/confirm', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const parsed = codeSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'code is required');
    const key = await seedKey(c.env);
    const row = await loadTotp(c.env, user.id);
    if (!key || !row || row.confirmed_at !== null) {
      return apiError(c, 404, 'totp_not_started', 'start authenticator setup first');
    }
    const seed = await openSeed(key, user.id, row.secret_enc);
    const step = await matchTotp(seed, parsed.data.code, row.last_step);
    if (step === null) return apiError(c, 400, 'invalid_code', 'that code did not match');
    const now = Date.now();
    await run(
      c.env,
      'UPDATE totp_secrets SET confirmed_at = ?, last_step = ? WHERE user_id = ?',
      [now, step, user.id],
    );
    await markSessionMfa(c.env, c.req.header('cookie'), now);
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

totpRoutes.delete('/api/v1/me/totp', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    await run(c.env, 'DELETE FROM totp_secrets WHERE user_id = ?', [user.id]);
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Step-up: a valid code marks this session as MFA-verified. Under /auth/ for its strict rate limit. */
totpRoutes.post('/auth/mfa/totp', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const parsed = codeSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'code is required');
    const key = await seedKey(c.env);
    const row = await loadTotp(c.env, user.id);
    if (!key || !row || row.confirmed_at === null) {
      return apiError(c, 404, 'totp_not_enrolled', 'no authenticator app is enrolled');
    }
    const seed = await openSeed(key, user.id, row.secret_enc);
    const step = await matchTotp(seed, parsed.data.code, row.last_step);
    // claim the step atomically so a code can never be used twice
    const claimed =
      step !== null &&
      (await q1(
        c.env,
        'UPDATE totp_secrets SET last_step = ? WHERE user_id = ? AND last_step < ? RETURNING user_id',
        [step, user.id, step],
      )) !== null;
    if (!claimed) return apiError(c, 400, 'invalid_code', 'that code did not match');
    await markSessionMfa(c.env, c.req.header('cookie'));
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
