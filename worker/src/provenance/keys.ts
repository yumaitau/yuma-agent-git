import { z } from 'zod';
import type { Env } from '../env';
import { b64urlDecode } from '../auth/encoding';
import { ApiError } from '../core/errors';
import { DSSE_PAYLOAD_TYPE, pae, type Envelope, type EnvelopeCheck } from './dsse';

/**
 * The forge's provenance signing key (issue #58): Ed25519 key ring in the
 * `PROVENANCE_SIGNING_KEYS` secret, `{"keys":[JWK, ...]}`. The first key
 * (with `d`) signs; every key is published at
 * `/.well-known/yag-provenance-keys`, so a key rotated out keeps verifying
 * the records it signed. Kept apart from the CI OIDC keys: those sign tokens
 * that cloud accounts trust.
 */

const jwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  kid: z.string().min(1).max(128),
  x: z.string().min(1),
  d: z.string().optional(),
});
const ringSchema = z.object({ keys: z.array(jwkSchema).min(1).max(5) });

export interface PublicKey {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  alg: 'EdDSA';
  use: 'sig';
}

interface Keys {
  kid: string;
  sign: CryptoKey;
  published: PublicKey[];
}

let cached: { raw: string; keys: Promise<Keys> } | null = null;

function notConfigured(): ApiError {
  return new ApiError(
    503,
    'provenance_not_configured',
    'Provenance signing is not configured. An operator must set PROVENANCE_SIGNING_KEYS.',
  );
}

async function importRing(raw: string): Promise<Keys> {
  let ring: z.infer<typeof ringSchema>;
  try {
    ring = ringSchema.parse(JSON.parse(raw));
  } catch {
    throw notConfigured(); // never echo key material
  }
  const current = ring.keys[0]!;
  if (!current.d) throw notConfigured();
  const sign = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: current.x, d: current.d },
    'Ed25519',
    false,
    ['sign'],
  );
  return {
    kid: current.kid,
    sign,
    published: ring.keys.map((k) => ({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: k.kid,
      x: k.x,
      alg: 'EdDSA',
      use: 'sig',
    })),
  };
}

export function canSign(env: Env): boolean {
  return Boolean(env.PROVENANCE_SIGNING_KEYS);
}

export function provenanceKeys(env: Env): Promise<Keys> {
  const raw = env.PROVENANCE_SIGNING_KEYS;
  if (!raw) return Promise.reject(notConfigured());
  if (cached?.raw !== raw) {
    const keys = importRing(raw);
    cached = { raw, keys };
    keys.catch(() => {
      if (cached?.keys === keys) cached = null;
    });
  }
  return cached.keys;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Sign an in-toto statement into a DSSE envelope with the current key. */
export async function signStatement(
  env: Env,
  statement: unknown,
): Promise<{ envelope: Envelope; keyId: string }> {
  const keys = await provenanceKeys(env);
  const body = new TextEncoder().encode(JSON.stringify(statement));
  const sig = await crypto.subtle.sign(
    'Ed25519',
    keys.sign,
    pae(DSSE_PAYLOAD_TYPE, body),
  );
  return {
    envelope: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: b64(body),
      signatures: [{ keyid: keys.kid, sig: b64(new Uint8Array(sig)) }],
    },
    keyId: keys.kid,
  };
}

/** Verify an envelope against the published provenance keys. */
export async function verifyStatement(
  env: Env,
  envelope: Envelope,
): Promise<EnvelopeCheck> {
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE)
    return { verified: false, reason: 'unexpected payloadType' };
  let body: Uint8Array;
  try {
    body = b64urlDecode(envelope.payload);
  } catch {
    return { verified: false, reason: 'payload is not base64' };
  }
  const { published } = await provenanceKeys(env);
  for (const signature of envelope.signatures) {
    const jwk = published.find((k) => k.kid === signature.keyid);
    if (!jwk) continue;
    let sig: Uint8Array;
    try {
      sig = b64urlDecode(signature.sig);
    } catch {
      continue;
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      'Ed25519',
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        key,
        sig as BufferSource,
        pae(envelope.payloadType, body) as BufferSource,
      ))
    )
      continue;
    try {
      return {
        verified: true,
        key_id: signature.keyid,
        statement: JSON.parse(new TextDecoder().decode(body)) as unknown,
      };
    } catch {
      return { verified: false, reason: 'payload is not JSON' };
    }
  }
  return { verified: false, reason: 'no signature verifies with a published key' };
}
