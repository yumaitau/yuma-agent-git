import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { b64urlDecode } from '../auth/encoding';
import { dagMergeBases } from '../core/ancestry';
import { storageId } from '../core/network';
import { USER_EMAIL_DOMAIN } from './identity';

/**
 * Commit signature checks (issue #58) for commits pushed over Git. The signed
 * payload is the commit body without its `gpgsig` header, as Git signs it.
 *
 * - SSH (`git config gpg.format ssh`): an SSHSIG blob in namespace `git`,
 *   checked against a key the committer registered (ed25519, RSA SHA-2,
 *   ECDSA P-256).
 * - OpenPGP: a v4 signature checked against a registered public key or one
 *   of its subkeys (RSA, EdDSA Ed25519).
 * - x509 (gitsign): a detached CMS signature whose certificate chains to a
 *   root in `SIGSTORE_TRUST_ROOTS` at signing time; the signer is the
 *   certificate's email and OIDC issuer. Rekor inclusion is not checked.
 *
 * `verified` also needs the committer email to belong to the signer: a
 * verified address of the key's owner (or their no-reply address), or the
 * certificate's email for x509. Everything else is `unverified` with a reason.
 */

export type SignatureFormat = 'ssh' | 'gpg' | 'x509';
export type SignatureStatus = 'verified' | 'unverified' | 'unsigned';

export interface SignatureCheck {
  status: SignatureStatus;
  format: SignatureFormat | null;
  key_id: string | null;
  signer: string | null;
  user_id: string | null;
  reason: string | null;
}

export interface SignatureView extends SignatureCheck {
  user_login: string | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function digest(algo: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algo, data as BufferSource));
}

/** `bytes` as an unsigned big-endian integer of exactly `size` bytes. */
function fixed(bytes: Uint8Array, size: number): Uint8Array {
  let start = 0;
  while (start < bytes.length - size && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  if (trimmed.length > size) throw new Error('integer too large');
  const out = new Uint8Array(size);
  out.set(trimmed, size - trimmed.length);
  return out;
}

function unsigned(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

const b64url = (bytes: Uint8Array): string =>
  b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The bytes between `-----BEGIN <label>-----` and its END line. */
function armored(text: string, label: string): Uint8Array | null {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) return null;
  let lines = text
    .slice(from + begin.length, to)
    .split('\n')
    .map((l) => l.trim());
  // OpenPGP armor: optional headers end at a blank line; `=` starts the CRC
  if (label.startsWith('PGP')) {
    const blank = lines.indexOf('', 1);
    if (lines.slice(1, blank).some((l) => l.includes(': '))) lines = lines.slice(blank);
    lines = lines.filter((l) => !l.startsWith('='));
  }
  try {
    return b64urlDecode(lines.join(''));
  } catch {
    return null;
  }
}

/** The commit body Git signed: every header but `gpgsig` and `gpgsig-sha256`. */
export function signedPayload(body: Uint8Array): Uint8Array {
  const text = dec.decode(body);
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && dropping) continue;
    dropping = line.startsWith('gpgsig ') || line.startsWith('gpgsig-sha256 ');
    if (!dropping) kept.push(line);
  }
  return enc.encode(`${kept.join('\n')}${split < 0 ? '' : text.slice(split)}`);
}

export function signatureFormat(gpgsig: string): SignatureFormat | null {
  const first = gpgsig.trimStart();
  if (first.startsWith('-----BEGIN SSH SIGNATURE-----')) return 'ssh';
  if (first.startsWith('-----BEGIN PGP SIGNATURE-----')) return 'gpg';
  if (first.startsWith('-----BEGIN SIGNED MESSAGE-----')) return 'x509';
  return null;
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

class SshReader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('truncated SSH data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u32(): number {
    const b = this.bytes(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }
  string(): Uint8Array {
    return this.bytes(this.u32());
  }
  text(): string {
    return dec.decode(this.string());
  }
}

function sshString(bytes: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length);
  return concat(len, bytes);
}

export const SSH_KEY_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'] as const;

