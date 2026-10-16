import { z } from 'zod';
import type { Env } from '../env';
import { ulid } from '../core/ids';
import { q, q1, run } from '../db/client';

/**
 * Backups and restore (issue #70); docs/operations/backup-dr.md is the runbook.
 *
 * A backup copies every D1 table and a manifest of every R2 object key to the
 * `BACKUPS` bucket (a separate bucket, meant for a separate account) under
 * `backups/<id>/`. Each part is encrypted with AES-256-GCM under
 * `BACKUP_ENCRYPTION_KEY`, a Worker secret that is never written to D1 or R2,
 * with the part's key as associated data. The cron starts one every
 * `BACKUP_INTERVAL_MINUTES` (15) and moves it along a few pages per tick, so a
 * large database never holds a tick for long; finished backups past
 * `BACKUP_RETENTION_DAYS` (30) are deleted, the newest always kept.
 *
 * The D1 copy is read table by table across ticks, so it is not a single
 * point in time: rows written meanwhile may be missing or newer. D1 Time
 * Travel stays the in-account point-in-time restore; this is the copy that
 * survives losing the account. R2 objects are content-addressed and are not
 * copied here: the manifest says what a restore needs, and the restore
 * reports any it cannot find.
 *
 * A restore runs in a fresh environment whose `RESTORE_BACKUP_ID` names the
 * backup: the cron inserts the rows (parents before children) and then checks
 * the manifest against `OBJECTS`, recording progress in a `restore` row.
 */

const PREFIX = 'backups';
const PAGE_ROWS = 500;
const R2_PAGE = 1000;
/** Pages (D1 or R2) per cron tick. */
const STEPS_PER_TICK = 20;
const INSERT_BATCH = 50;

/**
 * Tables never copied: bookkeeping for backups or migrations, and
 * `usage_daily` (#61), which a trigger rebuilds as `usage_events` rows are
 * restored (copying it too would count every event twice).
 */
const SKIPPED_TABLES = new Set([
  'd1_migrations',
  'backups',
  'sqlite_sequence',
  'usage_daily',
]);

export class BackupConfigError extends Error {}

// ---------------------------------------------------------------------------
// encryption

async function backupKey(env: Env): Promise<CryptoKey> {
  const raw = env.BACKUP_ENCRYPTION_KEY;
  let bytes: Uint8Array | null = null;
  try {
    bytes = raw ? Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)) : null;
  } catch {
    bytes = null;
  }
  if (bytes?.length !== 32)
    throw new BackupConfigError('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function putSealed(env: Env, key: string, value: unknown): Promise<number> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
      await backupKey(env),
      plain,
    ),
  );
  const body = new Uint8Array(iv.length + sealed.length);
  body.set(iv);
  body.set(sealed, iv.length);
  await (env.BACKUPS as R2Bucket).put(key, body);
  return body.length;
}

async function getSealed(env: Env, key: string): Promise<string | null> {
  const object = await (env.BACKUPS as R2Bucket).get(key);
  if (!object) return null;
  const body = new Uint8Array(await object.arrayBuffer());
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: body.subarray(0, 12),
      additionalData: new TextEncoder().encode(key),
    },
    await backupKey(env),
    body.subarray(12),
  );
  return new TextDecoder().decode(plain);
}

const partKey = (id: string, kind: string, part: number): string =>
  `${PREFIX}/${id}/${kind}/${String(part).padStart(6, '0')}.ndjson`;
const manifestKey = (id: string): string => `${PREFIX}/${id}/manifest.json`;

// ---------------------------------------------------------------------------
// rows <-> JSON (BLOB columns as base64)

function encodeValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes =
      v instanceof ArrayBuffer
        ? new Uint8Array(v)
        : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return { $b64: btoa(text) };
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && '$b64' in v) {
    return Uint8Array.from(atob(String((v as { $b64: unknown }).$b64)), (ch) =>
      ch.charCodeAt(0),
    );
  }
  return v;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// ---------------------------------------------------------------------------
// state

