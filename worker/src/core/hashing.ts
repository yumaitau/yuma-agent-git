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
    // Index-wise so sparse holes serialize as null (JSON semantics) instead of
    // producing invalid `[,]`. `-0` normalizes to `0` (JSON semantics — document,
    // do not rely on distinguishing them in hashed payloads).
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(canonicalJson(value[i]));
    }
    return `[${parts.join(',')}]`;
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

// ---------------------------------------------------------------------------
// Incremental SHA-256
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Streaming SHA-256 (FIPS 180-4), pure TS. WebCrypto has no incremental
 * digest in Workers, but `?format=raw` must both stream AND verify content
 * addresses on every read path — so we hash as the bytes flow past and abort
 * the stream on mismatch.
 */
export class IncrementalSha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private byteLen = 0;

  update(data: Uint8Array): void {
    this.byteLen += data.length;
    let offset = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.compress(this.h, this.block, 0);
        this.blockLen = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(this.h, data, offset);
      offset += 64;
    }
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLen = data.length - offset;
    }
  }

  /** Finalize without mutating state (safe to call more than once). */
  digestHex(): string {
    const h = this.h.slice();
    const padLen = this.blockLen < 56 ? 64 : 128;
    const pad = new Uint8Array(padLen);
    pad.set(this.block.subarray(0, this.blockLen));
    pad[this.blockLen] = 0x80;
    const view = new DataView(pad.buffer);
    const bits = this.byteLen * 8;
    view.setUint32(padLen - 8, Math.floor(bits / 0x20000000), false);
    view.setUint32(padLen - 4, bits >>> 0, false);
    for (let i = 0; i < padLen; i += 64) this.compress(h, pad, i);
    return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  private compress(h: Uint32Array, block: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] =
        ((block[o] as number) << 24) |
        ((block[o + 1] as number) << 16) |
        ((block[o + 2] as number) << 8) |
        (block[o + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0) >>> 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
}
