/** base64url (RFC 4648 §5, no padding): JWTs, PKCE, WebAuthn. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url (padding optional). Throws on malformed input. */
export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** n cryptographically random bytes, base64url encoded. */
export function randomB64url(n: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
}

/** SHA-256 digest bytes. */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}
