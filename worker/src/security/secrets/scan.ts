import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../../env';
import type { Principal } from '../../auth/principal';
import type { RepoRecord } from '../../db/client';
import { q } from '../../db/client';
import { can } from '../../auth/rbac';
import { actorOf, recordAudit, type AuditActor } from '../../audit/record';
import { emitEvent } from '../../webhooks/events';
import { getBlob } from '../../core/blobs';
import { ApiError } from '../../core/errors';
import { sha256Hex } from '../../core/hashing';
import { lookupRev } from '../../core/read';
import { resolvePath } from '../../core/trees';
import type { Change } from '../../core/commit';
import {
  DETECTOR_NAMES,
  DETECTORS_VERSION,
  isBinary,
  redactSecrets,
  scanText,
} from './detectors';

/**
 * Push protection (issue #66): scan what a push or a commit adds, refuse it
 * when a secret is found, and let a repository admin bypass with a reason.
 * Every bypass is audited and raises an alert. Alerts hold a SHA-256 of the
 * secret and where it was found, never the secret itself.
 */

export const BYPASS_REASONS = ['false_positive', 'test_data', 'will_fix'] as const;
export type BypassReason = (typeof BYPASS_REASONS)[number];
export const bypassSchema = z.object({
  reason: z.enum(BYPASS_REASONS),
  comment: z.string().max(500).optional(),
});
export type Bypass = z.infer<typeof bypassSchema>;

/** Files larger than this are not scanned (the push limit is 24 MiB). */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** A secret found in a file: what and where, plus the hash of the value. */
export interface Located {
  detector: string;
  path: string;
  line: number;
  column: number;
  /** sha256 hex of the secret. */
  hash: string;
  /** Git commit SHA (push) the file came in. */
  commit?: string;
  changeset?: string;
}

const decoder = new TextDecoder();

/**
 * Secrets `content` adds: a secret that the file's previous version already
 * held is not new, so editing a file with an old alert does not block again.
 * `previous` is only read when the new content has a finding.
 */
export async function scanFile(
  path: string,
  content: Uint8Array,
  previous: () => Promise<Uint8Array | null> = async () => null,
): Promise<Located[]> {
  if (content.length > MAX_SCAN_BYTES || isBinary(content)) return [];
  const findings = scanText(decoder.decode(content));
  if (findings.length === 0) return [];
  const before = await previous();
  const old = before ? decoder.decode(before) : '';
  const out: Located[] = [];
  for (const f of findings) {
    if (old.includes(f.secret)) continue;
    out.push({
      detector: f.detector,
      path,
      line: f.line,
      column: f.column,
      hash: await sha256Hex(new TextEncoder().encode(f.secret)),
    });
  }
  return out;
}

/** Drop findings an admin already resolved as a false positive or test data here. */
export async function withoutDismissed(
  env: Env,
  repoId: string,
  found: Located[],
): Promise<Located[]> {
  if (found.length === 0) return found;
  const hashes = [...new Set(found.map((f) => f.hash))];
  const rows = await q<{ secret_hash: string }>(
    env,
    `SELECT DISTINCT secret_hash FROM secret_alerts
      WHERE repo_id = ? AND resolution IN ('false_positive', 'test_data')
        AND secret_hash IN (${hashes.map(() => '?').join(',')})`,
    [repoId, ...hashes],
  );
  const dismissed = new Set(rows.map((r) => r.secret_hash));
  return found.filter((f) => !dismissed.has(f.hash));
}

/** Who may push past a finding: a repository admin, never an agent. */
export async function canBypass(
  env: Env,
  repo: RepoRecord,
  principal: Principal | null,
): Promise<boolean> {
  if (principal === null || principal.kind === 'agent') return false;
  return can(env, repo, principal, 'admin');
}

