import { z } from 'zod';
import type { Env } from '../env';
import { b64urlDecode } from '../auth/encoding';
import { signingKeys } from '../ci/oidc';

/**
 * Signed attestations (issue #54, shared with #58): in-toto statements in a
 * DSSE envelope, signed RS256 with the forge's CI OIDC key so anyone can
 * verify them offline against the published `/ci/oidc/jwks`. The same keys
 * sign CI ID tokens, which `verifyForgeJwt` checks here.
 */
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

export const envelopeSchema = z.object({
  payloadType: z.string().min(1).max(256),
  payload: z.string().min(1).max(1_000_000),
  signatures: z
    .array(z.object({ keyid: z.string().max(128), sig: z.string().min(1).max(4096) }))
    .min(1)
    .max(8),
});
export type Envelope = z.infer<typeof envelopeSchema>;

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** DSSE pre-authentication encoding: `DSSEv1 <len> <type> <len> <body>`. */
export function pae(type: string, body: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const head = new TextEncoder().encode(
    `DSSEv1 ${typeBytes.length} ${type} ${body.length} `,
  );
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export async function signEnvelope(
  env: Env,
  statement: unknown,
): Promise<{ envelope: Envelope; keyId: string }> {
  const keys = await signingKeys(env);
  const body = new TextEncoder().encode(JSON.stringify(statement));
  const sig = await crypto.subtle.sign(ALG, keys.sign, pae(DSSE_PAYLOAD_TYPE, body));
  return {
    envelope: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: b64(body),
      signatures: [{ keyid: keys.kid, sig: b64(new Uint8Array(sig)) }],
    },
    keyId: keys.kid,
  };
}

async function publicKey(env: Env, kid: string): Promise<CryptoKey | null> {
  const jwk = (await signingKeys(env)).published.find((k) => k.kid === kid);
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', { ...jwk, ext: true }, ALG, false, ['verify']);
}

function decode(text: string): Uint8Array | null {
  try {
    return b64urlDecode(text);
  } catch {
    return null;
  }
}

export type EnvelopeCheck =
  | { verified: true; key_id: string; statement: unknown }
  | { verified: false; reason: string };

/** Verify a DSSE envelope against the published keys (any signature may match). */
export async function verifyEnvelope(
  env: Env,
  envelope: Envelope,
): Promise<EnvelopeCheck> {
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE)
    return { verified: false, reason: 'unexpected payloadType' };
  const body = decode(envelope.payload);
  if (!body) return { verified: false, reason: 'payload is not base64' };
  for (const signature of envelope.signatures) {
    const key = await publicKey(env, signature.keyid);
    const sig = decode(signature.sig);
    if (!key || !sig) continue;
    if (
      await crypto.subtle.verify(
        ALG,
        key,
        sig as BufferSource,
        pae(envelope.payloadType, body) as BufferSource,
      )
    ) {
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
  }
  return { verified: false, reason: 'no signature verifies with a published key' };
}

/**
 * Claims of a JWT this forge signed (a CI ID token), or null when the
 * signature, issuer, audience or lifetime does not check out.
 */
export async function verifyForgeJwt(
  env: Env,
  token: string,
  expected: { issuer: string; audience: string },
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) return null;
  const json = (part: string): Record<string, unknown> | null => {
    const bytes = decode(part);
    if (!bytes) return null;
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const header = json(h);
  const claims = json(p);
  const sig = decode(s);
  if (!header || !claims || !sig || header.alg !== 'RS256') return null;
  if (typeof header.kid !== 'string') return null;
  const key = await publicKey(env, header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    ALG,
    key,
    sig as BufferSource,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== expected.issuer || claims.aud !== expected.audience) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > seconds + 60) return null;
  return claims;
}
