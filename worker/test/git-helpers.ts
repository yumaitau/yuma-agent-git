import { encodeCommit, encodeTree, gitObjectId, TREE_MODE } from '../src/git/objects';
import { packChunks, type PackObject } from '../src/git/pack-writer';
import { concatBytes, FLUSH, PktReader, pktLine, pktText } from '../src/git/pktline';

/**
 * Builders for Git wire tests (issues #31, #32): loose objects with their
 * SHA-1, packs from `packChunks`, push bodies, and parsers for the sideband
 * responses, so tests speak the protocol without a git binary.
 */

export interface Obj extends PackObject {
  sha: string;
}

const enc = new TextEncoder();
const NO_SHA256 = '0'.repeat(64);

export async function blob(text: string | Uint8Array): Promise<Obj> {
  const body = typeof text === 'string' ? enc.encode(text) : text;
  return { type: 'blob', body, sha: await gitObjectId('blob', body, 'sha1') };
}

export async function tree(
  entries: { name: string; mode?: string; sha: string }[],
): Promise<Obj> {
  const body = encodeTree(
    entries.map((e) => ({
      name: e.name,
      mode: e.mode ?? '100644',
      ids: { sha1: e.sha, sha256: NO_SHA256 },
    })),
    'sha1',
  );
  return { type: 'tree', body, sha: await gitObjectId('tree', body, 'sha1') };
}

export function dir(name: string, t: Obj): { name: string; mode: string; sha: string } {
  return { name, mode: TREE_MODE, sha: t.sha };
}

export async function commit(
  treeSha: string,
  parents: string[],
  message: string,
  seconds = 1_700_000_000,
): Promise<Obj> {
  const sig = { name: 'Ada', email: 'ada@example.com', seconds, tz: '+1000' };
  const body = encodeCommit(
    {
      tree: { sha1: treeSha, sha256: NO_SHA256 },
      parents: parents.map((p) => ({ sha1: p, sha256: NO_SHA256 })),
      author: sig,
      committer: { ...sig, seconds: seconds + 60, tz: '-0500' },
      message,
    },
    'sha1',
  );
  return { type: 'commit', body, sha: await gitObjectId('commit', body, 'sha1') };
}

export async function packOf(objects: PackObject[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of packChunks(
    objects.length,
    (async function* () {
      yield* objects;
    })(),
  )) {
    chunks.push(chunk);
  }
  return concatBytes(chunks);
}

/** SHA-1 trailer recomputed, for tests that corrupt the body on purpose. */
export async function retrail(pack: Uint8Array): Promise<Uint8Array> {
  const out = pack.slice();
  const digest = await crypto.subtle.digest('SHA-1', out.subarray(0, out.length - 20));
  out.set(new Uint8Array(digest), out.length - 20);
  return out;
}

export const ZERO = '0'.repeat(40);

export function pushBody(
  commands: [old: string, next: string, ref: string][],
  pack: Uint8Array | null,
  caps = 'report-status side-band-64k',
): Uint8Array {
  return concatBytes([
    ...commands.map(([o, n, r], i) =>
      pktLine(`${o} ${n} ${r}${i === 0 ? `\0${caps}` : ''}\n`),
    ),
    FLUSH,
    pack ?? new Uint8Array(),
  ]);
}

/** v2 command request: `command=…`, delimiter, arguments, flush. */
export function commandBody(command: string, args: string[]): Uint8Array {
  return concatBytes([
    pktLine(`command=${command}\n`),
    pktLine('object-format=sha1\n'),
    enc.encode('0001'),
    ...args.map((a) => pktLine(`${a}\n`)),
    FLUSH,
  ]);
}

/** Text lines of an unbanded response, flush/delim shown as `0000`/`0001`. */
export function lines(body: Uint8Array): string[] {
  const reader = new PktReader(body);
  const out: string[] = [];
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind === 'data') out.push(pktText(pkt.data));
    else out.push(pkt.kind === 'flush' ? '0000' : pkt.kind === 'delim' ? '0001' : '0002');
  }
  return out;
}

/** A fetch response: section lines before `packfile`, then the band-1 pack. */
export function parseFetch(body: Uint8Array): {
  lines: string[];
  pack: Uint8Array;
  errors: string;
} {
  const reader = new PktReader(body);
  const out: string[] = [];
  const pack: Uint8Array[] = [];
  let errors = '';
  let inPack = false;
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind !== 'data') {
      out.push(pkt.kind === 'flush' ? '0000' : '0001');
      continue;
    }
    if (inPack) {
      const band = pkt.data[0];
      if (band === 1) pack.push(pkt.data.subarray(1));
      else if (band === 3) errors += new TextDecoder().decode(pkt.data.subarray(1));
      continue;
    }
    const text = pktText(pkt.data);
    out.push(text);
    if (text === 'packfile') inPack = true;
  }
  return { lines: out, pack: concatBytes(pack), errors };
}

/** report-status (inside band 1 when sidebanded) and band-2 messages. */
export function parseReport(body: Uint8Array): {
  unpack: string;
  refs: Record<string, string>;
  messages: string;
} {
  const reader = new PktReader(body);
  const inner: Uint8Array[] = [];
  let messages = '';
  let banded = false;
  const first = new TextDecoder().decode(body.subarray(4, 10));
  if (!first.startsWith('unpack')) banded = true;
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind !== 'data') continue;
    if (!banded) inner.push(pktLine(pkt.data));
    else if (pkt.data[0] === 1) inner.push(pkt.data.subarray(1));
    else if (pkt.data[0] === 2)
      messages += new TextDecoder().decode(pkt.data.subarray(1));
  }
  const status = lines(concatBytes(inner)).filter((l) => l !== '0000');
  const refs: Record<string, string> = {};
  for (const line of status.slice(1)) {
    const [kind, ref, ...rest] = line.split(' ');
    refs[ref as string] = kind === 'ok' ? 'ok' : rest.join(' ');
  }
  return { unpack: (status[0] ?? '').replace(/^unpack /, ''), refs, messages };
}
