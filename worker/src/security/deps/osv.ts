import { z } from 'zod';
import type { Env } from '../../env';
import { q } from '../../db/client';
import { LOCKFILES, pypiName, type Ecosystem } from './lockfiles';

/**
 * OSV advisories (issue #67). Data from https://osv.dev is CC-BY 4.0: every
 * alert view carries `OSV_ATTRIBUTION`. Advisories reach D1 two ways:
 *
 * - an offline snapshot (OSV JSON entries, for example unzipped from
 *   `https://osv-vulnerabilities.storage.googleapis.com/<ecosystem>/all.zip`)
 *   that an instance admin posts to `POST /api/v1/admin/advisories`
 * - the hourly sync, which asks the OSV API about the packages default
 *   branches use (`syncAdvisories`); `OSV_SYNC=off` turns it off
 *
 * Only ecosystems the lockfile parsers produce are stored.
 */

export const OSV_ATTRIBUTION =
  'Advisory data from OSV (https://osv.dev), licensed under CC-BY 4.0.';
export const OSV_API = 'https://api.osv.dev';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type AdvisorySeverity = Severity | 'unknown';

const ECOSYSTEMS = new Set<string>(Object.values(LOCKFILES).map((l) => l.ecosystem));

const eventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
  limit: z.string().optional(),
});
const rangeSchema = z.object({
  type: z.string(),
  events: z.array(eventSchema).max(500),
});
export type OsvRange = z.infer<typeof rangeSchema>;

export const osvEntrySchema = z.looseObject({
  id: z.string().min(1).max(100),
  modified: z.string().min(1).max(64),
  withdrawn: z.string().max(64).optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  aliases: z.array(z.string().max(100)).max(100).optional(),
  severity: z
    .array(z.looseObject({ type: z.string(), score: z.string().max(200) }))
    .max(10)
    .optional(),
  database_specific: z.record(z.string(), z.unknown()).optional(),
  references: z
    .array(z.looseObject({ type: z.string(), url: z.string().max(2000) }))
    .max(500)
    .optional(),
  affected: z
    .array(
      z.looseObject({
        package: z.looseObject({ ecosystem: z.string(), name: z.string().max(500) }),
        ranges: z.array(rangeSchema).max(50).optional(),
        versions: z.array(z.string().max(200)).max(20_000).optional(),
      }),
    )
    .max(500)
    .optional(),
});
export type OsvEntry = z.infer<typeof osvEntrySchema>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Release-ordering words that sort after the release they follow. */
const AFTER_RELEASE = new Set(['post']);

function tokens(version: string): (number | string)[] {
  const v = version
    .toLowerCase()
    .replace(/^v(?=\d)/, '')
    .replace(/\+.*$/, '');
  return (v.match(/\d+|[a-z]+/g) ?? []).map((t) => (/^\d/.test(t) ? Number(t) : t));
}

/**
 * Generic version order for the ecosystems here: numbers compare as numbers,
 * a trailing word (`-beta`, `rc1`) is a pre-release before the bare version,
 * `.post1` comes after it. Good enough for SemVer (npm, Cargo, Go), PEP 440
 * and Composer versions; OSV's explicit version lists cover the rest.
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [tokens(a), tokens(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [l, r] = [x[i], y[i]];
    if (l === r) continue;
    if (l === undefined) return typeof r === 'number' || AFTER_RELEASE.has(r!) ? -1 : 1;
    if (r === undefined) return typeof l === 'number' || AFTER_RELEASE.has(l) ? 1 : -1;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    if (typeof l === 'number') return 1;
    if (typeof r === 'number') return -1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * OSV range evaluation: walk the events in version order; `introduced` at or
 * below the version opens, `fixed` at or below closes, `last_affected` below
 * closes. GIT ranges need commit graphs and are skipped.
 */
function inRange(range: OsvRange, version: string): boolean {
  if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') return false;
  const at = (e: z.infer<typeof eventSchema>): string =>
    e.introduced ?? e.fixed ?? e.last_affected ?? e.limit ?? '0';
  const events = [...range.events].sort((a, b) =>
    at(a) === '0' ? -1 : at(b) === '0' ? 1 : compareVersions(at(a), at(b)),
  );
  let affected = false;
  for (const e of events) {
    if (e.introduced !== undefined)
      affected ||= e.introduced === '0' || compareVersions(version, e.introduced) >= 0;
    if (e.fixed !== undefined && compareVersions(version, e.fixed) >= 0) affected = false;
    if (e.last_affected !== undefined && compareVersions(version, e.last_affected) > 0)
      affected = false;
  }
  return affected;
}

export interface Affected {
  ranges: OsvRange[];
  versions: string[];
}

export function isAffected(affected: Affected, version: string): boolean {
  return (
    affected.versions.includes(version) ||
    affected.ranges.some((r) => inRange(r, version))
  );
}

