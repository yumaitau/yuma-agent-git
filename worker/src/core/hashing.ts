/**
 * Hashing + canonical serialization.
 *
 * The content address of every object is the SHA-256 of its **uncompressed**
 * bytes (architecture §1.1), so clients verify after decompress and any cache
 * tier can answer reads.
 */

export type Sha256Input = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** Hex SHA-256 of raw bytes or a byte stream (WebCrypto). */
export async function sha256Hex(data: Sha256Input): Promise<string> {
  const bytes = await toBytes(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function toBytes(data: Sha256Input): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Streaming input: WebCrypto has no incremental digest, so accumulate chunks.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, numbers
 * as-is, arrays in order. Identical values serialize identically on every
 * isolate — safe to hash (trees, changesets).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite number');
      }
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined) continue; // match JSON.stringify semantics
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}
