import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo } from '../src/db/repos';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { encodeCommit, gitObjectId } from '../src/git/objects';
import { signedPayload, unverifiedPushed } from '../src/git/signatures';
import { USER_EMAIL_DOMAIN } from '../src/git/identity';
import { blob, packOf, parseReport, pushBody, tree, ZERO, type Obj } from './git-helpers';

/**
 * Commit signatures on push (issue #58): SSH and OpenPGP signatures checked
 * against keys people registered, gitsign (x509 CMS) signatures checked
 * against configured Sigstore roots, the result shown with the signer, and
 * `required_signatures` refusing pushes that bring in unverified commits.
 * Signatures are made here with WebCrypto, no git or gpg binary.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const enc = new TextEncoder();
const NO_SHA256 = '0'.repeat(64);

type User = Awaited<ReturnType<typeof loginAs>>;
let owner: User;

let trustRoots = '';

function app() {
  const values: Record<string, unknown> = { SIGSTORE_TRUST_ROOTS: trustRoots };
  return makeApp(
    new Proxy(testEnv, {
      get: (target, key, receiver) =>
        typeof key === 'string' && key in values
          ? values[key]
          : Reflect.get(target, key, receiver),
    }),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function armor(label: string, bytes: Uint8Array, blank = false): string {
  const lines = b64(bytes).match(/.{1,64}/g) ?? [];
  return [
    `-----BEGIN ${label}-----`,
    ...(blank ? [''] : []),
    ...lines,
    ...(blank ? ['=AAAA'] : []),
    `-----END ${label}-----`,
  ].join('\n');
}

async function digest(algo: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algo, data as BufferSource));
}

/** A commit whose committer is `email`, signed by `sign` (or unsigned). */
async function signedCommit(
  email: string,
  message: string,
  sign?: (payload: Uint8Array) => Promise<string>,
): Promise<{ objects: Obj[]; sha: string }> {
  const file = await blob(message);
  const root = await tree([{ name: 'f.txt', sha: file.sha }]);
  const who = { name: 'Owner', email, seconds: 1_800_000_000, tz: '+1000' };
  const fields = {
    tree: { sha1: root.sha, sha256: NO_SHA256 },
    parents: [],
    author: who,
    committer: who,
    message,
  };
  const payload = encodeCommit(fields, 'sha1');
  const body = sign
    ? encodeCommit({ ...fields, gpgsig: await sign(payload) }, 'sha1')
    : payload;
  const sha = await gitObjectId('commit', body, 'sha1');
  return { objects: [{ type: 'commit', body, sha }, root, file], sha };
}

