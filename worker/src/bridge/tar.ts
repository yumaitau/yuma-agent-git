/**
 * Minimal streaming tar reader/writer (USTAR + PAX) — no dependencies
 * (issue #15/#16). Workers have no git binary: imports arrive as tarballs
 * from the GitHub API and exports leave as tarballs/fast-import streams, so
 * this module is the whole file-archive layer.
 *
 * Layout: 512-byte header blocks + padded data blocks.
 *  - name: bytes 0-100 (or PAX `path` / GNU `L` longname), `prefix` at 345
 *  - size: octal at 124, typeflag at 156, linkname at 157
 *  - typeflag: '0'/'\0' regular, '5' directory, '2' symlink, 'x' PAX extended
 *    header (applies to the NEXT entry), 'g' PAX global (skipped)
 */

export interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  mode: string;
  size: number;
  /** File contents or symlink target. */
  body: Uint8Array;
}

const BLOCK = 512;

class ByteReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    // one reader for the stream's lifetime — getReader() locks it
    this.reader = stream.getReader();
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.done = true;
      return false;
    }
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer, 0);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  /** Exactly `n` bytes, or null at clean EOF; throws on truncation. */
  async readExact(n: number): Promise<Uint8Array | null> {
    while (this.buffer.length < n) {
      if (!(await this.pull())) {
        if (this.buffer.length === 0) return null;
        throw new Error('tar: truncated archive');
      }
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async skip(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.readExact(Math.min(remaining, 65536));
      if (chunk === null) throw new Error('tar: truncated archive');
      remaining -= chunk.length;
    }
  }
}

function decodeField(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end)).trim();
}

function parseOctal(raw: string): number {
  const text = raw.replace(/[^0-7]/g, '');
  return text === '' ? 0 : parseInt(text, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((b) => b === 0);
}

/**
 * Stream-parse a tar archive (optionally gzip-wrapped). Yields entries in
 * archive order; regular-file bodies are materialized per entry (callers cap
 * their own sizes — GitHub tarballs are bounded per file).
 */
export async function* parseTar(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source);
  let paxOverrides: Record<string, string> = {};

  for (;;) {
    const block = await reader.readExact(BLOCK);
    if (block === null) return;
    if (isZeroBlock(block)) continue; // padding / terminator

    const size = parseOctal(decodeField(block, 124, 12));
    const typeflag = String.fromCharCode(block[156] as number);
    const rawName = decodeField(block, 0, 100);
    const prefix = decodeField(block, 345, 155);
    const linkname = decodeField(block, 157, 100);
    const name = paxOverrides.path ?? (prefix === '' ? rawName : `${prefix}/${rawName}`);
    const paxSize = paxOverrides.size ? Number(paxOverrides.size) : size;

    if (typeflag === 'g') {
      // global PAX header — informational, skip
      await reader.skip(Math.ceil(size / BLOCK) * BLOCK);
      continue;
    }
    if (typeflag === 'x' || typeflag === 'X') {
      const raw = await reader.readExact(Math.ceil(size / BLOCK) * BLOCK);
      if (raw === null) throw new Error('tar: truncated PAX header');
      paxOverrides = parsePax(raw.subarray(0, size));
      continue;
    }

    const padded = Math.ceil(paxSize / BLOCK) * BLOCK;
    const raw = padded > 0 ? await reader.readExact(padded) : new Uint8Array(0);
    if (raw === null) throw new Error('tar: truncated entry data');
    const body = raw.subarray(0, paxSize);
    const overrides = paxOverrides;
    paxOverrides = {};

    switch (typeflag) {
      case '0':
      case '\0':
      case '7':
        yield {
          name,
          type: 'file',
          mode: decodeField(block, 100, 8),
          size: paxSize,
          body,
        };
        break;
      case '5':
        // directory entries are implicit in a tree walk — skip entirely
        break;
      case '2':
        yield {
          name,
          type: 'symlink',
          mode: decodeField(block, 100, 8),
          size: linkname.length,
          body: new TextEncoder().encode(overrides.path ? linkname : linkname),
        };
        break;
      case 'L': {
        // GNU longname: the data block IS the name of the next entry
        const longName = new TextDecoder().decode(body).replace(/\0+$/, '');
        paxOverrides = { path: longName };
        break;
      }
      default:
        yield {
          name,
          type: 'other',
          mode: decodeField(block, 100, 8),
          size: paxSize,
          body,
        };
    }
  }
}

/**
 * One PAX record: `"LEN key=value\n"` where LEN covers its own digits plus the
 * separating space — self-consistent length is what makes the stream parseable.
 */
export function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  while (`${length} `.length + body.length !== length) {
    length = `${length} `.length + body.length;
  }
  return `${length} ${body}`;
}

/** PAX records: `"%d %s=%s\n"` — length includes the length field itself. */
function parsePax(raw: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(raw);
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0) break;
    const length = parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(offset, offset + length).trimEnd();
    const eq = record.indexOf('=');
    if (eq > space) {
      out[record.slice(space + 1, eq)] = record.slice(eq + 1);
    }
    offset += length;
  }
  return out;
}

/** Wrap a byte stream as gzip if needed (export-side). */
export async function gunzipIfNeeded(
  stream: ReadableStream<Uint8Array>,
  gzipWrapped: boolean,
): Promise<ReadableStream<Uint8Array>> {
  return gzipWrapped
    ? stream.pipeThrough(new DecompressionStream('gzip' as unknown as 'gzip'))
    : stream;
}

// ---------------------------------------------------------------------------
// Writer (used by export, issue #16)
// ---------------------------------------------------------------------------

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(
  name: string,
  size: number,
  typeflag: string,
  mode = 0o644,
  linkname = '',
  mtime = 0,
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const write = (text: string, offset: number, length: number): void => {
    block.set(enc.encode(text).subarray(0, length), offset);
  };
  write(name, 0, 100);
  write(octal(mode, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(Math.floor(mtime), 12), 136, 12);
  write('        ', 148, 8); // checksum placeholder
  block[156] = enc.encode(typeflag)[0] as number;
  write(linkname, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const b of block) sum += b;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

function pad(size: number): Uint8Array {
  const remainder = size % BLOCK;
  return remainder === 0 ? new Uint8Array(0) : new Uint8Array(BLOCK - remainder);
}

/**
 * Build one archive entry (PAX for names > 100 bytes). Deterministic byte
 * output for identical inputs.
 */
export function tarEntry(
  name: string,
  body: Uint8Array,
  opts: {
    type?: 'file' | 'symlink';
    mode?: number;
    paxSize?: number;
    /** Unix seconds — tarball export stamps the changeset's time. */
    mtime?: number;
  } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const usePax = name.length > 100;
  const effectiveName = usePax ? name.slice(0, 100) : name;
  const type = opts.type === 'symlink' ? '2' : '0';

  if (usePax) {
    const pax = new TextEncoder().encode(paxRecord('path', name));
    chunks.push(
      header('./PaxHeader.' + (Math.abs(hashName(name)) % 100000), pax.length, 'x'),
    );
    chunks.push(pax, pad(pax.length));
  }
  chunks.push(
    header(
      effectiveName,
      type === '2' ? 0 : (opts.paxSize ?? body.length),
      type,
      opts.mode ?? (type === '2' ? 0o777 : 0o644),
      type === '2' ? new TextDecoder().decode(body) : '',
      opts.mtime ?? 0,
    ),
  );
  if (type !== '2') {
    chunks.push(body, pad(body.length));
  }
  return concat(chunks);
}

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return h;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** End-of-archive marker: two zero blocks. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}
