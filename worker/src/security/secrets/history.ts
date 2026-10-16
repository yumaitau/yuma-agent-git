import { z } from 'zod';
import type { Env } from '../../env';
import type { AuditActor } from '../../audit/record';
import { q, q1, run } from '../../db/client';
import { getRepo } from '../../db/repos';
import { fileChangeSchema } from '../../db/client';
import { getBlob } from '../../core/blobs';
import { ulid } from '../../core/ids';
import { storageId } from '../../core/network';
import { recordAlerts, scanFile, withoutDismissed, type Located } from './scan';

/**
 * History scan (issue #66): a background job over the `derived-data` queue
 * that scans every file version a repository holds, oldest changeset first,
 * and raises an alert for each secret found. It starts on import and from the
 * alerts API. Each message scans one slice and queues the next, so a large
 * repository never runs into one invocation's limits.
 */

export const SCAN_SLICE = 25;

export interface SecretScanMessage {
  secret_scan: string;
}

export function isSecretScanMessage(body: unknown): body is SecretScanMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { secret_scan?: unknown }).secret_scan === 'string'
  );
}

const scanRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed']),
  cursor_at: z.number().nullable(),
  cursor_id: z.string().nullable(),
  changesets: z.number(),
  files: z.number(),
  alerts: z.number(),
  error: z.string().nullable(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type SecretScan = z.infer<typeof scanRowSchema>;

async function scanRow(
  env: Env,
  sql: string,
  params: unknown[],
): Promise<SecretScan | null> {
  const row = await q1(env, sql, params);
  return row ? scanRowSchema.parse(row) : null;
}

/** Queue a history scan of `repoId`; one already queued or running is reused. */
export async function startSecretScan(
  env: Env,
  repoId: string,
  actor: AuditActor,
): Promise<SecretScan> {
  const active = await scanRow(
    env,
    "SELECT * FROM secret_scans WHERE repo_id = ? AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    [repoId],
  );
  if (active) return active;
  const now = Date.now();
  const scan: SecretScan = {
    id: ulid(now),
    repo_id: repoId,
    state: 'queued',
    cursor_at: null,
    cursor_id: null,
    changesets: 0,
    files: 0,
    alerts: 0,
    error: null,
    created_by: actor.id,
    created_at: now,
    updated_at: now,
  };
  await run(
    env,
    `INSERT INTO secret_scans (id, repo_id, state, created_by, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    [scan.id, repoId, actor.id, now, now],
  );
  await env.DERIVED_QUEUE.send({ secret_scan: scan.id } satisfies SecretScanMessage);
  return scan;
}

export async function latestSecretScan(
  env: Env,
  repoId: string,
): Promise<SecretScan | null> {
  return scanRow(
    env,
    'SELECT * FROM secret_scans WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1',
    [repoId],
  );
}

const changedFiles = z.array(fileChangeSchema);

/**
 * Scan the next slice of changesets. Returns true when the scan is finished
 * (or gone), false when another slice remains.
 */
export async function runSecretScanSlice(
  env: Env,
  scanId: string,
  slice = SCAN_SLICE,
): Promise<boolean> {
  const scan = await scanRow(env, 'SELECT * FROM secret_scans WHERE id = ?', [scanId]);
  if (!scan || scan.state === 'done' || scan.state === 'failed') return true;
  const repo = await getRepo(env, scan.repo_id);
  if (!repo) {
    await run(env, "UPDATE secret_scans SET state = 'failed', error = ? WHERE id = ?", [
      'repository not found',
      scanId,
    ]);
    return true;
  }
  const rows = await q<{ id: string; created_at: number; changed_files: string }>(
    env,
    `SELECT id, created_at, changed_files FROM changesets
      WHERE repo_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id LIMIT ?`,
    // a fork scans its network's changesets (core/network.ts)
    [
      storageId(repo.id),
      scan.cursor_at ?? -1,
      scan.cursor_at ?? -1,
      scan.cursor_id ?? '',
      slice,
    ],
  );
  let files = 0;
  const found: Located[] = [];
  for (const row of rows) {
    for (const file of changedFiles.parse(JSON.parse(row.changed_files))) {
      if (file.op === 'del' || !file.hash) continue;
      const blob = await getBlob(env, repo.id, file.hash);
      if (!blob) continue;
      files++;
      for (const f of await scanFile(file.path, blob.content))
        found.push({ ...f, changeset: row.id });
    }
  }
  const alerts = await recordAlerts(
    env,
    repo,
    await withoutDismissed(env, repo.id, found),
    {
      source: 'history',
      actor: { kind: 'system', id: 'secret-scanning' },
    },
  );
  const last = rows[rows.length - 1];
  const done = rows.length < slice;
  await run(
    env,
    `UPDATE secret_scans SET state = ?, cursor_at = ?, cursor_id = ?, changesets = changesets + ?,
        files = files + ?, alerts = alerts + ?, updated_at = ? WHERE id = ?`,
    [
      done ? 'done' : 'running',
      last?.created_at ?? scan.cursor_at,
      last?.id ?? scan.cursor_id,
      rows.length,
      files,
      alerts,
      Date.now(),
      scanId,
    ],
  );
  return done;
}

/** Queue consumer step: scan a slice, queue the next, give up after three tries. */
export async function secretScanMessage(
  env: Env,
  message: Message<SecretScanMessage>,
): Promise<void> {
  const scanId = message.body.secret_scan;
  try {
    if (!(await runSecretScanSlice(env, scanId))) {
      await env.DERIVED_QUEUE.send({ secret_scan: scanId } satisfies SecretScanMessage);
    }
    message.ack();
  } catch (err) {
    if (message.attempts < 3) {
      message.retry();
      return;
    }
    console.error('secret scan: giving up', scanId, err);
    await run(env, "UPDATE secret_scans SET state = 'failed', error = ? WHERE id = ?", [
      err instanceof Error ? err.message.slice(0, 200) : 'scan failed',
      scanId,
    ]);
    message.ack();
  }
}