export async function sshFingerprint(blob: Uint8Array): Promise<string> {
  return `SHA256:${b64(await digest('SHA-256', blob)).replace(/=+$/, '')}`;
}

/** `ssh-ed25519 AAAA… comment` → its key blob, or throws. */
export function parseSshPublicKey(line: string): { type: string; blob: Uint8Array } {
  const [type, data] = line.trim().split(/\s+/);
  if (!type || !data || !(SSH_KEY_TYPES as readonly string[]).includes(type))
    throw new Error(`unsupported SSH key type; use one of ${SSH_KEY_TYPES.join(', ')}`);
  const blob = b64urlDecode(data);
  if (new SshReader(blob).text() !== type) throw new Error('SSH key type mismatch');
  return { type, blob };
}

async function sshVerify(
  keyBlob: Uint8Array,
  sigBlob: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = new SshReader(keyBlob);
  const type = key.text();
  const sig = new SshReader(sigBlob);
  const alg = sig.text();
  const raw = sig.string();
  if (type === 'ssh-ed25519' && alg === 'ssh-ed25519') {
    const k = await crypto.subtle.importKey('raw', key.string(), 'Ed25519', false, [
      'verify',
    ]);
    return crypto.subtle.verify('Ed25519', k, raw, data);
  }
  if (type === 'ssh-rsa' && (alg === 'rsa-sha2-256' || alg === 'rsa-sha2-512')) {
    const e = unsigned(key.string());
    const n = unsigned(key.string());
    const params = {
      name: 'RSASSA-PKCS1-v1_5',
      hash: alg === 'rsa-sha2-256' ? 'SHA-256' : 'SHA-512',
    };
    const k = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: b64url(n), e: b64url(e), ext: true },
      params,
      false,
      ['verify'],
    );
    return crypto.subtle.verify(params, k, fixed(raw, n.length), data);
  }
  if (type === 'ecdsa-sha2-nistp256' && alg === type) {
    if (key.text() !== 'nistp256') return false;
    const k = await crypto.subtle.importKey(
      'raw',
      key.string(),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const rs = new SshReader(raw);
    const signature = concat(fixed(rs.string(), 32), fixed(rs.string(), 32));
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, signature, data);
  }
  return false;
}

interface SshSig {
  publicKey: Uint8Array;
  fingerprint: string;
  verify(payload: Uint8Array, keyBlob: Uint8Array): Promise<boolean>;
}

