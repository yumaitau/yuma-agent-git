import { z } from 'zod';
import type { Env } from '../../env';
import { q, q1, run } from '../../db/client';
import { getRepo } from '../../db/repos';
import { getBlob } from '../../core/blobs';
import { getChangeset, type Changeset } from '../../core/changesets';
import {
  FAILED_SENTINEL,
  getDerived,
  isSentinel,
  parseStored,
  peekDerived,
  registerKind,
  storeRaw,
  type DerivedKind,
} from '../../core/derived';
import { getTree } from '../../core/trees';
import type { AuditActor } from '../../audit/record';
import { emitEvent } from '../../webhooks/events';
import { lockfileOf, type Ecosystem } from './lockfiles';
import {
  fixedVersion,
  isAffected,
  OSV_ATTRIBUTION,
  type AdvisorySeverity,
  type OsvRange,
} from './osv';

/**
 * Dependency graph and alerts (issue #67).
 *
 * - `dependencies` derived kind, key `<csId>`: the packages each lockfile in
 *   the tree pins. A changeset reuses its first parent's stored value and
 *   parses only the lockfiles it changed; without one it walks the tree.
 * - The cron sweep queues a match for every repo whose default branch moved
 *   (or whose advisories changed); the derived-data queue copies the graph
 *   to `repo_dependencies` and opens, fixes and reopens `dependency_alerts`.
 */

export const DEPENDENCIES = 'dependencies';
/** Lockfiles larger than this are skipped (listed in `skipped`). */
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
/** Trees a full walk reads before it gives up (`truncated`). */
export const MAX_WALK_TREES = 5_000;
const MAX_PACKAGES = 20_000;
/** Directories never holding a project's own lockfile. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

const lockfileSchema = z.object({
  path: z.string(),
  hash: z.string(),
  ecosystem: z.string(),
  /** `[name, version]` pairs. */
  packages: z.array(z.tuple([z.string(), z.string()])),
  error: z.string().optional(),
});
const graphSchema = z.object({
  lockfiles: z.array(lockfileSchema),
  truncated: z.boolean().optional(),
});
export type DependencyGraph = z.infer<typeof graphSchema>;
export type LockfileDeps = z.infer<typeof lockfileSchema>;

async function parseLockfile(
  env: Env,
  repoId: string,
  path: string,
  hash: string,
  size: number | undefined,
): Promise<LockfileDeps | null> {
  const kind = lockfileOf(path);
  if (!kind) return null;
  const base = { path, hash, ecosystem: kind.ecosystem, packages: [] };
  if ((size ?? 0) > MAX_LOCKFILE_BYTES) return { ...base, error: 'too_large' };
  const blob = await getBlob(env, repoId, hash);
  if (!blob) return { ...base, error: 'missing' };
  if (blob.size > MAX_LOCKFILE_BYTES) return { ...base, error: 'too_large' };
  try {
    const packages = kind.parse(new TextDecoder().decode(blob.content));
    return {
      ...base,
      packages: packages.slice(0, MAX_PACKAGES).map((p) => [p.name, p.version]),
      ...(packages.length > MAX_PACKAGES ? { error: 'too_many_packages' } : {}),
    };
  } catch {
    return { ...base, error: 'unparseable' };
  }
}

/** Every lockfile in the tree, skipping vendored directories. */
async function walk(env: Env, cs: Changeset): Promise<DependencyGraph> {
  const lockfiles: LockfileDeps[] = [];
  if (!cs.root_tree) return { lockfiles };
  const queue: [string, string][] = [['', cs.root_tree]];
  let read = 0;
  while (queue.length > 0) {
    const [prefix, hash] = queue.shift()!;
    if (++read > MAX_WALK_TREES) return { lockfiles, truncated: true };
    const tree = await getTree(env, cs.repo_id, hash);
    for (const entry of tree?.entries ?? []) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === 'tree') {
        if (!SKIP_DIRS.has(entry.name)) queue.push([`${path}/`, entry.hash]);
        continue;
      }
      const parsed = await parseLockfile(env, cs.repo_id, path, entry.hash, entry.size);
      if (parsed) lockfiles.push(parsed);
    }
  }
  return { lockfiles };
}

