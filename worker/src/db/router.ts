import type { Env } from '../env';
import { appendAudit } from '../audit/record';
import { ApiError } from '../core/errors';

/**
 * Metadata sharding (issue #78, ADR 0006). `DB` is the directory database
 * (users, orgs, repos, the shard map and every table not routed yet). An org
 * with no `shard_directory` row lives on `DB`, so one database behaves exactly
 * as before. Personal (user-owned) repos always live on `DB`.
 *
 * Routed today: usage accounting (`usage_events` and its trigger-kept
 * `usage_daily`). Everything else still reads and writes `env.DB`; ADR 0006
 * lists what remains and in which order.
 */

const SHARD_NAME = /^DB(_SHARD_[1-9][0-9]{0,2})?$/;

/** The D1 binding named by a shard map row, failing closed when it is not bound. */
export function shardDb(env: Env, name: string): D1Database {
  if (!SHARD_NAME.test(name)) throw new Error(`invalid shard name ${name}`);
  const db = name === 'DB' ? env.DB : env[name as `DB_SHARD_${number}`];
  if (!db) throw new Error(`shard ${name} is not bound`);
  return db;
}

interface DirectoryRow {
  org_id: string;
  shard: string;
  target: string | null;
  state: 'active' | 'copying' | 'frozen' | 'settling';
  cursor: number;
}

/**
 * The database holding an org's routed tables. Writes are refused while the
 * org is frozen for the last step of a move (seconds), so none are lost.
 */
export async function shardForOrg(
  env: Env,
  orgId: string | null,
  mode: 'read' | 'write' = 'read',
): Promise<D1Database> {
  if (orgId === null) return env.DB;
  const row = await env.DB.prepare(
    'SELECT shard, state FROM shard_directory WHERE org_id = ?',
  )
    .bind(orgId)
    .first<Pick<DirectoryRow, 'shard' | 'state'>>();
  if (!row) return env.DB;
  if (mode === 'write' && row.state === 'frozen')
    throw new ApiError(
      503,
      'shard_moving',
      "This org's data is moving between databases; retry in a minute.",
    );
  return shardDb(env, row.shard);
}

/** `env` with `DB` pointing at a shard, for the q/q1/run helpers on routed tables only. */
export function onShard(env: Env, db: D1Database): Env {
  return db === env.DB ? env : { ...env, DB: db };
}

/**
 * One part per database for a query across every shard (an agent's usage
 * spans orgs). `where` keeps only rows of orgs that database currently
 * serves, so rows copied by an unfinished move, or left behind by a finished
 * one, are never counted twice. Rows with no org belong to `DB`.
 */
export interface ShardPart {
  db: D1Database;
  where: string;
  params: unknown[];
}

export async function shardParts(env: Env): Promise<ShardPart[]> {
  const rows = (
    await env.DB.prepare('SELECT org_id, shard FROM shard_directory').all<{
      org_id: string;
      shard: string;
    }>()
  ).results;
  const byShard = new Map<string, string[]>();
  for (const row of rows) {
    if (row.shard === 'DB') continue;
    byShard.set(row.shard, [...(byShard.get(row.shard) ?? []), row.org_id]);
  }
  if (byShard.size === 0) return [{ db: env.DB, where: '1 = 1', params: [] }];
  const elsewhere = [...byShard.values()].flat();
  return [
    {
      db: env.DB,
      where: "COALESCE(org_id, '') NOT IN (SELECT value FROM json_each(?))",
      params: [JSON.stringify(elsewhere)],
    },
    ...[...byShard].map(([name, orgs]) => ({
      db: shardDb(env, name),
      where: 'org_id IN (SELECT value FROM json_each(?))',
      params: [JSON.stringify(orgs)],
    })),
  ];
}

/** The single part an org's (or a repo's) usage lives in. */
export async function orgPart(env: Env, orgId: string | null): Promise<ShardPart> {
  return { db: await shardForOrg(env, orgId), where: '1 = 1', params: [] };
}

