/**
 * zlib inflate (RFC 1950 and 1951) that reports where the stream ended. A
 * pack stores objects as back-to-back zlib streams with no lengths, so the
 * reader must know how much input each one used; `DecompressionStream` cannot
 * say. The caller passes the inflated size from the pack header, which bounds
 * the output buffer and every loop.
 */

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InflateError';
  }
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99,
  115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025,
  1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12,
  12, 13, 13,
];
/** Order of code-length code lengths in a dynamic block header. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Lookup table indexed by the next `bits` input bits: `symbol << 4 | length`. */
interface Huffman {
  table: Int32Array;
  bits: number;
}

function huffman(lengths: Uint8Array): Huffman {
  const count = new Int32Array(16);
  let bits = 0;
  for (const len of lengths) {
    count[len] = (count[len] as number) + 1;
    if (len > bits) bits = len;
  }
  count[0] = 0;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - (count[len] as number);
    if (left < 0) throw new InflateError('over-subscribed huffman code');
  }
  const next = new Int32Array(16);
  for (let len = 1, code = 0; len <= 15; len++) {
    code = (code + (count[len - 1] as number)) << 1;
    next[len] = code;
  }
  const size = 1 << bits;
  const table = new Int32Array(size);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym] as number;
    if (len === 0) continue;
    const code = next[len] as number;
    next[len] = code + 1;
    let rev = 0;
    for (let i = 0; i < len; i++) rev |= ((code >> i) & 1) << (len - 1 - i);
    for (let i = rev; i < size; i += 1 << len) table[i] = (sym << 4) | len;
  }
  return { table, bits };
}

let fixedCodes: [Huffman, Huffman] | null = null;

function fixed(): [Huffman, Huffman] {
  if (fixedCodes === null) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    fixedCodes = [huffman(lit), huffman(new Uint8Array(30).fill(5))];
  }
  return fixedCodes;
}

class Bits {
  private buf = 0;
  private cnt = 0;

  constructor(
    private readonly data: Uint8Array,
    public pos: number,
  ) {}

  /** Peeks may run a few bytes past the end; `finish` rejects a real overrun. */
  private need(n: number): void {
    while (this.cnt < n) {
      if (this.pos >= this.data.length + 4) throw new InflateError('truncated stream');
      this.buf |= (this.data[this.pos] ?? 0) << this.cnt;
      this.pos++;
      this.cnt += 8;
    }
  }

  bits(n: number): number {
    this.need(n);
    const value = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return value;
  }

  decode(h: Huffman): number {
    this.need(h.bits);
    const entry = h.table[this.buf & ((1 << h.bits) - 1)] as number;
    const len = entry & 15;
    if (len === 0) throw new InflateError('invalid huffman code');
    this.buf >>>= len;
    this.cnt -= len;
    return entry >> 4;
  }

  /** Drop to a byte boundary and give back whole bytes still buffered. */
  align(): void {
    this.pos -= this.cnt >> 3;
    this.buf = 0;
    this.cnt = 0;
    if (this.pos > this.data.length) throw new InflateError('truncated stream');
  }
}

function dynamic(r: Bits): [Huffman, Huffman] {
  const nlit = r.bits(5) + 257;
  const ndist = r.bits(5) + 1;
  const ncl = r.bits(4) + 4;
  if (nlit > 286 || ndist > 30) throw new InflateError('bad dynamic block counts');
  const cl = new Uint8Array(19);
  for (let i = 0; i < ncl; i++) cl[CL_ORDER[i] as number] = r.bits(3);
  const clCode = huffman(cl);
  const lengths = new Uint8Array(nlit + ndist);
  for (let i = 0; i < lengths.length;) {
    const sym = r.decode(clCode);
    if (sym < 16) {
      lengths[i++] = sym;
      continue;
    }
    let value = 0;
    let repeat: number;
    if (sym === 16) {
      if (i === 0) throw new InflateError('repeat with no previous length');
      value = lengths[i - 1] as number;
      repeat = 3 + r.bits(2);
    } else if (sym === 17) repeat = 3 + r.bits(3);
    else repeat = 11 + r.bits(7);
    if (i + repeat > lengths.length) throw new InflateError('too many code lengths');
    lengths.fill(value, i, i + repeat);
    i += repeat;
  }
  if (lengths[256] === 0) throw new InflateError('no end-of-block code');
  return [huffman(lengths.subarray(0, nlit)), huffman(lengths.subarray(nlit))];
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream at `input[start]`, which must expand to exactly
 * `size` bytes. Returns the data and the offset just past the stream.
 */
export function inflate(
  input: Uint8Array,
  start: number,
  size: number,
): { data: Uint8Array; end: number } {
  const cmf = input[start];
  const flg = input[start + 1];
  if (cmf === undefined || flg === undefined) throw new InflateError('truncated stream');
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) {
    throw new InflateError('bad zlib header');
  }
  const out = new Uint8Array(size);
  let o = 0;
  const r = new Bits(input, start + 2);
  let final = 0;
  while (!final) {
    final = r.bits(1);
    const type = r.bits(2);
    if (type === 0) {
      r.align();
      const p = r.pos;
      if (p + 4 > input.length) throw new InflateError('truncated stream');
      const len = (input[p] as number) | ((input[p + 1] as number) << 8);
      const nlen = (input[p + 2] as number) | ((input[p + 3] as number) << 8);
      if (len !== (~nlen & 0xffff))
        throw new InflateError('stored block length mismatch');
      if (p + 4 + len > input.length) throw new InflateError('truncated stream');
      if (o + len > size) throw new InflateError('stream longer than declared size');
      out.set(input.subarray(p + 4, p + 4 + len), o);
      o += len;
      r.pos = p + 4 + len;
    } else if (type === 1 || type === 2) {
      const [lit, dist] = type === 1 ? fixed() : dynamic(r);
      for (;;) {
        const sym = r.decode(lit);
        if (sym < 256) {
          if (o >= size) throw new InflateError('stream longer than declared size');
          out[o++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new InflateError('invalid length symbol');
          const len = (LEN_BASE[li] as number) + r.bits(LEN_EXTRA[li] as number);
          const ds = r.decode(dist);
          if (ds >= 30) throw new InflateError('invalid distance symbol');
          const d = (DIST_BASE[ds] as number) + r.bits(DIST_EXTRA[ds] as number);
          if (d > o) throw new InflateError('distance before start of output');
          if (o + len > size) throw new InflateError('stream longer than declared size');
          for (let i = 0; i < len; i++, o++) out[o] = out[o - d] as number;
        }
      }
    } else {
      throw new InflateError('invalid block type');
    }
  }
  r.align();
  if (o !== size) throw new InflateError('stream shorter than declared size');
  const p = r.pos;
  if (p + 4 > input.length) throw new InflateError('truncated stream');
  const expected =
    (((input[p] as number) << 24) |
      ((input[p + 1] as number) << 16) |
      ((input[p + 2] as number) << 8) |
      (input[p + 3] as number)) >>>
    0;
  if (expected !== adler32(out)) throw new InflateError('adler-32 mismatch');
  return { data: out, end: p + 4 };
}
