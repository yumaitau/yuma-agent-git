import { parse as parseYaml } from 'yaml';

/**
 * Lockfile parsers (issue #67). Each turns one lockfile into the packages it
 * pins, named the way OSV names them (`ecosystem` is an OSV ecosystem).
 * Parsers read the resolved versions only; ranges in manifests are ignored,
 * since a range is not what gets installed.
 */

export type Ecosystem =
  'npm' | 'PyPI' | 'Go' | 'crates.io' | 'Packagist' | 'Maven' | 'SwiftURL';

export interface Package {
  name: string;
  version: string;
}

type Parser = (text: string) => Package[];

/** Lockfile basenames this module reads, with their ecosystem and parser. */
export const LOCKFILES: Record<string, { ecosystem: Ecosystem; parse: Parser }> = {
  'package-lock.json': { ecosystem: 'npm', parse: npmLock },
  'npm-shrinkwrap.json': { ecosystem: 'npm', parse: npmLock },
  'pnpm-lock.yaml': { ecosystem: 'npm', parse: pnpmLock },
  'yarn.lock': { ecosystem: 'npm', parse: yarnLock },
  'requirements.txt': { ecosystem: 'PyPI', parse: requirements },
  'poetry.lock': { ecosystem: 'PyPI', parse: tomlPackages },
  'go.sum': { ecosystem: 'Go', parse: goSum },
  'Cargo.lock': { ecosystem: 'crates.io', parse: cargoLock },
  'composer.lock': { ecosystem: 'Packagist', parse: composerLock },
  'gradle.lockfile': { ecosystem: 'Maven', parse: gradleLock },
  'Package.resolved': { ecosystem: 'SwiftURL', parse: swiftResolved },
};

export function lockfileOf(path: string): { ecosystem: Ecosystem; parse: Parser } | null {
  return LOCKFILES[path.slice(path.lastIndexOf('/') + 1)] ?? null;
}

/** Sorted, without duplicates. */
function unique(packages: Package[]): Package[] {
  const seen = new Map<string, Package>();
  for (const p of packages) {
    if (p.name && p.version) seen.set(`${p.name}\0${p.version}`, p);
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** package-lock.json v1 (`dependencies`, nested) and v2/v3 (`packages`). */
function npmLock(text: string): Package[] {
  const lock = record(JSON.parse(text));
  const out: Package[] = [];
  const packages = record(lock.packages);
  if (Object.keys(packages).length > 0) {
    for (const [key, raw] of Object.entries(packages)) {
      const entry = record(raw);
      const at = key.lastIndexOf('node_modules/');
      if (at < 0 || entry.link === true) continue; // the root and workspace links
      out.push({
        name: str(entry.name) || key.slice(at + 'node_modules/'.length),
        version: str(entry.version),
      });
    }
    return unique(out);
  }
  const walk = (deps: Record<string, unknown>): void => {
    for (const [name, raw] of Object.entries(deps)) {
      const entry = record(raw);
      out.push({ name, version: str(entry.version) });
      walk(record(entry.dependencies));
    }
  };
  walk(record(lock.dependencies));
  return unique(out);
}

/** `@scope/name@1.2.3(peer@1)` or `/name/1.2.3` (pnpm 5) → name and version. */
function pnpmKey(key: string): Package | null {
  const bare = key.replace(/^\//, '').replace(/\(.*$/, '');
  const at = bare.indexOf('@', 1);
  if (at > 0) return { name: bare.slice(0, at), version: bare.slice(at + 1) };
  const slash = bare.lastIndexOf('/');
  return slash > 0
    ? { name: bare.slice(0, slash), version: bare.slice(slash + 1) }
    : null;
}

function pnpmLock(text: string): Package[] {
  const lock = record(parseYaml(text, { maxAliasCount: 100 }));
  const out: Package[] = [];
  for (const key of Object.keys(record(lock.packages))) {
    const p = pnpmKey(key);
    // versions from git or a tarball URL are not registry versions
    if (p && /^\d/.test(p.version)) out.push(p);
  }
  return unique(out);
}

/** yarn.lock v1 (`version "1.2.3"`) and Berry (`version: 1.2.3`). */
function yarnLock(text: string): Package[] {
  const out: Package[] = [];
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      names = line
        .replace(/:\s*$/, '')
        .split(',')
        .map((spec) => spec.trim().replace(/^"|"$/g, ''))
        .filter((spec) => !/@(workspace|link|portal|file|patch):/.test(spec))
        // `name@range`; a key without one (Berry's `__metadata`) is no package
        .map((spec) => spec.slice(0, Math.max(0, spec.indexOf('@', 1))))
        .filter((name) => name !== '');
      continue;
    }
    const version = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line)?.[1];
    if (version) for (const name of new Set(names)) out.push({ name, version });
  }
  return unique(out);
}