// ---------------------------------------------------------------------------
// Online moves (cron)
// ---------------------------------------------------------------------------

const PAGE = 200;

/**
 * Copy one page of an org's `usage_events` rows after `cursor` from one
 * database to another. The rollup trigger rebuilds `usage_daily` on the
 * target, and fixed ids make a repeated copy a no-op.
 */
async function copyPage(
  from: D1Database,
  to: D1Database,
  orgId: string,
  cursor: number,
): Promise<{ cursor: number; copied: number }> {
  const rows = (
    await from
      .prepare(
        'SELECT rowid AS _rid, * FROM usage_events WHERE org_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
      )
      .bind(orgId, cursor, PAGE)
      .all<Record<string, unknown>>()
  ).results;
  if (rows.length === 0) return { cursor, copied: 0 };
  const columns = Object.keys(rows[0] as object).filter((k) => k !== '_rid');
  const sql = `INSERT INTO usage_events (${columns.join(', ')}) VALUES (${columns
    .map(() => '?')
    .join(', ')}) ON CONFLICT(id) DO NOTHING`;
  await to.batch(rows.map((row) => to.prepare(sql).bind(...columns.map((c) => row[c]))));
  return { cursor: Number(rows[rows.length - 1]?._rid), copied: rows.length };
}

async function setMove(env: Env, orgId: string, fields: Partial<DirectoryRow>) {
  const keys = Object.keys(fields) as (keyof DirectoryRow)[];
  await env.DB.prepare(
    `UPDATE shard_directory SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
      WHERE org_id = ?`,
  )
    .bind(...keys.map((k) => fields[k]), Date.now(), orgId)
    .run();
}

/**
 * Advance every move a few pages per tick, while the org keeps working:
 * `copying` copies pages from `shard` to `target`; once caught up the org is
 * `frozen` (writes get 503 `shard_moving`), the rest is copied and `shard`
 * flips to the target; `settling` copies anything a write already in flight
 * at the freeze left on the old database, one tick later, then the move ends.
 * The old database keeps its copy until an operator deletes it (ADR 0006).
 */
export async function advanceShardMoves(env: Env, pages = 20): Promise<void> {
  const moves = (
    await env.DB.prepare(
      "SELECT * FROM shard_directory WHERE state != 'active' AND target IS NOT NULL",
    ).all<DirectoryRow>()
  ).results;
  for (const move of moves) {
    const active = shardDb(env, move.shard);
    const other = shardDb(env, move.target as string);
    let cursor = move.cursor;
    if (move.state === 'settling') {
      // `target` names the old database now: bring over late writes, then finish
      for (let page = { cursor, copied: 1 }; page.copied > 0;)
        page = await copyPage(other, active, move.org_id, page.cursor);
      await setMove(env, move.org_id, { state: 'active', target: null, cursor: 0 });
      continue;
    }
    let caughtUp = false;
    for (let i = 0; i < pages && !caughtUp; i++) {
      const page = await copyPage(active, other, move.org_id, cursor);
      cursor = page.cursor;
      caughtUp = page.copied < PAGE;
    }
    if (!caughtUp) {
      await setMove(env, move.org_id, { cursor });
      continue;
    }
    await setMove(env, move.org_id, { state: 'frozen', cursor });
    for (let page = { cursor, copied: 1 }; page.copied > 0;) {
      page = await copyPage(active, other, move.org_id, page.cursor);
      cursor = page.cursor;
    }
    await setMove(env, move.org_id, {
      shard: move.target as string,
      target: move.shard,
      state: 'settling',
      cursor,
    });
    // where an org's data lives is a residency fact: audit it in the org's chain
    const org = await env.DB.prepare('SELECT slug FROM orgs WHERE id = ?')
      .bind(move.org_id)
      .first<{ slug: string }>();
    await appendAudit(env, {
      action: 'shard.move',
      actor: { kind: 'system', id: 'shard-router' },
      ...(org ? { orgId: org.slug } : {}),
      target: { org_id: move.org_id, from: move.shard, to: move.target },
    });
  }
}
