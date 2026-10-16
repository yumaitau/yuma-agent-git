import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, Principal } from '../auth/principal';
import { recordAudit } from '../audit/record';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { q, q1 } from '../db/client';
import type { RepoRecord } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { enforceAgentAction } from '../policy/guardrails';
import { authorize, registryCaller, type PackageAction } from './auth';
import {
  emitPackageEvent,
  ensurePackage,
  linkStatement,
  packageRepo,
  type PackageRow,
} from './packages';
import { blobKey, freeBytes, putVerifiedBlob, RegistryError } from './storage';

/**
 * npm registry subset (issue #53) under `/npm/`: publish, install (package
 * documents and tarballs), dist-tags and whoami, for scoped packages only.
 * `@owner/name` belongs to the owner's repo `owner/name`, or, when there is
 * no such repo, to the repo on this forge that package.json `repository`
 * names. Point a scope at it in `.npmrc`:
 *
 *   @owner:registry=https://<host>/npm/
 *   //<host>/npm/:_authToken=<forge token>
 *
 * Errors follow npm's `{ error: "<message>" }`, plus a stable `code`, since
 * npm prints `error` as text.
 */
export const npmRoutes = new Hono<AppEnv>();

const NAME_RE = /^@([a-z0-9][a-z0-9._~-]*)\/([a-z0-9][a-z0-9._~-]*)$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
/** npm sends the tarball base64 inside the JSON document, so it is read whole. */
const MAX_PUBLISH_BYTES = 64 * 1024 * 1024;
const NO_REPO =
  'no repository to link this package to: name it @owner/<repo> after a repository you can push to, or set package.json repository to one on this forge';

function npmError(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
): Response {
  const res = c.json({ error: message, code }, status as ContentfulStatusCode);
  if (status === 401)
    res.headers.set('www-authenticate', 'Bearer realm="yuma-agent-git"');
  return res;
}

function fromError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ApiError) return npmError(c, err.status, err.code, err.message);
  console.error(err);
  return npmError(c, 500, 'internal_error', 'internal error');
}

interface Loaded {
  principal: Principal;
  name: string;
  short: string;
  pkg: PackageRow | null;
  repo: RepoRecord;
}

/**
 * Caller, package and linked repo for an action. `linkTo` names the repo a
 * new package would link to (publish reads it from package.json).
 */
async function load(
  c: Context<AppEnv>,
  rawName: string,
  action: PackageAction,
  linkTo?: () => Promise<RepoRecord | null>,
): Promise<{ ok: true; value: Loaded } | { ok: false; response: Response }> {
  const origin = new URL(c.req.url).origin;
  const caller = await registryCaller(c.env, c.req.header('authorization'), origin);
  // registry tokens are for /v2/ only
  if (!caller || caller.access !== null)
    return {
      ok: false,
      response: npmError(c, 401, 'unauthorized', 'authentication required'),
    };
  const m = NAME_RE.exec(rawName);
  if (!m || rawName.length > 214)
    return {
      ok: false,
      response: npmError(
        c,
        400,
        'invalid_package_name',
        'only scoped packages (@owner/name) are served here',
      ),
    };
  const [, scope, short] = m as unknown as [string, string, string];
  const { pkg, repo } = await packageRepo(
    c.env,
    'npm',
    rawName,
    async () =>
      (await getRepoBySlug(c.env, `${scope}/${short}`)) ?? (linkTo ? linkTo() : null),
  );
  const notFound = (): Response =>
    npmError(
      c,
      404,
      'not_found',
      pkg || action !== 'push' ? 'package not found' : NO_REPO,
    );
  if (!repo) return { ok: false, response: notFound() };
  const refusal = await authorize(c.env, origin, caller.principal, repo, action);
  if (refusal?.status === 404) return { ok: false, response: notFound() };
  if (refusal)
    return { ok: false, response: npmError(c, 403, refusal.code, refusal.message) };
  c.set('principal', caller.principal);
  return {
    ok: true,
    value: { principal: caller.principal, name: rawName, short, pkg, repo },
  };
}

const versionMeta = z.looseObject({
  name: z.string(),
  version: z.string(),
  dist: z.looseObject({ shasum: z.string(), integrity: z.string() }),
});