async function push(
  objects: Obj[],
  sha: string,
  ref = 'refs/heads/main',
): Promise<ReturnType<typeof parseReport>> {
  const token = await createApiToken(dbEnv, owner.userId, { label: 'git' });
  const res = await app()(
    new Request(`https://x/acme/app.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: `Basic ${btoa(`git:${token.raw}`)}`,
      },
      body: pushBody([[ZERO, sha, ref]], await packOf(objects)),
    }),
  );
  expect(res.status).toBe(200);
  return parseReport(new Uint8Array(await res.arrayBuffer()));
}

async function check(): Promise<Record<string, unknown>> {
  const row = await q1<{ cs_id: string }>(dbEnv, 'SELECT cs_id FROM commit_signatures');
  const res = await app()(
    new Request(`https://x/api/v1/repos/acme/app/provenance?cs=${row!.cs_id}`, {
      headers: owner.headers,
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { signature: Record<string, unknown> }).signature;
}

async function addKey(kind: 'ssh' | 'gpg', publicKey: string): Promise<void> {
  const res = await app()(
    new Request('https://x/api/v1/me/signing-keys', {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kind, title: 'key', public_key: publicKey }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
}

// --- SSH ---------------------------------------------------------------------

function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

async function sshKey(): Promise<{
  line: string;
  sign: (payload: Uint8Array) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const keyBlob = concat(sshString(enc.encode('ssh-ed25519')), sshString(raw));
  return {
    line: `ssh-ed25519 ${b64(keyBlob)} owner@laptop`,
    async sign(payload) {
      const ns = enc.encode('git');
      const hash = enc.encode('sha512');
      const signed = concat(
        enc.encode('SSHSIG'),
        sshString(ns),
        sshString(new Uint8Array()),
        sshString(hash),
        sshString(await digest('SHA-512', payload)),
      );
      const sig = new Uint8Array(
        await crypto.subtle.sign('Ed25519', pair.privateKey, signed as BufferSource),
      );
      const version = new Uint8Array([0, 0, 0, 1]);
      return armor(
        'SSH SIGNATURE',
        concat(
          enc.encode('SSHSIG'),
          version,
          sshString(keyBlob),
          sshString(ns),
          sshString(new Uint8Array()),
          sshString(hash),
          sshString(concat(sshString(enc.encode('ssh-ed25519')), sshString(sig))),
        ),
      );
    },
  };
}

// --- OpenPGP (v4, EdDSA legacy, as gpg makes for ed25519 keys) ---------------

function packet(tag: number, body: Uint8Array): Uint8Array {
  expect(body.length).toBeLessThan(192);
  return concat(new Uint8Array([0xc0 | tag, body.length]), body);
}

function mpi(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const value = bytes.subarray(start);
  const bits = (value.length - 1) * 8 + (32 - Math.clz32(value[0]!));
  return concat(new Uint8Array([bits >> 8, bits & 0xff]), value);
}

async function pgpKey(): Promise<{
  armored: string;
  sign: (payload: Uint8Array) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const oid = [0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01];
  const body = concat(
    new Uint8Array([4, 0x6b, 0x00, 0x00, 0x00, 22, oid.length, ...oid]),
    mpi(concat(new Uint8Array([0x40]), raw)),
  );
  const fingerprint = await digest(
    'SHA-1',
    concat(new Uint8Array([0x99, body.length >> 8, body.length & 0xff]), body),
  );
  const keyId = fingerprint.subarray(12);
  const armored = armor(
    'PGP PUBLIC KEY BLOCK',
    concat(packet(6, body), packet(13, enc.encode('Owner <owner@example.com>'))),
    true,
  );
  return {
    armored,
    async sign(payload) {
      const hashed = concat(
        new Uint8Array([5, 2, 0x6b, 0, 0, 0]), // signature creation time
        new Uint8Array([22, 33, 4]), // issuer fingerprint
        fingerprint,
      );
      const head = concat(
        new Uint8Array([4, 0x00, 22, 8, hashed.length >> 8, hashed.length & 0xff]),
        hashed,
      );
      const trailer = new Uint8Array([0x04, 0xff, 0, 0, 0, 0]);
      new DataView(trailer.buffer).setUint32(2, head.length);
      const h = await digest('SHA-256', concat(payload, head, trailer));
      const sig = new Uint8Array(
        await crypto.subtle.sign('Ed25519', pair.privateKey, h as BufferSource),
      );
      const unhashed = concat(new Uint8Array([9, 16]), keyId);
      return armor(
        'PGP SIGNATURE',
        packet(
          2,
          concat(
            head,
            new Uint8Array([unhashed.length >> 8, unhashed.length & 0xff]),
            unhashed,
            h.subarray(0, 2),
            mpi(sig.subarray(0, 32)),
            mpi(sig.subarray(32)),
          ),
        ),
        true,
      );
    },
  };
}

// --- DER, X.509 and CMS (gitsign) --------------------------------------------

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concat(new Uint8Array([tag, ...len]), body);
}
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
const set = (...p: Uint8Array[]) => tlv(0x31, ...p);
const octets = (b: Uint8Array) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, enc.encode(s));
function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, new Uint8Array(out));
}
function int(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const v = bytes.subarray(start);
  return tlv(0x02, v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v);
}
function utc(ms: number): Uint8Array {
  const d = new Date(ms).toISOString();
  const text = `${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}Z`;
  return tlv(0x17, enc.encode(text));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

async function ecdsa(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      data as BufferSource,
    ),
  );
  return seq(int(raw.subarray(0, 32)), int(raw.subarray(32)));
}

interface Ca {
  name: Uint8Array;
  key: CryptoKey;
  cert: Uint8Array;
}

async function newPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

async function certificate(opts: {
  serial: number;
  issuer: Uint8Array;
  subject: Uint8Array;
  publicKey: CryptoKey;
  signer: CryptoKey;
  extensions: Uint8Array[];
}): Promise<Uint8Array> {
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', opts.publicKey)) as ArrayBuffer,
  );
  const tbs = seq(
    tlv(0xa0, int(new Uint8Array([2]))),
    int(new Uint8Array([opts.serial])),
    ECDSA_SHA256,
    opts.issuer,
    seq(utc(Date.UTC(2020, 0, 1)), utc(Date.UTC(2040, 0, 1))),
    opts.subject,
    spki,
    tlv(0xa3, seq(...opts.extensions)),
  );
  const sig = await ecdsa(opts.signer, tbs);
  return seq(tbs, ECDSA_SHA256, tlv(0x03, new Uint8Array([0]), sig));
}

const ext = (id: string, value: Uint8Array) => seq(oid(id), octets(value));

