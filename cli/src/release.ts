import { z } from 'zod';

/**
 * `yag release` (issue #54): checksums and offline verification of build
 * provenance. A DSSE envelope is checked against the forge's published
 * `/ci/oidc/jwks` with WebCrypto only, so the Worker test suite runs this
 * exact verifier against an envelope the server signed.
 */
export const ATTEST_AUDIENCE = 'yag:attest';
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export const envelopeSchema = z.object({
  payloadType: z.string(),
  payload: z.string(),
  signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })).min(1),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export const jwksSchema = z.object({
  keys: z.array(z.looseObject({ kid: z.string(), kty: z.string() })),
});
export type Jwks = z.infer<typeof jwksSchema>;

export const statementSchema = z.looseObject({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  subject: z.array(
    z.object({ name: z.string(), digest: z.record(z.string(), z.string()) }),
  ),
  predicateType: z.string(),
});
export type Statement = z.infer<typeof statementSchema>;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function pae(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = new TextEncoder().encode(type);
  const head = new TextEncoder().encode(
    `DSSEv1 ${typeBytes.length} ${type} ${body.length} `,
  );
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export type VerifyResult =
  { ok: true; keyId: string; statement: Statement } | { ok: false; reason: string };

/** Verify an envelope's signature and statement shape against a JWK set. */
export async function verifyEnvelope(
  envelope: Envelope,
  jwks: Jwks,
): Promise<VerifyResult> {
  if (envelope.payloadType !== PAYLOAD_TYPE)
    return { ok: false, reason: 'unexpected payloadType' };
  let body: Uint8Array;
  try {
    body = fromBase64(envelope.payload);
  } catch {
    return { ok: false, reason: 'payload is not base64' };
  }
  for (const signature of envelope.signatures) {
    const jwk = jwks.keys.find((k) => k.kid === signature.keyid);
    if (!jwk) continue;
    let ok = false;
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, ALG, false, ['verify']);
      ok = await crypto.subtle.verify(
        ALG,
        key,
        fromBase64(signature.sig),
        pae(envelope.payloadType, body),
      );
    } catch {
      ok = false;
    }
    if (!ok) continue;
    try {
      const statement = statementSchema.safeParse(
        JSON.parse(new TextDecoder().decode(body)),
      );
      if (!statement.success)
        return { ok: false, reason: 'payload is not an in-toto statement' };
      return { ok: true, keyId: signature.keyid, statement: statement.data };
    } catch {
      return { ok: false, reason: 'payload is not JSON' };
    }
  }
  return { ok: false, reason: 'no signature verifies with a published key' };
}

/**
 * For each asset, whether some verified statement names its digest. Returns
 * the names that no attestation covers.
 */
export function uncovered(
  assets: { name: string; sha256: string }[],
  statements: Statement[],
): string[] {
  return assets
    .filter(
      (a) =>
        !statements.some((s) =>
          s.subject.some(
            (sub) => sub.name === a.name && sub.digest['sha256'] === a.sha256,
          ),
        ),
    )
    .map((a) => a.name);
}

/** One line: `v1.2.0 (latest, prerelease, draft) 2 assets`. */
export function formatRelease(release: {
  tag: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  latest: boolean;
  assets: unknown[];
}): string {
  const flags = [
    release.latest && 'latest',
    release.prerelease && 'prerelease',
    release.draft && 'draft',
  ].filter(Boolean);
  return `${release.tag}${release.name !== release.tag ? ` ${release.name}` : ''}${
    flags.length ? ` (${flags.join(', ')})` : ''
  } ${release.assets.length} asset${release.assets.length === 1 ? '' : 's'}`;
}
