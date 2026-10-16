#!/usr/bin/env node
/**
 * Generate and rotate CI key material (issue #50) without printing it.
 * Every command writes a new file (mode 0600, never overwriting) and prints
 * only key ids. Pipe the file into a Worker secret, then delete it:
 *
 *   wrangler secret put CI_OIDC_SIGNING_KEYS --env prod < ci-oidc-keys.json
 *
 * OIDC signing keys (JWK set; the first key signs, all are published):
 *   oidc-new     --out FILE                  first key
 *   oidc-stage   --current FILE --out FILE   publish a new key, old key still signs
 *   oidc-promote --current FILE --out FILE   new key signs; old key kept public-only
 *   oidc-retire  --current FILE --out FILE   drop every key but the signer
 *
 * Secrets key-encryption key (SECRETS_KEK):
 *   kek --out FILE [--previous FILE --id v2]  new key, or a key ring that keeps
 *                                             the previous key for re-wrapping
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    current: { type: 'string' },
    previous: { type: 'string' },
    id: { type: 'string' },
  },
});
const command = positionals[0];

function fail(message) {
  console.error(message);
  process.exit(1);
}
if (!values.out) fail('--out FILE is required (see the header of this script).');

function write(content) {
  // wx: refuse to overwrite; 0600: readable by the operator only
  try {
    writeFileSync(values.out, content, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    fail(err.code === 'EEXIST' ? `${values.out} already exists.` : String(err.message));
  }
}

function readSet(path) {
  if (!path) fail('--current FILE is required.');
  const set = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(set.keys) || set.keys.length === 0) fail(`${path} has no keys.`);
  return set.keys;
}

function newSigningKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  // RFC 7638 thumbprint as the key id
  const thumbprint = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const kid = createHash('sha256').update(thumbprint).digest('base64url').slice(0, 16);
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

const publicOnly = ({ kty, kid, n, e, alg, use }) => ({ kty, kid, n, e, alg, use });

function writeKek() {
  const key = randomBytes(32).toString('base64');
  if (!values.previous) {
    write(key);
    console.log(`Wrote a new SECRETS_KEK (id v1) to ${values.out}`);
    return;
  }
  const raw = readFileSync(values.previous, 'utf8').trim();
  const ring = raw.startsWith('{') ? JSON.parse(raw) : { keys: { v1: raw } };
  const id = values.id ?? `v${Object.keys(ring.keys).length + 1}`;
  if (ring.keys[id]) fail(`Key id ${id} already exists.`);
  write(JSON.stringify({ current: id, keys: { ...ring.keys, [id]: key } }));
  console.log(`Wrote a SECRETS_KEK ring to ${values.out}; current key id ${id}`);
}

let keys;
switch (command) {
  case 'oidc-new':
    keys = [newSigningKey()];
    break;
  case 'oidc-stage':
    keys = [...readSet(values.current), newSigningKey()];
    break;
  case 'oidc-promote': {
    const current = readSet(values.current);
    const next = current.at(-1);
    if (!next.d) fail('The last key has no private part; stage a new key first.');
    keys = [next, ...current.slice(0, -1).map(publicOnly)];
    break;
  }
  case 'oidc-retire':
    keys = readSet(values.current).slice(0, 1);
    break;
  case 'kek':
    writeKek();
    process.exit(0);
    break;
  default:
    fail('Unknown command (see the header of this script).');
}
write(JSON.stringify({ keys }));
console.log(
  `Wrote ${values.out}. Signing key: ${keys[0].kid}. Published: ${keys.map((k) => k.kid).join(', ')}`,
);
