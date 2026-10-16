import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseUserRow, q, q1, run } from '../db/client';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { b64urlDecode, b64urlEncode, randomB64url, sha256Bytes } from './encoding';
import {
  createSession,
  markSessionMfa,
  requireRecentMfa,
  sessionCookie,
} from './session';
import type { AppEnv } from './principal';

/**
 * Passkeys (issue #27): WebAuthn registration and assertion verified on the
 * Worker with WebCrypto. Attestation is not requested ("none"), so the
 * attestation statement is ignored: trust comes from the signed, single-use,
 * origin-bound challenge. ES256 and RS256 credentials are accepted.
 *
 * A passkey is a second factor for an existing session, or a whole sign-in
 * (with user verification) that counts as MFA on its own.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const COSE_ES256 = -7;
const COSE_RS256 = -257;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949): definite lengths, the types WebAuthn uses
// ---------------------------------------------------------------------------

type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

export function decodeCbor(buf: Uint8Array, start = 0): { value: Cbor; end: number } {
  let pos = start;
  const take = (n: number): Uint8Array => {
    if (pos + n > buf.length) throw new Error('cbor: truncated');
    const out = buf.slice(pos, pos + n);
    pos += n;
    return out;
  };
  const arg = (info: number): number => {
    if (info < 24) return info;
    const len = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (len === undefined) throw new Error('cbor: unsupported length');
    return take(len).reduce((n, b) => n * 256 + b, 0);
  };
  const item = (): Cbor => {
    const [head = 0] = take(1);
    const info = head & 31;
    switch (head >> 5) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2:
        return take(arg(info));
      case 3:
        return new TextDecoder().decode(take(arg(info)));
      case 4:
        return Array.from({ length: arg(info) }, item);
      case 5: {
        const map = new Map<Cbor, Cbor>();
        for (let n = arg(info); n > 0; n--) {
          const key = item();
          map.set(key, item());
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
    }
    throw new Error('cbor: unsupported item');
  };
  const value = item();
  return { value, end: pos };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId: Uint8Array | null;
  publicKey: Uint8Array | null;
}

function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new Error('authenticator data too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = view.getUint8(32);
  const out: AuthData = {
    rpIdHash: data.slice(0, 32),
    flags,
    signCount: view.getUint32(33),
    credentialId: null,
    publicKey: null,
  };
  if (flags & FLAG_AT) {
    // aaguid (16) + credential id length (2) + id + COSE key
    if (data.length < 55) throw new Error('attested credential data too short');
    const idEnd = 55 + view.getUint16(53);
    out.credentialId = data.slice(55, idEnd);
    out.publicKey = data.slice(idEnd, decodeCbor(data, idEnd).end);
  }
  return out;
}

/** COSE public key → WebCrypto verify key. */
async function importCoseKey(cose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  const { value } = decodeCbor(cose);
  if (!(value instanceof Map)) throw new Error('public key is not a COSE map');
  const bytes = (label: number): string => {
    const v = value.get(label);
    if (!(v instanceof Uint8Array)) throw new Error('COSE key is missing a parameter');
    return b64urlEncode(v);
  };
  const alg = value.get(3);
  if (value.get(1) === 2 && alg === COSE_ES256 && value.get(-1) === 1) {
    const jwk = { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) };
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return { key, alg };
  }
  if (value.get(1) === 3 && alg === COSE_RS256) {
    const jwk = { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return { key, alg };
  }
  throw new Error('unsupported passkey algorithm');
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants r||s. */
function derToRaw(der: Uint8Array): Uint8Array {
  let pos = 2;
  if (der[0] !== 0x30) throw new Error('bad ECDSA signature');
  const int = (): Uint8Array => {
    if (der[pos] !== 0x02) throw new Error('bad ECDSA signature');
    const len = der[pos + 1] ?? 0;
    let v = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('bad ECDSA signature');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(int(), 0);
  raw.set(int(), 32);
  return raw;
}

const clientDataSchema = z
  .object({
    type: z.string(),
    challenge: z.string(),
    origin: z.string(),
    crossOrigin: z.boolean().optional(),
  })
  .loose();

export interface Expected {
  challenge: string;
  origin: string;
  rpId: string;
  /** Require user verification (PIN/biometric), e.g. for passkey sign-in. */
  userVerification?: boolean;
}

async function checkCommon(
  clientDataJSON: Uint8Array,
  authData: AuthData,
  type: string,
  expected: Expected,
): Promise<void> {
  const client = clientDataSchema.parse(
    JSON.parse(new TextDecoder().decode(clientDataJSON)),
  );
  if (client.type !== type) throw new Error('wrong ceremony type');
  if (client.challenge !== expected.challenge) throw new Error('challenge mismatch');
  if (client.origin !== expected.origin || client.crossOrigin) {
    throw new Error('origin mismatch');
  }
  const rpIdHash = await sha256Bytes(new TextEncoder().encode(expected.rpId));
  if (b64urlEncode(rpIdHash) !== b64urlEncode(authData.rpIdHash)) {
    throw new Error('relying party mismatch');
  }
  if (!(authData.flags & FLAG_UP)) throw new Error('user presence missing');
  if (expected.userVerification && !(authData.flags & FLAG_UV)) {
    throw new Error('user verification missing');
  }
}

/** Run a verification step; any failure is a stable `400 invalid_passkey`. */
async function guarded<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const why = err instanceof Error ? err.message : 'verification failed';
    throw new ApiError(400, 'invalid_passkey', `passkey rejected: ${why}`);
  }
}