const tableStatSchema = z.object({
  name: z.string(),
  rows: z.number(),
  parts: z.number(),
});
export const manifestSchema = z.object({
  format: z.literal('yag-backup/1'),
  id: z.string(),
  started_at: z.number(),
  finished_at: z.number(),
  migrations: z.array(z.string()),
  /** In restore order: parents before children. */
  tables: z.array(tableStatSchema),
  r2: z.object({ objects: z.number(), bytes: z.number(), parts: z.number() }),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const backupCursorSchema = z.object({
  phase: z.enum(['d1', 'r2']),
  tables: z.array(z.object({ name: z.string(), rowid: z.boolean() })),
  t: z.number(),
  after: z.number(),
  part: z.number(),
  r2_cursor: z.string().nullable(),
  r2_parts: z.number(),
  r2_bytes: z.number(),
  stats: z.array(tableStatSchema),
});
type BackupCursor = z.infer<typeof backupCursorSchema>;

const restoreCursorSchema = z.object({
  phase: z.enum(['d1', 'r2']),
  t: z.number(),
  part: z.number(),
  skipped: z.record(z.string(), z.number()),
  missing_objects: z.number(),
});

export interface BackupRow {
  id: string;
  status: 'running' | 'done' | 'failed' | 'expired';
  kind: 'schedule' | 'manual' | 'restore';
  created_by: string | null;
  cursor: string;
  row_count: number;
  object_count: number;
  byte_count: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

function minutes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Tables to copy, parents before children (foreign keys), from the live schema. */
async function tablesInOrder(env: Env): Promise<{ name: string; rowid: boolean }[]> {
  const rows = await q<{ name: string; sql: string | null }>(
    env,
    `SELECT name, sql FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE '!_cf!_%' ESCAPE '!'
     ORDER BY name`,
  );
  const tables = rows.filter((r) => !SKIPPED_TABLES.has(r.name));
  const names = new Set(tables.map((t) => t.name));
  const parents = new Map<string, string[]>();
  for (const t of tables) {
    const fks = await q<{ table: string }>(
      env,
      `PRAGMA foreign_key_list(${quote(t.name)})`,
    );
    parents.set(
      t.name,
      fks.map((f) => f.table).filter((p) => p !== t.name && names.has(p)),
    );
  }
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.has(name)) return; // done, or a cycle: order it where it stands
    state.set(name, 'visiting');
    for (const p of parents.get(name) ?? []) visit(p);
    state.set(name, 'done');
    ordered.push(name);
  };
  for (const t of tables) visit(t.name);
  const withoutRowid = new Set(
    tables.filter((t) => /WITHOUT\s+ROWID/i.test(t.sql ?? '')).map((t) => t.name),
  );
  return ordered.map((name) => ({ name, rowid: !withoutRowid.has(name) }));
}

async function migrationNames(env: Env): Promise<string[]> {
  const rows = await q<{ name: string }>(
    env,
    'SELECT name FROM d1_migrations ORDER BY id',
  );
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// backup

/** Start a backup now; null when one is already running or backups are off. */
export async function startBackup(
  env: Env,
  trigger: 'schedule' | 'manual',
  createdBy: string | null = null,
  now = Date.now(),
): Promise<BackupRow | null> {
  if (!env.BACKUPS) throw new BackupConfigError('the BACKUPS bucket is not bound');
  await backupKey(env);
  // Backups page `DB` only. Refuse rather than report a backup as complete
  // while an org's routed rows sit on a shard database (ADR 0006).
  if (
    await q1(
      env,
      "SELECT 1 FROM shard_directory WHERE shard != 'DB' OR target IS NOT NULL",
    )
  )
    throw new BackupConfigError(
      'an org lives on a shard database, and backups do not cover shards yet (ADR 0006)',
    );
  const running = await q1(
    env,
    "SELECT 1 FROM backups WHERE status = 'running' AND kind != 'restore'",
  );
  if (running) return null;
  const cursor: BackupCursor = {
    phase: 'd1',
    tables: await tablesInOrder(env),
    t: 0,
    after: 0,
    part: 0,
    r2_cursor: null,
    r2_parts: 0,
    r2_bytes: 0,
    stats: [],
  };
  const id = ulid(now);
  await run(
    env,
    `INSERT INTO backups (id, status, kind, created_by, cursor, started_at)
     VALUES (?, 'running', ?, ?, ?, ?)`,
    [id, trigger, createdBy, JSON.stringify(cursor), now],
  );
  return (await q1<BackupRow>(env, 'SELECT * FROM backups WHERE id = ?', [
    id,
  ])) as BackupRow;
}

/** One page of the running backup; true when it finished. */
async function backupStep(
  env: Env,
  row: BackupRow,
  cursor: BackupCursor,
): Promise<boolean> {
  if (cursor.phase === 'd1') {
    const table = cursor.tables[cursor.t];
    if (!table) {
      cursor.phase = 'r2';
      return false;
    }
    const rows = table.rowid
      ? await q<Record<string, unknown>>(
          env,
          `SELECT rowid AS "__rowid", * FROM ${quote(table.name)}
            WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          [cursor.after, PAGE_ROWS],
        )
      : await q<Record<string, unknown>>(
          env,
          `SELECT * FROM ${quote(table.name)} LIMIT ? OFFSET ?`,
          [PAGE_ROWS, cursor.after],
        );
    let stat = cursor.stats.find((s) => s.name === table.name);
    if (!stat) {
      stat = { name: table.name, rows: 0, parts: 0 };
      cursor.stats.push(stat);
    }
    if (rows.length > 0) {
      const lines = rows.map((r) => {
        const { __rowid, ...cols } = r;
        void __rowid;
        return JSON.stringify(
          Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, encodeValue(v)])),
        );
      });
      row.byte_count += await putSealed(
        env,
        partKey(row.id, `d1/${table.name}`, stat.parts),
        lines.join('\n'),
      );
      stat.parts += 1;
      stat.rows += rows.length;
      row.row_count += rows.length;
    }
    if (rows.length < PAGE_ROWS) {
      cursor.t += 1;
      cursor.after = 0;
    } else {
      cursor.after = table.rowid
        ? Number(rows[rows.length - 1]?.['__rowid'])
        : cursor.after + rows.length;
    }
    return false;
  }

  const page = await env.OBJECTS.list({
    limit: R2_PAGE,
    ...(cursor.r2_cursor ? { cursor: cursor.r2_cursor } : {}),
  });
  if (page.objects.length > 0) {
    const lines = page.objects.map((o) =>
      JSON.stringify({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded }),
    );
    row.byte_count += await putSealed(
      env,
      partKey(row.id, 'r2', cursor.r2_parts),
      lines.join('\n'),
    );
    cursor.r2_parts += 1;
    cursor.r2_bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    row.object_count += page.objects.length;
  }
  cursor.r2_cursor = page.truncated ? page.cursor : null;
  if (page.truncated) return false;

  const manifest: BackupManifest = {
    format: 'yag-backup/1',
    id: row.id,
    started_at: row.started_at,
    finished_at: Date.now(),
    migrations: await migrationNames(env),
    tables: cursor.stats,
    r2: { objects: row.object_count, bytes: cursor.r2_bytes, parts: cursor.r2_parts },
  };
  row.byte_count += await putSealed(env, manifestKey(row.id), manifest);
  return true;
}

/** Advance the running backup by up to `steps` pages. */
export async function advanceBackup(
  env: Env,
  steps = STEPS_PER_TICK,
): Promise<BackupRow | null> {
  const row = await q1<BackupRow>(
    env,
    "SELECT * FROM backups WHERE status = 'running' AND kind != 'restore' LIMIT 1",
  );
  if (!row) return null;
  const cursor = backupCursorSchema.parse(JSON.parse(row.cursor));
  let done = false;
  try {
    for (let i = 0; i < steps && !done; i++) done = await backupStep(env, row, cursor);
  } catch (err) {
    console.error('backup: step failed', row.id, err);
    await run(
      env,
      "UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      [err instanceof Error ? err.message : 'backup step failed', Date.now(), row.id],
    );
    return { ...row, status: 'failed' };
  }
  await run(
    env,
    `UPDATE backups SET cursor = ?, row_count = ?, object_count = ?, byte_count = ?,
       status = ?, finished_at = ? WHERE id = ?`,
    [
      JSON.stringify(cursor),
      row.row_count,
      row.object_count,
      row.byte_count,
      done ? 'done' : 'running',
      done ? Date.now() : null,
      row.id,
    ],
  );
  return { ...row, status: done ? 'done' : 'running' };
}

/** Delete finished backups past retention, a page of keys per call; the newest stays. */
async function expireBackups(env: Env, now: number): Promise<void> {
  const days = minutes(env.BACKUP_RETENTION_DAYS, 30);
  const old = await q<{ id: string }>(
    env,
    `SELECT id FROM backups WHERE status IN ('done','failed') AND kind != 'restore'
       AND started_at < ? AND id != (SELECT MAX(id) FROM backups WHERE status = 'done' AND kind != 'restore')
     ORDER BY id LIMIT 1`,
    [now - days * 86_400_000],
  );
  for (const { id } of old) {
    const listed = await (env.BACKUPS as R2Bucket).list({
      prefix: `${PREFIX}/${id}/`,
      limit: R2_PAGE,
    });
    if (listed.objects.length > 0)
      await (env.BACKUPS as R2Bucket).delete(listed.objects.map((o) => o.key));
    if (!listed.truncated)
      await run(env, "UPDATE backups SET status = 'expired' WHERE id = ?", [id]);
  }
}

/** Cron: start a backup when one is due, advance it, expire old ones. */
export async function backupTick(env: Env, now = Date.now()): Promise<void> {
  if (!env.BACKUPS || env.RESTORE_BACKUP_ID) return;
  if (!env.BACKUP_ENCRYPTION_KEY) {
    console.warn('backup: BACKUP_ENCRYPTION_KEY is not set; no backups are taken');
    return;
  }
  const last = await q1<{ started_at: number }>(
    env,
    "SELECT MAX(started_at) AS started_at FROM backups WHERE kind != 'restore'",
  );
  const due = minutes(env.BACKUP_INTERVAL_MINUTES, 15) * 60_000;
  if (!last?.started_at || last.started_at <= now - due) {
    try {
      await startBackup(env, 'schedule', null, now);
    } catch (err) {
      if (!(err instanceof BackupConfigError)) throw err;
      console.warn(`backup: ${err.message}; no backup taken`);
    }
  }
  await advanceBackup(env);
  await expireBackups(env, now);
}

// ---------------------------------------------------------------------------
// restore

export async function readManifest(env: Env, id: string): Promise<BackupManifest | null> {
  const text = await getSealed(env, manifestKey(id));
  return text === null ? null : manifestSchema.parse(JSON.parse(text));
}

async function insertRows(
  env: Env,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  const statement = (r: Record<string, unknown>): D1PreparedStatement => {
    const cols = Object.keys(r);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO ${quote(table)} (${cols.map(quote).join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
    ).bind(...cols.map((c) => decodeValue(r[c])));
  };
  let skipped = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    try {
      await env.DB.batch(chunk.map(statement));
    } catch {
      // one bad row (a child whose parent changed during the backup) fails
      // the batch: insert one by one and count what will not go in
      for (const r of chunk) {
        try {
          await statement(r).run();
        } catch {
          skipped += 1;
        }
      }
    }
  }
  return skipped;
}

/**
 * Cron in a fresh environment with `RESTORE_BACKUP_ID`: restore up to `steps`
 * parts. Refuses to start over existing data; never runs a second time.
 */
export async function restoreTick(
  env: Env,
  steps = STEPS_PER_TICK,
): Promise<BackupRow | null> {
  const source = env.RESTORE_BACKUP_ID;
  if (!source || !env.BACKUPS) return null;
  const id = `restore-${source}`;
  let row = await q1<BackupRow>(env, 'SELECT * FROM backups WHERE id = ?', [id]);
  if (row && row.status !== 'running') return row;
  const fail = async (message: string): Promise<BackupRow | null> => {
    console.error('restore:', message);
    if (row)
      await run(
        env,
        "UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
        [message, Date.now(), id],
      );
    return row ? { ...row, status: 'failed', error: message } : null;
  };
  let manifest: BackupManifest | null;
  try {
    manifest = await readManifest(env, source);
  } catch (err) {
    return fail(`backup ${source} cannot be read: ${(err as Error).message}`);
  }
  if (!manifest) return fail(`backup ${source} has no manifest`);
  if (!row) {
    const used = await q1<{ n: number }>(
      env,
      'SELECT (SELECT COUNT(*) FROM repos) + (SELECT COUNT(*) FROM users) AS n',
    );
    if ((used?.n ?? 0) > 0) {
      console.error('restore: the target database is not empty; refusing to restore');
      return null;
    }
    const cursor: z.infer<typeof restoreCursorSchema> = {
      phase: 'd1',
      t: 0,
      part: 0,
      skipped: {},
      missing_objects: 0,
    };
    await run(
      env,
      `INSERT INTO backups (id, status, kind, cursor, started_at)
       VALUES (?, 'running', 'restore', ?, ?)`,
      [id, JSON.stringify(cursor), Date.now()],
    );
    row = (await q1<BackupRow>(env, 'SELECT * FROM backups WHERE id = ?', [
      id,
    ])) as BackupRow;
    const have = await migrationNames(env);
    if (JSON.stringify(have) !== JSON.stringify(manifest.migrations))
      return fail(
        `schema mismatch: apply exactly the backup's migrations first (backup has ${manifest.migrations.length}, this database ${have.length})`,
      );
  }
  const cursor = restoreCursorSchema.parse(JSON.parse(row.cursor));
  let done = false;
  try {
    for (let i = 0; i < steps && !done; i++) {
      if (cursor.phase === 'd1') {
        const table = manifest.tables[cursor.t];
        if (!table) {
          cursor.phase = 'r2';
          cursor.part = 0;
          continue;
        }
        if (cursor.part >= table.parts) {
          cursor.t += 1;
          cursor.part = 0;
          continue;
        }
        const text = await getSealed(
          env,
          partKey(source, `d1/${table.name}`, cursor.part),
        );
        if (text === null) throw new Error(`missing part ${table.name}/${cursor.part}`);
        const rows = text
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const skipped = await insertRows(env, table.name, rows);
        if (skipped > 0)
          cursor.skipped[table.name] = (cursor.skipped[table.name] ?? 0) + skipped;
        row.row_count += rows.length - skipped;
        cursor.part += 1;
        continue;
      }
      if (cursor.part >= manifest.r2.parts) {
        done = true;
        continue;
      }
      const text = await getSealed(env, partKey(source, 'r2', cursor.part));
      if (text === null) throw new Error(`missing R2 manifest part ${cursor.part}`);
      for (const line of text.split('\n')) {
        const entry = JSON.parse(line) as { key: string; size: number };
        const head = await env.OBJECTS.head(entry.key);
        if (head?.size === entry.size) row.object_count += 1;
        else cursor.missing_objects += 1;
      }
      cursor.part += 1;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'restore step failed');
  }
  const skippedRows = Object.values(cursor.skipped).reduce((a, b) => a + b, 0);
  const problems = [
    ...(skippedRows > 0 ? [`${skippedRows} rows skipped`] : []),
    ...(cursor.missing_objects > 0
      ? [`${cursor.missing_objects} objects missing from OBJECTS`]
      : []),
  ];
  await run(
    env,
    `UPDATE backups SET cursor = ?, row_count = ?, object_count = ?, status = ?, error = ?,
       finished_at = ? WHERE id = ?`,
    [
      JSON.stringify(cursor),
      row.row_count,
      row.object_count,
      done ? 'done' : 'running',
      problems.length > 0 ? problems.join('; ') : null,
      done ? Date.now() : null,
      id,
    ],
  );
  return (await q1<BackupRow>(env, 'SELECT * FROM backups WHERE id = ?', [
    id,
  ])) as BackupRow;
}