/** The lowest `fixed` above `version`, or null when no fix is published. */
export function fixedVersion(affected: Affected, version: string): string | null {
  let best: string | null = null;
  for (const range of affected.ranges)
    for (const e of range.events)
      if (
        e.fixed !== undefined &&
        compareVersions(e.fixed, version) > 0 &&
        (best === null || compareVersions(e.fixed, best) < 0)
      )
        best = e.fixed;
  return best;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

const CVSS3: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
};

function roundUp(x: number): number {
  const n = Math.round(x * 100_000);
  return n % 10_000 === 0 ? n / 100_000 : (Math.floor(n / 10_000) + 1) / 10;
}

/** CVSS 3.x base score from a vector string, or null when it is not one. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':') as [string, string]),
  );
  const changed = m.S === 'C';
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[
    m.PR as 'N' | 'L' | 'H'
  ];
  const v = (k: string): number | undefined => CVSS3[k]?.[m[k] ?? ''];
  const [av, ac, ui, c, i, a] = ['AV', 'AC', 'UI', 'C', 'I', 'A'].map(v);
  if ([pr, av, ac, ui, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploit = 8.22 * av! * ac! * pr! * ui!;
  if (impact <= 0) return 0;
  return roundUp(Math.min((changed ? 1.08 : 1) * (impact + exploit), 10));
}

export function severityOfScore(score: number): Severity {
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
}

/** GitHub-reviewed severity when present, else the CVSS v3 vector's score. */
export function advisorySeverity(entry: OsvEntry): AdvisorySeverity {
  const named = String(entry.database_specific?.severity ?? '').toLowerCase();
  if (named === 'moderate') return 'medium';
  if ((SEVERITIES as readonly string[]).includes(named)) return named as Severity;
  for (const s of entry.severity ?? []) {
    const score = s.type === 'CVSS_V3' ? cvss3Score(s.score) : null;
    if (score !== null) return severityOfScore(score);
  }
  return 'unknown';
}

