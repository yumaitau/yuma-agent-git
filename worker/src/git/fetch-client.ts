import { concatBytes, DELIM, FLUSH, PktReader, pktLine, pktText } from './pktline';
import { AGENT } from './upload-pack';

/**
 * Smart HTTP client, protocol v2 (issue #72): the bulk importer fetches
 * GitHub repositories the way `git clone` does, so commits arrive as raw Git
 * objects and keep their SHAs. Two commands are used: `ls-refs` (with peeled
 * tags and the HEAD symref) and `fetch` (with `done`, so the reply is the
 * pack alone). Replies are read into memory under a byte cap, like pushes.
 */

export class FetchClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchClientError';
  }
}

export interface RemoteRef {
  name: string;
  sha: string;
  /** The commit an annotated tag points at. */
  peeled?: string;
}

export interface RemoteRefs {
  /** HEAD's target branch (`refs/heads/…`), when the remote says. */
  head: string | null;
  refs: RemoteRef[];
}

export interface RemoteOptions {
  /** `https://host/owner/name.git` */
  url: string;
  headers?: Record<string, string>;
  /** Largest reply read into memory. */
  maxBytes: number;
  fetch?: typeof fetch;
}

async function command(
  opts: RemoteOptions,
  name: string,
  args: string[],
): Promise<Uint8Array> {
  const body = concatBytes([
    pktLine(`command=${name}\n`),
    pktLine(`${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    DELIM,
    ...args.map((a) => pktLine(`${a}\n`)),
    FLUSH,
  ]);
  const res = await (opts.fetch ?? fetch)(`${opts.url}/git-upload-pack`, {
    method: 'POST',
    headers: {
      ...opts.headers,
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
      'git-protocol': 'version=2',
      'user-agent': 'git/2.0 (yuma-agent-git)',
    },
    body,
  });
  if (!res.ok) {
    throw new FetchClientError(`${name}: HTTP ${res.status}`, res.status);
  }
  return readCapped(res, opts.maxBytes);
}

/** A reply body read into memory, refused past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw new FetchClientError(`reply is over ${max} bytes`);
  if (!res.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new FetchClientError(`reply is over ${max} bytes`);
    }
    parts.push(value);
  }
  return concatBytes(parts);
}

function errLine(text: string): void {
  if (text.startsWith('ERR ')) throw new FetchClientError(text.slice(4));
}

/** Branches and tags, peeled, plus HEAD's target. Extra prefixes are optional. */
export async function lsRemote(
  opts: RemoteOptions,
  prefixes: string[] = ['refs/heads/', 'refs/tags/'],
): Promise<RemoteRefs> {
  const reply = await command(opts, 'ls-refs', [
    'peel',
    'symrefs',
    'ref-prefix HEAD',
    ...prefixes.map((p) => `ref-prefix ${p}`),
  ]);
  const out: RemoteRefs = { head: null, refs: [] };
  const reader = new PktReader(reply);
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind !== 'data') continue;
    const text = pktText(pkt.data);
    errLine(text);
    const [sha, name, ...attrs] = text.split(' ');
    if (!sha || !name || !/^[0-9a-f]{40}$/.test(sha)) continue;
    if (name === 'HEAD') {
      const target = attrs.find((a) => a.startsWith('symref-target:'));
      out.head = target ? target.slice('symref-target:'.length) : null;
      continue;
    }
    const peeled = attrs.find((a) => a.startsWith('peeled:'));
    out.refs.push({
      name,
      sha,
      ...(peeled ? { peeled: peeled.slice('peeled:'.length) } : {}),
    });
  }
  return out;
}

/**
 * The pack for `wants` minus what `haves` already reach. `filter` asks for a
 * partial pack (`tree:0`: commits only, used to plan the history in chunks).
 */
export async function fetchRemotePack(
  opts: RemoteOptions,
  wants: string[],
  haves: string[] = [],
  filter?: 'tree:0' | 'blob:none',
): Promise<Uint8Array> {
  if (wants.length === 0) return new Uint8Array();
  const reply = await command(opts, 'fetch', [
    ...wants.map((w) => `want ${w}`),
    ...haves.map((h) => `have ${h}`),
    'ofs-delta',
    'no-progress',
    ...(filter ? [`filter ${filter}`] : []),
    'done',
  ]);
  const reader = new PktReader(reply);
  const pack: Uint8Array[] = [];
  let inPack = false;
  let errors = '';
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind !== 'data') continue;
    if (!inPack) {
      const text = pktText(pkt.data);
      errLine(text);
      if (text === 'packfile') inPack = true;
      continue;
    }
    const band = pkt.data[0];
    if (band === 1) pack.push(pkt.data.subarray(1));
    else if (band === 3) errors += new TextDecoder().decode(pkt.data.subarray(1));
  }
  if (errors) throw new FetchClientError(errors.trim());
  if (!inPack) throw new FetchClientError('fetch: the reply has no pack');
  return concatBytes(pack);
}
