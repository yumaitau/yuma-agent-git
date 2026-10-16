import { gitObjectBytes, type GitObjectType } from './objects';
import { inflate } from './zlib';

/**
 * Pack parser for pushes (issue #32). Checks the trailing SHA-1 first, then
 * reads every entry (inflating with `zlib.ts`), resolves ofs-delta and
 * ref-delta entries, and hashes each object. Bases missing from a thin pack
 * come from `resolveBase` (the repo's stored objects via the #30 mapping).
 * Every count and size is capped before any allocation, and any malformed
 * input throws `PackError`.
 */

export type PackObjectType = GitObjectType | 'tag';

export interface PackedObject {
  type: PackObjectType;
  body: Uint8Array;
}

export interface PackLimits {
  maxObjects: number;
  /** Largest inflated object (or delta result). */
  maxObjectBytes: number;
  /** Sum of every inflated entry and delta result. */
  maxTotalBytes: number;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

const TYPES: Record<number, PackObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

interface Entry {
  offset: number;
  /** Base object type, or the delta kind. */
  code: number;
  data: Uint8Array;
  baseOffset?: number;
  baseSha?: string;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource)));
}

function byteAt(buf: Uint8Array, i: number): number {
  const b = buf[i];
  if (b === undefined) throw new PackError('truncated pack');
  return b;
}

/** Apply a git delta to `base`. */
export function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  maxSize: number,
): Uint8Array {
  let p = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const b = byteAt(delta, p++);
      value += (b & 0x7f) * shift;
      shift *= 128;
      if (!(b & 0x80)) return value;
      if (shift > 2 ** 35) throw new PackError('delta size too large');
    }
  };
  if (varint() !== base.length) throw new PackError('delta base size mismatch');
  const size = varint();
  if (size > maxSize) throw new PackError('delta result too large');
  const out = new Uint8Array(size);
  let o = 0;
  while (p < delta.length) {
    const op = byteAt(delta, p++);
    if (op & 0x80) {
      let offset = 0;
      let len = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) offset += byteAt(delta, p++) * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) len += byteAt(delta, p++) * 2 ** (8 * i);
      }
      if (len === 0) len = 0x10000;
      if (offset + len > base.length || o + len > size) {
        throw new PackError('delta copy out of range');
      }
      out.set(base.subarray(offset, offset + len), o);
      o += len;
    } else if (op) {
      if (p + op > delta.length || o + op > size) {
        throw new PackError('delta insert out of range');
      }
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else {
      throw new PackError('reserved delta opcode 0');
    }
  }
  if (o !== size) throw new PackError('delta result size mismatch');
  return out;
}

