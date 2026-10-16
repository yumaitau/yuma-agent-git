import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, Principal } from '../auth/principal';
import { recordAudit } from '../audit/record';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { q } from '../db/client';
import type { RepoRecord } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { enforceAgentAction } from '../policy/guardrails';
import {
  authorize,
  credentialPrincipal,
  basicSecret,
  granted,
  guardedPrincipal,
  mintRegistryToken,
  registryCaller,
  REGISTRY_TOKEN_TTL_S,
  type Access,
  type PackageAction,
  type RegistryCaller,
} from './auth';
import {
  emitPackageEvent,
  ensurePackage,
  linkedSize,
  linkFile,
  linkStatement,
  packageRepo,
  type PackageRow,
} from './packages';
import {
  appendUpload,
  blobKey,
  DIGEST_RE,
  dropUpload,
  finishUpload,
  freeBytes,
  getUpload,
  putVerifiedBlob,
  quotaExceeded,
  RegistryError,
  startUpload,
  type UploadRow,
} from './storage';

/**
 * OCI distribution spec v1.1 (issue #53) at `/v2/`: blobs (monolithic,
 * chunked, cross-repo mount), manifests, tags, the referrers API and the
 * Bearer token flow `docker`, `helm` and `cosign` use. An image name starts
 * with the repo it belongs to, `owner/repo[/more]`; see registry/auth.ts for
 * who may pull and push.
 *
 * Errors use the spec's `{ errors: [{ code, message, detail }] }` and also
 * carry the forge envelope `error: { code, message }`. Anonymous callers get
 * 401 with `WWW-Authenticate: Bearer realm=".../v2/token"`; a registry
 * token lacking the action gets 401 naming the scope, so the client fetches
 * a wider one.
 */
export const ociRoutes = new Hono<AppEnv>();

const NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)+$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  OCI_INDEX,
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const INDEX_TYPES = new Set([
  OCI_INDEX,
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

function ociError(
  c: Context<AppEnv>,
  status: number,
  oci: string,
  message: string,
  extra: Record<string, unknown> = {},
  code = oci.toLowerCase(),
): Response {
  return c.json(
    {
      errors: [{ code: oci, message, detail: extra }],
      error: { code, message, ...extra },
    },
    status as ContentfulStatusCode,
  );
}

function challenge(c: Context<AppEnv>, scope?: string): Response {
  const url = new URL(c.req.url);
  const res = ociError(
    c,
    401,
    'UNAUTHORIZED',
    'authentication required',
    {},
    'unauthorized',
  );
  res.headers.set(
    'www-authenticate',
    `Bearer realm="${url.origin}/v2/token",service="${url.host}"${scope ? `,scope="${scope}"` : ''}`,
  );
  return res;
}

function fromError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof RegistryError)
    return ociError(c, err.status, err.oci, err.message, err.details);
  if (err instanceof ApiError) {
    const oci =
      err.status === 404 ? 'NAME_UNKNOWN' : err.status === 403 ? 'DENIED' : 'UNSUPPORTED';
    return ociError(c, err.status, oci, err.message, err.details, err.code);
  }
  console.error(err);
  return ociError(c, 500, 'UNKNOWN', 'internal error', {}, 'internal_error');
}

/** The repo an image name belongs to: its first two components. */
function nameRepo(c: Context<AppEnv>, name: string): Promise<RepoRecord | null> {
  const [owner, repo] = name.split('/');
  return getRepoBySlug(c.env, `${owner}/${repo}`);
}

interface Loaded {
  caller: RegistryCaller;
  name: string;
  pkg: PackageRow | null;
  repo: RepoRecord;
}

