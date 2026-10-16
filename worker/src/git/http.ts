import { Hono, type Context, type Next } from 'hono';
import type { AppEnv, Principal } from '../auth/principal';
import { apiError, errorResponse } from '../api/errors';
import { decide, pathDecider, restrictingDecision, type Decision } from '../auth/rbac';
import { ssoMessage } from '../auth/sso';
import { resolveTokenPrincipal } from '../auth/tokens';
import { resolveCloneToken } from '../ci/runners';
import { PayloadTooLargeError } from '../core/errors';
import { getRepoBySlug } from '../db/repos';
import type { RepoRecord } from '../db/client';
import { concatBytes, FLUSH, GitProtocolError, PktLineError, pktLine } from './pktline';
import { advertiseReceivePack, PUSH_LIMITS, receivePack } from './receive-pack';
import { advertiseV2, fetchPack, lsRefs, parseCommand } from './upload-pack';

/**
 * Git smart HTTP (issues #31, #32):
 *   GET  /:owner/:repo.git/info/refs?service=git-upload-pack   (protocol v2)
 *   POST /:owner/:repo.git/git-upload-pack                      (ls-refs, fetch)
 *   GET  /:owner/:repo.git/info/refs?service=git-receive-pack
 *   POST /:owner/:repo.git/git-receive-pack                     (push, v0)
 *
 * Auth is a token: HTTP Basic with the token as password (any username) or
 * `Authorization: Bearer`. Anonymous callers get 401 with `WWW-Authenticate`
 * so Git asks for credentials; the API's sign-in rule applies to public repos
 * too. Unreadable repos are 404; readable without write is 403 on push.
 * Callers any path rule restricts cannot use Git at all: a commit carries the
 * whole tree, so they get a `path_restricted` error. Protocol refusals go back
 * as `ERR` lines, which Git prints as `remote error: …`.
 */
export const gitRoutes = new Hono<AppEnv>();

const REPO = '/:owner/:repo{[^/]+\\.git}';
const GIT_PATH_RE =
  /^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/.+)$/;
/** Upload-pack requests are want/have lists; this bounds a hostile one. */
const MAX_UPLOAD_REQUEST_BYTES = 4 * 1024 * 1024;

/** HTTP Basic for Git paths only: browsers never get a Basic session for the API. */
export async function gitBasicAuth(c: Context<AppEnv>, next: Next): Promise<void> {
  const header = c.req.header('authorization');
  if (
    !c.get('principal') &&
    header?.startsWith('Basic ') &&
    GIT_PATH_RE.test(new URL(c.req.url).pathname)
  ) {
    let decoded = '';
    try {
      decoded = atob(header.slice('Basic '.length));
    } catch {
      decoded = '';
    }
    const colon = decoded.indexOf(':');
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const password = colon < 0 ? '' : decoded.slice(colon + 1);
    const secret = password || user;
    // a self-hosted runner clones with its job's clone token (issue #48)
    const principal =
      (await resolveTokenPrincipal(c.env, secret)) ??
      (await resolveCloneToken(c.env, secret));
    if (principal) c.set('principal', principal);
  }
  await next();
}

function unauthorized(c: Context<AppEnv>): Response {
  const res = apiError(c, 401, 'unauthorized', 'authentication required');
  res.headers.set('www-authenticate', 'Basic realm="yuma-agent-git", charset="UTF-8"');
  return res;
}

function gitResponse(body: BodyInit, type: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': type, 'cache-control': 'no-cache' },
  });
}

/** An `ERR` line, after the service header for an advertisement. */
function gitError(service: string, message: string, advert: boolean): Response {
  const err = pktLine(`ERR ${message}\n`);
  return gitResponse(
    advert ? concatBytes([pktLine(`# service=${service}\n`), FLUSH, err]) : err,
    `application/x-${service}-${advert ? 'advertisement' : 'result'}`,
  );
}

export type Loaded =
  | { ok: true; repo: RepoRecord; principal: Principal }
  | { ok: false; response: Response };

/** Why a Git or LFS request is refused; each protocol formats it its own way. */
export interface GitRefusal {
  kind: 'unauthorized' | 'not_found' | 'forbidden' | 'sso_required' | 'path_restricted';
  message: string;
  deniedBy?: Decision['deniedBy'];
}

/**
 * Git's formats: 401 with `WWW-Authenticate`, 404 and 403 envelopes, and
 * `ERR` lines for SSO and path rules so Git prints the reason.
 */
function gitRefuser(
  c: Context<AppEnv>,
  service: string,
  advert: boolean,
): (r: GitRefusal) => Response {
  return (r) => {
    if (r.kind === 'unauthorized') return unauthorized(c);
    if (r.kind === 'not_found') return apiError(c, 404, 'repo_not_found', r.message);
    if (r.kind === 'forbidden')
      return apiError(c, 403, 'forbidden', r.message, {
        ...(r.deniedBy ? { denied_by: r.deniedBy } : {}),
      });
    return gitError(service, `${r.kind}: ${r.message}`, advert);
  };
}

/**
 * The repo and caller for a Git or LFS request: 401 anonymous, 404
 * unreadable, 403 without write for a push, `path_restricted` for any read
 * or history restriction, and `sso_required` while org SSO withholds access.
 */
