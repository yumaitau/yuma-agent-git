import { describe, expect, it } from 'vitest';
import { gunzipIfNeeded, parseTar, paxRecord, tarEntry, tarEnd } from '../src/bridge/tar';
import { gzipSync } from 'node:zlib';

/**
 * Hand-rolled USTAR fixtures — deliberately independent of the module's own
 * writer so reader bugs cannot cancel out writer bugs.
 */
function ustarHeader(
  name: string,
  size: number,
  typeflag: string,
  linkname = '',
): Uint8Array {
  const block = new Uint8Array(512);
  const write = (text: string, offset: number, length: number): void => {
    block.set(new TextEncoder().encode(text).subarray(0, length), offset);
  };
  write(name, 0, 100);
  write('0000644\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  write('00000000000\0', 136, 12);
  block.fill(0x20, 148, 156);
  write(typeflag, 156, 1);
  write(linkname, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const b of block) sum += b;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

function paxHeader(records: Record<string, string>): Uint8Array {
  let text = '';
  for (const [key, value] of Object.entries(records)) {
    text += paxRecord(key, value);
  }
  return new TextEncoder().encode(text);
}

function concatBlocks(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function padded(body: Uint8Array): Uint8Array {
  const remainder = body.length % 512;
  return remainder === 0 ? body : concatBlocks(body, new Uint8Array(512 - remainder));
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(bytes: Uint8Array, gzipWrapped = false): Promise<unknown[]> {
  const stream = await gunzipIfNeeded(streamOf(bytes), gzipWrapped);
  const entries: unknown[] = [];
  for await (const entry of parseTar(stream)) {
    entries.push({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      body: new TextDecoder().decode(entry.body),
    });
  }
  return entries;
}

describe('tar reader', () => {
  it('parses regular files (single and multi-entry)', async () => {
    const archive = concatBlocks(
      ustarHeader('pkg/a.txt', 5, '0'),
      padded(new TextEncoder().encode('hello')),
      ustarHeader('pkg/b.txt', 3, '0'),
      padded(new TextEncoder().encode('bye')),
      tarEnd(),
    );
    expect(await collect(archive)).toEqual([
      { name: 'pkg/a.txt', type: 'file', size: 5, body: 'hello' },
      { name: 'pkg/b.txt', type: 'file', size: 3, body: 'bye' },
    ]);
  });

  it('handles PAX long names (>100 chars) and skips directories', async () => {
    const longName = `pkg/${'nested/'.repeat(16)}file.txt`; // > 100 chars
    expect(longName.length).toBeGreaterThan(100);
    const pax = paxHeader({ path: longName });
    const archive = concatBlocks(
      ustarHeader('pkg/', 0, '5'), // directory entry — skipped
      ustarHeader('./PaxHeader.1', pax.length, 'x'),
      padded(pax),
      ustarHeader('placeholder.txt', 4, '0'),
      padded(new TextEncoder().encode('deep')),
      tarEnd(),
    );
    const entries = await collect(archive);
    expect(entries).toEqual([{ name: longName, type: 'file', size: 4, body: 'deep' }]);
  });

  it('reads symlinks as target-bearing entries', async () => {
    const archive = concatBlocks(
      ustarHeader('pkg/link', 0, '2', 'target/file.txt'),
      tarEnd(),
    );
    const entries = (await collect(archive)) as {
      name: string;
      type: string;
      body: string;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('symlink');
    expect(entries[0]?.body).toBe('target/file.txt');
  });

  it('reads gzip-wrapped archives', async () => {
    const archive = concatBlocks(
      ustarHeader('gz.txt', 10, '0'),
      padded(new TextEncoder().encode('compressed')),
      tarEnd(),
    );
    const gz = new Uint8Array(gzipSync(Buffer.from(archive)));
    expect(await collect(gz, true)).toEqual([
      { name: 'gz.txt', type: 'file', size: 10, body: 'compressed' },
    ]);
  });

  it('errors cleanly on truncation', async () => {
    const archive = concatBlocks(
      ustarHeader('a.txt', 100, '0'),
      new Uint8Array(10), // truncated data block
    );
    await expect(collect(archive)).rejects.toThrow(/truncated/);
  });

  it('round-trips through its own writer (PAX included)', async () => {
    const longName = `x/${'d'.repeat(140)}.txt`;
    const archive = concatBlocks(
      tarEntry('short.txt', new TextEncoder().encode('short')),
      tarEntry(longName, new TextEncoder().encode('long content')),
      tarEntry('sym', new TextEncoder().encode('a/b'), { type: 'symlink' }),
      tarEnd(),
    );
    const entries = (await collect(archive)) as {
      name: string;
      type: string;
      body: string;
    }[];
    expect(entries.map((e) => e.name)).toEqual(['short.txt', longName, 'sym']);
    expect(entries[1]?.body).toBe('long content');
    expect(entries[2]?.type).toBe('symlink');
  });

  it('reassembles entries split across odd-sized stream chunks', async () => {
    const body = new Uint8Array(70_001).map((_, i) => i % 251);
    const archive = concatBlocks(
      ustarHeader('pkg/big.bin', body.length, '0'),
      padded(body),
      ustarHeader('pkg/a.txt', 5, '0'),
      padded(new TextEncoder().encode('hello')),
      tarEnd(),
    );
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < archive.length; i += 333) {
          controller.enqueue(archive.subarray(i, i + 333));
        }
        controller.close();
      },
    });
    const entries = [];
    for await (const entry of parseTar(chunked)) entries.push(entry);
    expect(entries.map((e) => e.name)).toEqual(['pkg/big.bin', 'pkg/a.txt']);
    expect(entries[0]!.body).toEqual(body);
    expect(new TextDecoder().decode(entries[1]!.body)).toBe('hello');
  });

  it('streams past bodies over maxBodyBytes without buffering them', async () => {
    const archive = concatBlocks(
      ustarHeader('pkg/huge.bin', 4096, '0'),
      padded(new Uint8Array(4096).fill(7)),
      ustarHeader('pkg/a.txt', 5, '0'),
      padded(new TextEncoder().encode('hello')),
      tarEnd(),
    );
    const entries = [];
    for await (const entry of parseTar(streamOf(archive), { maxBodyBytes: 1024 })) {
      entries.push(entry);
    }
    expect(entries[0]).toMatchObject({ name: 'pkg/huge.bin', size: 4096, skipped: true });
    expect(entries[0]!.body).toHaveLength(0);
    expect(entries[1]).toMatchObject({ name: 'pkg/a.txt', size: 5 });
    expect(entries[1]!.skipped).toBeUndefined();
  });
});
