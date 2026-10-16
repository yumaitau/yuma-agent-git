import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { q, q1, run } from '../src/db/client';
import { readSession } from '../src/auth/session';
import { hotp, matchTotp } from '../src/auth/totp';
import { decodeCbor } from '../src/auth/webauthn';
import { encodeCbor, FakeAuthenticator } from './identity-fakes';

const testEnv = env as unknown as TestEnv;
const ORIGIN = 'https://x';

async function app(path: string, init?: RequestInit): Promise<Response> {
  return makeApp(testEnv)(new Request(`${ORIGIN}${path}`, init));
}

function post(path: string, cookie: string, body: unknown = {}): Promise<Response> {
  return app(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function base32Decode(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Pretend the session's last second factor was `ageMs` ago. */
async function ageMfa(cookie: string, ageMs: number | null): Promise<void> {
  const token = cookie.slice('yag_session='.length);
  await run(testEnv, 'UPDATE sessions SET mfa_at = ? WHERE token_hash = ?', [
    ageMs === null ? null : Date.now() - ageMs,
    await sha256(new TextEncoder().encode(token)),
  ]);
}

async function registerPasskey(
  cookie: string,
  auth: FakeAuthenticator,
): Promise<Response> {
  const options = await post('/api/v1/me/passkeys/options', cookie);
  const { challenge } = (await options.json()) as { challenge: string };
  return post('/api/v1/me/passkeys', cookie, {
    credential: await auth.register(challenge, ORIGIN),
  });
}

async function enrolTotp(cookie: string): Promise<Uint8Array> {
  const setup = await post('/api/v1/me/totp', cookie);
  expect(setup.status).toBe(201);
  const { secret } = (await setup.json()) as { secret: string };
  const seed = base32Decode(secret);
  const code = await hotp(seed, Math.floor(Date.now() / 30_000));
  expect((await post('/api/v1/me/totp/confirm', cookie, { code })).status).toBe(200);
  return seed;
}

describe('totp', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('matches the RFC 6238 SHA-1 vector and rejects used or distant steps', async () => {
    const seed = new TextEncoder().encode('12345678901234567890');
    expect(await hotp(seed, 1)).toBe('287082'); // T = 59s
    expect(await matchTotp(seed, '287082', 0, 59_000)).toBe(1);
    expect(await matchTotp(seed, '287082', 1, 59_000)).toBeNull(); // replay
    expect(await matchTotp(seed, '287082', 0, 59_000 + 5 * 30_000)).toBeNull();
    expect(await matchTotp(seed, 'abcdef', 0, 59_000)).toBeNull();
  });

  it('encrypts the seed, gates token creation, and steps up with a fresh code once', async () => {
    const { cookie } = await loginAs(testEnv, 1, 'tia');
    const seed = await enrolTotp(cookie);

    const row = await q1<{ secret_enc: string; confirmed_at: number | null }>(
      testEnv,
      'SELECT * FROM totp_secrets',
    );
    expect(row?.confirmed_at).not.toBeNull();
    const rawSeed = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(row?.secret_enc).not.toContain(rawSeed);

    // confirming counted as MFA, so a token can be minted now
    const label = { label: 'ci' };
    expect((await post('/api/v1/tokens', cookie, label)).status).toBe(201);

    // 13 hours later: mfa_required
    await ageMfa(cookie, 13 * 60 * 60 * 1000);
    const stale = await post('/api/v1/tokens', cookie, label);
    expect(stale.status).toBe(403);
    expect(await errorCode(stale)).toBe('mfa_required');

    // a wrong code fails; a fresh code (a later step) passes once
    expect((await post('/auth/mfa/totp', cookie, { code: '000000' })).status).toBe(400);
    const code = await hotp(seed, Math.floor(Date.now() / 30_000) + 1);
    expect((await post('/auth/mfa/totp', cookie, { code })).status).toBe(200);
    expect((await post('/auth/mfa/totp', cookie, { code })).status).toBe(400);
    expect((await post('/api/v1/tokens', cookie, label)).status).toBe(201);
    const audited = await q<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action IN ('mfa.totp.enroll', 'auth.mfa') ORDER BY id",
    );
    expect(audited.map((e) => e.action)).toEqual(['mfa.totp.enroll', 'auth.mfa']);

    // removing the authenticator needs recent MFA, then works
    await ageMfa(cookie, null);
    expect(
      (await app('/api/v1/me/totp', { method: 'DELETE', headers: { cookie } })).status,
    ).toBe(403);
  });

  it('still lets users without a second factor create tokens, but not enrol over one', async () => {
    const { cookie } = await loginAs(testEnv, 2, 'noel');
    expect((await post('/api/v1/tokens', cookie, { label: 'x' })).status).toBe(201);
    await enrolTotp(cookie);
    expect(await errorCode(await post('/api/v1/me/totp', cookie))).toBe('totp_enrolled');
    await ageMfa(cookie, null);
    // adding a passkey on top of TOTP needs the existing factor first
    expect(await errorCode(await post('/api/v1/me/passkeys/options', cookie))).toBe(
      'mfa_required',
    );
  });
});

describe('passkeys', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('round-trips CBOR', () => {
    const encoded = encodeCbor(
      new Map<number | string, string | number>([
        ['a', 1],
        [-7, 'b'],
      ]),
    );
    const { value, end } = decodeCbor(encoded);
    expect(end).toBe(encoded.length);
    expect(value).toEqual(
      new Map<number | string, string | number>([
        ['a', 1],
        [-7, 'b'],
      ]),
    );
  });

  for (const alg of ['ES256', 'RS256'] as const) {
    it(`registers an ${alg} passkey and uses it as a second factor`, async () => {
      const { cookie } = await loginAs(testEnv, 3, `pat-${alg}`);
      const auth = await FakeAuthenticator.create(alg);
      const registered = await registerPasskey(cookie, auth);
      expect(registered.status).toBe(201);
      const stored = await q1<{ id: string; public_key: string }>(
        testEnv,
        'SELECT * FROM webauthn_credentials',
      );
      expect(stored?.id).toBe(auth.id);

      await ageMfa(cookie, 13 * 60 * 60 * 1000);
      expect(await errorCode(await post('/api/v1/tokens', cookie, { label: 'x' }))).toBe(
        'mfa_required',
      );
      const options = await post('/auth/mfa/passkey/options', cookie);
      const { challenge, allowCredentials } = (await options.json()) as {
        challenge: string;
        allowCredentials: { id: string }[];
      };
      expect(allowCredentials.map((c) => c.id)).toEqual([auth.id]);
      const ok = await post('/auth/mfa/passkey', cookie, {
        credential: await auth.assert(challenge, ORIGIN),
      });
      expect(ok.status).toBe(200);
      expect((await post('/api/v1/tokens', cookie, { label: 'x' })).status).toBe(201);
    });
  }

  it('rejects wrong origin, reused challenges, foreign rp ids and counter regressions', async () => {
    const { cookie } = await loginAs(testEnv, 4, 'quinn');
    const auth = await FakeAuthenticator.create();
    expect((await registerPasskey(cookie, auth)).status).toBe(201);

    const challengeFor = async (): Promise<string> =>
      (
        (await (await post('/auth/mfa/passkey/options', cookie)).json()) as {
          challenge: string;
        }
      ).challenge;

    let challenge = await challengeFor();
    const wrongOrigin = await post('/auth/mfa/passkey', cookie, {
      credential: await auth.assert(challenge, 'https://evil.test', { rpId: 'x' }),
    });
    expect(await errorCode(wrongOrigin)).toBe('invalid_passkey');
    // the challenge was consumed by that attempt
    const reused = await post('/auth/mfa/passkey', cookie, {
      credential: await auth.assert(challenge, ORIGIN),
    });
    expect(await errorCode(reused)).toBe('invalid_challenge');

    challenge = await challengeFor();
    const foreignRp = await post('/auth/mfa/passkey', cookie, {
      credential: await auth.assert(challenge, ORIGIN, { rpId: 'evil.test' }),
    });
    expect(await errorCode(foreignRp)).toBe('invalid_passkey');

    challenge = await challengeFor();
    expect(
      (
        await post('/auth/mfa/passkey', cookie, {
          credential: await auth.assert(challenge, ORIGIN, { counter: 10 }),
        })
      ).status,
    ).toBe(200);
    challenge = await challengeFor();
    const cloned = await post('/auth/mfa/passkey', cookie, {
      credential: await auth.assert(challenge, ORIGIN, { counter: 5 }),
    });
    expect(await errorCode(cloned)).toBe('invalid_passkey');
  });

  it('signs in with a passkey (user verification required) as an MFA session', async () => {
    const { cookie, userId } = await loginAs(testEnv, 5, 'remy');
    const auth = await FakeAuthenticator.create();
    expect((await registerPasskey(cookie, auth)).status).toBe(201);

    const options = async (): Promise<string> =>
      (
        (await (await app('/auth/passkey/options', { method: 'POST' })).json()) as {
          challenge: string;
        }
      ).challenge;
    const signIn = async (credential: unknown): Promise<Response> =>
      app('/auth/passkey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential }),
      });

    // presence without verification is not enough to sign in
    const noUv = await signIn(
      await auth.assert(await options(), ORIGIN, { flags: 0x01 }),
    );
    expect(await errorCode(noUv)).toBe('invalid_passkey');

    const res = await signIn(await auth.assert(await options(), ORIGIN));
    expect(res.status).toBe(200);
    const newCookie = (res.headers.get('set-cookie') as string).split(';')[0] as string;
    expect((await readSession(testEnv, newCookie))?.id).toBe(userId);
    const session = await q1<{ auth_method: string; mfa_at: number | null }>(
      testEnv,
      "SELECT auth_method, mfa_at FROM sessions WHERE auth_method = 'passkey'",
    );
    expect(session?.mfa_at).not.toBeNull();
    const login = await q1<{ actor_id: string; target: string }>(
      testEnv,
      "SELECT actor_id, target FROM audit_events WHERE action = 'auth.login'",
    );
    expect(login?.actor_id).toBe(userId);
    expect(JSON.parse(login?.target ?? '{}')).toMatchObject({ method: 'passkey' });

    // the security summary reflects it
    const summary = await app('/api/v1/me/security', { headers: { cookie: newCookie } });
    expect(await summary.json()).toMatchObject({
      session: { auth_method: 'passkey', mfa_fresh: true },
      passkeys: [{ id: auth.id }],
      totp: { enrolled: false },
    });
    expect((await app('/api/v1/me/security')).status).toBe(401);
  });

  it('removing a passkey needs recent MFA', async () => {
    const { cookie } = await loginAs(testEnv, 6, 'sam');
    const auth = await FakeAuthenticator.create();
    expect((await registerPasskey(cookie, auth)).status).toBe(201);
    await ageMfa(cookie, null);
    const del = (): Promise<Response> =>
      app(`/api/v1/me/passkeys/${auth.id}`, { method: 'DELETE', headers: { cookie } });
    expect(await errorCode(await del())).toBe('mfa_required');
    await ageMfa(cookie, 0);
    expect((await del()).status).toBe(200);
    expect(await q(testEnv, 'SELECT * FROM webauthn_credentials')).toHaveLength(0);
  });

  it('an inactive user has no session even if a row survives', async () => {
    const { cookie, userId } = await loginAs(testEnv, 7, 'tess');
    await run(testEnv, 'UPDATE users SET active = 0 WHERE id = ?', [userId]);
    expect(await readSession(testEnv, cookie)).toBeNull();
  });
});