/** Caller, name and package for an `action`, or the response that refuses it. */
async function load(
  c: Context<AppEnv>,
  action: PackageAction,
): Promise<{ ok: true; value: Loaded } | { ok: false; response: Response }> {
  const name = c.req.param('name') ?? '';
  const origin = new URL(c.req.url).origin;
  const scope = `repository:${name}:${action === 'push' ? 'pull,push' : action}`;
  const caller = await registryCaller(c.env, c.req.header('authorization'), origin);
  if (!caller || !granted(caller, name, action))
    return { ok: false, response: challenge(c, scope) };
  if (!NAME_RE.test(name))
    return {
      ok: false,
      response: ociError(c, 400, 'NAME_INVALID', 'invalid repository name'),
    };
  const { pkg, repo } = await packageRepo(c.env, 'oci', name, () => nameRepo(c, name));
  if (!repo) return { ok: false, response: unknownName(c) };
  const refusal = await authorize(c.env, origin, caller.principal, repo, action);
  if (refusal) {
    const oci = refusal.status === 404 ? 'NAME_UNKNOWN' : 'DENIED';
    return {
      ok: false,
      response: ociError(
        c,
        refusal.status,
        oci,
        refusal.message,
        refusal.details,
        refusal.code,
      ),
    };
  }
  c.set('principal', caller.principal);
  return { ok: true, value: { caller, name, pkg, repo } };
}

function unknownName(c: Context<AppEnv>): Response {
  return ociError(c, 404, 'NAME_UNKNOWN', 'repository name not known to registry');
}

// --- ping and token ----------------------------------------------------------

ociRoutes.get('/v2/', async (c) => {
  const caller = await registryCaller(
    c.env,
    c.req.header('authorization'),
    new URL(c.req.url).origin,
  );
  if (!caller) return challenge(c);
  return c.json({}, 200, { 'docker-distribution-api-version': 'registry/2.0' });
});

const scopeRe = /^repository:([^:]+):([a-z*,]+)$/;
const tokenForm = z.object({
  grant_type: z.enum(['password', 'refresh_token']),
  username: z.string().optional(),
  password: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  service: z.string().optional(),
});

/** Grant each requested action the caller may take now; never fails on a denied one. */
async function issueToken(
  c: Context<AppEnv>,
  principal: Principal,
  scopes: string[],
): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const access: Access = [];
  for (const scope of scopes
    .flatMap((s) => s.split(' '))
    .filter(Boolean)
    .slice(0, 20)) {
    const m = scopeRe.exec(scope);
    if (!m || !NAME_RE.test(m[1]!)) continue;
    const name = m[1]!;
    const wanted = m[2]!
      .split(',')
      .flatMap((a) => (a === '*' ? ['pull', 'push', 'delete'] : [a]));
    const { repo } = await packageRepo(c.env, 'oci', name, () => nameRepo(c, name));
    if (!repo) continue;
    const actions: PackageAction[] = [];
    for (const action of ['pull', 'push', 'delete'] as const) {
      if (
        wanted.includes(action) &&
        !(await authorize(c.env, origin, principal, repo, action))
      )
        actions.push(action);
    }
    if (actions.length) access.push({ name, actions });
  }
  const token = await mintRegistryToken(c.env, principal, access);
  c.header('cache-control', 'no-store');
  return c.json({
    token,
    access_token: token,
    expires_in: REGISTRY_TOKEN_TTL_S,
    issued_at: new Date().toISOString(),
  });
}

function tokenUnauthorized(c: Context<AppEnv>): Response {
  const res = ociError(
    c,
    401,
    'UNAUTHORIZED',
    'sign in with a forge token',
    {},
    'unauthorized',
  );
  res.headers.set('www-authenticate', 'Basic realm="yuma-agent-git", charset="UTF-8"');
  return res;
}

ociRoutes.get('/v2/token', async (c) => {
  try {
    const header = c.req.header('authorization') ?? '';
    const secret = header.startsWith('Basic ')
      ? basicSecret(header)
      : header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    const principal = await credentialPrincipal(c.env, secret, new URL(c.req.url).origin);
    if (!principal) return tokenUnauthorized(c);
    return await issueToken(c, principal, c.req.queries('scope') ?? []);
  } catch (err) {
    return fromError(c, err);
  }
});

