/**
 * pkt-line framing (issue #31). Each line is four hex digits giving the
 * length including those four, then the payload. `0000` is a flush, `0001` a
 * delimiter and `0002` a response end (protocol v2). `0003` and anything over
 * 65520 are invalid. Parsing is strict: a malformed or truncated line throws
 * `PktLineError`, it never guesses.
 */

export const MAX_PKT_LEN = 65520;
/** Largest payload of one data line. */
export const MAX_PKT_DATA = MAX_PKT_LEN - 4;
/** Largest sideband payload (one byte goes to the band number). */
export const MAX_SIDEBAND_DATA = MAX_PKT_DATA - 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH = encoder.encode('0000');
export const DELIM = encoder.encode('0001');

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

export type Pkt =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** One data line. Strings are UTF-8 encoded as given (callers add `\n`). */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const data = typeof payload === 'string' ? encoder.encode(payload) : payload;
  if (data.length > MAX_PKT_DATA) {
    throw new PktLineError(`pkt-line payload of ${data.length} bytes is too long`);
  }
  const out = new Uint8Array(data.length + 4);
  out.set(encoder.encode((data.length + 4).toString(16).padStart(4, '0')));
  out.set(data, 4);
  return out;
}

/** Sideband lines for `data` on `band` (1 pack data, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, data: string | Uint8Array): Uint8Array[] {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += MAX_SIDEBAND_DATA) {
    const chunk = bytes.subarray(i, i + MAX_SIDEBAND_DATA);
    const payload = new Uint8Array(chunk.length + 1);
    payload[0] = band;
    payload.set(chunk, 1);
    out.push(pktLine(payload));
  }
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Sequential reader over a buffer; `offset` is where the next line starts. */
export class PktReader {
  offset: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
  ) {
    this.offset = start;
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  /** The next line, or null at the end of the buffer. */
  next(): Pkt | null {
    if (this.done) return null;
    if (this.offset + 4 > this.buf.length) {
      throw new PktLineError('truncated pkt-line length');
    }
    const head = decoder.decode(this.buf.subarray(this.offset, this.offset + 4));
    if (!/^[0-9a-f]{4}$/.test(head)) {
      throw new PktLineError(`invalid pkt-line length ${JSON.stringify(head)}`);
    }
    const len = parseInt(head, 16);
    if (len === 0 || len === 1 || len === 2) {
      this.offset += 4;
      return { kind: len === 0 ? 'flush' : len === 1 ? 'delim' : 'end' };
    }
    if (len < 4 || len > MAX_PKT_LEN) {
      throw new PktLineError(`invalid pkt-line length ${len}`);
    }
    if (this.offset + len > this.buf.length) {
      throw new PktLineError('truncated pkt-line');
    }
    const data = this.buf.subarray(this.offset + 4, this.offset + len);
    this.offset += len;
    return { kind: 'data', data };
  }
}

export function pktText(data: Uint8Array): string {
  const text = decoder.decode(data);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** A protocol-level refusal, sent to the client as an `ERR` line. */
export class GitProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProtocolError';
  }
}
