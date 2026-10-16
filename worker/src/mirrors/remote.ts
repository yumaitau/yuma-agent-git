import { blockedHost, resolvesToBlocked } from '../webhooks/deliver';
import { PUSH_LIMITS } from '../git/receive-pack';
import {
  concatBytes,
  DELIM,
  FLUSH,
  PktLineError,
  PktReader,
  pktLine,
  pktText,
} from '../git/pktline';

/**
 * Git smart HTTP client for mirrors (issues #36, #73): the Worker itself is
 * the Git client, so no container or git binary is needed. Fetch speaks
 * protocol v2 (`ls-refs`, `fetch`), push speaks v0 receive-pack with
 * `report-status`, as GitHub, GitLab and Gitea do.
 *
 * Every response is read into memory and capped. Redirects are refused (a
 * redirect could point at a private address the URL check never saw). The
 * credential travels only in the Authorization header and is scrubbed from
 * every error message.
 */

export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface Remote {
  /** Repository URL, e.g. https://github.com/acme/widgets.git */
  url: string;
  /** HTTP Basic credential, or null for an anonymous remote. */
  basic: { username: string; password: string } | null;
}

export interface RemoteRef {
  sha: string;
  /** Present for an annotated tag: the commit it points at. */
  peeled?: string;
}

const ZERO_SHA = '0'.repeat(40);
const USER_AGENT = 'git/2.0 (yuma-agent-git)';
/** A fetched pack is landed by receive-pack, so it gets the push cap. */
const MAX_RESPONSE_BYTES = PUSH_LIMITS.maxPackBytes + 1024 * 1024;

/** Why a remote URL cannot be mirrored, or null. Checked again before every sync. */
export function remoteUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Remote URL is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'Remote URLs must use https';
  if (url.username || url.password)
    return 'Remote URLs cannot contain credentials; set a token instead';
  if (url.search || url.hash) return 'Remote URLs cannot have a query or fragment';
  if (url.pathname === '/' || url.pathname === '')
    return 'Remote URL needs a repository path';
  if (blockedHost(url.hostname))
    return 'Remote URLs cannot point at private, loopback, link-local or metadata addresses';
  return null;
}

/** The message with the credential removed, in case a remote echoes it. */
export function scrub(message: string, remote: Remote): string {
  const secret = remote.basic?.password;
  return secret ? message.split(secret).join('***') : message;
}

export async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RemoteError(
        `remote response exceeds ${MAX_RESPONSE_BYTES} bytes; land the history with an import first, then mirror the increments`,
      );
    }
    chunks.push(value);
  }
  return concatBytes(chunks);
}

async function call(
  remote: Remote,
  path: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Uint8Array },
): Promise<Uint8Array> {
  const base = remote.url.replace(/\/+$/, '');
  if (await resolvesToBlocked(new URL(base).hostname).catch(() => true)) {
    throw new RemoteError(
      'remote host did not resolve, or resolves to a blocked address',
    );
  }
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...init.headers };
  if (remote.basic) {
    headers.authorization = `Basic ${btoa(`${remote.basic.username}:${remote.basic.password}`)}`;
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'manual',
    });
  } catch {
    throw new RemoteError('remote could not be reached');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new RemoteError(
      `remote redirected (HTTP ${res.status}); use the repository's final URL`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new RemoteError(`remote refused the credentials (HTTP ${res.status})`);
  }
  if (res.status === 404) throw new RemoteError('remote repository not found (HTTP 404)');
  if (!res.ok) throw new RemoteError(`remote answered HTTP ${res.status}`);
  return readCapped(res);
}

/** Data lines up to the next flush, as text; an `ERR` line throws. */
function textLines(reader: PktReader, what: string): string[] {
  const out: string[] = [];
  for (;;) {
    const pkt = reader.next();
    if (pkt === null) throw new RemoteError(`${what}: response ended early`);
    if (pkt.kind === 'flush') return out;
    if (pkt.kind !== 'data') continue;
    const line = pktText(pkt.data);
    if (line.startsWith('ERR ')) throw new RemoteError(`remote error: ${line.slice(4)}`);
    out.push(line);
  }
}

function parsed<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof PktLineError) throw new RemoteError(`${what}: ${err.message}`);
    throw err;
  }
}

function v2Request(command: string, args: string[]): Uint8Array {
  return concatBytes([
    pktLine(`command=${command}\n`),
    pktLine(`agent=${USER_AGENT}\n`),
    DELIM,
    ...args.map((a) => pktLine(`${a}\n`)),
    FLUSH,
  ]);
}

const V2_HEADERS = { 'git-protocol': 'version=2' };

/** Branches and tags of a remote (protocol v2 `ls-refs`). */
export async function lsRemote(remote: Remote): Promise<Map<string, RemoteRef>> {
  const advert = await call(remote, '/info/refs?service=git-upload-pack', {
    method: 'GET',
    headers: V2_HEADERS,
  });
  parsed('capability advertisement', () => {
    const reader = new PktReader(advert);
    let lines = textLines(reader, 'capability advertisement');
    // smart HTTP may open with `# service=…` and a flush before the v2 lines
    if (lines[0]?.startsWith('# service=')) lines = textLines(reader, 'advertisement');
    if (lines[0] !== 'version 2' || !lines.some((l) => l.startsWith('fetch'))) {
      throw new RemoteError('remote does not speak Git protocol v2');
    }
  });
  const body = await call(remote, '/git-upload-pack', {
    method: 'POST',
    headers: {
      ...V2_HEADERS,
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
    },
    body: v2Request('ls-refs', [
      'peel',
      'ref-prefix refs/heads/',
      'ref-prefix refs/tags/',
    ]),
  });
  return parsed('ls-refs', () => {
    const refs = new Map<string, RemoteRef>();
    for (const line of textLines(new PktReader(body), 'ls-refs')) {
      const [sha, name, ...attrs] = line.split(' ');
      if (!sha || !name || !/^[0-9a-f]{40}$/.test(sha)) continue;
      if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) continue;
      const peeled = attrs.find((a) => a.startsWith('peeled:'))?.slice('peeled:'.length);
      refs.set(name, peeled ? { sha, peeled } : { sha });
    }
    return refs;
  });
}