function tarballUrl(
  origin: string,
  name: string,
  short: string,
  version: string,
): string {
  return `${origin}/npm/${name}/-/${short}-${version}.tgz`;
}

/** The package document npm install reads. */
async function packument(c: Context<AppEnv>, raw: string): Promise<Response> {
  try {
    const loaded = await load(c, raw, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg, name, short } = loaded.value;
    if (!pkg) return npmError(c, 404, 'not_found', 'package not found');
    const origin = new URL(c.req.url).origin;
    const [versions, tags] = await Promise.all([
      q<{ version: string; metadata: string; created_at: number }>(
        c.env,
        'SELECT version, metadata, created_at FROM package_versions WHERE package_id = ? ORDER BY created_at',
        [pkg.id],
      ),
      q<{ tag: string; version: string }>(
        c.env,
        'SELECT tag, version FROM package_tags WHERE package_id = ?',
        [pkg.id],
      ),
    ]);
    const time: Record<string, string> = {
      created: new Date(pkg.created_at).toISOString(),
    };
    const docs: Record<string, unknown> = {};
    for (const v of versions) {
      const meta = versionMeta.parse(JSON.parse(v.metadata));
      docs[v.version] = {
        ...meta,
        dist: { ...meta.dist, tarball: tarballUrl(origin, name, short, v.version) },
      };
      time[v.version] = new Date(v.created_at).toISOString();
    }
    time.modified = new Date(versions.at(-1)?.created_at ?? pkg.created_at).toISOString();
    c.header('cache-control', 'private, no-cache');
    return c.json({
      _id: name,
      name,
      'dist-tags': Object.fromEntries(tags.map((t) => [t.tag, t.version])),
      versions: docs,
      time,
    });
  } catch (err) {
    return fromError(c, err);
  }
}

npmRoutes.get('/npm/-/whoami', async (c) => {
  try {
    const caller = await registryCaller(
      c.env,
      c.req.header('authorization'),
      new URL(c.req.url).origin,
    );
    if (!caller || caller.access !== null)
      return npmError(c, 401, 'unauthorized', 'authentication required');
    const user = await q1<{ login: string }>(
      c.env,
      'SELECT login FROM users WHERE id = ?',
      [caller.principal.userId],
    );
    return c.json({ username: user?.login ?? caller.principal.userId });
  } catch (err) {
    return fromError(c, err);
  }
});

npmRoutes.get('/npm/-/package/:pkg/dist-tags', async (c) => {
  try {
    const loaded = await load(c, c.req.param('pkg'), 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg } = loaded.value;
    if (!pkg) return npmError(c, 404, 'not_found', 'package not found');
    const tags = await q<{ tag: string; version: string }>(
      c.env,
      'SELECT tag, version FROM package_tags WHERE package_id = ?',
      [pkg.id],
    );
    return c.json(Object.fromEntries(tags.map((t) => [t.tag, t.version])));
  } catch (err) {
    return fromError(c, err);
  }
});