// OAuth2 password grant, which oras-go and helm use when told to
ociRoutes.post('/v2/token', async (c) => {
  try {
    const form = tokenForm.safeParse(Object.fromEntries(await c.req.formData()));
    if (!form.success)
      return ociError(c, 400, 'UNSUPPORTED', 'expected an OAuth2 token form');
    const secret =
      form.data.grant_type === 'password'
        ? form.data.password || form.data.username || ''
        : (form.data.refresh_token ?? '');
    const principal = await credentialPrincipal(c.env, secret, new URL(c.req.url).origin);
    if (!principal) return tokenUnauthorized(c);
    return await issueToken(c, principal, form.data.scope ? [form.data.scope] : []);
  } catch (err) {
    return fromError(c, err);
  }
});

// --- blobs -------------------------------------------------------------------

ociRoutes.get('/v2/:name{.+}/blobs/:digest', async (c) => {
  try {
    const loaded = await load(c, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg } = loaded.value;
    if (!pkg) return unknownName(c);
    const digest = c.req.param('digest');
    const size = DIGEST_RE.test(digest) ? await linkedSize(c.env, pkg.id, digest) : null;
    const headers = {
      'docker-content-digest': digest,
      'content-type': 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (size === null)
      return ociError(c, 404, 'BLOB_UNKNOWN', 'blob unknown to registry');
    if (c.req.method === 'HEAD')
      return new Response(null, {
        headers: { ...headers, 'content-length': String(size) },
      });
    const object = await c.env.OBJECTS.get(blobKey(digest));
    if (!object) return ociError(c, 404, 'BLOB_UNKNOWN', 'blob unknown to registry');
    return new Response(object.body, {
      headers: { ...headers, 'content-length': String(object.size) },
    });
  } catch (err) {
    return fromError(c, err);
  }
});

function uploadHeaders(name: string, upload: UploadRow) {
  return {
    location: `/v2/${name}/blobs/uploads/${upload.id}`,
    range: `0-${Math.max(0, upload.size - 1)}`,
    'docker-upload-uuid': upload.id,
    'content-length': '0',
  };
}

function created(name: string, digest: string): Response {
  return new Response(null, {
    status: 201,
    headers: {
      location: `/v2/${name}/blobs/${digest}`,
      'docker-content-digest': digest,
      'content-length': '0',
    },
  });
}

function bodyLength(c: Context<AppEnv>): number | null {
  const raw = c.req.header('content-length');
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** A monolithic upload: straight into the blob key when the length is known. */
async function putWhole(
  c: Context<AppEnv>,
  loaded: Loaded,
  pkg: PackageRow,
  digest: string,
  upload: UploadRow | null,
): Promise<Response> {
  if (!DIGEST_RE.test(digest))
    return ociError(c, 400, 'DIGEST_INVALID', 'only sha256 digests are supported');
  const free = await freeBytes(c.env, pkg.owner);
  const length = bodyLength(c);
  let size: number;
  if (upload === null && length !== null && c.req.raw.body) {
    if (length > free) throw quotaExceeded(c.env, pkg.owner);
    await putVerifiedBlob(c.env, digest, c.req.raw.body, length);
    size = length;
  } else {
    let session =
      upload ?? (await startUpload(c.env, pkg.id, loaded.caller.principal.userId));
    // Docker's closing PUT is usually empty: nothing to append
    if (length !== 0 && c.req.raw.body)
      session = await appendUpload(c.env, session, c.req.raw.body, free);
    await finishUpload(c.env, session, digest);
    size = session.size;
  }
  await linkFile(c.env, pkg.id, digest, size);
  return created(loaded.name, digest);
}

ociRoutes.post('/v2/:name{.+}/blobs/uploads/', async (c) => {
  try {
    const loaded = await load(c, 'push');
    if (!loaded.ok) return loaded.response;
    const { name, repo, caller } = loaded.value;
    const pkg = await ensurePackage(c.env, 'oci', name, repo, caller.principal.userId);
    const mount = c.req.query('mount');
    const from = c.req.query('from');
    if (mount && from && DIGEST_RE.test(mount) && NAME_RE.test(from)) {
      // a cross-repo mount needs pull on the source, and the blob linked there
      const source = await packageRepo(c.env, 'oci', from, async () => null);
      const allowed =
        source.pkg &&
        source.repo &&
        granted(caller, from, 'pull') &&
        !(await authorize(
          c.env,
          new URL(c.req.url).origin,
          caller.principal,
          source.repo,
          'pull',
        ));
      const size = allowed ? await linkedSize(c.env, source.pkg!.id, mount) : null;
      if (size !== null) {
        await freeBytes(c.env, pkg.owner, size);
        await linkFile(c.env, pkg.id, mount, size);
        return created(name, mount);
      }
    }
    const digest = c.req.query('digest');
    if (digest) return await putWhole(c, loaded.value, pkg, digest, null);
    const upload = await startUpload(c.env, pkg.id, caller.principal.userId);
    return new Response(null, { status: 202, headers: uploadHeaders(name, upload) });
  } catch (err) {
    return fromError(c, err);
  }
});

async function loadUpload(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; loaded: Loaded; pkg: PackageRow; upload: UploadRow }
  | { ok: false; response: Response }
> {
  const loaded = await load(c, 'push');
  if (!loaded.ok) return loaded;
  const { pkg } = loaded.value;
  const upload = pkg ? await getUpload(c.env, pkg.id, c.req.param('uuid') ?? '') : null;
  if (!pkg || !upload)
    return {
      ok: false,
      response: ociError(
        c,
        404,
        'BLOB_UPLOAD_UNKNOWN',
        'blob upload unknown to registry',
      ),
    };
  return { ok: true, loaded: loaded.value, pkg, upload };
}

ociRoutes.get('/v2/:name{.+}/blobs/uploads/:uuid', async (c) => {
  try {
    const found = await loadUpload(c);
    if (!found.ok) return found.response;
    return new Response(null, {
      status: 204,
      headers: uploadHeaders(found.loaded.name, found.upload),
    });
  } catch (err) {
    return fromError(c, err);
  }
});

ociRoutes.patch('/v2/:name{.+}/blobs/uploads/:uuid', async (c) => {
  try {
    const found = await loadUpload(c);
    if (!found.ok) return found.response;
    const { upload, pkg } = found;
    // chunks arrive in order: `Content-Range: <start>-<end>` must start where we are
    const range = c.req.header('content-range');
    if (range !== undefined) {
      const m = /^(\d+)-(\d+)$/.exec(range.trim());
      if (!m || Number(m[1]) !== upload.size) {
        return new Response(null, {
          status: 416,
          headers: uploadHeaders(found.loaded.name, upload),
        });
      }
    }
    const free = await freeBytes(c.env, pkg.owner);
    const next = await appendUpload(c.env, upload, c.req.raw.body, free);
    return new Response(null, {
      status: 202,
      headers: uploadHeaders(found.loaded.name, next),
    });
  } catch (err) {
    return fromError(c, err);
  }
});

ociRoutes.put('/v2/:name{.+}/blobs/uploads/:uuid', async (c) => {
  try {
    const found = await loadUpload(c);
    if (!found.ok) return found.response;
    const { upload, pkg, loaded } = found;
    return await putWhole(c, loaded, pkg, c.req.query('digest') ?? '', upload);
  } catch (err) {
    return fromError(c, err);
  }
});

ociRoutes.delete('/v2/:name{.+}/blobs/uploads/:uuid', async (c) => {
  try {
    const found = await loadUpload(c);
    if (!found.ok) return found.response;
    await dropUpload(c.env, found.upload);
    return new Response(null, { status: 204 });
  } catch (err) {
    return fromError(c, err);
  }
});

// --- manifests ---------------------------------------------------------------

const descriptor = z.object({
  mediaType: z.string().optional(),
  digest: z.string().regex(DIGEST_RE),
  size: z.number().int().nonnegative(),
  artifactType: z.string().optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  artifactType: z.string().optional(),
  config: descriptor.optional(),
  layers: z.array(descriptor).optional(),
  manifests: z.array(descriptor).optional(),
  subject: descriptor.optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

interface VersionRow {
  version: string;
  digest: string;
  media_type: string;
  artifact_type: string | null;
  size: number;
  metadata: string;
}

/** The manifest a tag or digest names. */
async function findManifest(
  c: Context<AppEnv>,
  pkg: PackageRow,
  reference: string,
): Promise<VersionRow | null> {
  const rows = await q<VersionRow>(
    c.env,
    DIGEST_RE.test(reference)
      ? `SELECT version, digest, media_type, artifact_type, size, metadata FROM package_versions
          WHERE package_id = ? AND version = ?`
      : `SELECT v.version, v.digest, v.media_type, v.artifact_type, v.size, v.metadata
           FROM package_tags t JOIN package_versions v
             ON v.package_id = t.package_id AND v.version = t.version
          WHERE t.package_id = ? AND t.tag = ?`,
    [pkg.id, reference],
  );
  return rows[0] ?? null;
}

ociRoutes.get('/v2/:name{.+}/manifests/:reference', async (c) => {
  try {
    const loaded = await load(c, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg } = loaded.value;
    if (!pkg) return unknownName(c);
    const manifest = await findManifest(c, pkg, c.req.param('reference'));
    if (!manifest)
      return ociError(c, 404, 'MANIFEST_UNKNOWN', 'manifest unknown to registry');
    const headers = {
      'content-type': manifest.media_type,
      'docker-content-digest': manifest.digest,
      'content-length': String(manifest.size),
    };
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    const object = await c.env.OBJECTS.get(blobKey(manifest.digest));
    if (!object)
      return ociError(c, 404, 'MANIFEST_UNKNOWN', 'manifest unknown to registry');
    return new Response(object.body, { headers });
  } catch (err) {
    return fromError(c, err);
  }
});

/** Read a request body of at most `max` bytes. */
async function readLimited(c: Context<AppEnv>, max: number): Promise<Uint8Array> {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (!reader) break;
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new RegistryError(
        413,
        'SIZE_INVALID',
        `manifests are limited to ${max} bytes`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

ociRoutes.put('/v2/:name{.+}/manifests/:reference', async (c) => {
  try {
    const loaded = await load(c, 'push');
    if (!loaded.ok) return loaded.response;
    const { name, repo, caller } = loaded.value;
    const reference = c.req.param('reference');
    const byDigest = DIGEST_RE.test(reference);
    if (!byDigest && !TAG_RE.test(reference))
      return ociError(c, 400, 'MANIFEST_INVALID', 'invalid tag');
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
    if (!MANIFEST_TYPES.has(mediaType))
      return ociError(
        c,
        400,
        'MANIFEST_INVALID',
        `unsupported manifest type ${mediaType}`,
      );
    const bytes = await readLimited(c, MAX_MANIFEST_BYTES);
    const digest = `sha256:${await sha256Hex(bytes)}`;
    if (byDigest && reference !== digest)
      return ociError(c, 400, 'DIGEST_INVALID', 'the manifest does not match its digest');
    let parsed: z.infer<typeof manifestSchema>;
    try {
      parsed = manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return ociError(
        c,
        400,
        'MANIFEST_INVALID',
        'the manifest is not valid JSON of schema version 2',
      );
    }
    if (parsed.mediaType && parsed.mediaType !== mediaType)
      return ociError(
        c,
        400,
        'MANIFEST_INVALID',
        'mediaType does not match Content-Type',
      );
    const isIndex = INDEX_TYPES.has(mediaType);
    if (isIndex ? !parsed.manifests : !parsed.config)
      return ociError(
        c,
        400,
        'MANIFEST_INVALID',
        isIndex ? 'an index lists manifests' : 'an image manifest has a config',
      );

    const pkg = await ensurePackage(c.env, 'oci', name, repo, caller.principal.userId);
    // every blob an image names, and every manifest an index names, must be here
    const blobs = isIndex
      ? []
      : [parsed.config!, ...(parsed.layers ?? [])].map((d) => d.digest);
    const children = isIndex ? parsed.manifests!.map((d) => d.digest) : [];
    for (const blob of blobs) {
      if ((await linkedSize(c.env, pkg.id, blob)) === null)
        return ociError(
          c,
          400,
          'MANIFEST_BLOB_UNKNOWN',
          `blob ${blob} is not in this repository`,
          { digest: blob },
        );
    }
    for (const child of children) {
      if (!(await findManifest(c, pkg, child)))
        return ociError(
          c,
          400,
          'MANIFEST_BLOB_UNKNOWN',
          `manifest ${child} is not in this repository`,
          { digest: child },
        );
    }
    // agent guardrails (#62): publishing a package is a release
    await enforceAgentAction(
      c.env,
      await guardedPrincipal(c.env, caller.principal),
      repo,
      { action: 'release.publish', ref: `packages/oci/${name}:${reference}` },
      {
        exact: { kind: 'oci', name, reference, digest },
        summary: { package: name, reference, digest },
      },
    );
    await freeBytes(c.env, pkg.owner, bytes.length);
    await putVerifiedBlob(c.env, digest, bytes, bytes.length);
    const artifactType =
      parsed.artifactType ?? (isIndex ? null : (parsed.config?.mediaType ?? null));
    const now = Date.now();
    const change = [
      linkStatement(c.env, pkg.id, digest, bytes.length),
      c.env.DB.prepare(
        `INSERT INTO package_versions
           (package_id, version, digest, media_type, artifact_type, subject, size, metadata, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (package_id, version) DO NOTHING`,
      ).bind(
        pkg.id,
        digest,
        digest,
        mediaType,
        artifactType,
        parsed.subject?.digest ?? null,
        bytes.length,
        JSON.stringify({ blobs, children, annotations: parsed.annotations ?? {} }),
        caller.principal.userId,
        now,
      ),
      ...(byDigest
        ? []
        : [
            c.env.DB.prepare(
              `INSERT INTO package_tags (package_id, tag, version, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (package_id, tag) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
            ).bind(pkg.id, reference, digest, now),
          ]),
    ];
    await recordAudit(
      c,
      {
        action: 'package.publish',
        repo,
        target: { kind: 'oci', package: name, reference, digest, media_type: mediaType },
      },
      change,
    );
    await emitPackageEvent(
      c.env,
      repo,
      pkg,
      'published',
      caller.principal,
      new URL(c.req.url).origin,
      {
        reference,
        digest,
        media_type: mediaType,
        ...(byDigest ? {} : { tag: reference }),
      },
    );
    const res = new Response(null, {
      status: 201,
      headers: {
        location: `/v2/${name}/manifests/${digest}`,
        'docker-content-digest': digest,
        'content-length': '0',
      },
    });
    if (parsed.subject) res.headers.set('oci-subject', parsed.subject.digest);
    return res;
  } catch (err) {
    return fromError(c, err);
  }
});

ociRoutes.delete('/v2/:name{.+}/manifests/:reference', async (c) => {
  try {
    const loaded = await load(c, 'delete');
    if (!loaded.ok) return loaded.response;
    const { pkg, repo, name } = loaded.value;
    if (!pkg) return unknownName(c);
    const reference = c.req.param('reference');
    const manifest = await findManifest(c, pkg, reference);
    if (!manifest)
      return ociError(c, 404, 'MANIFEST_UNKNOWN', 'manifest unknown to registry');
    const byDigest = DIGEST_RE.test(reference);
    // a digest deletes the manifest and its tags; a tag deletes just the tag
    const change = byDigest
      ? [
          c.env.DB.prepare(
            'DELETE FROM package_tags WHERE package_id = ? AND version = ?',
          ).bind(pkg.id, reference),
          c.env.DB.prepare(
            'DELETE FROM package_versions WHERE package_id = ? AND version = ?',
          ).bind(pkg.id, reference),
        ]
      : [
          c.env.DB.prepare(
            'DELETE FROM package_tags WHERE package_id = ? AND tag = ?',
          ).bind(pkg.id, reference),
        ];
    await recordAudit(
      c,
      {
        action: 'package.delete',
        repo,
        target: { kind: 'oci', package: name, reference, digest: manifest.digest },
      },
      change,
    );
    await emitPackageEvent(
      c.env,
      repo,
      pkg,
      'deleted',
      loaded.value.caller.principal,
      new URL(c.req.url).origin,
      {
        reference,
        digest: manifest.digest,
      },
    );
    return new Response(null, { status: 202 });
  } catch (err) {
    return fromError(c, err);
  }
});

// --- tags and referrers ------------------------------------------------------

ociRoutes.get('/v2/:name{.+}/tags/list', async (c) => {
  try {
    const loaded = await load(c, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg, name } = loaded.value;
    if (!pkg) return unknownName(c);
    const n = Math.min(Math.max(Number(c.req.query('n') ?? 1000) || 1000, 1), 1000);
    const last = c.req.query('last') ?? '';
    const rows = await q<{ tag: string }>(
      c.env,
      'SELECT tag FROM package_tags WHERE package_id = ? AND tag > ? ORDER BY tag LIMIT ?',
      [pkg.id, last, n + 1],
    );
    const tags = rows.slice(0, n).map((r) => r.tag);
    if (rows.length > n)
      c.header(
        'link',
        `</v2/${name}/tags/list?n=${n}&last=${encodeURIComponent(tags[tags.length - 1]!)}>; rel="next"`,
      );
    return c.json({ name, tags });
  } catch (err) {
    return fromError(c, err);
  }
});

ociRoutes.get('/v2/:name{.+}/referrers/:digest', async (c) => {
  try {
    const loaded = await load(c, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg } = loaded.value;
    const digest = c.req.param('digest');
    if (!DIGEST_RE.test(digest))
      return ociError(c, 400, 'DIGEST_INVALID', 'only sha256 digests are supported');
    const artifactType = c.req.query('artifactType');
    const rows = pkg
      ? await q<VersionRow>(
          c.env,
          `SELECT version, digest, media_type, artifact_type, size, metadata FROM package_versions
            WHERE package_id = ? AND subject = ?${artifactType ? ' AND artifact_type = ?' : ''}
            ORDER BY created_at LIMIT 1000`,
          artifactType ? [pkg.id, digest, artifactType] : [pkg.id, digest],
        )
      : [];
    if (artifactType) c.header('oci-filters-applied', 'artifactType');
    c.header('content-type', OCI_INDEX);
    return c.body(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: rows.map((r) => {
          const meta = z
            .object({ annotations: z.record(z.string(), z.string()).optional() })
            .parse(JSON.parse(r.metadata));
          return {
            mediaType: r.media_type,
            digest: r.digest,
            size: r.size,
            ...(r.artifact_type ? { artifactType: r.artifact_type } : {}),
            ...(meta.annotations && Object.keys(meta.annotations).length
              ? { annotations: meta.annotations }
              : {}),
          };
        }),
      }),
    );
  } catch (err) {
    return fromError(c, err);
  }
});
