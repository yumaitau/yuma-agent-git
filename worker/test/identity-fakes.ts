import { b64urlDecode, b64urlEncode, sha256Bytes } from '../src/auth/encoding';

/**
 * Hermetic stand-ins for the outside world of issue #27: an OIDC identity
 * provider (discovery, JWKS, token endpoint) behind a global fetch stub, and a
 * WebAuthn authenticator that signs with real WebCrypto keys.
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CBOR encoder (just what attestation objects and COSE keys need)
// ---------------------------------------------------------------------------

type CborIn = number | string | Uint8Array | Map<number | string, CborIn>;

export function encodeCbor(v: CborIn): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number): void => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else out.push((major << 5) | 25, n >> 8, n & 255);
  };
  const enc = (x: CborIn): void => {
    if (typeof x === 'number') {
      if (x >= 0) head(0, x);
      else head(1, -1 - x);
    } else if (typeof x === 'string') {
      const b = utf8(x);
      head(3, b.length);
      out.push(...b);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      out.push(...x);
    } else {
      head(5, x.size);
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// WebAuthn authenticator
// ---------------------------------------------------------------------------

/** ECDSA r||s → DER, as authenticators emit it. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): Uint8Array => {
    let v = bytes;
    while (v.length > 1 && v[0] === 0) v = v.slice(1);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class FakeAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  signCount = 0;

  private constructor(
    private readonly keys: CryptoKeyPair,
    readonly alg: 'ES256' | 'RS256',
    private readonly cose: Uint8Array,
  ) {}

  static async create(alg: 'ES256' | 'RS256' = 'ES256'): Promise<FakeAuthenticator> {
    const keys = (
      alg === 'ES256'
        ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify',
          ])
        : await crypto.subtle.generateKey(
            {
              name: 'RSASSA-PKCS1-v1_5',
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: 'SHA-256',
            },
            true,
            ['sign', 'verify'],
          )
    ) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
    const b = (s: string | undefined): Uint8Array => b64urlDecode(s ?? '');
    const cose =
      alg === 'ES256'
        ? encodeCbor(
            new Map<number, CborIn>([
              [1, 2],
              [3, -7],
              [-1, 1],
              [-2, b(jwk.x)],
              [-3, b(jwk.y)],
            ]),
          )
        : encodeCbor(
            new Map<number, CborIn>([
              [1, 3],
              [3, -257],
              [-1, b(jwk.n)],
              [-2, b(jwk.e)],
            ]),
          );
    return new FakeAuthenticator(keys, alg, cose);
  }

  get id(): string {
    return b64urlEncode(this.credentialId);
  }

  private async authData(
    rpId: string,
    flags: number,
    attested: boolean,
  ): Promise<Uint8Array> {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.signCount);
    const head = concat(await sha256Bytes(utf8(rpId)), new Uint8Array([flags]), counter);
    if (!attested) return head;
    const idLen = new Uint8Array([0, this.credentialId.length]);
    return concat(head, new Uint8Array(16), idLen, this.credentialId, this.cose);
  }

  async register(
    challenge: string,
    origin: string,
    rpId: string = new URL(origin).hostname,
  ): Promise<{
    id: string;
    response: { clientDataJSON: string; attestationObject: string };
  }> {
    const clientDataJSON = utf8(
      JSON.stringify({ type: 'webauthn.create', challenge, origin }),
    );
    const authData = await this.authData(rpId, 0x45, true); // UP + UV + AT
    const attestationObject = encodeCbor(
      new Map<string, CborIn>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(attestationObject),
      },
    };
  }

  async assert(
    challenge: string,
    origin: string,
    opts: { rpId?: string; flags?: number; counter?: number } = {},
  ): Promise<{
    id: string;
    response: { clientDataJSON: string; authenticatorData: string; signature: string };
  }> {
    this.signCount = opts.counter ?? this.signCount + 1;
    const authData = await this.authData(
      opts.rpId ?? new URL(origin).hostname,
      opts.flags ?? 0x05,
      false,
    );
    const clientDataJSON = utf8(
      JSON.stringify({ type: 'webauthn.get', challenge, origin }),
    );
    const signed = concat(authData, await sha256Bytes(clientDataJSON));
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        this.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5',
        this.keys.privateKey,
        signed as BufferSource,
      ),
    );
    return {
      id: this.id,
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(this.alg === 'ES256' ? rawToDer(sig) : sig),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// OIDC identity provider
// ---------------------------------------------------------------------------

export interface IdTokenOverrides {
  [claim: string]: unknown;
}

interface PendingCode {
  clientId: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  claims: IdTokenOverrides;
}

/**
 * A fake IdP at `issuer`. `install()` stubs global fetch; `authorize()` plays
 * the browser + IdP leg and returns the callback path to hit on the Worker.
 */
export class FakeIdp {
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, PendingCode>();
  /** Sign ID tokens with a key the JWKS does not publish (signature tests). */
  rogueKey: CryptoKey | null = null;

  private constructor(
    readonly issuer: string,
    private readonly kid: string,
    private readonly keys: CryptoKeyPair,
  ) {}

  static async create(issuer: string): Promise<FakeIdp> {
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    return new FakeIdp(
      issuer,
      b64urlEncode(crypto.getRandomValues(new Uint8Array(8))),
      keys,
    );
  }

  async signIdToken(claims: Record<string, unknown>): Promise<string> {
    const header = b64urlEncode(utf8(JSON.stringify({ alg: 'RS256', kid: this.kid })));
    const payload = b64urlEncode(utf8(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      this.rogueKey ?? this.keys.privateKey,
      utf8(`${header}.${payload}`) as BufferSource,
    );
    return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
  }

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      const url = new URL(req.url);
      const at = `${url.origin}${url.pathname}`;
      if (at === `${this.issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
        });
      }
      if (at === `${this.issuer}/jwks`) {
        const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
        return Response.json({ keys: [{ ...jwk, kid: this.kid, use: 'sig' }] });
      }
      if (at === `${this.issuer}/token` && req.method === 'POST') {
        const form = new URLSearchParams(
          [...(await req.formData())].map(([k, v]) => [k, String(v)]),
        );
        this.tokenRequests.push(form);
        const pending = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = b64urlEncode(await sha256Bytes(utf8(verifier)));
        if (
          !pending ||
          pending.challenge !== challenge ||
          pending.redirectUri !== form.get('redirect_uri')
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = await this.signIdToken({
          iss: this.issuer,
          aud: pending.clientId,
          sub: 'subject-1',
          iat: now,
          exp: now + 300,
          nonce: pending.nonce,
          ...pending.claims,
        });
        return Response.json({ access_token: 'idp-access', id_token: idToken });
      }
      throw new Error(`unexpected outbound fetch in test: ${req.url}`);
    }) as typeof fetch;
  }

  /** Approve the authorisation request in `location`; returns the callback path. */
  authorize(location: string, claims: IdTokenOverrides = {}): string {
    const url = new URL(location);
    const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    this.codes.set(code, {
      clientId: url.searchParams.get('client_id') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri,
      claims,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state') ?? '');
    return `${callback.pathname}${callback.search}`;
  }
}