export const dependenciesKind: DerivedKind<DependencyGraph> = {
  name: DEPENDENCIES,
  eager: false,
  isolated: true,
  async compute(env, repoId, cs) {
    const stored = cs.first_parent
      ? await peekDerived(env, repoId, DEPENDENCIES, cs.first_parent)
      : null;
    const parent = stored === null ? null : parseStored(dependenciesKind, stored);
    if (parent === null || isSentinel(parent)) return walk(env, cs);
    const changed = cs.changed_files.filter((f) => lockfileOf(f.path));
    const paths = new Set(changed.map((f) => f.path));
    const lockfiles = parent.lockfiles.filter((l) => !paths.has(l.path));
    for (const f of changed) {
      if (f.op === 'del' || !f.hash) continue;
      const parsed = await parseLockfile(env, repoId, f.path, f.hash, f.size);
      if (parsed) lockfiles.push(parsed);
    }
    lockfiles.sort((a, b) => (a.path < b.path ? -1 : 1));
    return parent.truncated ? { lockfiles, truncated: true } : { lockfiles };
  },
  parse(payload) {
    return graphSchema.parse(JSON.parse(payload));
  },
};
registerKind(dependenciesKind);

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  path: string;
}

/**
 * A changeset's graph; a sentinel (oversize or failed) reads as an empty,
 * truncated graph with `failed` set, so callers never take it as "no packages".
 */
export async function dependencyGraph(
  env: Env,
  repoId: string,
  csId: string,
): Promise<(DependencyGraph & { failed?: true }) | null> {
  const graph = await getDerived<DependencyGraph>(env, repoId, DEPENDENCIES, csId);
  if (graph === null) return null;
  return isSentinel(graph) ? { lockfiles: [], truncated: true, failed: true } : graph;
}

