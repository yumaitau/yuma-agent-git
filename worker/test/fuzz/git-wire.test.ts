import { describe, expect, it } from 'vitest';
import { PktLineError, PktReader } from '../../src/git/pktline';
import { InflateError, inflate } from '../../src/git/zlib';
import { applyDelta, PackError, readPack } from '../../src/git/pack-reader';
import { deflate } from '../../src/git/pack-writer';
import { parseCommand, parseFetchArgs } from '../../src/git/upload-pack';
import { GitProtocolError } from '../../src/git/pktline';
import { blob, commit, packOf, retrail, tree } from '../git-helpers';

/**
 * Wire-format fuzzing (issues #31, #32): pkt-lines, the v2 command parser,
 * zlib inflate, deltas and whole packs get random, truncated and bit-flipped
 * input. The only acceptable failures are the parsers' own error types: no
 * other exception, no hang, no out-of-bounds read.
 */

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytes(rand: () => number, n: number, alphabet?: string): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = alphabet
      ? alphabet.charCodeAt(Math.floor(rand() * alphabet.length))
      : Math.floor(rand() * 256);
  }
  return out;
}

function onlyThrows(fn: () => unknown, ...types: (new (...a: never[]) => Error)[]): void {
  try {
    fn();
  } catch (err) {
    if (!types.some((t) => err instanceof t)) throw err;
  }
}

async function onlyRejects(
  fn: () => Promise<unknown>,
  ...types: (new (...a: never[]) => Error)[]
): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    if (!types.some((t) => err instanceof t)) throw err;
    return true;
  }
}

describe('git wire fuzz', () => {
  it('pkt-line reader and v2 command parser only fail with protocol errors', () => {
    const rand = prng(0x917);
    for (let i = 0; i < 3000; i++) {
      const input = bytes(
        rand,
        Math.floor(rand() * 48),
        '0123456789abcdef\n =commandwant',
      );
      onlyThrows(() => {
        const reader = new PktReader(input);
        while (reader.next() !== null);
      }, PktLineError);
      onlyThrows(() => parseCommand(input), PktLineError, GitProtocolError);
    }
    onlyThrows(() => parseFetchArgs(['want zz', 'deepen -1']), GitProtocolError);
  });

  it('inflate round-trips CompressionStream output and rejects damaged streams', async () => {
    const rand = prng(0x2a);
    for (const size of [0, 1, 100, 5000, 70_000]) {
      const plain = rand() < 0.5 ? bytes(rand, size) : bytes(rand, size, 'ab\n');
      const packed = await deflate(plain);
      const tail = new Uint8Array([1, 2, 3]);
      const input = new Uint8Array(packed.length + tail.length);
      input.set(packed);
      input.set(tail, packed.length);
      const out = inflate(input, 0, size);
      expect(out.data).toEqual(plain);
      expect(out.end).toBe(packed.length);

      for (let cut = 0; cut < packed.length; cut += Math.max(1, packed.length >> 4)) {
        onlyThrows(() => inflate(packed.subarray(0, cut), 0, size), InflateError);
      }
      for (let n = 0; n < 50; n++) {
        const bad = packed.slice();
        bad[Math.floor(rand() * bad.length)]! ^= 1 << Math.floor(rand() * 8);
        onlyThrows(() => {
          const res = inflate(bad, 0, size);
          // the adler-32 check means a surviving stream is the same data
          expect(res.data).toEqual(plain);
        }, InflateError);
      }
      onlyThrows(() => inflate(packed, 0, size + 1), InflateError);
    }
    for (let i = 0; i < 500; i++) {
      onlyThrows(() => inflate(bytes(rand, 64), 0, 128), InflateError);
    }
  });

  it('applyDelta rejects every malformed delta', () => {
    const rand = prng(0xde17a);
    const base = bytes(rand, 64);
    for (let i = 0; i < 3000; i++) {
      onlyThrows(
        () => applyDelta(base, bytes(rand, Math.floor(rand() * 24)), 1 << 16),
        PackError,
      );
    }
  });

  it('readPack rejects truncated and bit-flipped packs with PackError only', async () => {
    const a = await blob('alpha\n');
    const b = await blob('beta\n'.repeat(50));
    const t = await tree([
      { name: 'a', sha: a.sha },
      { name: 'b', sha: b.sha },
    ]);
    const c = await commit(t.sha, [], 'fuzz\n');
    const pack = await packOf([c, t, a, b]);
    const limits = { maxObjects: 16, maxObjectBytes: 1 << 16, maxTotalBytes: 1 << 18 };
    expect((await readPack(pack, limits, async () => null)).size).toBe(4);

    for (let cut = 20; cut < pack.length; cut += 3) {
      expect(
        await onlyRejects(
          async () =>
            readPack(await retrail(pack.subarray(0, cut)), limits, async () => null),
          PackError,
        ),
      ).toBe(true);
    }
    const rand = prng(0x9ac);
    let rejected = 0;
    for (let n = 0; n < 300; n++) {
      const bad = pack.slice();
      bad[12 + Math.floor(rand() * (bad.length - 32))]! ^= 1 << Math.floor(rand() * 8);
      if (
        await onlyRejects(
          async () => readPack(await retrail(bad), limits, async () => null),
          PackError,
        )
      ) {
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(250);
    // a flipped trailer is a checksum mismatch
    const tampered = pack.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(readPack(tampered, limits, async () => null)).rejects.toThrow(
      'pack checksum mismatch',
    );
    // caps hold before any allocation
    await expect(
      readPack(pack, { ...limits, maxObjects: 3 }, async () => null),
    ).rejects.toThrow(/limit is 3/);
  });
});