export async function loadGitRepo(
  c: Context<AppEnv>,
  perm: 'read' | 'write',
  refuse: (r: GitRefusal) => Response,
): Promise<Loaded> {
  const no = (r: GitRefusal): Loaded => ({ ok: false, response: refuse(r) });
  const principal = c.get('principal');
  if (!principal) return no({ kind: 'unauthorized', message: 'authentication required' });
  const slug = `${c.req.param('owner')}/${(c.req.param('repo') ?? '').slice(0, -'.git'.length)}`;
  const repo = await getRepoBySlug(c.env, slug);
  const sso = (d: Decision): GitRefusal | null =>
    d.ssoRequired
      ? {
          kind: 'sso_required',
          message: ssoMessage(d.ssoRequired, new URL(c.req.url).origin),
        }
      : null;
  const read = repo ? await decide(c.env, repo, principal, 'read') : null;
  const readRefused = read && sso(read);
  if (readRefused) return no(readRefused);
  if (!repo || !read?.allowed)
    return no({ kind: 'not_found', message: `no repo ${slug}` });
  if (perm === 'write') {
    const decision = await decide(c.env, repo, principal, 'write');
    const refused = sso(decision);
    if (refused) return no(refused);
    if (!decision.allowed) {
      return no({
        kind: 'forbidden',
        message: 'insufficient permission',
        ...(decision.deniedBy ? { deniedBy: decision.deniedBy } : {}),
      });
    }
  }
  // history too: a pack carries every path's full history
  const restricted = restrictingDecision(await pathDecider(c.env, repo, principal), [
    'read',
    'history',
  ]);
  if (restricted) {
    return no({
      kind: 'path_restricted',
      // the rule's prefix is not named: that would reveal the hidden path
      message:
        'permission rules hide part of this repository from you and Git needs the whole tree; use the yag CLI or the API',
    });
  }
  return { ok: true, repo, principal };
}

/** Request body, gunzipped when Git compressed it, refused past `max` bytes. */
async function readBody(c: Context<AppEnv>, max: number): Promise<Uint8Array> {
  let stream = c.req.raw.body;
  if (!stream) return new Uint8Array();
  if (c.req.header('content-encoding') === 'gzip') {
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new PayloadTooLargeError(
        `request body exceeds ${max} bytes`,
        'git_request_too_large',
        { limit: max },
      );
    }
    chunks.push(value);
  }
  return concatBytes(chunks);
}

/** `Git-Protocol: version=2` (colon-separated parameters). */
function wantsV2(c: Context<AppEnv>): boolean {
  return (c.req.header('git-protocol') ?? '').split(':').includes('version=2');
}

gitRoutes.get(`${REPO}/info/refs`, async (c) => {
  try {
    const service = c.req.query('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return apiError(c, 400, 'dumb_http_unsupported', 'only smart HTTP is supported');
    }
    const loaded = await loadGitRepo(
      c,
      service === 'git-receive-pack' ? 'write' : 'read',
      gitRefuser(c, service, true),
    );
    if (!loaded.ok) return loaded.response;
    if (service === 'git-receive-pack') {
      return gitResponse(
        await advertiseReceivePack(c.env, loaded.repo, loaded.principal),
        'application/x-git-receive-pack-advertisement',
      );
    }
    if (!wantsV2(c)) {
      return gitError(
        service,
        'this server speaks Git protocol v2 only; run git -c protocol.version=2 (the default since Git 2.26)',
        true,
      );
    }
    return gitResponse(advertiseV2(), 'application/x-git-upload-pack-advertisement');
  } catch (err) {
    if (err instanceof GitProtocolError)
      return gitError(c.req.query('service') ?? '', err.message, true);
    return errorResponse(c, err);
  }
});

gitRoutes.post(`${REPO}/git-upload-pack`, async (c) => {
  try {
    if (c.req.header('content-type') !== 'application/x-git-upload-pack-request') {
      return apiError(
        c,
        415,
        'unsupported_media_type',
        'expected a Git upload-pack request',
      );
    }
    const loaded = await loadGitRepo(c, 'read', gitRefuser(c, 'git-upload-pack', false));
    if (!loaded.ok) return loaded.response;
    if (!wantsV2(c)) {
      return gitError(
        'git-upload-pack',
        'this server speaks Git protocol v2 only',
        false,
      );
    }
    const { command, args } = parseCommand(await readBody(c, MAX_UPLOAD_REQUEST_BYTES));
    const type = 'application/x-git-upload-pack-result';
    if (command === 'ls-refs')
      return gitResponse(await lsRefs(c.env, loaded.repo, args), type);
    if (command === 'fetch')
      return gitResponse(await fetchPack(c.env, loaded.repo.id, args), type);
    throw new GitProtocolError(`unknown command ${JSON.stringify(command)}`);
  } catch (err) {
    if (err instanceof GitProtocolError || err instanceof PktLineError) {
      return gitError('git-upload-pack', err.message, false);
    }
    return errorResponse(c, err);
  }
});

gitRoutes.post(`${REPO}/git-receive-pack`, async (c) => {
  try {
    if (c.req.header('content-type') !== 'application/x-git-receive-pack-request') {
      return apiError(
        c,
        415,
        'unsupported_media_type',
        'expected a Git receive-pack request',
      );
    }
    const loaded = await loadGitRepo(
      c,
      'write',
      gitRefuser(c, 'git-receive-pack', false),
    );
    if (!loaded.ok) return loaded.response;
    const body = await readBody(c, PUSH_LIMITS.maxPackBytes);
    return gitResponse(
      await receivePack(c, loaded.repo, body),
      'application/x-git-receive-pack-result',
    );
  } catch (err) {
    if (err instanceof GitProtocolError || err instanceof PktLineError) {
      return gitError('git-receive-pack', err.message, false);
    }
    if (err instanceof PayloadTooLargeError) {
      return gitError(
        'git-receive-pack',
        `push too large: packs over ${PUSH_LIMITS.maxPackBytes} bytes are not accepted yet; push in smaller batches`,
        false,
      );
    }
    return errorResponse(c, err);
  }
});