export function flatten(graph: DependencyGraph): Dependency[] {
  return graph.lockfiles.flatMap((l) =>
    l.packages.map(([name, version]) => ({
      ecosystem: l.ecosystem as Ecosystem,
      name,
      version,
      path: l.path,
    })),
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface Match extends Dependency {
  advisory_id: string;
  severity: AdvisorySeverity;
  fixed_version: string | null;
}

const affectedRow = z.object({
  advisory_id: z.string(),
  ecosystem: z.string(),
  name: z.string(),
  ranges: z.string(),
  versions: z.string(),
  severity: z.string(),
});

/** Advisories that affect each dependency's exact version. */
export async function matchDependencies(
  env: Env,
  deps: readonly Dependency[],
): Promise<Match[]> {
  const byEcosystem = new Map<string, Set<string>>();
  for (const d of deps) {
    const names = byEcosystem.get(d.ecosystem) ?? new Set<string>();
    names.add(d.name);
    byEcosystem.set(d.ecosystem, names);
  }
  const affected = new Map<string, z.infer<typeof affectedRow>[]>();
  for (const [ecosystem, names] of byEcosystem) {
    const list = [...names];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const rows = await q(
        env,
        `SELECT a.advisory_id, a.ecosystem, a.name, a.ranges, a.versions, v.severity
           FROM osv_affected a JOIN osv_advisories v ON v.id = a.advisory_id
          WHERE v.withdrawn IS NULL AND a.ecosystem = ?
            AND a.name IN (${chunk.map(() => '?').join(',')})`,
        [ecosystem, ...chunk],
      );
      for (const raw of rows) {
        const row = affectedRow.parse(raw);
        const key = `${row.ecosystem}\0${row.name}`;
        affected.set(key, [...(affected.get(key) ?? []), row]);
      }
    }
  }
  const out: Match[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    for (const row of affected.get(`${d.ecosystem}\0${d.name}`) ?? []) {
      const entry = {
        ranges: JSON.parse(row.ranges) as OsvRange[],
        versions: JSON.parse(row.versions) as string[],
      };
      const key = `${row.advisory_id}\0${d.ecosystem}\0${d.name}\0${d.path}`;
      if (seen.has(key) || !isAffected(entry, d.version)) continue;
      seen.add(key);
      out.push({
        ...d,
        advisory_id: row.advisory_id,
        severity: row.severity as AdvisorySeverity,
        fixed_version: fixedVersion(entry, d.version),
      });
    }
  }
  return out;
}

export const matchKey = (m: {
  advisory_id: string;
  ecosystem: string;
  name: string;
  path: string;
}): string => `${m.advisory_id}\0${m.ecosystem}\0${m.name}\0${m.path}`;

/**
 * Vulnerable dependencies `head` adds over `base` at or above `minimum`
 * (the ruleset check and pull request findings).
 */
export async function newVulnerableDependencies(
  env: Env,
  repoId: string,
  baseCs: string | null,
  headCs: string,
): Promise<Match[]> {
  const head = await dependencyGraph(env, repoId, headCs);
  if (!head) return [];
  const base = baseCs ? await dependencyGraph(env, repoId, baseCs) : null;
  const before = new Set(
    (base ? await matchDependencies(env, flatten(base)) : []).map(matchKey),
  );
  return (await matchDependencies(env, flatten(head))).filter(
    (m) => !before.has(matchKey(m)),
  );
}

// ---------------------------------------------------------------------------
// Default-branch snapshot and alerts
// ---------------------------------------------------------------------------

export const alertRowSchema = z.object({
  id: z.number(),
  advisory_id: z.string(),
  ecosystem: z.string(),
  name: z.string(),
  version: z.string(),
  path: z.string(),
  severity: z.string(),
  fixed_version: z.string().nullable(),
  state: z.enum(['open', 'fixed', 'dismissed']),
  dismissed_reason: z.string().nullable(),
  dismissed_by: z.string().nullable(),
  work_number: z.number().nullable(),
  cs_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type DependencyAlert = z.infer<typeof alertRowSchema>;
export const ALERT_COLUMNS =
  'id, advisory_id, ecosystem, name, version, path, severity, fixed_version, state, dismissed_reason, dismissed_by, work_number, cs_id, created_at, updated_at';

/** An alert as the API returns it: with its advisory and the OSV attribution. */
export async function alertViews(
  env: Env,
  alerts: readonly DependencyAlert[],
): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(alerts.map((a) => a.advisory_id))];
  const advisories = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    for (const row of await q<{
      id: string;
      summary: string;
      aliases: string;
      url: string;
    }>(
      env,
      `SELECT id, summary, aliases, url FROM osv_advisories WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    ))
      advisories.set(row.id, {
        id: row.id,
        summary: row.summary,
        aliases: JSON.parse(row.aliases) as unknown,
        url: row.url,
      });
  }
  return alerts.map((a) => ({
    ...a,
    advisory: advisories.get(a.advisory_id) ?? { id: a.advisory_id },
    attribution: OSV_ATTRIBUTION,
  }));
}

const SYSTEM: AuditActor = { kind: 'system', id: 'dependency-alerts' };

/**
 * Match the graph at `csId` (the default branch head): replace the repo's
 * `repo_dependencies`, then open new alerts, fix ones whose match is gone
 * and reopen fixed ones that match again. Dismissed alerts stay dismissed.
 */
export async function syncRepoDependencies(
  env: Env,
  repoId: string,
  csId: string,
): Promise<{ dependencies: number; opened: number; fixed: number; reopened: number }> {
  const repo = await getRepo(env, repoId);
  const graph = await dependencyGraph(env, repoId, csId);
  const out = { dependencies: 0, opened: 0, fixed: 0, reopened: 0 };
  if (!repo || !graph) return out;
  const now = Date.now();
  const snapshot = env.DB.prepare(
    `INSERT INTO dependency_snapshots (repo_id, cs_id, queued_cs, queued_at, truncated, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET cs_id = excluded.cs_id, queued_cs = NULL,
       queued_at = NULL, truncated = excluded.truncated, updated_at = excluded.updated_at`,
  ).bind(repoId, csId, graph.truncated ? 1 : 0, now);
  // a graph that could not be read says nothing about the packages: keep the alerts
  if (graph.failed) {
    await env.DB.batch([snapshot]);
    return out;
  }
  const deps = flatten(graph);
  out.dependencies = deps.length;
  const writes: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM repo_dependencies WHERE repo_id = ?').bind(repoId),
    ...deps.map((d) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO repo_dependencies (repo_id, ecosystem, name, version, path) VALUES (?, ?, ?, ?, ?)',
      ).bind(repoId, d.ecosystem, d.name, d.version, d.path),
    ),
  ];
  const matches = new Map(
    (await matchDependencies(env, deps)).map((m) => [matchKey(m), m]),
  );
  const existing = (
    await q(env, `SELECT ${ALERT_COLUMNS} FROM dependency_alerts WHERE repo_id = ?`, [
      repoId,
    ])
  ).map((r) => alertRowSchema.parse(r));
  const events: { action: string; key: string }[] = [];
  for (const alert of existing) {
    const key = matchKey(alert);
    const match = matches.get(key);
    matches.delete(key);
    if (!match) {
      // a truncated walk did not see every lockfile, so absence is not a fix
      if (alert.state !== 'open' || graph.truncated) continue;
      writes.push(
        env.DB.prepare(
          "UPDATE dependency_alerts SET state = 'fixed', cs_id = ?, updated_at = ? WHERE id = ?",
        ).bind(csId, now, alert.id),
      );
      out.fixed++;
      events.push({ action: 'fixed', key });
      continue;
    }
    const reopen = alert.state === 'fixed';
    if (
      !reopen &&
      alert.version === match.version &&
      alert.severity === match.severity &&
      alert.fixed_version === match.fixed_version
    )
      continue;
    writes.push(
      env.DB.prepare(
        `UPDATE dependency_alerts SET state = ?, version = ?, severity = ?, fixed_version = ?,
           cs_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        reopen ? 'open' : alert.state,
        match.version,
        match.severity,
        match.fixed_version,
        csId,
        now,
        alert.id,
      ),
    );
    if (reopen) {
      out.reopened++;
      events.push({ action: 'reopened', key });
    }
  }
  for (const [key, m] of matches) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO dependency_alerts (repo_id, advisory_id, ecosystem, name, version, path, severity,
           fixed_version, state, cs_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).bind(
        repoId,
        m.advisory_id,
        m.ecosystem,
        m.name,
        m.version,
        m.path,
        m.severity,
        m.fixed_version,
        csId,
        now,
        now,
      ),
    );
    out.opened++;
    events.push({ action: 'created', key });
  }
  writes.push(snapshot);
  for (let i = 0; i < writes.length; i += 100)
    await env.DB.batch(writes.slice(i, i + 100));
  if (events.length > 0) {
    const rows = (
      await q(env, `SELECT ${ALERT_COLUMNS} FROM dependency_alerts WHERE repo_id = ?`, [
        repoId,
      ])
    ).map((r) => alertRowSchema.parse(r));
    const byKey = new Map(rows.map((r) => [matchKey(r), r]));
    const views = new Map(
      (await alertViews(env, rows)).map((v, i) => [matchKey(rows[i]!), v]),
    );
    for (const e of events) {
      if (!byKey.has(e.key)) continue;
      await emitEvent(env, repo, {
        event: 'dependency_alert',
        action: e.action,
        actor: SYSTEM,
        data: { alert: views.get(e.key) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep and queue
// ---------------------------------------------------------------------------

export interface DependencyMessage {
  type: 'dependencies';
  repo_id: string;
  cs_id: string;
}

export function isDependencyMessage(body: unknown): body is DependencyMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { type?: unknown }).type === 'dependencies'
  );
}

const REQUEUE_MS = 10 * 60_000;

/**
 * Cron: queue a match for repos whose default branch head is not the one
 * last matched (a push, merge, import or mirror moved it, or an advisory
 * load reset it). A queued match is not queued again for ten minutes.
 */
export async function sweepDependencies(env: Env, now = Date.now()): Promise<number> {
  const due = await q<{ repo_id: string; head: string }>(
    env,
    `SELECT r.id AS repo_id, f.head FROM repos r
       JOIN refs f ON f.repo_id = r.id AND f.name = r.default_branch
       LEFT JOIN dependency_snapshots s ON s.repo_id = r.id
      WHERE s.cs_id IS NOT f.head
        AND (s.queued_cs IS NOT f.head OR s.queued_at < ?)
      LIMIT 20`,
    [now - REQUEUE_MS],
  );
  for (const d of due) {
    await run(
      env,
      `INSERT INTO dependency_snapshots (repo_id, cs_id, queued_cs, queued_at, updated_at)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET queued_cs = excluded.queued_cs,
         queued_at = excluded.queued_at`,
      [d.repo_id, d.head, now, now],
    );
    const message: DependencyMessage = {
      type: 'dependencies',
      repo_id: d.repo_id,
      cs_id: d.head,
    };
    await env.DERIVED_QUEUE.send(message);
  }
  return due.length;
}

/** `derived-data` consumer branch: match one repo; give up after three tries. */
export async function dependencyMessage(
  env: Env,
  message: Message<DependencyMessage>,
): Promise<void> {
  const { repo_id: repoId, cs_id: csId } = message.body;
  try {
    if (await getChangeset(env, repoId, csId))
      await syncRepoDependencies(env, repoId, csId);
    message.ack();
  } catch (err) {
    if (message.attempts >= 3) {
      // the next sweep matches the failed graph as empty and truncated
      await storeRaw(env, repoId, DEPENDENCIES, csId, FAILED_SENTINEL);
      console.error('dependencies: giving up', repoId, csId, err);
      message.ack();
    } else message.retry();
  }
}

export async function snapshotOf(
  env: Env,
  repoId: string,
): Promise<{ cs_id: string | null; truncated: boolean; updated_at: number } | null> {
  const row = await q1<{ cs_id: string | null; truncated: number; updated_at: number }>(
    env,
    'SELECT cs_id, truncated, updated_at FROM dependency_snapshots WHERE repo_id = ?',
    [repoId],
  );
  return row ? { ...row, truncated: row.truncated === 1 } : null;
}