/** Parse, resolve and hash a pack. Returns objects keyed by SHA-1. */
export async function readPack(
  pack: Uint8Array,
  limits: PackLimits,
  resolveBase: (sha: string) => Promise<PackedObject | null>,
): Promise<Map<string, PackedObject>> {
  if (pack.length < 32) throw new PackError('pack too short');
  const trailer = hex(pack.subarray(pack.length - 20));
  if ((await sha1Hex(pack.subarray(0, pack.length - 20))) !== trailer) {
    throw new PackError('pack checksum mismatch');
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK') {
    throw new PackError('missing PACK signature');
  }
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3)
    throw new PackError(`unsupported pack version ${version}`);
  const count = view.getUint32(8);
  if (count > limits.maxObjects) {
    throw new PackError(`pack has ${count} objects; the limit is ${limits.maxObjects}`);
  }

  const end = pack.length - 20;
  let pos = 12;
  let total = 0;
  const spend = (bytes: number): void => {
    if (bytes > limits.maxObjectBytes) {
      throw new PackError(`object of ${bytes} bytes exceeds ${limits.maxObjectBytes}`);
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      throw new PackError(`pack inflates past ${limits.maxTotalBytes} bytes`);
    }
  };

  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  for (let n = 0; n < count; n++) {
    const offset = pos;
    if (pos >= end) throw new PackError('truncated pack');
    let b = byteAt(pack, pos++);
    const code = (b >> 4) & 7;
    let size = b & 15;
    let shift = 16;
    while (b & 0x80) {
      b = byteAt(pack, pos++);
      size += (b & 0x7f) * shift;
      shift *= 128;
      if (shift > 2 ** 40) throw new PackError('object size too large');
    }
    spend(size);
    const entry: Entry = { offset, code, data: new Uint8Array() };
    if (code === OFS_DELTA) {
      b = byteAt(pack, pos++);
      let back = b & 0x7f;
      while (b & 0x80) {
        b = byteAt(pack, pos++);
        back = (back + 1) * 128 + (b & 0x7f);
        if (back > offset) throw new PackError('ofs-delta base before pack start');
      }
      entry.baseOffset = offset - back;
      if (back === 0 || !byOffset.has(entry.baseOffset)) {
        throw new PackError('ofs-delta base is not an object in this pack');
      }
    } else if (code === REF_DELTA) {
      if (pos + 20 > end) throw new PackError('truncated pack');
      entry.baseSha = hex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!(code in TYPES)) {
      throw new PackError(`invalid object type ${code}`);
    }
    let inflated: { data: Uint8Array; end: number };
    try {
      inflated = inflate(pack.subarray(0, end), pos, size);
    } catch (err) {
      throw new PackError(`object at offset ${offset}: ${(err as Error).message}`);
    }
    entry.data = inflated.data;
    pos = inflated.end;
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  if (pos !== end) throw new PackError('trailing bytes after the last object');

  // Resolve: full objects first, then deltas as their bases appear.
  const objects = new Map<string, PackedObject>();
  const resolvedAt = new Map<number, PackedObject>();
  const waitingOnOffset = new Map<number, Entry[]>();
  const waitingOnSha = new Map<string, Entry[]>();
  const ready: [Entry, PackedObject][] = [];
  const wait = <K>(map: Map<K, Entry[]>, key: K, entry: Entry): void => {
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  for (const entry of entries) {
    if (entry.code === OFS_DELTA)
      wait(waitingOnOffset, entry.baseOffset as number, entry);
    else if (entry.code === REF_DELTA) wait(waitingOnSha, entry.baseSha as string, entry);
    else
      ready.push([
        entry,
        { type: TYPES[entry.code] as PackObjectType, body: entry.data },
      ]);
  }

  const settle = async (): Promise<void> => {
    while (ready.length > 0) {
      const [entry, object] = ready.pop() as [Entry, PackedObject];
      const sha = await sha1Hex(
        gitObjectBytes(object.type as GitObjectType, object.body),
      );
      objects.set(sha, object);
      resolvedAt.set(entry.offset, object);
      const children = [
        ...(waitingOnOffset.get(entry.offset) ?? []),
        ...(waitingOnSha.get(sha) ?? []),
      ];
      waitingOnOffset.delete(entry.offset);
      waitingOnSha.delete(sha);
      for (const child of children) {
        const body = applyDelta(object.body, child.data, limits.maxObjectBytes);
        spend(body.length);
        ready.push([child, { type: object.type, body }]);
      }
    }
  };
  await settle();

  // Thin pack: bases the client assumed the repo already has.
  for (const sha of [...waitingOnSha.keys()]) {
    const children = waitingOnSha.get(sha);
    if (!children) continue; // resolved inside the pack by an earlier base
    waitingOnSha.delete(sha);
    const base = objects.get(sha) ?? (await resolveBase(sha));
    if (base === null) throw new PackError(`delta base ${sha} not found`);
    for (const child of children) {
      const body = applyDelta(base.body, child.data, limits.maxObjectBytes);
      spend(body.length);
      ready.push([child, { type: base.type, body }]);
    }
    await settle();
  }
  if (resolvedAt.size !== entries.length) throw new PackError('unresolved delta in pack');
  return objects;
}