export async function verifyRegistration(
  response: { clientDataJSON: string; attestationObject: string },
  expected: Expected,
): Promise<{ credentialId: string; publicKey: string; signCount: number }> {
  return guarded(async () => {
    const { value } = decodeCbor(b64urlDecode(response.attestationObject));
    const raw = value instanceof Map ? value.get('authData') : null;
    if (!(raw instanceof Uint8Array))
      throw new Error('attestation has no authenticator data');
    const authData = parseAuthData(raw);
    await checkCommon(
      b64urlDecode(response.clientDataJSON),
      authData,
      'webauthn.create',
      expected,
    );
    if (!authData.credentialId || !authData.publicKey) throw new Error('no credential');
    await importCoseKey(authData.publicKey); // reject keys we could never verify
    return {
      credentialId: b64urlEncode(authData.credentialId),
      publicKey: b64urlEncode(authData.publicKey),
      signCount: authData.signCount,
    };
  });
}

/** Verify an assertion; returns the new signature counter. */
export async function verifyAssertion(
  response: { clientDataJSON: string; authenticatorData: string; signature: string },
  stored: { publicKey: string; signCount: number },
  expected: Expected,
): Promise<number> {
  return guarded(async () => {
    const authBytes = b64urlDecode(response.authenticatorData);
    const clientBytes = b64urlDecode(response.clientDataJSON);
    const authData = parseAuthData(authBytes);
    await checkCommon(clientBytes, authData, 'webauthn.get', expected);
    const { key, alg } = await importCoseKey(b64urlDecode(stored.publicKey));
    const signed = new Uint8Array(authBytes.length + 32);
    signed.set(authBytes, 0);
    signed.set(await sha256Bytes(clientBytes), authBytes.length);
    const sig = b64urlDecode(response.signature);
    const ok =
      alg === COSE_ES256
        ? await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            derToRaw(sig) as BufferSource,
            signed,
          )
        : await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            sig as BufferSource,
            signed,
          );
    if (!ok) throw new Error('bad signature');
    // a counter that stops increasing suggests a cloned authenticator
    if (
      (authData.signCount !== 0 || stored.signCount !== 0) &&
      authData.signCount <= stored.signCount
    ) {
      throw new Error('signature counter did not increase');
    }
    return authData.signCount;
  });
}

// ---------------------------------------------------------------------------
// Challenges: single-use, hashed, 5-minute TTL
// ---------------------------------------------------------------------------

type Purpose = 'register' | 'mfa' | 'login';

