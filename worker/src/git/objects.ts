/**
 * Git object encoding (issue #30): the exact bytes Git hashes, so changesets,
 * trees and blobs map to stable Git IDs. Pure functions, no I/O.
 *
 * An object ID is the hash of `<type> <size>\0<body>`, the loose-object form
 * before zlib. SHA-1 IDs are what clients speak today. SHA-256 IDs (Git's hash
 * function transition) hash the same layout, with SHA-256 IDs for the trees,
 * parents and entries a body refers to.
 */

export type GitObjectType = 'blob' | 'tree' | 'commit';
export type GitHashAlgo = 'sha1' | 'sha256';

export interface GitIds {
  sha1: string;
  sha256: string;
}

/** IDs of the empty tree (`git hash-object -t tree /dev/null`). */
export const EMPTY_TREE: GitIds = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/** Tree entry modes Git writes. Directories are `40000`, no leading zero. */
export const TREE_MODE = '40000';
const MODES = new Set([TREE_MODE, '100644', '100755', '120000', '160000']);

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function digestHex(algo: GitHashAlgo, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    algo === 'sha1' ? 'SHA-1' : 'SHA-256',
    bytes as BufferSource,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `<type> <size>\0<body>`: what an ID hashes (zlib it for a loose object file). */
export function gitObjectBytes(type: GitObjectType, body: Uint8Array): Uint8Array {
  return concat([encoder.encode(`${type} ${body.byteLength}\0`), body]);
}

/** Hash one encoded body with one algorithm. */
export function gitObjectId(
  type: GitObjectType,
  body: Uint8Array,
  algo: GitHashAlgo,
): Promise<string> {
  return digestHex(algo, gitObjectBytes(type, body));
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

/** A blob body is the raw content, so both IDs hash the same bytes. */
export async function gitBlobId(content: Uint8Array): Promise<GitIds> {
  const bytes = gitObjectBytes('blob', content);
  const [sha1, sha256] = await Promise.all([
    digestHex('sha1', bytes),
    digestHex('sha256', bytes),
  ]);
  return { sha1, sha256 };
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface GitTreeEntry {
  name: string;
  /** `40000` for a directory, else `100644` | `100755` | `120000` | `160000`. */
  mode: string;
  ids: GitIds;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

/** Git's order: UTF-8 bytes, a directory compared as if its name ended in `/`. */
export function sortTreeEntries(entries: GitTreeEntry[]): GitTreeEntry[] {
  const key = (e: GitTreeEntry): Uint8Array =>
    encoder.encode(e.mode === TREE_MODE ? `${e.name}/` : e.name);
  return entries
    .map((e) => ({ e, k: key(e) }))
    .sort((a, b) => compareBytes(a.k, b.k))
    .map(({ e }) => e);
}

/** Tree body: `<mode> <name>\0<raw id>` per entry, in Git order. */
export function encodeTree(entries: GitTreeEntry[], algo: GitHashAlgo): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of sortTreeEntries(entries)) {
    if (!MODES.has(entry.mode)) {
      throw new Error(`unsupported git mode ${entry.mode} for ${entry.name}`);
    }
    parts.push(
      encoder.encode(`${entry.mode} ${entry.name}\0`),
      hexToBytes(entry.ids[algo]),
    );
  }
  return concat(parts);
}

export async function gitTreeId(entries: GitTreeEntry[]): Promise<GitIds> {
  const [sha1, sha256] = await Promise.all([
    gitObjectId('tree', encodeTree(entries, 'sha1'), 'sha1'),
    gitObjectId('tree', encodeTree(entries, 'sha256'), 'sha256'),
  ]);
  return { sha1, sha256 };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface GitSignature {
  name: string;
  email: string;
  /** Epoch seconds. */
  seconds: number;
  /** `+hhmm` / `-hhmm`. */
  tz: string;
}

export interface GitCommit {
  tree: GitIds;
  parents: GitIds[];
  author: GitSignature;
  committer: GitSignature;
  /** Written in order after `committer`. */
  extraHeaders?: [string, string][];
  /** Written last, as Git does when it signs. */
  gpgsig?: string;
  message: string;
}

/** `Name <email> 1700000000 +1000`, the ident form commits and fast-import share. */
export function formatSignature(sig: GitSignature): string {
  return `${sig.name} <${sig.email}> ${sig.seconds} ${sig.tz}`;
}

/** Multi-line header values continue with a leading space. */
function header(key: string, value: string): string {
  return `${key} ${value.split('\n').join('\n ')}\n`;
}

export function encodeCommit(commit: GitCommit, algo: GitHashAlgo): Uint8Array {
  let text = header('tree', commit.tree[algo]);
  for (const parent of commit.parents) text += header('parent', parent[algo]);
  text += header('author', formatSignature(commit.author));
  text += header('committer', formatSignature(commit.committer));
  for (const [key, value] of commit.extraHeaders ?? []) text += header(key, value);
  if (commit.gpgsig !== undefined) text += header('gpgsig', commit.gpgsig);
  return encoder.encode(`${text}\n${commit.message}`);
}

export async function gitCommitId(commit: GitCommit): Promise<GitIds> {
  const [sha1, sha256] = await Promise.all([
    gitObjectId('commit', encodeCommit(commit, 'sha1'), 'sha1'),
    gitObjectId('commit', encodeCommit(commit, 'sha256'), 'sha256'),
  ]);
  return { sha1, sha256 };
}

// ---------------------------------------------------------------------------
// Decoding (pushed objects, issue #32)
// ---------------------------------------------------------------------------

export interface GitTreeItem {
  mode: string;
  name: string;
  sha: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ignoreBOM keeps a leading BOM in the text, so the bytes round-trip
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** SHA-1 tree body → entries in stored order. Throws on a malformed body. */
export function parseTree(body: Uint8Array): GitTreeItem[] {
  const out: GitTreeItem[] = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    const nul = space < 0 ? -1 : body.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > body.length) {
      throw new Error('malformed tree entry');
    }
    out.push({
      mode: utf8.decode(body.subarray(pos, space)),
      name: utf8.decode(body.subarray(space + 1, nul)),
      sha: bytesToHex(body.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return out;
}

/** A commit as pushed: object IDs are SHA-1 hex. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: GitSignature;
  committer: GitSignature;
  extraHeaders: [string, string][];
  gpgsig?: string;
  message: string;
}

const SIGNATURE_RE = /^(.*) <([^<>\n]*)> (\d+) ([+-]\d{4})$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

export function parseSignature(text: string): GitSignature {
  const m = SIGNATURE_RE.exec(text);
  if (!m) throw new Error(`malformed ident: ${JSON.stringify(text)}`);
  return {
    name: m[1] as string,
    email: m[2] as string,
    seconds: Number(m[3]),
    tz: m[4] as string,
  };
}

/**
 * Commit body → fields in the layout `encodeCommit` writes back. Anything
 * that layout cannot reproduce (headers out of order, a header after the
 * signature) throws, so a pushed commit either round-trips or is refused.
 */
export function parseCommit(body: Uint8Array): ParsedCommit {
  const text = utf8.decode(body);
  const split = text.indexOf('\n\n');
  if (split < 0) throw new Error('commit has no message separator');
  const headers: [string, string][] = [];
  for (const line of text.slice(0, split).split('\n')) {
    if (line.startsWith(' ')) {
      const last = headers[headers.length - 1];
      if (!last) throw new Error('continuation line without a header');
      last[1] += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space <= 0) throw new Error(`malformed commit header: ${JSON.stringify(line)}`);
    headers.push([line.slice(0, space), line.slice(space + 1)]);
  }

  let i = 0;
  const take = (key: string): string => {
    const header = headers[i];
    if (!header || header[0] !== key) throw new Error(`commit is missing ${key}`);
    i++;
    return header[1];
  };
  const tree = take('tree');
  const parents: string[] = [];
  while (headers[i]?.[0] === 'parent') parents.push(take('parent'));
  const author = parseSignature(take('author'));
  const committer = parseSignature(take('committer'));
  const extraHeaders: [string, string][] = [];
  let gpgsig: string | undefined;
  for (; i < headers.length; i++) {
    const [key, value] = headers[i] as [string, string];
    if (gpgsig !== undefined) throw new Error('commit has a header after gpgsig');
    if (key === 'gpgsig') gpgsig = value;
    else if (['tree', 'parent', 'author', 'committer'].includes(key)) {
      throw new Error(`commit header ${key} out of order`);
    } else extraHeaders.push([key, value]);
  }
  for (const sha of [tree, ...parents]) {
    if (!SHA1_RE.test(sha)) throw new Error(`malformed object id ${JSON.stringify(sha)}`);
  }
  return {
    tree,
    parents,
    author,
    committer,
    extraHeaders,
    gpgsig,
    message: text.slice(split + 2),
  };
}
