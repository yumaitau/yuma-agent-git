import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { actorOf } from '../audit/record';
import { ulid } from '../core/ids';
import { q, q1, run } from '../db/client';
import type { RepoRecord } from '../db/client';
import { getRepo } from '../db/repos';
import { emitEvent } from '../webhooks/events';
import { BLOB_PREFIX, dropUpload } from './storage';

/**
 * Package metadata in D1 (issue #53): `packages` linked to a repo,
 * `package_versions` (OCI manifests, npm versions), `package_tags` (OCI tags,
 * npm dist-tags) and `package_files` (the blobs a package may serve).
 */

export type PackageKind = 'oci' | 'npm';

export const packageRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['oci', 'npm']),
  name: z.string(),
  repo_id: z.string(),
  owner: z.string(),
  keep_untagged: z.number().int().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type PackageRow = z.infer<typeof packageRowSchema>;

export async function findPackage(
  env: Env,
  kind: PackageKind,
  name: string,
): Promise<PackageRow | null> {
  const row = await q1(env, 'SELECT * FROM packages WHERE kind = ? AND name = ?', [
    kind,
    name,
  ]);
  return row ? packageRowSchema.parse(row) : null;
}

/**
 * The package and the repo it is linked to. An existing package keeps the
 * repo it was first pushed to; a new one links to `fallback`.
 */
export async function packageRepo(
  env: Env,
  kind: PackageKind,
  name: string,
  fallback: () => Promise<RepoRecord | null>,
): Promise<{ pkg: PackageRow | null; repo: RepoRecord | null }> {
  const pkg = await findPackage(env, kind, name);
  return { pkg, repo: pkg ? await getRepo(env, pkg.repo_id) : await fallback() };
}

/** The package row, created and linked to `repo` on first push. */
export async function ensurePackage(
  env: Env,
  kind: PackageKind,
  name: string,
  repo: RepoRecord,
  userId: string,
): Promise<PackageRow> {
  const now = Date.now();
  await run(
    env,
    `INSERT INTO packages (id, kind, name, repo_id, owner, keep_untagged, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT (kind, name) DO NOTHING`,
    [ulid(), kind, name, repo.id, repo.slug.split('/')[0], userId, now, now],
  );
  const pkg = await findPackage(env, kind, name);
  if (!pkg) throw new Error('package row missing after insert');
  return pkg;
}

/** Size of a blob this package may serve, or null when it is not linked. */
export async function linkedSize(
  env: Env,
  packageId: string,
  digest: string,
): Promise<number | null> {
  const row = await q1<{ size: number }>(
    env,
    'SELECT size FROM package_files WHERE package_id = ? AND digest = ?',
    [packageId, digest],
  );
  return row?.size ?? null;
}

export function linkStatement(
  env: Env,
  packageId: string,
  digest: string,
  size: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO package_files (package_id, digest, size, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (package_id, digest) DO NOTHING`,
  ).bind(packageId, digest, size, Date.now());
}

export async function linkFile(
  env: Env,
  packageId: string,
  digest: string,
  size: number,
): Promise<void> {
  await linkStatement(env, packageId, digest, size).run();
}

/** A `package` webhook event (yag format only; GitHub's shape has no equivalent here). */
export async function emitPackageEvent(
  env: Env,
  repo: RepoRecord,
  pkg: PackageRow,
  action: 'published' | 'deleted' | 'tagged',
  principal: Principal,
  origin: string,
  data: Record<string, unknown>,
): Promise<void> {
  await emitEvent(env, repo, {
    event: 'package',
    action,
    actor: actorOf(principal),
    origin,
    data: { package: { id: pkg.id, kind: pkg.kind, name: pkg.name }, ...data },
  });
}

// --- retention and cleanup (cron) --------------------------------------------

/** Untagged manifests past the newest `keep`, unless an index or a live subject needs them. */
const PRUNABLE = `SELECT v.version, v.digest FROM package_versions v
  WHERE v.package_id = ?1
    AND NOT EXISTS (SELECT 1 FROM package_tags t
                     WHERE t.package_id = v.package_id AND t.version = v.version)
    AND NOT EXISTS (SELECT 1 FROM package_versions i, json_each(i.metadata, '$.children') j
                     WHERE i.package_id = v.package_id AND j.value = v.version)
    AND (v.subject IS NULL OR NOT EXISTS (SELECT 1 FROM package_versions s
                     WHERE s.package_id = v.package_id AND s.version = v.subject))
  ORDER BY v.created_at DESC, v.version DESC LIMIT 100 OFFSET ?2`;

/** Links no remaining manifest uses, a day after they were made (pushes in flight keep theirs). */
const UNUSED_LINKS = `SELECT f.digest FROM package_files f
  WHERE f.package_id = ?1 AND f.created_at < ?2
    AND NOT EXISTS (SELECT 1 FROM package_versions v
                     WHERE v.package_id = f.package_id AND v.digest = f.digest)
    AND NOT EXISTS (SELECT 1 FROM package_versions v, json_each(v.metadata, '$.blobs') b
                     WHERE v.package_id = f.package_id AND b.value = f.digest)
  LIMIT 200`;

const DAY_MS = 86_400_000;

/**
 * One cron pass: apply each OCI package's `keep_untagged`, drop blob links no
 * manifest uses, delete R2 blobs no package links (unless rewritten within a
 * day), abandoned uploads and expired registry tokens. Bounded per pass.
 */
export async function registryCleanup(env: Env, now = Date.now()): Promise<void> {
  await run(env, 'DELETE FROM registry_tokens WHERE expires_at < ?', [now]);
  const stale = await q<{ id: string; r2_upload_id: string | null }>(
    env,
    'SELECT id, r2_upload_id FROM registry_uploads WHERE updated_at < ? LIMIT 20',
    [now - DAY_MS],
  );
  for (const upload of stale) await dropUpload(env, upload);

  // the least recently swept first; the sweep bumps updated_at
  const packages = await q<{ id: string; keep_untagged: number | null }>(
    env,
    "SELECT id, keep_untagged FROM packages WHERE kind = 'oci' ORDER BY updated_at LIMIT 20",
  );
  for (const pkg of packages) {
    const prunable =
      pkg.keep_untagged === null
        ? []
        : await q<{ version: string }>(env, PRUNABLE, [pkg.id, pkg.keep_untagged]);
    for (const v of prunable) {
      await run(
        env,
        'DELETE FROM package_versions WHERE package_id = ? AND version = ?',
        [pkg.id, v.version],
      );
    }
    const unused = await q<{ digest: string }>(env, UNUSED_LINKS, [pkg.id, now - DAY_MS]);
    for (const f of unused) {
      await run(env, 'DELETE FROM package_files WHERE package_id = ? AND digest = ?', [
        pkg.id,
        f.digest,
      ]);
      const elsewhere = await q1(env, 'SELECT 1 FROM package_files WHERE digest = ?', [
        f.digest,
      ]);
      const key = `${BLOB_PREFIX}${f.digest.slice('sha256:'.length)}`;
      const head = elsewhere ? null : await env.OBJECTS.head(key);
      if (head && head.uploaded.getTime() < now - DAY_MS) await env.OBJECTS.delete(key);
    }
    await run(env, 'UPDATE packages SET updated_at = ? WHERE id = ?', [now, pkg.id]);
  }
}