/** The pack bytes of a v2 fetch response (sections before `packfile` skipped). */
export function packOfFetchResponse(body: Uint8Array): Uint8Array {
  return parsed('fetch', () => {
    const reader = new PktReader(body);
    for (;;) {
      const pkt = reader.next();
      if (pkt === null) throw new RemoteError('fetch: no packfile section');
      if (pkt.kind !== 'data') continue;
      const line = pktText(pkt.data);
      if (line.startsWith('ERR '))
        throw new RemoteError(`remote error: ${line.slice(4)}`);
      if (line === 'packfile') break;
    }
    const pack: Uint8Array[] = [];
    for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
      if (pkt.kind === 'flush') break;
      if (pkt.kind !== 'data' || pkt.data.length === 0) continue;
      const band = pkt.data[0];
      if (band === 1) pack.push(pkt.data.subarray(1));
      else if (band === 3) {
        throw new RemoteError(
          `pack stream failed: ${new TextDecoder().decode(pkt.data.subarray(1)).trim()}`,
        );
      }
    }
    return concatBytes(pack);
  });
}

/** Fetch the objects for `wants` that `haves` lack (protocol v2 `fetch`). */
export async function fetchRemotePack(
  remote: Remote,
  wants: string[],
  haves: string[],
): Promise<Uint8Array> {
  const body = await call(remote, '/git-upload-pack', {
    method: 'POST',
    headers: {
      ...V2_HEADERS,
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
    },
    body: v2Request('fetch', [
      'ofs-delta',
      'no-progress',
      ...wants.map((w) => `want ${w}`),
      ...haves.map((h) => `have ${h}`),
      'done',
    ]),
  });
  return packOfFetchResponse(body);
}

export interface ReceiveAdvert {
  refs: Map<string, string>;
  caps: Set<string>;
}

/** The refs and capabilities a remote advertises for push (v0). */
export async function receiveAdvert(remote: Remote): Promise<ReceiveAdvert> {
  const body = await call(remote, '/info/refs?service=git-receive-pack', {
    method: 'GET',
  });
  return parsed('receive-pack advertisement', () => {
    const reader = new PktReader(body);
    let lines = textLines(reader, 'receive-pack advertisement');
    if (lines[0]?.startsWith('# service=')) lines = textLines(reader, 'advertisement');
    const refs = new Map<string, string>();
    let caps = new Set<string>();
    for (const [i, raw] of lines.entries()) {
      const nul = raw.indexOf('\0');
      if (i === 0 && nul >= 0) caps = new Set(raw.slice(nul + 1).split(' '));
      const [sha, name] = (nul >= 0 ? raw.slice(0, nul) : raw).split(' ');
      if (!sha || !name || sha === ZERO_SHA) continue;
      if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/'))
        refs.set(name, sha);
    }
    if (!caps.has('report-status')) {
      throw new RemoteError('remote does not offer report-status for pushes');
    }
    return { refs, caps };
  });
}

export interface RefCommand {
  ref: string;
  /** What the remote has now (zero for a create). */
  oldSha: string;
  /** What it should have (zero for a delete). */
  newSha: string;
}

/** `report-status` lines: `unpack …`, then `ok <ref>` or `ng <ref> <reason>`. */
export function parseReportStatus(body: Uint8Array): {
  unpack: string;
  refs: Map<string, string | null>;
} {
  return parsed('report-status', () => {
    const lines = textLines(new PktReader(body), 'report-status');
    const unpack = (lines[0] ?? '').replace(/^unpack /, '');
    const refs = new Map<string, string | null>();
    for (const line of lines.slice(1)) {
      const [kind, ref, ...rest] = line.split(' ');
      if (!ref) continue;
      refs.set(ref, kind === 'ok' ? null : rest.join(' ') || 'rejected');
    }
    return { unpack, refs };
  });
}

/** One receive-pack request: commands, then the pack when anything is sent. */
export function receiveRequest(
  commands: RefCommand[],
  caps: string[],
  pack: Uint8Array | null,
): Uint8Array {
  return concatBytes([
    ...commands.map((c, i) =>
      pktLine(
        `${c.oldSha} ${c.newSha} ${c.ref}${i === 0 ? `\0${caps.join(' ')}` : ''}\n`,
      ),
    ),
    FLUSH,
    pack ?? new Uint8Array(),
  ]);
}

/** Push `commands` (and `pack`) to the remote; each ref's refusal, or null. */
export async function sendPack(
  remote: Remote,
  advert: ReceiveAdvert,
  commands: RefCommand[],
  pack: Uint8Array | null,
): Promise<Map<string, string | null>> {
  const caps = ['report-status', `agent=${USER_AGENT}`];
  if (advert.caps.has('ofs-delta')) caps.push('ofs-delta');
  if (commands.some((c) => c.newSha === ZERO_SHA)) {
    if (!advert.caps.has('delete-refs'))
      throw new RemoteError('remote does not allow deleting refs');
    caps.push('delete-refs');
  }
  const body = await call(remote, '/git-receive-pack', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
    body: receiveRequest(commands, caps, pack),
  });
  const report = parseReportStatus(body);
  if (report.unpack !== 'ok')
    throw new RemoteError(`remote unpack failed: ${report.unpack}`);
  return report.refs;
}

export { ZERO_SHA };