/** PEP 503 normalised name, as OSV keys PyPI packages. */
export function pypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Exact pins (`name==1.2.3`) only; ranges, URLs and options are skipped. */
function requirements(text: string): Package[] {
  const out: Package[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/\s#.*$/, '')
      .split(';')[0]!
      .trim();
    const m =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.!+_-]+)$/.exec(
        line,
      );
    if (m) out.push({ name: pypiName(m[1]!), version: m[3]! });
  }
  return unique(out);
}

/**
 * `[[package]]` tables with `name` and `version` (poetry.lock, Cargo.lock).
 * `keep` sees each table's other keys.
 */
function tomlTables(
  text: string,
  keep: (fields: Record<string, string>) => boolean = () => true,
): Package[] {
  const out: Package[] = [];
  let fields: Record<string, string> | null = null;
  const flush = (): void => {
    if (fields?.name && fields.version && keep(fields))
      out.push({ name: fields.name, version: fields.version });
    fields = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) {
      // any table header ends the keys of the package before it
      flush();
      if (line.trim() === '[[package]]') fields = {};
      continue;
    }
    const m = /^([a-z_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (fields && m) fields[m[1]!] = m[2]!;
  }
  flush();
  return out;
}

function tomlPackages(text: string): Package[] {
  return unique(tomlTables(text).map((p) => ({ ...p, name: pypiName(p.name) })));
}

/** Registry crates only: workspace members have no `source`. */
function cargoLock(text: string): Package[] {
  return unique(tomlTables(text, (f) => (f.source ?? '').startsWith('registry+')));
}

/**
 * go.sum lists every module version the build looked at. Lines without the
 * `/go.mod` suffix were downloaded; of those the highest version per module
 * is the one minimal version selection builds with.
 */
function goSum(text: string): Package[] {
  const best = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [module, version] = line.trim().split(/\s+/);
    if (!module || !version || version.endsWith('/go.mod')) continue;
    const current = best.get(module);
    if (!current || goNewer(version, current)) best.set(module, version);
  }
  return unique([...best].map(([name, version]) => ({ name, version })));
}

function goNewer(a: string, b: string): boolean {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function composerLock(text: string): Package[] {
  const lock = record(JSON.parse(text));
  const out: Package[] = [];
  for (const list of [lock.packages, lock['packages-dev']]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = record(raw);
      const version = str(entry.version).replace(/^v(?=\d)/, '');
      if (!version.startsWith('dev-')) out.push({ name: str(entry.name), version });
    }
  }
  return unique(out);
}

/** `group:artifact:version=classpaths`; Maven packages are `group:artifact`. */
function gradleLock(text: string): Package[] {
  const out: Package[] = [];
  for (const line of text.split('\n')) {
    const m = /^([^#:\s]+):([^:\s]+):([^=\s]+)=/.exec(line.trim());
    if (m) out.push({ name: `${m[1]}:${m[2]}`, version: m[3]! });
  }
  return unique(out);
}

/**
 * Swift Package.resolved v1 (`object.pins[].repositoryURL`) and v2/v3
 * (`pins[].location`). OSV's SwiftURL names a package by its repository URL
 * without the scheme or `.git`. Pins to a branch or revision have no version.
 */
function swiftResolved(text: string): Package[] {
  const file = record(JSON.parse(text));
  const pins = file.pins ?? record(file.object).pins;
  const out: Package[] = [];
  for (const raw of Array.isArray(pins) ? pins : []) {
    const pin = record(raw);
    const url = str(pin.location) || str(pin.repositoryURL);
    out.push({
      name: url.replace(/^[a-z]+:\/\//, '').replace(/\.git$/, ''),
      version: str(record(pin.state).version),
    });
  }
  return unique(out);
}