/** `AWS access key ID at config/prod.env:3 (commit 1a2b3c4)`, first few only. */
export function describeFindings(found: Located[], max = 5): string {
  const parts = found.slice(0, max).map((f) => {
    const where = `${f.path}:${f.line}`;
    const commit = f.commit ? ` (commit ${f.commit.slice(0, 7)})` : '';
    return `${DETECTOR_NAMES[f.detector] ?? f.detector} at ${where}${commit}`;
  });
  const more = found.length > max ? `; and ${found.length - max} more` : '';
  return `${parts.join('; ')}${more}`;
}

/** Findings as API details (no secret, no hash: the hash is for alerts only). */
export function findingDetails(found: Located[]): Record<string, unknown>[] {
  return found.slice(0, 50).map((f) => ({
    detector: f.detector,
    path: f.path,
    line: f.line,
    column: f.column,
    ...(f.commit ? { commit: f.commit } : {}),
  }));
}

/** Push option that requests a bypass: `git push -o secret-scanning.bypass=<reason>`. */
export const BYPASS_OPTION = 'secret-scanning.bypass';
export const COMMENT_OPTION = 'secret-scanning.comment';

export function bypassFromPushOptions(options: string[]): Bypass | 'invalid' | null {
  const value = (key: string): string | undefined =>
    options
      .filter((o) => o.startsWith(`${key}=`))
      .map((o) => o.slice(key.length + 1))
      .pop();
  const reason = value(BYPASS_OPTION);
  if (reason === undefined) return null;
  const parsed = bypassSchema.safeParse({ reason, comment: value(COMMENT_OPTION) });
  return parsed.success ? parsed.data : 'invalid';
}

export function bypassHint(): string {
  return `remove the secret from the commits, or ask a repository admin to push with -o ${BYPASS_OPTION}=<${BYPASS_REASONS.join('|')}>`;
}

/** Content of `path` in changeset `rev`, or null. */
async function contentAt(
  env: Env,
  repoId: string,
  rev: string | null,
  path: string,
): Promise<Uint8Array | null> {
  if (rev === null) return null;
  const base = await lookupRev(env, repoId, rev);
  if (!base?.root_tree) return null;
  const entry = await resolvePath(env, repoId, base.root_tree, path.split('/'));
  if (!entry || entry.kind !== 'blob') return null;
  return (await getBlob(env, repoId, entry.hash))?.content ?? null;
}

/** Secrets the commit-RPC changes add on top of `firstParent`. */
export async function scanChanges(
  env: Env,
  repoId: string,
  changes: readonly Change[],
  firstParent: string | null,
): Promise<Located[]> {
  const out: Located[] = [];
  for (const change of changes) {
    if (change.op === 'del') continue;
    let content: Uint8Array | null = null;
    if ('content_b64' in change) {
      try {
        content = Uint8Array.from(atob(change.content_b64), (ch) => ch.charCodeAt(0));
      } catch {
        continue; // commitChanges refuses it as invalid base64
      }
    } else {
      content = (await getBlob(env, repoId, change.blob_sha256))?.content ?? null;
    }
    if (!content) continue;
    out.push(
      ...(await scanFile(change.path, content, () =>
        change.op === 'mod'
          ? contentAt(env, repoId, firstParent, change.path)
          : Promise.resolve(null),
      )),
    );
  }
  return withoutDismissed(env, repoId, out);
}

/**
 * The commit-RPC gate: no findings → null; findings without a bypass, or with
 * one the caller may not use → 403; an accepted bypass → the findings, for
 * `recordBypass` once the commit exists.
 */
