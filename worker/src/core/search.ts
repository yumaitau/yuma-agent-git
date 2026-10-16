import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q } from '../db/client';
import type { PathDecider } from '../auth/rbac';
import { globMatch } from '../policy/rulesets';
import { getBlob } from './blobs';
import type { Changeset } from './changesets';
import { diffRevisions } from './diff';
import { ApiError, ObjectWalkLimitError } from './errors';
import { linearMatcher, MatchBudgetError, type LineMatcher } from './linear-regex';
import {
  foldAscii,
  isBinary,
  languageOf,
  listFiles,
  MAX_DELTA_FILES,
  MAX_INDEX_BYTES,
  SnapshotTooLargeError,
  syncSnapshot,
  trigrams,
  type FileRow,
} from './derived/codeSearch';

/**
 * Code search and the file finder (issue #45, ADR 0004).
 *
 * A search runs over *views*: one per readable repo, either the repo's
 * default-branch file list in D1 or, for `rev`, that list with the tree diff
 * to the revision laid over it. Trigram postings narrow the files to read;
 * every candidate is then read and matched line by line, so results are
 * exact. Path rules are applied to each file before its content is read.
 *
 * Limits (also in docs/api.md): patterns up to 200 characters, matched in
 * linear time (no look-around or back-references); each line is matched on its first 1000
 * characters; files over 1 MiB and binary files are not searched by
 * content; one search reads at most 2000 files or 32 MiB.
 */

export const MAX_PATTERN_CHARS = 200;
export const MAX_LINE_CHARS = 1000;
export const MAX_READ_FILES = 2_000;
export const MAX_READ_BYTES = 32 * 1024 * 1024;
const CANDIDATE_LIMIT = 2_000;
const MAX_GRAMS = 16;
const MATCHES_PER_FILE = 20;
const RANGES_PER_LINE = 10;
const READ_CONCURRENCY = 8;
const CHUNK = 2_000;

export interface SearchScope {
  repo: RepoRecord;
  decider: PathDecider;
  /** Null for the default branch. */
  rev: Changeset | null;
}

export interface CodeSearchInput {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Path prefix, or a glob when it holds `*` or `?`. */
  path?: string;
  lang?: string;
  limit: number;
}

export interface CodeMatch {
  line: number;
  text: string;
  /** `[start, end)` offsets of each match within `text`. */
  ranges: [number, number][];
}

export interface CodeResult {
  repo: string;
  path: string;
  lang: string | null;
  cs: string;
  blob: string;
  matches: CodeMatch[];
}

export interface SkippedRepo {
  repo: string;
  reason: string;
}

