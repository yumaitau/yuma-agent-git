import { z } from 'zod';
import type { WebauthnOptions } from './api';

/**
 * Browser half of passkeys (issue #27): the Worker sends WebAuthn options as
 * JSON with base64url binary fields; these helpers call the platform
 * authenticator and turn the credential back into JSON for the Worker.
 */

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function toB64url(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window;
}

const descriptorSchema = z.object({ type: z.literal('public-key'), id: z.string() });
const requirement = z.enum(['discouraged', 'preferred', 'required']);

const creationSchema = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
  timeout: z.number().optional(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
  authenticatorSelection: z
    .object({
      residentKey: requirement.optional(),
      userVerification: requirement.optional(),
    })
    .optional(),
  excludeCredentials: z.array(descriptorSchema).optional(),
});

const requestSchema = z.object({
  challenge: z.string(),
  rpId: z.string().optional(),
  timeout: z.number().optional(),
  userVerification: requirement.optional(),
  allowCredentials: z.array(descriptorSchema).optional(),
});

const descriptors = (
  list: z.infer<typeof descriptorSchema>[] | undefined,
): PublicKeyCredentialDescriptor[] =>
  (list ?? []).map((d) => ({ ...d, id: fromB64url(d.id) }));

/** Create a passkey from registration options; returns the JSON to post back. */
export async function createPasskey(options: WebauthnOptions): Promise<unknown> {
  const o = creationSchema.parse(options);
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      user: { ...o.user, id: fromB64url(o.user.id) },
      excludeCredentials: descriptors(o.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey creation was cancelled');
  const res = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      attestationObject: toB64url(res.attestationObject),
    },
  };
}

/** Sign a challenge with a passkey; returns the JSON to post back. */
export async function getPasskey(options: WebauthnOptions): Promise<unknown> {
  const o = requestSchema.parse(options);
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      allowCredentials: descriptors(o.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey sign-in was cancelled');
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      authenticatorData: toB64url(res.authenticatorData),
      signature: toB64url(res.signature),
    },
  };
}