export async function enforceSecretScan(
  env: Env,
  repo: RepoRecord,
  principal: Principal | null,
  changes: readonly Change[],
  firstParent: string | null,
  bypass: Bypass | undefined,
): Promise<Located[] | null> {
  const found = await scanChanges(env, repo.id, changes, firstParent);
  if (found.length === 0) return null;
  if (!bypass) {
    throw new ApiError(
      403,
      'secret_detected',
      `Secret scanning blocked this commit: ${describeFindings(found)}. Remove the secret, or a repository admin can send secret_scanning_bypass with a reason.`,
      {
        findings: findingDetails(found),
        bypass_reasons: [...BYPASS_REASONS],
        detectors_version: DETECTORS_VERSION,
      },
    );
  }
  if (!(await canBypass(env, repo, principal))) {
    throw new ApiError(
      403,
      'secret_bypass_forbidden',
      'Only a repository admin can bypass secret scanning',
      { findings: findingDetails(found) },
    );
  }
  return found;
}

export type AlertSource = 'push' | 'commit' | 'history';

/** Alert state for a bypass reason, as GitHub does it: only "will fix" stays open. */
function stateFor(bypass: Bypass | undefined): {
  state: string;
  resolution: string | null;
} {
  if (bypass?.reason === 'false_positive')
    return { state: 'resolved', resolution: 'false_positive' };
  if (bypass?.reason === 'test_data')
    return { state: 'resolved', resolution: 'test_data' };
  return { state: 'open', resolution: null };
}

/**
 * Insert one alert per (secret, path); a known one is left alone. New open
 * alerts are sent to `secret_scanning_alert` webhooks, which route them to
 * the owners. Returns how many alerts were created.
 */
export async function recordAlerts(
  env: Env,
  repo: RepoRecord,
  found: Located[],
  meta: {
    source: AlertSource;
    actor: AuditActor;
    bypass?: Bypass;
    origin?: string | null;
  },
): Promise<number> {
  const { state, resolution } = stateFor(meta.bypass);
  const person = meta.actor.onBehalfOf ?? meta.actor.id;
  let created = 0;
  for (const f of found) {
    const now = Date.now();
    const res = await env.DB.prepare(
      `INSERT INTO secret_alerts (repo_id, detector, secret_hash, path, line, changeset_id, source, state, resolution, bypass_reason, bypass_comment, created_by, created_at, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, secret_hash, path) DO NOTHING`,
    )
      .bind(
        repo.id,
        f.detector,
        f.hash,
        f.path,
        f.line,
        f.changeset ?? null,
        meta.source,
        state,
        resolution,
        meta.bypass?.reason ?? null,
        meta.bypass?.comment ? redactSecrets(meta.bypass.comment) : null,
        person,
        now,
        resolution ? person : null,
        resolution ? now : null,
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) continue;
    created++;
    if (state !== 'open') continue;
    await emitEvent(env, repo, {
      event: 'secret_scanning_alert',
      action: 'created',
      actor: meta.actor,
      origin: meta.origin ?? null,
      data: {
        alert: {
          id: res.meta.last_row_id,
          detector: f.detector,
          path: f.path,
          line: f.line,
          changeset: f.changeset ?? null,
          source: meta.source,
          bypass_reason: meta.bypass?.reason ?? null,
        },
      },
    });
  }
  return created;
}

/** After a bypassed push or commit lands: alerts plus a `secret_scanning.bypass` event. */
export async function recordBypass(
  c: Context,
  repo: RepoRecord,
  found: Located[],
  bypass: Bypass,
  where: { source: 'push' | 'commit'; via: string; ref?: string },
): Promise<void> {
  const principal = (c.get('principal') as Principal | null | undefined) ?? null;
  await recordAlerts(c.env as Env, repo, found, {
    source: where.source,
    actor: actorOf(principal),
    bypass,
    origin: new URL(c.req.url).origin,
  });
  await recordAudit(c, {
    action: 'secret_scanning.bypass',
    repo,
    target: {
      via: where.via,
      ...(where.ref ? { ref: where.ref } : {}),
      reason: bypass.reason,
      ...(bypass.comment ? { comment: redactSecrets(bypass.comment) } : {}),
      findings: found.slice(0, 50).map((f) => ({
        detector: f.detector,
        path: f.path,
        line: f.line,
        hash: f.hash,
        changeset: f.changeset ?? null,
      })),
    },
  });
}