export const SEVERITY_RANK: Record<AdvisorySeverity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** `severity` is `minimum` or worse (`unknown` never is). */
export function atLeast(severity: string, minimum: Severity): boolean {
  const rank = SEVERITY_RANK[severity as AdvisorySeverity] ?? 0;
  return rank > 0 && rank >= SEVERITY_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadResult {
  loaded: number;
  unchanged: number;
  /** Packages whose advisories changed (their repos are matched again). */
  packages: { ecosystem: Ecosystem; name: string }[];
}

/**
 * Store OSV entries (newer `modified` replaces). Withdrawn advisories keep
 * their row but no affected packages, so they stop matching. Repos using a
 * changed package get their dependency snapshot reset for the next sweep.
 */
export async function loadAdvisories(
  env: Env,
  entries: readonly OsvEntry[],
): Promise<LoadResult> {
  const result: LoadResult = { loaded: 0, unchanged: 0, packages: [] };
  const known = new Map<string, string>();
  for (let i = 0; i < entries.length; i += 90) {
    const ids = entries.slice(i, i + 90).map((e) => e.id);
    for (const row of await q<{ id: string; modified: string }>(
      env,
      `SELECT id, modified FROM osv_advisories WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    ))
      known.set(row.id, row.modified);
  }
  const touched = new Map<string, { ecosystem: Ecosystem; name: string }>();
  const now = Date.now();
  for (const entry of entries) {
    if (known.get(entry.id) === entry.modified) {
      result.unchanged++;
      continue;
    }
    const affected = (entry.affected ?? []).filter((a) =>
      ECOSYSTEMS.has(a.package.ecosystem),
    );
    // packages an earlier version named, so a dropped package rematches too
    for (const old of await q<{ ecosystem: Ecosystem; name: string }>(
      env,
      'SELECT ecosystem, name FROM osv_affected WHERE advisory_id = ?',
      [entry.id],
    ))
      touched.set(`${old.ecosystem}\0${old.name}`, old);
    const url =
      entry.references?.find((r) => r.type === 'ADVISORY')?.url ??
      `https://osv.dev/vulnerability/${encodeURIComponent(entry.id)}`;
    const statements = [
      env.DB.prepare(
        `INSERT OR REPLACE INTO osv_advisories (id, summary, severity, aliases, url, modified, withdrawn, loaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        entry.id,
        (entry.summary ?? entry.details ?? '').slice(0, 500),
        advisorySeverity(entry),
        JSON.stringify(entry.aliases ?? []),
        url,
        entry.modified,
        entry.withdrawn ?? null,
        now,
      ),
      env.DB.prepare('DELETE FROM osv_affected WHERE advisory_id = ?').bind(entry.id),
    ];
    for (const a of entry.withdrawn ? [] : affected) {
      const ecosystem = a.package.ecosystem as Ecosystem;
      // lockfile parsers normalise PyPI names (PEP 503); match them the same way
      const name = ecosystem === 'PyPI' ? pypiName(a.package.name) : a.package.name;
      touched.set(`${ecosystem}\0${name}`, { ecosystem, name });
      statements.push(
        env.DB.prepare(
          'INSERT INTO osv_affected (advisory_id, ecosystem, name, ranges, versions) VALUES (?, ?, ?, ?, ?)',
        ).bind(
          entry.id,
          ecosystem,
          name,
          JSON.stringify(a.ranges ?? []),
          JSON.stringify(a.versions ?? []),
        ),
      );
    }
    await env.DB.batch(statements);
    result.loaded++;
  }
  result.packages = [...touched.values()];
  const resets = result.packages.map((p) =>
    env.DB.prepare(
      `UPDATE dependency_snapshots SET cs_id = NULL, queued_cs = NULL WHERE repo_id IN
         (SELECT repo_id FROM repo_dependencies WHERE ecosystem = ? AND name = ?)`,
    ).bind(p.ecosystem, p.name),
  );
  for (let i = 0; i < resets.length; i += 50) await env.DB.batch(resets.slice(i, i + 50));
  return result;
}

// ---------------------------------------------------------------------------
// Scheduled sync
// ---------------------------------------------------------------------------

/** Packages asked about per run, and advisories fetched per run (subrequests). */
export const SYNC_PACKAGES = 500;
export const SYNC_ADVISORIES = 40;
const RECHECK_MS = 24 * 3600_000;

const batchResponse = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string(), modified: z.string() })).optional(),
    }),
  ),
});

export interface SyncResult {
  packages: number;
  fetched: number;
  loaded: number;
}

/**
 * Ask OSV (`querybatch`) which advisories name the packages default branches
 * use and that were not checked in the last day, then fetch the new or
 * changed ones. A package is marked checked once all its advisories are
 * stored, so a capped run leaves the rest for the next one.
 */
export async function syncAdvisories(
  env: Env,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now = Date.now(),
): Promise<SyncResult> {
  const result: SyncResult = { packages: 0, fetched: 0, loaded: 0 };
  if (env.OSV_SYNC === 'off') return result;
  const packages = await q<{ ecosystem: string; name: string }>(
    env,
    `SELECT DISTINCT d.ecosystem, d.name FROM repo_dependencies d
       LEFT JOIN osv_packages p ON p.ecosystem = d.ecosystem AND p.name = d.name
      WHERE p.checked_at IS NULL OR p.checked_at < ? LIMIT ?`,
    [now - RECHECK_MS, SYNC_PACKAGES],
  );
  if (packages.length === 0) return result;
  const res = await fetcher(`${OSV_API}/v1/querybatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: packages.map((p) => ({
        package: { ecosystem: p.ecosystem, name: p.name },
      })),
    }),
  });
  if (!res.ok) throw new Error(`OSV querybatch failed: ${res.status}`);
  const batch = batchResponse.parse(await res.json());
  const known = new Map<string, string>();
  const all = [
    ...new Set(batch.results.flatMap((r) => (r.vulns ?? []).map((v) => v.id))),
  ];
  for (let i = 0; i < all.length; i += 90) {
    const ids = all.slice(i, i + 90);
    for (const row of await q<{ id: string; modified: string }>(
      env,
      `SELECT id, modified FROM osv_advisories WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    ))
      known.set(row.id, row.modified);
  }
  const wanted = new Set<string>();
  for (const r of batch.results)
    for (const v of r.vulns ?? []) if (known.get(v.id) !== v.modified) wanted.add(v.id);
  const entries: OsvEntry[] = [];
  const fetchedIds = new Set<string>();
  for (const id of [...wanted].slice(0, SYNC_ADVISORIES)) {
    const vuln = await fetcher(`${OSV_API}/v1/vulns/${encodeURIComponent(id)}`);
    if (!vuln.ok) continue;
    const parsed = osvEntrySchema.safeParse(await vuln.json());
    if (!parsed.success) continue;
    entries.push(parsed.data);
    fetchedIds.add(id);
  }
  result.fetched = entries.length;
  result.loaded = (await loadAdvisories(env, entries)).loaded;
  const done = packages.filter((_, i) =>
    (batch.results[i]?.vulns ?? []).every(
      (v) => !wanted.has(v.id) || fetchedIds.has(v.id),
    ),
  );
  const marks = done.map((p) =>
    env.DB.prepare(
      `INSERT INTO osv_packages (ecosystem, name, checked_at) VALUES (?, ?, ?)
       ON CONFLICT (ecosystem, name) DO UPDATE SET checked_at = excluded.checked_at`,
    ).bind(p.ecosystem, p.name, now),
  );
  for (let i = 0; i < marks.length; i += 50) await env.DB.batch(marks.slice(i, i + 50));
  result.packages = done.length;
  return result;
}