async function changeTag(c: Context<AppEnv>, remove: boolean): Promise<Response> {
  try {
    const loaded = await load(c, c.req.param('pkg') ?? '', 'push');
    if (!loaded.ok) return loaded.response;
    const { pkg, repo, name, principal } = loaded.value;
    if (!pkg) return npmError(c, 404, 'not_found', 'package not found');
    const tag = c.req.param('tag') ?? '';
    if (!TAG_RE.test(tag)) return npmError(c, 400, 'invalid_tag', 'invalid dist-tag');
    let version: string | null = null;
    if (remove) {
      if (tag === 'latest')
        return npmError(c, 400, 'invalid_tag', 'the latest tag cannot be removed');
    } else {
      const body = z.string().safeParse(await c.req.json().catch(() => null));
      if (!body.success)
        return npmError(c, 400, 'invalid_request', 'send the version as a JSON string');
      version = body.data;
      const exists = await q1(
        c.env,
        'SELECT 1 FROM package_versions WHERE package_id = ? AND version = ?',
        [pkg.id, version],
      );
      if (!exists) return npmError(c, 404, 'version_not_found', `no version ${version}`);
    }
    const statement = remove
      ? c.env.DB.prepare(
          'DELETE FROM package_tags WHERE package_id = ? AND tag = ?',
        ).bind(pkg.id, tag)
      : c.env.DB.prepare(
          `INSERT INTO package_tags (package_id, tag, version, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (package_id, tag) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
        ).bind(pkg.id, tag, version, Date.now());
    await recordAudit(
      c,
      {
        action: 'package.tag',
        repo,
        target: { kind: 'npm', package: name, tag, version },
      },
      [statement],
    );
    await emitPackageEvent(
      c.env,
      repo,
      pkg,
      'tagged',
      principal,
      new URL(c.req.url).origin,
      {
        tag,
        version,
      },
    );
    return c.json({ ok: true });
  } catch (err) {
    return fromError(c, err);
  }
}

npmRoutes.put('/npm/-/package/:pkg/dist-tags/:tag', (c) => changeTag(c, false));
npmRoutes.delete('/npm/-/package/:pkg/dist-tags/:tag', (c) => changeTag(c, true));

npmRoutes.get('/npm/:scope/:name/-/:file', async (c) => {
  try {
    const raw = `${c.req.param('scope')}/${c.req.param('name')}`;
    const loaded = await load(c, raw, 'pull');
    if (!loaded.ok) return loaded.response;
    const { pkg, short } = loaded.value;
    const file = c.req.param('file');
    const prefix = `${short}-`;
    const version =
      file.startsWith(prefix) && file.endsWith('.tgz')
        ? file.slice(prefix.length, -4)
        : '';
    const row = pkg
      ? await q1<{ digest: string; size: number }>(
          c.env,
          'SELECT digest, size FROM package_versions WHERE package_id = ? AND version = ?',
          [pkg.id, version],
        )
      : null;
    const object = row ? await c.env.OBJECTS.get(blobKey(row.digest)) : null;
    if (!object) return npmError(c, 404, 'not_found', 'tarball not found');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(object.size),
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return fromError(c, err);
  }
});

npmRoutes.get('/npm/:scope/:name', (c) =>
  packument(c, `${c.req.param('scope')}/${c.req.param('name')}`),
);
// npm itself asks for `@scope%2fname`
npmRoutes.get('/npm/:pkg', (c) => packument(c, c.req.param('pkg')));

export const publishSchema = z.looseObject({
  name: z.string(),
  'dist-tags': z.record(z.string(), z.string()).default({}),
  versions: z.record(
    z.string(),
    z.looseObject({ name: z.string(), version: z.string() }),
  ),
  _attachments: z.record(
    z.string(),
    z.object({
      content_type: z.string().optional(),
      data: z.string(),
      length: z.number().optional(),
    }),
  ),
});

/** package.json `repository` on this forge, as a repo of the package's scope. */
function repositoryRepo(
  c: Context<AppEnv>,
  scope: string,
  repository: unknown,
): Promise<RepoRecord | null> {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? String((repository as { url: unknown }).url)
        : '';
  try {
    const url = new URL(raw.replace(/^git\+/, ''));
    const [owner, repo] = url.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/, '')
      .split('/');
    if (url.host !== new URL(c.req.url).host || owner !== scope || !repo)
      return Promise.resolve(null);
    return getRepoBySlug(c.env, `${owner}/${repo}`);
  } catch {
    return Promise.resolve(null);
  }
}

async function readText(c: Context<AppEnv>, max: number): Promise<string> {
  const reader = c.req.raw.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
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
        `publish documents are limited to ${max} bytes`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function base64Bytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function digestOf(
  algorithm: 'SHA-1' | 'SHA-512',
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource));
}

npmRoutes.put('/npm/:pkg', async (c) => {
  try {
    let doc: z.infer<typeof publishSchema>;
    try {
      doc = publishSchema.parse(JSON.parse(await readText(c, MAX_PUBLISH_BYTES)));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return npmError(c, 400, 'invalid_request', 'expected an npm publish document');
    }
    const name = c.req.param('pkg');
    const entries = Object.entries(doc.versions);
    const attachments = Object.values(doc._attachments);
    if (doc.name !== name || entries.length !== 1 || attachments.length !== 1)
      return npmError(
        c,
        400,
        'invalid_request',
        'publish one version of this package with its tarball (unpublish and deprecate are not supported)',
      );
    const [version, manifest] = entries[0]!;
    if (
      manifest.name !== name ||
      manifest.version !== version ||
      !VERSION_RE.test(version)
    )
      return npmError(
        c,
        400,
        'invalid_version',
        'the version is not valid semver for this package',
      );
    const scope = NAME_RE.exec(name)?.[1] ?? '';
    const loaded = await load(c, name, 'push', () =>
      repositoryRepo(c, scope, manifest.repository),
    );
    if (!loaded.ok) return loaded.response;
    const { repo, principal } = loaded.value;

    let tarball: Uint8Array;
    try {
      tarball = base64Bytes(attachments[0]!.data);
    } catch {
      return npmError(c, 400, 'invalid_request', 'the tarball is not base64');
    }
    const integrity = `sha512-${btoa(String.fromCharCode(...(await digestOf('SHA-512', tarball))))}`;
    const shasum = [...(await digestOf('SHA-1', tarball))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const dist = z
      .object({ integrity: z.string().optional(), shasum: z.string().optional() })
      .loose()
      .safeParse(manifest.dist ?? {});
    if (
      !dist.success ||
      (dist.data.integrity && dist.data.integrity !== integrity) ||
      (dist.data.shasum && dist.data.shasum !== shasum)
    )
      return npmError(
        c,
        400,
        'integrity_mismatch',
        'the tarball does not match dist.integrity',
      );

    const pkg =
      loaded.value.pkg ??
      (await ensurePackage(c.env, 'npm', name, repo, principal.userId));
    const exists = await q1(
      c.env,
      'SELECT 1 FROM package_versions WHERE package_id = ? AND version = ?',
      [pkg.id, version],
    );
    if (exists)
      return npmError(
        c,
        409,
        'version_exists',
        `cannot publish over the previously published version ${version}`,
      );
    const digest = `sha256:${await sha256Hex(tarball)}`;
    // agent guardrails (#62): publishing a package is a release
    await enforceAgentAction(
      c.env,
      principal,
      repo,
      { action: 'release.publish', ref: `packages/npm/${name}@${version}` },
      {
        exact: { kind: 'npm', name, version, digest },
        summary: { package: name, version, digest },
      },
    );
    await freeBytes(c.env, pkg.owner, tarball.length);
    await putVerifiedBlob(c.env, digest, tarball, tarball.length);
    const { dist: _dist, ...rest } = manifest;
    const metadata = { ...rest, dist: { shasum, integrity } };
    const now = Date.now();
    const tags = Object.entries(doc['dist-tags']).filter(
      ([tag, v]) => v === version && TAG_RE.test(tag),
    );
    await recordAudit(
      c,
      {
        action: 'package.publish',
        repo,
        target: {
          kind: 'npm',
          package: name,
          version,
          digest,
          tags: tags.map(([t]) => t),
        },
      },
      [
        linkStatement(c.env, pkg.id, digest, tarball.length),
        c.env.DB.prepare(
          `INSERT INTO package_versions
             (package_id, version, digest, media_type, artifact_type, subject, size, metadata, created_by, created_at)
           VALUES (?, ?, ?, 'application/octet-stream', NULL, NULL, ?, ?, ?, ?)`,
        ).bind(
          pkg.id,
          version,
          digest,
          tarball.length,
          JSON.stringify(metadata),
          principal.userId,
          now,
        ),
        ...tags.map(([tag]) =>
          c.env.DB.prepare(
            `INSERT INTO package_tags (package_id, tag, version, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (package_id, tag) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
          ).bind(pkg.id, tag, version, now),
        ),
      ],
    );
    await emitPackageEvent(
      c.env,
      repo,
      pkg,
      'published',
      principal,
      new URL(c.req.url).origin,
      {
        version,
        digest,
        tags: tags.map(([t]) => t),
      },
    );
    return c.json({ ok: true, id: name, version }, 201);
  } catch (err) {
    return fromError(c, err);
  }
});