export interface CodeSearchOutput {
  results: CodeResult[];
  /** More files matched than were returned. */
  truncated: boolean;
  /** Files were left unread or unmatched (read or match budget): results may be missing. */
  partial: boolean;
  skipped_repos: SkippedRepo[];
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export interface CompiledQuery {
  matcher: LineMatcher;
  /** Trigrams every match contains, or null when none can be derived. */
  grams: string[] | null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index just past the `]` closing the class that opens at `start`. */
function skipClass(source: string, start: number): number {
  let i = start + 1;
  if (source[i] === '^') i++;
  if (source[i] === ']') i++;
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i++;
    i++;
  }
  return i;
}

/**
 * Literal runs every match of `source` must contain, read conservatively:
 * only top-level runs count, alternation gives none, and a character with
 * `?`, `*` or `{` after it ends the run without it. Missing a literal only
 * costs speed; inventing one would lose results.
 */
export function requiredLiterals(source: string): string[] {
  if (source.includes('|')) return [];
  const out: string[] = [];
  let run = '';
  let depth = 0;
  const flush = (): void => {
    if (run.length >= 3) out.push(run);
    run = '';
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    let literal: string;
    if (ch === '\\') {
      const next = source[++i];
      if (next === undefined) break;
      if (/[A-Za-z0-9]/.test(next)) {
        flush(); // \d, \w, \b, \n, \u…, back-references
        continue;
      }
      literal = next;
    } else if (ch === '[') {
      flush();
      i = skipClass(source, i);
      continue;
    } else if (ch === '(' || ch === ')') {
      flush();
      depth = Math.max(0, depth + (ch === '(' ? 1 : -1));
      continue;
    } else if ('.^$?*+{}'.includes(ch)) {
      flush();
      if (ch === '{') while (i < source.length && source[i] !== '}') i++;
      continue;
    } else {
      literal = ch;
    }
    if (depth > 0) continue;
    const after = source[i + 1];
    if (after === '?' || after === '*' || after === '{') {
      flush();
      continue;
    }
    run += literal;
    if (after === '+') flush();
  }
  flush();
  return out;
}

export function compileQuery(input: {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
}): CompiledQuery {
  if (input.q.length === 0 || input.q.length > MAX_PATTERN_CHARS) {
    throw new ApiError(
      400,
      'invalid_pattern',
      `query must be 1 to ${MAX_PATTERN_CHARS} characters`,
    );
  }
  const source = input.regex ? input.q : escapeRegex(input.q);
  let regex: RegExp;
  try {
    regex = new RegExp(source, input.caseSensitive ? '' : 'i');
  } catch {
    throw new ApiError(400, 'invalid_pattern', 'not a valid regular expression');
  }
  // a literal is linear in RegExp; a pattern runs on the linear-time matcher,
  // since RegExp backtracking on a crafted pattern can take exponential time
  const matcher: LineMatcher = input.regex
    ? linearMatcher(source, !input.caseSensitive)
    : {
        test: (line) => regex.test(line),
        ranges: (line, max) => {
          const out: [number, number][] = [];
          for (const m of line.matchAll(new RegExp(regex.source, `${regex.flags}g`))) {
            out.push([m.index, m.index + m[0].length]);
            if (out.length >= max) break;
          }
          return out;
        },
      };
  if (matcher.test('')) {
    throw new ApiError(400, 'invalid_pattern', 'pattern matches every line');
  }
  const literals = input.regex ? requiredLiterals(input.q) : [input.q];
  const grams = new Set<string>();
  for (const literal of literals) {
    for (const gram of trigrams(literal)) {
      // case-insensitive matching folds ASCII only, as the index does
      if (!input.caseSensitive && [...gram].some((ch) => ch.charCodeAt(0) > 0x7f))
        continue;
      grams.add(gram);
    }
  }
  return { matcher, grams: grams.size === 0 ? null : spread([...grams], MAX_GRAMS) };
}

/** Up to `n` items spread evenly across `items`. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from(
    { length: n },
    (_, k) => items[Math.floor((k * items.length) / n)] as T,
  );
}

/** Matches of `matcher` in `text` as `[start, end)` lines. */
export function matchText(
  text: string,
  matcher: LineMatcher,
  maxMatches: number,
): CodeMatch[] {
  const out: CodeMatch[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
    const line = (lines[i] as string).slice(0, MAX_LINE_CHARS);
    if (!matcher.test(line)) continue;
    const ranges = matcher
      .ranges(line, RANGES_PER_LINE + 1)
      .filter(([a, b]) => b > a)
      .slice(0, RANGES_PER_LINE);
    out.push({ line: i + 1, text: line, ranges });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface View {
  repo: RepoRecord;
  decider: PathDecider;
  cs: string;
  /** Read the default-branch list (minus `shadow`). */
  base: boolean;
  shadow: string[];
  /** Files at this revision that the list does not hold. */
  extras: FileRow[];
}

async function resolveViews(
  env: Env,
  scopes: SearchScope[],
): Promise<{ views: View[]; skipped: SkippedRepo[] }> {
  const known = new Map<string, { head: string | null; cs_id: string | null }>();
  for (let i = 0; i < scopes.length; i += CHUNK) {
    const ids = scopes.slice(i, i + CHUNK).map((s) => s.repo.id);
    const rows = await q<{ id: string; head: string | null; cs_id: string | null }>(
      env,
      `SELECT r.id,
              (SELECT head FROM refs WHERE repo_id = r.id AND name = r.default_branch) AS head,
              (SELECT cs_id FROM search_repos WHERE repo_id = r.id) AS cs_id
         FROM repos r WHERE r.id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)],
    );
    for (const row of rows) known.set(row.id, { head: row.head, cs_id: row.cs_id });
  }

  const views: View[] = [];
  const skipped: SkippedRepo[] = [];
  for (const scope of scopes) {
    const { repo, decider, rev } = scope;
    const snap = await syncSnapshot(env, repo, known.get(repo.id));
    const view: View = { repo, decider, cs: '', base: false, shadow: [], extras: [] };
    if (rev === null || rev.id === snap.cs_id) {
      if (snap.skipped !== undefined)
        skipped.push({ repo: repo.slug, reason: snap.skipped });
      if (snap.cs_id === null || snap.skipped !== undefined) continue;
      views.push({ ...view, cs: snap.cs_id, base: true });
      continue;
    }
    view.cs = rev.id;
    const diff =
      snap.cs_id === null || snap.skipped !== undefined
        ? null
        : await diffRevisions(env, repo.id, snap.cs_id, rev.id, {
            mode: 'direct',
            maxFiles: MAX_DELTA_FILES,
          }).catch(() => null);
    if (diff !== null && !diff.truncated) {
      view.base = true;
      for (const f of diff.files) {
        view.shadow.push(f.path);
        if (f.kind !== 'del' && f.new_hash !== undefined)
          view.extras.push({
            path: f.path,
            hash: f.new_hash,
            size: f.new_size ?? 0,
            lang: languageOf(f.path),
          });
      }
    } else {
      try {
        view.extras = await listFiles(env, repo.id, rev.root_tree);
      } catch (err) {
        if (!(
          err instanceof SnapshotTooLargeError || err instanceof ObjectWalkLimitError
        ))
          throw err;
        skipped.push({ repo: repo.slug, reason: 'too_large' });
        continue;
      }
    }
    views.push(view);
  }
  return { views, skipped };
}

interface Filters {
  path?: string;
  lang?: string;
}

/** The literal prefix of a path filter (everything before a glob character). */
function pathPrefix(path: string | undefined): string {
  if (path === undefined) return '';
  const glob = path.search(/[*?]/);
  return glob < 0 ? path : path.slice(0, glob);
}

function pathAllowed(view: View, path: string, filters: Filters): boolean {
  if (filters.path !== undefined) {
    const isGlob = /[*?]/.test(filters.path);
    if (isGlob ? !globMatch(filters.path, path) : !path.startsWith(filters.path))
      return false;
  }
  if (filters.lang !== undefined && languageOf(path) !== filters.lang) return false;
  return view.decider.decide('read', path).allowed;
}

/** SQL fragment + params for the path/lang filters on `search_files f`. */
function filterSql(filters: Filters): { sql: string; params: unknown[] } {
  let sql = '';
  const params: unknown[] = [];
  const prefix = pathPrefix(filters.path);
  if (prefix !== '') {
    sql += ' AND substr(f.path, 1, ?) = ?';
    params.push(prefix.length, prefix);
  }
  if (filters.lang !== undefined) {
    sql += ' AND f.lang = ?';
    params.push(filters.lang);
  }
  return { sql, params };
}

interface Candidate {
  view: View;
  file: FileRow;
}

interface Row {
  repo_id: string;
  path: string;
  blob_hash: string;
  size: number;
  lang: string | null;
}

/** Base-list rows of `views` matching the filters (and `where`), capped. */
async function baseRows(
  env: Env,
  views: View[],
  filters: Filters,
  where: { sql: string; params: unknown[] },
  limit: number,
): Promise<{ rows: Row[]; more: boolean }> {
  // views sharing one shadow list run as one query (the default-branch case)
  const groups = new Map<string, View[]>();
  for (const view of views) {
    if (!view.base) continue;
    const key = JSON.stringify(view.shadow);
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }
  const f = filterSql(filters);
  const rows: Row[] = [];
  let more = false;
  for (const [shadow, group] of groups) {
    const found = await q<Row>(
      env,
      `SELECT f.repo_id, f.path, f.blob_hash, f.size, f.lang FROM search_files f
        WHERE f.repo_id IN (SELECT value FROM json_each(?))
          AND f.path NOT IN (SELECT value FROM json_each(?))${f.sql}${where.sql}
        ORDER BY f.repo_id, f.path LIMIT ?`,
      [
        JSON.stringify(group.map((v) => v.repo.id)),
        shadow,
        ...f.params,
        ...where.params,
        limit + 1,
      ],
    );
    if (found.length > limit) more = true;
    rows.push(...found.slice(0, limit));
  }
  return { rows, more };
}

function toCandidates(views: View[], rows: Row[]): Candidate[] {
  const byId = new Map(views.map((v) => [v.repo.id, v]));
  return rows.flatMap((r) => {
    const view = byId.get(r.repo_id);
    return view
      ? [
          {
            view,
            file: { path: r.path, hash: r.blob_hash, size: r.size, lang: r.lang },
          },
        ]
      : [];
  });
}

/** Index status of each extra file's blob, plus which indexed ones hold `grams`. */
async function classifyExtras(
  env: Env,
  hashes: string[],
  grams: string[] | null,
): Promise<{ status: Map<string, string>; hits: Set<string> }> {
  const status = new Map<string, string>();
  const hits = new Set<string>();
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const list = JSON.stringify(hashes.slice(i, i + CHUNK));
    const rows = await q<{ blob_hash: string; status: string }>(
      env,
      `SELECT blob_hash, status FROM search_blobs
        WHERE blob_hash IN (SELECT value FROM json_each(?))`,
      [list],
    );
    for (const row of rows) status.set(row.blob_hash, row.status);
    if (grams === null) continue;
    const matched = await q<{ blob_hash: string }>(
      env,
      `SELECT blob_hash FROM search_trigrams
        WHERE blob_hash IN (SELECT value FROM json_each(?))
          AND gram IN (SELECT value FROM json_each(?))
        GROUP BY blob_hash HAVING COUNT(*) = ?`,
      [list, JSON.stringify(grams), grams.length],
    );
    for (const row of matched) hits.add(row.blob_hash);
  }
  return { status, hits };
}

// ---------------------------------------------------------------------------
// Code search
// ---------------------------------------------------------------------------

export async function searchCode(
  env: Env,
  scopes: SearchScope[],
  input: CodeSearchInput,
): Promise<CodeSearchOutput> {
  const compiled = compileQuery(input);
  const { views, skipped } = await resolveViews(env, scopes);
  const filters: Filters = { path: input.path, lang: input.lang };
  const { grams } = compiled;

  // indexed text blobs holding every trigram, then blobs not yet indexed
  const indexedWhere = {
    sql:
      ` AND EXISTS (SELECT 1 FROM search_blobs b WHERE b.blob_hash = f.blob_hash AND b.status = 'indexed')` +
      (grams === null
        ? ''
        : ` AND (SELECT COUNT(*) FROM search_trigrams t
                  WHERE t.blob_hash = f.blob_hash
                    AND t.gram IN (SELECT value FROM json_each(?))) = ?`),
    params: grams === null ? [] : [JSON.stringify(grams), grams.length],
  };
  const unindexedWhere = {
    sql: ' AND NOT EXISTS (SELECT 1 FROM search_blobs b WHERE b.blob_hash = f.blob_hash)',
    params: [],
  };
  const hits = await baseRows(env, views, filters, indexedWhere, CANDIDATE_LIMIT);
  const pending = await baseRows(env, views, filters, unindexedWhere, CANDIDATE_LIMIT);
  const indexed = toCandidates(views, hits.rows);
  const unindexed = toCandidates(views, pending.rows);
  let truncated = hits.more;
  let partial = pending.more;

  for (const view of views) {
    const extras = view.extras.filter(
      (f) => f.size <= MAX_INDEX_BYTES && pathAllowed(view, f.path, filters),
    );
    const { status, hits: gramHits } = await classifyExtras(
      env,
      extras.map((f) => f.hash),
      grams,
    );
    for (const file of extras) {
      const state = status.get(file.hash);
      if (state === undefined) unindexed.push({ view, file });
      else if (state === 'indexed' && (grams === null || gramHits.has(file.hash)))
        indexed.push({ view, file });
    }
  }

  const order = (a: Candidate, b: Candidate): number =>
    a.view.repo.slug === b.view.repo.slug
      ? a.file.path < b.file.path
        ? -1
        : a.file.path > b.file.path
          ? 1
          : 0
      : a.view.repo.slug < b.view.repo.slug
        ? -1
        : 1;
  const queue = [
    ...indexed.filter((c) => pathAllowed(c.view, c.file.path, filters)).sort(order),
    ...unindexed
      .filter((c) => c.file.size <= MAX_INDEX_BYTES)
      .filter((c) => pathAllowed(c.view, c.file.path, filters))
      .sort(order),
  ];

  const results: CodeResult[] = [];
  let read = 0;
  let bytes = 0;
  let next = 0;
  while (next < queue.length && results.length < input.limit) {
    if (read >= MAX_READ_FILES || bytes >= MAX_READ_BYTES) break;
    const batch = queue.slice(next, next + READ_CONCURRENCY);
    next += batch.length;
    read += batch.length;
    let spent = false;
    const found = await Promise.all(
      batch.map(async ({ view, file }) => {
        const blob = await getBlob(env, view.repo.id, file.hash);
        if (blob === null || isBinary(blob.content)) return { size: 0, result: null };
        let matches: CodeMatch[];
        try {
          matches = matchText(
            new TextDecoder().decode(blob.content),
            compiled.matcher,
            MATCHES_PER_FILE,
          );
        } catch (err) {
          if (!(err instanceof MatchBudgetError)) throw err;
          spent = true;
          return { size: blob.size, result: null };
        }
        const result: CodeResult | null =
          matches.length === 0
            ? null
            : {
                repo: view.repo.slug,
                path: file.path,
                lang: file.lang,
                cs: view.cs,
                blob: file.hash,
                matches,
              };
        return { size: blob.size, result };
      }),
    );
    for (const { size, result } of found) {
      bytes += size;
      if (result !== null) results.push(result);
    }
    // the matching budget is spent: what was not matched may hold results
    if (spent) {
      partial = true;
      break;
    }
  }
  if (next < queue.length) {
    // stopped early: on the result limit, or with the read budget spent
    if (results.length >= input.limit) truncated = true;
    else partial = true;
  }
  return {
    results: results.slice(0, input.limit),
    truncated: truncated || results.length > input.limit,
    partial,
    skipped_repos: skipped,
  };
}

// ---------------------------------------------------------------------------
// File finder
// ---------------------------------------------------------------------------

export interface PathSearchInput {
  q: string;
  path?: string;
  lang?: string;
  limit: number;
}

export interface PathResult {
  repo: string;
  path: string;
  lang: string | null;
  size: number;
  cs: string;
}

/**
 * Characters of `q` in order, anything between (a fuzzy file finder). Only
 * the first few characters go into the `LIKE`: each `%` can make SQLite
 * backtrack, so the full query is checked in code.
 */
const LIKE_CHARS = 8;
function subsequenceLike(query: string): string {
  const chars = [...query].slice(0, LIKE_CHARS);
  return `%${chars.map((ch) => (/[%_\\]/.test(ch) ? `\\${ch}` : ch)).join('%')}%`;
}

/**
 * Lower is better: the base name (or it without its extension) is the query,
 * the base name holds it, the path holds it, the characters are scattered.
 */
function pathScore(path: string, query: string): number {
  const p = foldAscii(path);
  const needle = foldAscii(query);
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (base === needle || (dot > 0 && base.slice(0, dot) === needle)) return 0;
  if (base.includes(needle)) return 1;
  if (p.includes(needle)) return 2;
  return 3;
}

function isSubsequence(path: string, query: string): boolean {
  const p = foldAscii(path);
  let at = 0;
  for (const ch of foldAscii(query)) {
    at = p.indexOf(ch, at);
    if (at < 0) return false;
    at += ch.length;
  }
  return true;
}

export async function searchPaths(
  env: Env,
  scopes: SearchScope[],
  input: PathSearchInput,
): Promise<{ files: PathResult[]; truncated: boolean; skipped_repos: SkippedRepo[] }> {
  if (input.q.length === 0 || input.q.length > MAX_PATTERN_CHARS) {
    throw new ApiError(
      400,
      'invalid_pattern',
      `query must be 1 to ${MAX_PATTERN_CHARS} characters`,
    );
  }
  const { views, skipped } = await resolveViews(env, scopes);
  const filters: Filters = { path: input.path, lang: input.lang };
  const base = await baseRows(
    env,
    views,
    filters,
    { sql: ` AND f.path LIKE ? ESCAPE '\\'`, params: [subsequenceLike(input.q)] },
    CANDIDATE_LIMIT,
  );
  const candidates = toCandidates(views, base.rows);
  for (const view of views) {
    for (const file of view.extras) candidates.push({ view, file });
  }
  const ranked = candidates
    .filter((c) => isSubsequence(c.file.path, input.q))
    .filter((c) => pathAllowed(c.view, c.file.path, filters))
    .map((c) => ({ c, score: pathScore(c.file.path, input.q) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.c.file.path.length - b.c.file.path.length ||
        (a.c.view.repo.slug + a.c.file.path < b.c.view.repo.slug + b.c.file.path
          ? -1
          : 1),
    );
  return {
    files: ranked.slice(0, input.limit).map(({ c }) => ({
      repo: c.view.repo.slug,
      path: c.file.path,
      lang: c.file.lang,
      size: c.file.size,
      cs: c.view.cs,
    })),
    truncated: base.more || ranked.length > input.limit,
    skipped_repos: skipped,
  };
}