async function newCa(cn: string): Promise<Ca> {
  const pair = await newPair();
  const subject = name(cn);
  const cert = await certificate({
    serial: 1,
    issuer: subject,
    subject,
    publicKey: pair.publicKey,
    signer: pair.privateKey,
    extensions: [ext('2.5.29.19', seq(tlv(0x01, new Uint8Array([0xff]))))],
  });
  return { name: subject, key: pair.privateKey, cert };
}

function pem(der: Uint8Array): string {
  return armor('CERTIFICATE', der);
}

/** A gitsign-style detached CMS signature by a Fulcio-like leaf for `email`. */
async function gitsign(ca: Ca, email: string) {
  const pair = await newPair();
  const serial = 7;
  const leaf = await certificate({
    serial,
    issuer: ca.name,
    subject: seq(),
    publicKey: pair.publicKey,
    signer: ca.key,
    extensions: [
      ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.3'))),
      ext('2.5.29.17', seq(tlv(0x81, enc.encode(email)))),
      ext('1.3.6.1.4.1.57264.1.8', utf8('https://accounts.example.com')),
    ],
  });
  return async (payload: Uint8Array): Promise<string> => {
    const attrs = [
      seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.7.1'))),
      seq(oid('1.2.840.113549.1.9.5'), set(utc(Date.UTC(2027, 0, 1)))),
      seq(oid('1.2.840.113549.1.9.4'), set(octets(await digest('SHA-256', payload)))),
    ];
    const signature = await ecdsa(pair.privateKey, set(...attrs));
    const signerInfo = seq(
      int(new Uint8Array([1])),
      seq(ca.name, int(new Uint8Array([serial]))),
      seq(oid('2.16.840.1.101.3.4.2.1')),
      tlv(0xa0, ...attrs),
      ECDSA_SHA256,
      octets(signature),
    );
    const signedData = seq(
      int(new Uint8Array([1])),
      set(seq(oid('2.16.840.1.101.3.4.2.1'))),
      seq(oid('1.2.840.113549.1.7.1')),
      tlv(0xa0, leaf),
      set(signerInfo),
    );
    return armor(
      'SIGNED MESSAGE',
      seq(oid('1.2.840.113549.1.7.2'), tlv(0xa0, signedData)),
    );
  };
}

// -----------------------------------------------------------------------------

const ownerEmail = `owner@${USER_EMAIL_DOMAIN}`;

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  trustRoots = '';
  owner = await loginAs(testEnv, 5901, 'owner');
  await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId });
});

describe('signed payload', () => {
  it('is the commit without its gpgsig header', async () => {
    const plain = await signedCommit('a@example.com', 'm\n');
    const signed = await signedCommit('a@example.com', 'm\n', async () =>
      ['-----BEGIN SSH SIGNATURE-----', 'AAAA', '', '-----END SSH SIGNATURE-----'].join(
        '\n',
      ),
    );
    expect(signedPayload(signed.objects[0]!.body)).toEqual(plain.objects[0]!.body);
  });
});

describe('SSH signatures', () => {
  it('a commit signed with a registered key shows verified with its signer', async () => {
    const key = await sshKey();
    await addKey('ssh', key.line);
    const c = await signedCommit(ownerEmail, 'signed\n', key.sign);
    expect((await push(c.objects, c.sha)).refs['refs/heads/main']).toBe('ok');
    expect(await check()).toMatchObject({
      status: 'verified',
      format: 'ssh',
      signer: ownerEmail,
      user_id: owner.userId,
      user_login: 'owner',
      key_id: expect.stringMatching(/^SHA256:/),
    });
  });

  it('an unregistered key, other bytes or another person’s email stay unverified', async () => {
    const key = await sshKey();
    const c = await signedCommit(ownerEmail, 'signed\n', key.sign);
    await push(c.objects, c.sha);
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'no registered key matches the signature',
    });

    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 5901, 'owner');
    await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId });
    await addKey('ssh', key.line);
    // a signature over different bytes
    const forged = await signedCommit(ownerEmail, 'signed\n', (payload) =>
      key.sign(concat(payload, enc.encode('x'))),
    );
    await push(forged.objects, forged.sha);
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'bad signature',
    });

    await run(dbEnv, 'DELETE FROM commit_signatures');
    const other = await signedCommit('someone@example.com', 'other\n', key.sign);
    await push(other.objects, other.sha, 'refs/heads/other');
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: "the committer email is not a verified address of the key's owner",
    });
  });
});