async function parseSshSig(gpgsig: string): Promise<SshSig> {
  const blob = armored(gpgsig, 'SSH SIGNATURE');
  if (!blob) throw new Error('malformed SSH signature');
  const r = new SshReader(blob);
  if (dec.decode(r.bytes(6)) !== 'SSHSIG' || r.u32() !== 1)
    throw new Error('not an SSHSIG v1 signature');
  const publicKey = r.string();
  const namespace = r.string();
  const reserved = r.string();
  const hashAlg = r.text();
  const signature = r.string();
  if (dec.decode(namespace) !== 'git') throw new Error('signature is not for Git');
  if (hashAlg !== 'sha256' && hashAlg !== 'sha512')
    throw new Error(`unsupported hash ${hashAlg}`);
  return {
    publicKey,
    fingerprint: await sshFingerprint(publicKey),
    async verify(payload, keyBlob) {
      const h = await digest(hashAlg === 'sha256' ? 'SHA-256' : 'SHA-512', payload);
      const signed = concat(
        enc.encode('SSHSIG'),
        sshString(namespace),
        sshString(reserved),
        sshString(enc.encode(hashAlg)),
        sshString(h),
      );
      return sshVerify(keyBlob, signature, signed);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenPGP
// ---------------------------------------------------------------------------

interface Packet {
  tag: number;
  body: Uint8Array;
}

function packets(buf: Uint8Array): Packet[] {
  const out: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const first = buf[pos++]!;
    if ((first & 0x80) === 0) throw new Error('malformed OpenPGP packet');
    let tag: number;
    let len: number;
    if (first & 0x40) {
      tag = first & 0x3f;
      const o = buf[pos++]!;
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[pos++]! + 192;
      else if (o === 255) {
        len = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0);
        pos += 4;
      } else throw new Error('partial OpenPGP packets are not supported');
    } else {
      tag = (first >> 2) & 0x0f;
      const type = first & 3;
      if (type === 3) len = buf.length - pos;
      else {
        const size = [1, 2, 4][type]!;
        len = 0;
        for (let i = 0; i < size; i++) len = len * 256 + buf[pos++]!;
      }
    }
    if (pos + len > buf.length) throw new Error('truncated OpenPGP packet');
    out.push({ tag, body: buf.subarray(pos, pos + len) });
    pos += len;
  }
  return out;
}

/** Multiprecision integers: a two-byte bit count, then the bytes. */
function mpi(buf: Uint8Array, pos: number): { value: Uint8Array; next: number } {
  const bits = (buf[pos]! << 8) | buf[pos + 1]!;
  const len = (bits + 7) >> 3;
  if (pos + 2 + len > buf.length) throw new Error('truncated OpenPGP integer');
  return { value: buf.subarray(pos + 2, pos + 2 + len), next: pos + 2 + len };
}

const ED25519_OID = new Uint8Array([
  0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01,
]);
const PGP_HASHES: Record<number, string> = { 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512' };

export interface PgpKey {
  fingerprint: string;
  keyId: string;
  key:
    { kind: 'rsa'; n: Uint8Array; e: Uint8Array } | { kind: 'ed25519'; pk: Uint8Array };
}

async function pgpKey(body: Uint8Array): Promise<PgpKey | null> {
  if (body[0] !== 4) return null; // v4 keys only
  const alg = body[5];
  let key: PgpKey['key'];
  if (alg === 1 || alg === 3) {
    const n = mpi(body, 6);
    key = { kind: 'rsa', n: n.value, e: mpi(body, n.next).value };
  } else if (alg === 22) {
    const oidLen = body[6]!;
    if (!equal(body.subarray(7, 7 + oidLen), ED25519_OID)) return null;
    const q = mpi(body, 7 + oidLen).value;
    if (q.length !== 33 || q[0] !== 0x40) return null;
    key = { kind: 'ed25519', pk: q.subarray(1) };
  } else if (alg === 27) {
    key = { kind: 'ed25519', pk: body.subarray(6, 38) };
  } else return null;
  const len = new Uint8Array([0x99, body.length >> 8, body.length & 0xff]);
  const fingerprint = hex(await digest('SHA-1', concat(len, body)));
  return { fingerprint, keyId: fingerprint.slice(-16), key };
}

/** Every v4 key (primary first, then subkeys) in an armored public key block. */
export async function parsePgpPublicKey(text: string): Promise<PgpKey[]> {
  const bytes = armored(text, 'PGP PUBLIC KEY BLOCK');
  if (!bytes) throw new Error('not an armored OpenPGP public key block');
  const keys: PgpKey[] = [];
  for (const p of packets(bytes)) {
    if (p.tag !== 6 && p.tag !== 14) continue;
    const key = await pgpKey(p.body);
    if (key) keys.push(key);
  }
  if (keys.length === 0 || packets(bytes)[0]?.tag !== 6)
    throw new Error('no supported v4 RSA or Ed25519 public key in the block');
  return keys;
}

interface PgpSig {
  issuers: string[];
  verify(payload: Uint8Array, key: PgpKey): Promise<boolean>;
}

function parsePgpSig(gpgsig: string): PgpSig {
  const bytes = armored(gpgsig, 'PGP SIGNATURE');
  const sig = bytes ? packets(bytes).find((p) => p.tag === 2) : undefined;
  if (!sig) throw new Error('malformed OpenPGP signature');
  const b = sig.body;
  if (b[0] !== 4) throw new Error('only v4 OpenPGP signatures are supported');
  if (b[1] !== 0x00) throw new Error('not a binary document signature');
  const pubAlg = b[2]!;
  const hash = PGP_HASHES[b[3]!];
  if (!hash) throw new Error('unsupported OpenPGP hash algorithm');
  const hashedLen = (b[4]! << 8) | b[5]!;
  const hashedEnd = 6 + hashedLen;
  const unhashedLen = (b[hashedEnd]! << 8) | b[hashedEnd + 1]!;
  const issuers: string[] = [];
  const subpackets = (from: number, to: number): void => {
    let pos = from;
    while (pos < to) {
      let len = b[pos++]!;
      if (len >= 192 && len < 255) len = ((len - 192) << 8) + b[pos++]! + 192;
      else if (len === 255) {
        len = new DataView(b.buffer, b.byteOffset + pos, 4).getUint32(0);
        pos += 4;
      }
      const type = b[pos]! & 0x7f;
      const data = b.subarray(pos + 1, pos + len);
      if (type === 16) issuers.push(hex(data));
      if (type === 33) issuers.push(hex(data.subarray(1)));
      pos += len;
    }
  };
  subpackets(6, hashedEnd);
  subpackets(hashedEnd + 2, hashedEnd + 2 + unhashedLen);
  const material = hashedEnd + 2 + unhashedLen + 2; // after the left 16 bits
  const trailer = new Uint8Array([0x04, 0xff, 0, 0, 0, 0]);
  new DataView(trailer.buffer).setUint32(2, hashedEnd);
  return {
    issuers: [...new Set(issuers)],
    async verify(payload, key) {
      const input = concat(payload, b.subarray(0, hashedEnd), trailer);
      if (key.key.kind === 'rsa' && (pubAlg === 1 || pubAlg === 3)) {
        const n = unsigned(key.key.n);
        const params = { name: 'RSASSA-PKCS1-v1_5', hash };
        const k = await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: b64url(n), e: b64url(unsigned(key.key.e)), ext: true },
          params,
          false,
          ['verify'],
        );
        return crypto.subtle.verify(
          params,
          k,
          fixed(mpi(b, material).value, n.length),
          input,
        );
      }
      if (key.key.kind === 'ed25519' && (pubAlg === 22 || pubAlg === 27)) {
        let signature: Uint8Array;
        if (pubAlg === 22) {
          const r = mpi(b, material);
          signature = concat(fixed(r.value, 32), fixed(mpi(b, r.next).value, 32));
        } else signature = b.subarray(material, material + 64);
        const k = await crypto.subtle.importKey('raw', key.key.pk, 'Ed25519', false, [
          'verify',
        ]);
        // EdDSA signs the digest, not the data
        return crypto.subtle.verify('Ed25519', k, signature, await digest(hash, input));
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// DER, X.509 and CMS (gitsign)
// ---------------------------------------------------------------------------

interface Der {
  tag: number;
  /** Header start, value start, end, in `buf`. */
  start: number;
  vStart: number;
  end: number;
  buf: Uint8Array;
}

function der(buf: Uint8Array, start = 0): Der {
  const tag = buf[start]!;
  let pos = start + 1;
  let len = buf[pos++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('unsupported DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]!;
  }
  if (pos + len > buf.length) throw new Error('truncated DER');
  return { tag, start, vStart: pos, end: pos + len, buf };
}

function kids(node: Der): Der[] {
  const out: Der[] = [];
  for (let pos = node.vStart; pos < node.end;) {
    const child = der(node.buf, pos);
    out.push(child);
    pos = child.end;
  }
  return out;
}

const value = (n: Der): Uint8Array => n.buf.subarray(n.vStart, n.end);
const whole = (n: Der): Uint8Array => n.buf.subarray(n.start, n.end);

function oid(n: Der): string {
  const b = value(n);
  const parts = [Math.floor(b[0]! / 40), b[0]! % 40];
  let acc = 0;
  for (const byte of b.subarray(1)) {
    acc = acc * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

function derTime(n: Der): number {
  const s = dec.decode(value(n));
  const full = n.tag === 0x17 ? `${Number(s.slice(0, 2)) < 50 ? '20' : '19'}${s}` : s;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(full);
  if (!m) throw new Error('unsupported certificate time');
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  ecPublicKey: '1.2.840.10045.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ed25519: '1.3.101.112',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  fulcioIssuer: '1.3.6.1.4.1.57264.1.1',
  fulcioIssuerV2: '1.3.6.1.4.1.57264.1.8',
} as const;

const DIGESTS: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const SIG_ALGS: Record<string, { kind: 'ec' | 'rsa'; hash: string }> = {
  '1.2.840.10045.4.3.2': { kind: 'ec', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { kind: 'ec', hash: 'SHA-384' },
  '1.2.840.113549.1.1.11': { kind: 'rsa', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { kind: 'rsa', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { kind: 'rsa', hash: 'SHA-512' },
};
const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
};

interface Cert {
  raw: Uint8Array;
  tbs: Uint8Array;
  sigAlg: string;
  sig: Uint8Array;
  serial: string;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  keyAlg: string;
  curve: string | null;
  exts: Map<string, Uint8Array>;
}

function parseCert(node: Der): Cert {
  const [tbsNode, algNode, sigNode] = kids(node);
  const tbs = kids(tbsNode!);
  let i = tbs[0]!.tag === 0xa0 ? 1 : 0; // explicit version
  const serial = tbs[i++]!;
  i++; // signature algorithm (repeated outside)
  const issuer = tbs[i++]!;
  const [notBefore, notAfter] = kids(tbs[i++]!);
  const subject = tbs[i++]!;
  const spki = tbs[i++]!;
  const [keyAlgNode] = kids(spki);
  const keyAlg = kids(keyAlgNode!);
  const exts = new Map<string, Uint8Array>();
  for (const n of tbs.slice(i)) {
    if (n.tag !== 0xa3) continue;
    for (const ext of kids(kids(n)[0]!)) {
      const parts = kids(ext);
      exts.set(oid(parts[0]!), value(parts[parts.length - 1]!));
    }
  }
  return {
    raw: whole(node),
    tbs: whole(tbsNode!),
    sigAlg: oid(kids(algNode!)[0]!),
    sig: value(sigNode!).subarray(1), // BIT STRING: drop the unused-bits byte
    serial: hex(value(serial)),
    issuer: whole(issuer),
    subject: whole(subject),
    notBefore: derTime(notBefore!),
    notAfter: derTime(notAfter!),
    spki: whole(spki),
    keyAlg: oid(keyAlg[0]!),
    curve: keyAlg[1]?.tag === 0x06 ? oid(keyAlg[1]) : null,
    exts,
  };
}

/** ECDSA-Sig-Value (SEQUENCE of r, s) → raw r‖s. */
function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array {
  const [r, s] = kids(der(sig));
  return concat(fixed(value(r!), size), fixed(value(s!), size));
}

async function certVerify(
  cert: Cert,
  alg: { kind: 'ec' | 'rsa'; hash: string } | 'ed25519',
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (alg === 'ed25519' || cert.keyAlg === OID.ed25519) {
      if (alg !== 'ed25519' || cert.keyAlg !== OID.ed25519) return false;
      const k = await crypto.subtle.importKey('spki', cert.spki, 'Ed25519', false, [
        'verify',
      ]);
      return crypto.subtle.verify('Ed25519', k, sig, data);
    }
    if (alg.kind === 'ec' && cert.keyAlg === OID.ecPublicKey) {
      const curve = CURVES[cert.curve ?? ''];
      if (!curve) return false;
      const k = await crypto.subtle.importKey(
        'spki',
        cert.spki,
        { name: 'ECDSA', namedCurve: curve.name },
        false,
        ['verify'],
      );
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: alg.hash },
        k,
        ecdsaRaw(sig, curve.size),
        data,
      );
    }
    if (alg.kind === 'rsa' && cert.keyAlg === OID.rsaEncryption) {
      const params = { name: 'RSASSA-PKCS1-v1_5', hash: alg.hash };
      const k = await crypto.subtle.importKey('spki', cert.spki, params, false, [
        'verify',
      ]);
      return crypto.subtle.verify(params, k, sig, data);
    }
  } catch {
    return false;
  }
  return false;
}

function certAlg(
  sigAlg: string,
): { kind: 'ec' | 'rsa'; hash: string } | 'ed25519' | null {
  if (sigAlg === OID.ed25519) return 'ed25519';
  return SIG_ALGS[sigAlg] ?? null;
}

function isCa(cert: Cert): boolean {
  const bc = cert.exts.get(OID.basicConstraints);
  if (!bc) return false;
  const first = kids(der(bc))[0];
  return first?.tag === 0x01 && value(first)[0] !== 0;
}

/** PEM certificates in a bundle. */
export function pemCertificates(bundle: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (const m of bundle.matchAll(re)) out.push(b64urlDecode(m[1]!.replace(/\s+/g, '')));
  return out;
}

interface X509Signer {
  email: string | null;
  uri: string | null;
  issuer: string | null;
  serial: string;
}

async function verifyX509(
  env: Env,
  gpgsig: string,
  payload: Uint8Array,
  fallbackTime: number,
): Promise<{ signer: X509Signer | null; reason: string | null }> {
  const bytes = armored(gpgsig, 'SIGNED MESSAGE');
  if (!bytes) return { signer: null, reason: 'malformed x509 signature' };
  const info = kids(der(bytes));
  if (oid(info[0]!) !== OID.signedData)
    return { signer: null, reason: 'not CMS signed data' };
  const signed = kids(kids(info[1]!)[0]!);
  const certSet = signed.find((n) => n.tag === 0xa0);
  const certs = (certSet ? kids(certSet) : []).map(parseCert);
  const signerInfo = kids(signed[signed.length - 1]!)[0];
  if (!signerInfo) return { signer: null, reason: 'no signer in the signature' };
  const si = kids(signerInfo);
  const sid = si[1]!;
  if (sid.tag !== 0x30) return { signer: null, reason: 'unsupported signer identifier' };
  const [sidIssuer, sidSerial] = kids(sid);
  const leaf = certs.find(
    (c) => equal(c.issuer, whole(sidIssuer!)) && c.serial === hex(value(sidSerial!)),
  );
  if (!leaf) return { signer: null, reason: 'signing certificate not included' };
  const digestAlg = DIGESTS[oid(kids(si[2]!)[0]!)];
  const attrsNode = si[3]!;
  if (!digestAlg || attrsNode.tag !== 0xa0)
    return { signer: null, reason: 'unsupported CMS signer info' };
  let messageDigest: Uint8Array | null = null;
  let at = fallbackTime;
  for (const attr of kids(attrsNode)) {
    const [type, values] = kids(attr);
    const first = kids(values!)[0]!;
    if (oid(type!) === OID.messageDigest) messageDigest = value(first);
    if (oid(type!) === OID.signingTime) at = derTime(first);
  }
  if (!messageDigest || !equal(messageDigest, await digest(digestAlg, payload)))
    return { signer: null, reason: 'the signature does not cover this commit' };
  const sigAlgOid = oid(kids(si[4]!)[0]!);
  const sigAlg =
    sigAlgOid === OID.ecPublicKey
      ? { kind: 'ec' as const, hash: digestAlg }
      : sigAlgOid === OID.rsaEncryption
        ? { kind: 'rsa' as const, hash: digestAlg }
        : certAlg(sigAlgOid);
  const attrs = whole(attrsNode).slice();
  attrs[0] = 0x31; // signed over as a SET
  if (!sigAlg || !(await certVerify(leaf, sigAlg, value(si[5]!), attrs)))
    return { signer: null, reason: 'bad signature' };

  // chain to a configured root, every certificate valid at signing time
  const roots = pemCertificates(env.SIGSTORE_TRUST_ROOTS ?? '').map((r) =>
    parseCert(der(r)),
  );
  if (roots.length === 0)
    return { signer: null, reason: 'no x509 trust roots are configured' };
  const eku = leaf.exts.get(OID.extKeyUsage);
  if (!eku || !kids(der(eku)).some((n) => oid(n) === OID.codeSigning))
    return { signer: null, reason: 'certificate is not for code signing' };
  let current = leaf;
  for (let depth = 0; ; depth++) {
    if (at < current.notBefore || at > current.notAfter)
      return { signer: null, reason: 'certificate was not valid at signing time' };
    if (roots.some((r) => equal(r.raw, current.raw))) break;
    if (depth >= 5) return { signer: null, reason: 'certificate chain too long' };
    const candidates = [...roots, ...certs].filter((c) =>
      equal(c.subject, current.issuer),
    );
    let parent: Cert | null = null;
    for (const c of candidates) {
      const alg = certAlg(current.sigAlg);
      if (isCa(c) && alg && (await certVerify(c, alg, current.sig, current.tbs))) {
        parent = c;
        break;
      }
    }
    if (!parent)
      return { signer: null, reason: 'certificate does not chain to a trusted root' };
    current = parent;
  }

  const signer: X509Signer = {
    email: null,
    uri: null,
    issuer: null,
    serial: leaf.serial,
  };
  const san = leaf.exts.get(OID.subjectAltName);
  for (const name of san ? kids(der(san)) : []) {
    if (name.tag === 0x81) signer.email ??= dec.decode(value(name));
    if (name.tag === 0x86) signer.uri ??= dec.decode(value(name));
  }
  const v2 = leaf.exts.get(OID.fulcioIssuerV2);
  const v1 = leaf.exts.get(OID.fulcioIssuer);
  signer.issuer = v2 ? dec.decode(value(der(v2))) : v1 ? dec.decode(v1) : null;
  return { signer, reason: null };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function ownsEmail(env: Env, userId: string, email: string): Promise<boolean> {
  const wanted = email.toLowerCase();
  const user = await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
    userId,
  ]);
  if (user && `${user.login}@${USER_EMAIL_DOMAIN}`.toLowerCase() === wanted) return true;
  const rows = await q<{ email: string | null }>(
    env,
    'SELECT email FROM user_identities WHERE user_id = ?',
    [userId],
  );
  return rows.some((r) => r.email?.toLowerCase() === wanted);
}

interface KeyRow {
  user_id: string;
  fingerprint: string;
  public_key: string;
}

export interface CommitToCheck {
  gpgsig: string | undefined;
  /** The signed bytes (`signedPayload` of the commit body). */
  payload: Uint8Array;
  committerEmail: string;
  /** Committer time in ms, the signing time when a signature carries none. */
  committedAt: number;
}

export async function checkCommitSignature(
  env: Env,
  commit: CommitToCheck,
): Promise<SignatureCheck> {
  const none = { key_id: null, signer: null, user_id: null };
  if (!commit.gpgsig) return { status: 'unsigned', format: null, ...none, reason: null };
  const format = signatureFormat(commit.gpgsig);
  const fail = (reason: string, extra: Partial<SignatureCheck> = {}): SignatureCheck => ({
    status: 'unverified',
    format,
    ...none,
    reason,
    ...extra,
  });
  if (!format) return fail('unknown signature format');
  try {
    let key: KeyRow | null = null;
    let ok = false;
    let keyId: string;
    if (format === 'x509') {
      const { signer, reason } = await verifyX509(
        env,
        commit.gpgsig,
        commit.payload,
        commit.committedAt,
      );
      if (!signer) return fail(reason ?? 'bad signature');
      const identity = signer.email ?? signer.uri;
      const user = signer.email
        ? await q1<{ user_id: string }>(
            env,
            'SELECT user_id FROM user_identities WHERE email = ? COLLATE NOCASE LIMIT 1',
            [signer.email],
          )
        : null;
      const extra = {
        key_id: signer.serial,
        signer: signer.issuer ? `${identity} (${signer.issuer})` : identity,
        user_id: user?.user_id ?? null,
      };
      if (signer.email?.toLowerCase() !== commit.committerEmail.toLowerCase())
        return fail('the committer email is not the certificate email', extra);
      return { status: 'verified', format, ...extra, reason: null };
    }
    if (format === 'ssh') {
      const sig = await parseSshSig(commit.gpgsig);
      keyId = sig.fingerprint;
      key = await q1<KeyRow>(
        env,
        "SELECT user_id, fingerprint, public_key FROM user_signing_keys WHERE kind = 'ssh' AND fingerprint = ?",
        [keyId],
      );
      if (key) {
        const { blob } = parseSshPublicKey(key.public_key);
        ok = equal(blob, sig.publicKey) && (await sig.verify(commit.payload, blob));
      }
    } else {
      const sig = parsePgpSig(commit.gpgsig);
      keyId = sig.issuers[0] ?? '';
      for (const issuer of sig.issuers) {
        const rows = await q<KeyRow>(
          env,
          `SELECT user_id, fingerprint, public_key FROM user_signing_keys
            WHERE kind = 'gpg' AND (' ' || key_ids || ' ') LIKE ?`,
          [`% ${issuer.slice(-16)} %`],
        );
        for (const row of rows) {
          for (const k of await parsePgpPublicKey(row.public_key)) {
            if (!issuer.endsWith(k.keyId) || !(await sig.verify(commit.payload, k)))
              continue;
            key = row;
            keyId = k.fingerprint;
            ok = true;
          }
          if (ok) break;
        }
        if (ok) break;
      }
    }
    if (!key) return fail('no registered key matches the signature', { key_id: keyId });
    const extra = { key_id: keyId, user_id: key.user_id, signer: commit.committerEmail };
    if (!ok) return fail('bad signature', extra);
    if (!(await ownsEmail(env, key.user_id, commit.committerEmail)))
      return fail("the committer email is not a verified address of the key's owner", {
        ...extra,
        signer: null,
      });
    return { status: 'verified', format, ...extra, reason: null };
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'malformed signature');
  }
}

/** Keep the checks of pushed commits; a changeset keeps its first check. */
export async function recordSignatures(
  env: Env,
  repoId: string,
  checks: { csId: string; check: SignatureCheck }[],
): Promise<void> {
  if (checks.length === 0) return;
  const now = Date.now();
  await env.DB.batch(
    checks.map(({ csId, check }) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO commit_signatures
           (repo_id, cs_id, status, format, key_id, signer, user_id, reason, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        repoId,
        csId,
        check.status,
        check.format,
        check.key_id,
        check.signer,
        check.user_id,
        check.reason,
        now,
      ),
    ),
  );
}

export async function signatureOf(
  env: Env,
  repoId: string,
  csId: string,
): Promise<SignatureView | null> {
  return q1<SignatureView>(
    env,
    `SELECT s.status, s.format, s.key_id, s.signer, s.user_id, s.reason,
            u.login AS user_login
       FROM commit_signatures s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.repo_id = ? AND s.cs_id = ?`,
    [repoId, csId],
  );
}

/**
 * The `required_signatures` facts for moving a ref to `to`: pushed commits
 * in `base..to` without a verified signature (just `to` without a base).
 */
export async function signatureFacts(
  env: Env,
  repoId: string,
  base: string | null,
  to: string,
): Promise<{ unverified: string[]; truncated: boolean }> {
  let ids = [to];
  if (base !== null && base !== to) {
    try {
      ids = (await dagMergeBases(env, repoId, base, to, 2_000)).onlyB.map((cs) => cs.id);
    } catch {
      return { unverified: [], truncated: true };
    }
  }
  return { unverified: await unverifiedPushed(env, repoId, ids), truncated: false };
}

/**
 * Of `csIds`, the ones pushed without a verified signature to any repo of
 * `repoId`'s fork network (`<root>` and `<root>~<ulid>`): a fork pull request
 * brings in commits pushed to the fork only.
 */
export async function unverifiedPushed(
  env: Env,
  repoId: string,
  csIds: readonly string[],
): Promise<string[]> {
  const root = storageId(repoId);
  const out: string[] = [];
  for (let i = 0; i < csIds.length; i += 90) {
    const slice = csIds.slice(i, i + 90);
    const rows = await q<{ cs_id: string }>(
      env,
      `SELECT DISTINCT cs_id FROM commit_signatures
        WHERE (repo_id = ? OR (repo_id > ? AND repo_id < ?)) AND status != 'verified'
          AND cs_id IN (${slice.map(() => '?').join(',')})`,
      [root, `${root}~`, `${root}\x7f`, ...slice],
    );
    out.push(...rows.map((r) => r.cs_id));
  }
  return out;
}
