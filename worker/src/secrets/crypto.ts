import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { ApiError } from '../core/errors';
import { b64urlDecode, b64urlEncode } from '../auth/encoding';

/**
 * Envelope encryption for CI secrets (issue #50).
 *
 *   SECRETS_KEK (Worker secret) ──wraps──▶ data key per owner ──encrypts──▶ secret values
 *
 * The key-encryption key never touches D1. Each owner (`org:<id>` or
 * `user:<login>`) gets a random AES-256-GCM data key, stored wrapped in
 * `secret_data_keys` with the id of the KEK that wrapped it. Rotating the KEK
 * re-wraps those rows only (`rewrapDataKeys`); secret ciphertexts never change,
 * so rotation has no downtime as long as the old KEK stays configured until
 * every row reports the new id.
 *
 * SECRETS_KEK is either one base64 key (id `v1`) or a key ring:
 *   {"current":"v2","keys":{"v1":"<base64 32 bytes>","v2":"<base64 32 bytes>"}}
 */
interface Kek {
  current: string;
  keys: Map<string, CryptoKey>;
}

const ringSchema = z.object({
  current: z.string().min(1).max(32),
  keys: z.record(z.string().min(1).max(32), z.string().min(1)),
});

function decodeKey(text: string): Uint8Array {
  const bytes = b64urlDecode(text.trim().replace(/=+$/, ''));
  if (bytes.length !== 32) throw new Error('SECRETS_KEK keys must be 32 bytes');
  return bytes;
}

function notConfigured(): ApiError {
  return new ApiError(
    503,
    'secrets_not_configured',
    'Secret storage is not configured. An operator must set SECRETS_KEK.',
  );
}

async function loadKek(env: Env): Promise<Kek> {
  const raw = env.SECRETS_KEK?.trim();
  if (!raw) throw notConfigured();
  let entries: [string, string][];
  let current: string;
  try {
    if (raw.startsWith('{')) {
      const ring = ringSchema.parse(JSON.parse(raw));
      entries = Object.entries(ring.keys);
      current = ring.current;
    } else {
      entries = [['v1', raw]];
      current = 'v1';
    }
    const keys = new Map<string, CryptoKey>();
    for (const [id, text] of entries) {
      keys.set(
        id,
        await crypto.subtle.importKey(
          'raw',
          decodeKey(text) as BufferSource,
          'AES-GCM',
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    }
    if (!keys.has(current)) throw new Error('current KEK missing');
    return { current, keys };
  } catch {
    // never echo the malformed value
    throw notConfigured();
  }
}

async function seal(key: CryptoKey, aad: string, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    plain as BufferSource,
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

async function open(key: CryptoKey, aad: string, sealed: string): Promise<Uint8Array> {
  const [iv = '', ct = ''] = sealed.split('.');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64urlDecode(iv) as BufferSource,
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      b64urlDecode(ct) as BufferSource,
    ),
  );
}

interface DataKeyRow {
  owner: string;
  version: number;
  kek_id: string;
  wrapped: string;
}

async function unwrap(kek: Kek, row: DataKeyRow): Promise<CryptoKey> {
  const wrapping = kek.keys.get(row.kek_id);
  if (!wrapping) throw notConfigured();
  const raw = await open(wrapping, `dek|${row.owner}|${row.version}`, row.wrapped);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The owner's newest data key, created on first use. */
async function currentDataKey(
  env: Env,
  kek: Kek,
  owner: string,
): Promise<{ version: number; key: CryptoKey }> {
  const select = (): Promise<DataKeyRow | null> =>
    q1<DataKeyRow>(
      env,
      'SELECT * FROM secret_data_keys WHERE owner = ? ORDER BY version DESC LIMIT 1',
      [owner],
    );
  let row = await select();
  if (!row) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await seal(kek.keys.get(kek.current)!, `dek|${owner}|1`, raw);
    // concurrent first writes: one insert wins, both use the stored key
    await run(
      env,
      'INSERT OR IGNORE INTO secret_data_keys (owner, version, kek_id, wrapped, created_at) VALUES (?, 1, ?, ?, ?)',
      [owner, kek.current, wrapped, Date.now()],
    );
    row = await select();
  }
  if (!row) throw new Error('data key unavailable');
  return { version: row.version, key: await unwrap(kek, row) };
}

/** Encrypt a value for `owner`. `aad` binds the ciphertext to its row. */
export async function encryptSecret(
  env: Env,
  owner: string,
  aad: string,
  value: string,
): Promise<{ ciphertext: string; keyVersion: number }> {
  const kek = await loadKek(env);
  const dek = await currentDataKey(env, kek, owner);
  return {
    ciphertext: await seal(dek.key, aad, new TextEncoder().encode(value)),
    keyVersion: dek.version,
  };
}

/** Decrypt many values for one owner, unwrapping each data key once. */
export async function decryptSecrets(
  env: Env,
  items: { owner: string; keyVersion: number; aad: string; ciphertext: string }[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const kek = await loadKek(env);
  const keys = new Map<string, Promise<CryptoKey>>();
  const keyFor = (owner: string, version: number): Promise<CryptoKey> => {
    const id = `${owner}|${version}`;
    let key = keys.get(id);
    if (!key) {
      key = q1<DataKeyRow>(
        env,
        'SELECT * FROM secret_data_keys WHERE owner = ? AND version = ?',
        [owner, version],
      ).then((row) => {
        if (!row) throw new Error('data key missing');
        return unwrap(kek, row);
      });
      keys.set(id, key);
    }
    return key;
  };
  return Promise.all(
    items.map(async (item) =>
      new TextDecoder().decode(
        await open(await keyFor(item.owner, item.keyVersion), item.aad, item.ciphertext),
      ),
    ),
  );
}

/**
 * KEK rotation: re-wrap up to `limit` data keys not yet under the current
 * KEK. Run until `remaining` is 0, then drop the old KEK from SECRETS_KEK.
 */
export async function rewrapDataKeys(
  env: Env,
  limit = 100,
): Promise<{ current: string; rewrapped: number; remaining: number }> {
  const kek = await loadKek(env);
  const rows = await q<DataKeyRow>(
    env,
    'SELECT * FROM secret_data_keys WHERE kek_id != ? LIMIT ?',
    [kek.current, limit],
  );
  let rewrapped = 0;
  for (const row of rows) {
    const old = kek.keys.get(row.kek_id);
    if (!old) continue; // unrecoverable without its KEK; reported as remaining
    const aad = `dek|${row.owner}|${row.version}`;
    const raw = await open(old, aad, row.wrapped);
    const wrapped = await seal(kek.keys.get(kek.current)!, aad, raw);
    const result = await env.DB.prepare(
      'UPDATE secret_data_keys SET kek_id = ?, wrapped = ?, rewrapped_at = ? WHERE owner = ? AND version = ? AND kek_id = ?',
    )
      .bind(kek.current, wrapped, Date.now(), row.owner, row.version, row.kek_id)
      .run();
    rewrapped += result.meta.changes;
  }
  const left = await q1<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM secret_data_keys WHERE kek_id != ?',
    [kek.current],
  );
  return { current: kek.current, rewrapped, remaining: left?.n ?? 0 };
}