describe('OpenPGP signatures', () => {
  it('checks a v4 Ed25519 signature against the registered key', async () => {
    const key = await pgpKey();
    await addKey('gpg', key.armored);
    const keys = await q<{ key_ids: string }>(
      dbEnv,
      'SELECT key_ids FROM user_signing_keys',
    );
    expect(keys[0]!.key_ids).toMatch(/^[0-9a-f]{16}$/);
    const c = await signedCommit(ownerEmail, 'pgp\n', key.sign);
    expect((await push(c.objects, c.sha)).refs['refs/heads/main']).toBe('ok');
    expect(await check()).toMatchObject({
      status: 'verified',
      format: 'gpg',
      user_login: 'owner',
      key_id: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
  });

  it('refuses a signature made with another key', async () => {
    await addKey('gpg', (await pgpKey()).armored);
    const c = await signedCommit(ownerEmail, 'pgp\n', (await pgpKey()).sign);
    await push(c.objects, c.sha);
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'no registered key matches the signature',
    });
  });
});

describe('gitsign (x509) signatures', () => {
  it('a gitsign-signed commit pushed over Git shows verified with the signer identity', async () => {
    const ca = await newCa('sigstore-test');
    trustRoots = pem(ca.cert);
    await run(
      dbEnv,
      "INSERT INTO user_identities (provider, subject, user_id, email, linked_at) VALUES ('oidc:test', 's', ?, 'ada@example.com', 0)",
      [owner.userId],
    );
    const c = await signedCommit(
      'ada@example.com',
      'keyless\n',
      await gitsign(ca, 'ada@example.com'),
    );
    expect((await push(c.objects, c.sha)).refs['refs/heads/main']).toBe('ok');
    expect(await check()).toMatchObject({
      status: 'verified',
      format: 'x509',
      signer: 'ada@example.com (https://accounts.example.com)',
      user_login: 'owner',
    });
  });

  it('needs a configured root it chains to and the committer’s own email', async () => {
    const ca = await newCa('sigstore-test');
    const sign = await gitsign(ca, 'ada@example.com');
    const c = await signedCommit('ada@example.com', 'keyless\n', sign);
    await push(c.objects, c.sha);
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'no x509 trust roots are configured',
    });

    await run(dbEnv, 'DELETE FROM commit_signatures');
    trustRoots = pem((await newCa('someone-else')).cert);
    const again = await signedCommit('ada@example.com', 'again\n', sign);
    await push(again.objects, again.sha, 'refs/heads/again');
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'certificate does not chain to a trusted root',
    });

    await run(dbEnv, 'DELETE FROM commit_signatures');
    trustRoots = pem(ca.cert);
    const spoof = await signedCommit('eve@example.com', 'spoof\n', sign);
    await push(spoof.objects, spoof.sha, 'refs/heads/spoof');
    expect(await check()).toMatchObject({
      status: 'unverified',
      reason: 'the committer email is not the certificate email',
    });
  });
});

describe('required_signatures', () => {
  it('refuses a push that brings in an unverified commit', async () => {
    const res = await app()(
      new Request('https://x/api/v1/repos/acme/app/rulesets', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Signed',
          target: 'branch',
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
          rules: [{ type: 'required_signatures' }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const unsigned = await signedCommit(ownerEmail, 'unsigned\n');
    const refused = await push(unsigned.objects, unsigned.sha);
    expect(refused.refs['refs/heads/main']).toMatch(
      /ruleset "Signed": 1 pushed commit has no verified signature/,
    );
    expect(await q(dbEnv, "SELECT name FROM refs WHERE name = 'main'")).toEqual([]);

    const key = await sshKey();
    await addKey('ssh', key.line);
    const signed = await signedCommit(ownerEmail, 'signed\n', key.sign);
    expect((await push(signed.objects, signed.sha)).refs['refs/heads/main']).toBe('ok');
  });

  it('counts commits pushed unsigned to a fork, which a fork pull request brings in', async () => {
    const sig = (repoId: string, cs: string, status: string) =>
      run(
        dbEnv,
        'INSERT INTO commit_signatures (repo_id, cs_id, status, checked_at) VALUES (?,?,?,0)',
        [repoId, cs, status],
      );
    await sig('ROOT1~FORK1', 'cs-fork', 'unsigned');
    await sig('ROOT1', 'cs-base', 'unverified');
    await sig('ROOT1~FORK2', 'cs-ok', 'verified');
    await sig('ROOT1X', 'cs-other', 'unsigned');
    const ids = ['cs-fork', 'cs-base', 'cs-ok', 'cs-other', 'cs-api'];
    for (const repoId of ['ROOT1', 'ROOT1~FORK1'])
      expect((await unverifiedPushed(dbEnv, repoId, ids)).sort()).toEqual([
        'cs-base',
        'cs-fork',
      ]);
  });
});