async function issueChallenge(
  env: Env,
  purpose: Purpose,
  userId: string | null,
): Promise<string> {
  const challenge = randomB64url(32);
  const now = Date.now();
  await run(env, 'DELETE FROM webauthn_challenges WHERE expires_at < ?', [now]);
  await run(
    env,
    `INSERT INTO webauthn_challenges (challenge_hash, user_id, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      await sha256Hex(new TextEncoder().encode(challenge)),
      userId,
      purpose,
      now,
      now + CHALLENGE_TTL_MS,
    ],
  );
  return challenge;
}

/** Consume the challenge the client signed; throws unless it was ours and fresh. */
async function consumeChallenge(
  c: Context<AppEnv>,
  clientDataJSON: string,
  purpose: Purpose,
  userId: string | null,
): Promise<Expected> {
  const claimed = await guarded(async () =>
    clientDataSchema.parse(
      JSON.parse(new TextDecoder().decode(b64urlDecode(clientDataJSON))),
    ),
  );
  const row = await q1<{ expires_at: number }>(
    c.env,
    `DELETE FROM webauthn_challenges WHERE challenge_hash = ? AND purpose = ? AND user_id IS ?
     RETURNING expires_at`,
    [await sha256Hex(new TextEncoder().encode(claimed.challenge)), purpose, userId],
  );
  if (!row || row.expires_at < Date.now()) {
    throw new ApiError(
      400,
      'invalid_challenge',
      'unknown, reused or expired passkey challenge',
    );
  }
  const url = new URL(c.req.url);
  return {
    challenge: claimed.challenge,
    origin: url.origin,
    rpId: url.hostname,
    userVerification: purpose === 'login',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const webauthnRoutes = new Hono<AppEnv>();

const b64Field = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);

const registrationSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  credential: z.object({
    id: b64Field,
    response: z.object({ clientDataJSON: b64Field, attestationObject: b64Field }),
  }),
});

const assertionSchema = z.object({
  credential: z.object({
    id: b64Field,
    response: z.object({
      clientDataJSON: b64Field,
      authenticatorData: b64Field,
      signature: b64Field,
    }),
  }),
});

const credentialRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  public_key: z.string(),
  sign_count: z.number(),
  label: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});
type CredentialRow = z.infer<typeof credentialRowSchema>;

export async function listPasskeys(env: Env, userId: string): Promise<CredentialRow[]> {
  const rows = await q(
    env,
    'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at',
    [userId],
  );
  return rows.map((r) => credentialRowSchema.parse(r));
}

function passkeyMetadata(row: CredentialRow): Record<string, unknown> {
  return {
    id: row.id,
    label: row.label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

const PUB_KEY_PARAMS = [
  { type: 'public-key', alg: COSE_ES256 },
  { type: 'public-key', alg: COSE_RS256 },
];

/** Verify an assertion for a stored credential and record its use. */
async function assertCredential(
  c: Context<AppEnv>,
  body: z.infer<typeof assertionSchema>,
  cred: CredentialRow,
  expected: Expected,
): Promise<void> {
  const signCount = await verifyAssertion(
    body.credential.response,
    { publicKey: cred.public_key, signCount: cred.sign_count },
    expected,
  );
  await run(
    c.env,
    'UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?',
    [signCount, Date.now(), cred.id],
  );
}

async function findCredential(env: Env, id: string): Promise<CredentialRow | null> {
  const row = await q1(env, 'SELECT * FROM webauthn_credentials WHERE id = ?', [id]);
  return row ? credentialRowSchema.parse(row) : null;
}

/** Registration options (adding a factor needs recent MFA if one exists). */
webauthnRoutes.post('/api/v1/me/passkeys/options', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const url = new URL(c.req.url);
    const existing = await listPasskeys(c.env, user.id);
    return c.json(
      {
        challenge: await issueChallenge(c.env, 'register', user.id),
        rp: { id: url.hostname, name: 'Yuma' },
        user: {
          id: b64urlEncode(new TextEncoder().encode(user.id)),
          name: user.login,
          displayName: user.login,
        },
        pubKeyCredParams: PUB_KEY_PARAMS,
        timeout: CHALLENGE_TTL_MS,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        excludeCredentials: existing.map((k) => ({ type: 'public-key', id: k.id })),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

webauthnRoutes.post('/api/v1/me/passkeys', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const parsed = registrationSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'invalid passkey');
    const { credential } = parsed.data;
    const expected = await consumeChallenge(
      c,
      credential.response.clientDataJSON,
      'register',
      user.id,
    );
    const verified = await verifyRegistration(credential.response, expected);
    if (verified.credentialId !== credential.id.replace(/=+$/, '')) {
      return apiError(c, 400, 'invalid_passkey', 'credential id mismatch');
    }
    if (await findCredential(c.env, verified.credentialId)) {
      return apiError(c, 409, 'passkey_exists', 'this passkey is already registered');
    }
    const now = Date.now();
    const row: CredentialRow = {
      id: verified.credentialId,
      user_id: user.id,
      public_key: verified.publicKey,
      sign_count: verified.signCount,
      label: parsed.data.label ?? 'Passkey',
      created_at: now,
      last_used_at: null,
    };
    await run(
      c.env,
      `INSERT INTO webauthn_credentials (id, user_id, public_key, sign_count, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.public_key, row.sign_count, row.label, row.created_at],
    );
    // the user just proved possession: this session now counts as MFA
    await markSessionMfa(c.env, c.req.header('cookie'), now);
    return c.json({ passkey: passkeyMetadata(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

webauthnRoutes.delete('/api/v1/me/passkeys/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const removed = await q1(
      c.env,
      'DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ? RETURNING id',
      [c.req.param('id'), user.id],
    );
    if (!removed) return apiError(c, 404, 'passkey_not_found', 'no such passkey');
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Step-up with a passkey. Under /auth/ for its strict rate limit. */
webauthnRoutes.post('/auth/mfa/passkey/options', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const keys = await listPasskeys(c.env, user.id);
    if (keys.length === 0) {
      return apiError(c, 404, 'passkey_not_enrolled', 'no passkey is registered');
    }
    return c.json(
      {
        challenge: await issueChallenge(c.env, 'mfa', user.id),
        rpId: new URL(c.req.url).hostname,
        timeout: CHALLENGE_TTL_MS,
        userVerification: 'preferred',
        allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.id })),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

webauthnRoutes.post('/auth/mfa/passkey', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const parsed = assertionSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'invalid passkey');
    const expected = await consumeChallenge(
      c,
      parsed.data.credential.response.clientDataJSON,
      'mfa',
      user.id,
    );
    const cred = await findCredential(c.env, parsed.data.credential.id);
    if (!cred || cred.user_id !== user.id) {
      return apiError(c, 400, 'invalid_passkey', 'unknown passkey');
    }
    await assertCredential(c, parsed.data, cred, expected);
    await markSessionMfa(c.env, c.req.header('cookie'));
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Passkey sign-in (discoverable credential + user verification). */
webauthnRoutes.post('/auth/passkey/options', async (c) => {
  try {
    return c.json(
      {
        challenge: await issueChallenge(c.env, 'login', null),
        rpId: new URL(c.req.url).hostname,
        timeout: CHALLENGE_TTL_MS,
        userVerification: 'required',
      },
      200,
      { 'cache-control': 'no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

webauthnRoutes.post('/auth/passkey', async (c) => {
  try {
    const parsed = assertionSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return apiError(c, 400, 'invalid_request', 'invalid passkey');
    const expected = await consumeChallenge(
      c,
      parsed.data.credential.response.clientDataJSON,
      'login',
      null,
    );
    const cred = await findCredential(c.env, parsed.data.credential.id);
    if (!cred) return apiError(c, 400, 'invalid_passkey', 'unknown passkey');
    await assertCredential(c, parsed.data, cred, expected);
    const user = parseUserRow(
      await q1(c.env, `SELECT * FROM ${T.users} WHERE ${C.users.id} = ?`, [cred.user_id]),
    );
    if (user.active === 0) {
      return apiError(c, 403, 'account_disabled', 'this account has been deprovisioned');
    }
    const now = Date.now();
    const session = await createSession(c.env, user.id, now, {
      method: 'passkey',
      mfaAt: now,
    });
    return c.json({ ok: true }, 200, {
      'set-cookie': sessionCookie(c.req.url, session.token),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
