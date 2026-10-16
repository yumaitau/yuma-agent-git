import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  stringify,
  type Document,
} from 'yaml';
import { parseSpec, type PipelineFile } from '../spec';
import { ARTIFACT_NAME } from '../artifacts';

/**
 * GitHub Actions compatibility (issue #49): translate one
 * `.github/workflows/*.yml` file into a pipeline spec v2 document and report,
 * by line, what changes behaviour on the way (`translated`) and what cannot
 * run (`unsupported`). Nothing is fetched: the actions listed in `action()`
 * become shell steps or job settings, and any other `uses:` is unsupported.
 */

export type CompatStatus = 'supported' | 'translated' | 'unsupported';
export interface CompatFinding {
  status: 'translated' | 'unsupported';
  line: number;
  message: string;
}
export interface WorkflowReport {
  path: string;
  name: string;
  status: CompatStatus;
  findings: CompatFinding[];
  /** The translated pipeline v2 YAML; null when the workflow cannot run. */
  pipeline: string | null;
}

/** `github` context keys a translated job reads as variables (gha/env.ts sets them). */
export const GITHUB_VARIABLES = new Map([
  ['github.sha', 'GITHUB_SHA'],
  ['github.ref', 'GITHUB_REF'],
  ['github.ref_name', 'GITHUB_REF_NAME'],
  ['github.ref_type', 'GITHUB_REF_TYPE'],
  ['github.repository', 'GITHUB_REPOSITORY'],
  ['github.repository_owner', 'GITHUB_REPOSITORY_OWNER'],
  ['github.event_name', 'GITHUB_EVENT_NAME'],
  ['github.actor', 'GITHUB_ACTOR'],
  ['github.run_id', 'GITHUB_RUN_ID'],
  ['github.job', 'GITHUB_JOB'],
  ['github.server_url', 'GITHUB_SERVER_URL'],
  ['github.workspace', 'GITHUB_WORKSPACE'],
  ['github.workflow', 'GITHUB_WORKFLOW'],
]);

// Tool versions of the built-in image (worker/runner/Dockerfile).
const BUILTIN_NODE = '22';
const BUILTIN_PYTHON = '3.11';
const BUILTIN_HELM = 'v3.22.0';
const BUILTIN_IMAGE =
  'Debian bookworm with Node.js 22, python3, Docker, git, aws, helm and kubectl';
const MAX_TIMEOUT_SECONDS = 600;

type Key = string | number;
type Obj = Record<string, unknown>;
interface Aws {
  role_arn: string;
  region: string;
  session_name?: string;
}
interface Permissions {
  id_token: 'none' | 'write';
  packages: 'none' | 'write';
  security_events: 'none' | 'write';
}
interface Defaults {
  shell?: unknown;
  wd?: unknown;
}

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isValue = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;
const hasExpression = (v: unknown): boolean => typeof v === 'string' && v.includes('${{');
/** A single-quoted shell word. */
const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
/** Text escaped for a double-quoted shell word. */
const dq = (s: string): string => s.replace(/[\\"$`]/g, '\\$&');

class Translation {
  readonly findings: CompatFinding[] = [];

  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  /** Line of the key (or list item) at `path`, else of its nearest parent. */
  private line(path: Key[]): number {
    for (let n = path.length; n > 0; n--) {
      const parent = this.doc.getIn(path.slice(0, n - 1), true);
      const last = path[n - 1];
      const node = isMap(parent)
        ? parent.items.find((p) => isScalar(p.key) && p.key.value === last)?.key
        : isSeq(parent)
          ? parent.items[Number(last)]
          : undefined;
      if (isNode(node) && node.range) return this.lines.linePos(node.range[0]).line;
    }
    return 1;
  }

  note(status: CompatFinding['status'], path: Key[], message: string): void {
    const line = this.line(path);
    if (!this.findings.some((f) => f.line === line && f.message === message))
      this.findings.push({ status, line, message });
  }

  /** One expression as run step text, or null when it has no equivalent. */
  reference(expr: string, at: Key[]): string | null {
    const ref = /^(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
    if (ref) {
      if (ref[1] === 'secrets' && ref[2]!.toUpperCase() === 'GITHUB_TOKEN')
        this.note(
          'translated',
          at,
          'No GITHUB_TOKEN is issued: store a forge token as the repository secret GITHUB_TOKEN',
        );
      return `\${{ ${expr} }}`;
    }
    if (/^matrix\.[A-Za-z0-9_-]+$/.test(expr)) return `\${{ ${expr} }}`;
    const name =
      /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr)?.[1] ?? GITHUB_VARIABLES.get(expr);
    if (name) return `\${${name}}`;
    this.note('unsupported', at, `Expression \${{ ${expr} }} has no equivalent here`);
    return null;
  }

  /** Text with its expressions translated; `quoted` escapes it for a double-quoted word. */
  text(value: string, at: Key[], quoted = false): string {
    let out = '';
    let last = 0;
    for (const m of value.matchAll(EXPRESSION)) {
      const literal = value.slice(last, m.index);
      out += (quoted ? dq(literal) : literal) + (this.reference(m[1]!, at) ?? '');
      last = m.index + m[0].length;
    }
    const rest = value.slice(last);
    return out + (quoted ? dq(rest) : rest);
  }

  /** An `if:` as a shell test; null when it is always true. */
  condition(raw: unknown, at: Key[]): string | null {
    if (raw === undefined || raw === true) return null;
    if (raw === false) return 'false';
    if (typeof raw !== 'string') {
      this.note('unsupported', at, 'Use an expression for if');
      return 'false';
    }
    const src = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(raw)?.[1] ?? raw;
    try {
      return shellCondition(
        src,
        (expr) => {
          const word = this.reference(expr, at);
          if (word === null) throw new Error('');
          return word;
        },
        (message) => this.note('translated', at, message),
      );
    } catch (err) {
      if ((err as Error).message) this.note('unsupported', at, (err as Error).message);
      return 'false';
    }
  }

  /** `with:` inputs as strings. */
  inputs(raw: unknown, at: Key[]): Map<string, string> {
    const out = new Map<string, string>();
    if (raw === undefined) return out;
    if (!isObj(raw)) {
      this.note('unsupported', at, 'with must be a mapping');
      return out;
    }
    for (const [k, v] of Object.entries(raw)) {
      if (isValue(v)) out.set(k, String(v));
      else this.note('unsupported', [...at, k], `with.${k} must be a single value`);
    }
    return out;
  }
}

/**
 * GitHub expression syntax for `if:` as a bash test: `==`, `!=`, `!`, `&&`,
 * `||`, brackets, literals, contexts and `success()`, `startsWith()`,
 * `endsWith()` and `contains()` on strings. Comparisons are case-sensitive
 * here (GitHub ignores case). A failed step ends the job, so `always()` is
 * true and `failure()` and `cancelled()` are false; `note` says so. Throws on
 * anything else.
 */
export function shellCondition(
  src: string,
  context: (expr: string) => string,
  note: (message: string) => void,
): string {
  const tokens: string[] = [];
  const re =
    /\s*(\|\||&&|==|!=|<=|>=|[()!,<>]|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_*-]+)*)/y;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) {
      if (!src.slice(at).trim()) break;
      throw new Error(`Cannot read the condition "${src.trim()}"`);
    }
    tokens.push(m[1]!);
    at = re.lastIndex;
  }
  type Node = { test: string } | { word: string; truthy: boolean | null };
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (want?: string): string => {
    const t = tokens[i++];
    if (t === undefined || (want !== undefined && t !== want))
      throw new Error(`Cannot read the condition "${src.trim()}"`);
    return t;
  };
  const test = (n: Node): string =>
    'test' in n
      ? n.test
      : n.truthy === null
        ? `[ -n ${n.word} ]`
        : n.truthy
          ? 'true'
          : 'false';
  const word = (n: Node): string => {
    if ('test' in n) throw new Error('Compare values, not conditions');
    return n.word;
  };
  const primary = (): Node => {
    const t = take();
    if (t === '(') {
      const inner = or();
      take(')');
      return { test: `{ ${test(inner)}; }` };
    }
    if (t.startsWith("'")) {
      const s = t.slice(1, -1).replaceAll("''", "'");
      return { word: sq(s), truthy: s !== '' };
    }
    if (/^-?\d/.test(t)) return { word: t, truthy: Number(t) !== 0 };
    if (t === 'true' || t === 'false') return { word: t, truthy: t === 'true' };
    if (t === 'null') return { word: "''", truthy: false };
    if (peek() === '(') {
      take('(');
      const args: Node[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take(',');
      }
      take(')');
      const fn = t.toLowerCase();
      if (fn === 'success' && args.length === 0) return { test: 'true' };
      if (fn === 'always' && args.length === 0) {
        note('always() runs only while earlier steps pass: a failed step ends the job');
        return { test: 'true' };
      }
      if ((fn === 'failure' || fn === 'cancelled') && args.length === 0) {
        note(`${fn}() steps never run: a failed or cancelled step ends the job`);
        return { test: 'false' };
      }
      const patterns: Record<string, (b: string) => string> = {
        startswith: (b) => `${b}*`,
        endswith: (b) => `*${b}`,
        contains: (b) => `*${b}*`,
      };
      if (patterns[fn] && args.length === 2)
        return { test: `[[ ${word(args[0]!)} == ${patterns[fn](word(args[1]!))} ]]` };
      throw new Error(`${t}() is not supported in if`);
    }
    return { word: `"${context(t)}"`, truthy: null };
  };
  const compare = (): Node => {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      take();
      const right = primary();
      return { test: `[ ${word(left)} ${op === '==' ? '=' : '!='} ${word(right)} ]` };
    }
    if (op && ['<', '>', '<=', '>='].includes(op))
      throw new Error(`${op} is not supported in if`);
    return left;
  };
  const unary = (): Node => {
    if (peek() !== '!') return compare();
    take('!');
    return { test: `! { ${test(unary())}; }` };
  };
  const and = (): Node => {
    let left = unary();
    while (peek() === '&&') {
      take();
      left = { test: `{ ${test(left)} && ${test(unary())}; }` };
    }
    return left;
  };
  const or = (): Node => {
    let left = and();
    while (peek() === '||') {
      take();
      left = { test: `{ ${test(left)} || ${test(and())}; }` };
    }
    return left;
  };
  const out = test(or());
  if (i !== tokens.length) throw new Error(`Cannot read the condition "${src.trim()}"`);
  return out;
}

interface JobState {
  aws: Aws | null;
  permissions: Permissions;
  /** Steps run after the job's own steps, like an action's post step (cache saves). */
  post: Obj[];
}

const NO_PERMISSIONS: Permissions = {
  id_token: 'none',
  packages: 'none',
  security_events: 'none',
};

function permissions(t: Translation, raw: unknown, at: Key[]): Permissions {
  if (raw === 'write-all') {
    t.note(
      'translated',
      at,
      'write-all grants only id-token, packages and security-events here; jobs get no forge token',
    );
    return { id_token: 'write', packages: 'write', security_events: 'write' };
  }
  if (raw === 'read-all' || raw === null || raw === undefined) return NO_PERMISSIONS;
  if (!isObj(raw)) {
    t.note('unsupported', at, 'Use read-all, write-all or a mapping for permissions');
    return NO_PERMISSIONS;
  }
  const out: Permissions = { ...NO_PERMISSIONS };
  for (const [scope, level] of Object.entries(raw)) {
    if (scope === 'id-token') out.id_token = level === 'write' ? 'write' : 'none';
    else if (scope === 'packages') out.packages = level === 'write' ? 'write' : 'none';
    else if (scope === 'security-events')
      out.security_events = level === 'write' ? 'write' : 'none';
    else if (level === 'write')
      t.note(
        'translated',
        [...at, scope],
        `${scope}: write has no effect: jobs get no forge token`,
      );
  }
  return out;
}

function triggers(t: Translation, raw: unknown): Obj {
  const at = ['on'];
  const events: Obj = isObj(raw)
    ? raw
    : Object.fromEntries(list(raw).map((e) => [String(e), null]));
  const out: Obj = {};
  const filters = (value: unknown, path: Key[], keys: string[]): Obj | null => {
    if (value === null || value === undefined) return null;
    if (!isObj(value)) {
      t.note('unsupported', path, 'Use a mapping of filters');
      return null;
    }
    const kept: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'types') {
        t.note(
          'translated',
          [...path, k],
          'Event types are ignored: the pipeline runs for every activity of this event',
        );
      } else if (k.endsWith('-ignore')) {
        t.note(
          'unsupported',
          [...path, k],
          `${k} is not supported; list what to include`,
        );
      } else if (keys.includes(k)) {
        const patterns = list(v).map(String);
        if (patterns.some((p) => p.startsWith('!')))
          t.note('unsupported', [...path, k], 'Negated (!) patterns are not supported');
        kept[k] = patterns;
      } else
        t.note(
          'unsupported',
          [...path, k],
          `on.${String(path[1])}.${k} is not supported`,
        );
    }
    return Object.keys(kept).length ? kept : null;
  };
  for (const [event, value] of Object.entries(events)) {
    const path = [...at, event];
    if (event === 'push') out.push = filters(value, path, ['branches', 'tags', 'paths']);
    else if (event === 'pull_request')
      out.pull_request = filters(value, path, ['branches', 'paths']);
    else if (event === 'merge_group')
      out.merge_group = filters(value, path, ['branches']);
    else if (event === 'workflow_dispatch') {
      if (isObj(value) && value.inputs !== undefined)
        t.note(
          'translated',
          [...path, 'inputs'],
          'Manual runs take no inputs; expressions reading inputs are unsupported',
        );
      out.manual = {};
    } else if (event === 'schedule') {
      out.schedule = list(value).map((s, i) => {
        if (!isObj(s) || typeof s.cron !== 'string')
          t.note('unsupported', [...path, i], 'Each schedule needs a cron expression');
        return { cron: isObj(s) ? String(s.cron) : '', timezone: 'UTC' };
      });
    } else
      t.note(
        'translated',
        path,
        event === 'pull_request_target'
          ? 'pull_request_target is not supported (it runs untrusted code with secrets); the workflow does not run for it'
          : `The ${event} event is not supported; the workflow does not run for it`,
      );
  }
  if (Object.keys(out).length === 0)
    t.note(
      'unsupported',
      at,
      'No supported trigger: use push, pull_request, schedule, workflow_dispatch or merge_group',
    );
  return out;
}

function runsOn(t: Translation, raw: unknown, at: Key[]): string[] | null {
  if (raw === undefined) return null;
  if (isObj(raw)) {
    if (raw.group !== undefined)
      t.note('unsupported', at, 'Runner groups are not supported; use labels');
    return runsOn(t, raw.labels, at);
  }
  const labels = list(raw).map(String);
  if (labels.some(hasExpression)) {
    t.note('unsupported', at, 'runs-on must be literal labels');
    return null;
  }
  if (labels.length === 1 && /^ubuntu-(latest|\d\d\.04)$/.test(labels[0]!)) {
    t.note(
      'translated',
      at,
      `${labels[0]} runs on the built-in Linux pool (${BUILTIN_IMAGE})`,
    );
    return null;
  }
  const hosted = labels.find((l) => /^(ubuntu-.+-arm|macos-|windows-)/.test(l));
  if (hosted) {
    t.note(
      'unsupported',
      at,
      `GitHub-hosted ${hosted} runners do not exist here; register a self-hosted runner and use its labels`,
    );
    return null;
  }
  return labels.map((l) => l.toLowerCase());
}

function services(t: Translation, raw: unknown, at: Key[]): Obj | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    t.note('unsupported', at, 'services must be a mapping');
    return undefined;
  }
  const out: Obj = {};
  for (const [name, svc] of Object.entries(raw)) {
    const path = [...at, name];
    if (!isObj(svc) || typeof svc.image !== 'string' || hasExpression(svc.image)) {
      t.note('unsupported', path, 'A service needs a literal image');
      continue;
    }
    const env: Obj = {};
    for (const [k, v] of Object.entries(isObj(svc.env) ? svc.env : {})) {
      if (hasExpression(v))
        t.note(
          'unsupported',
          [...path, 'env', k],
          'Service variables must be literal values',
        );
      env[k] = isValue(v) ? String(v) : '';
    }
    for (const key of Object.keys(svc)) {
      if (key === 'image' || key === 'env') continue;
      if (key === 'ports') {
        const moved = list(svc.ports).some((p) => {
          const [host, container] = String(p).split(':');
          return container !== undefined && host !== container;
        });
        if (moved)
          t.note(
            'translated',
            [...path, key],
            'Services share the job network: connect to localhost on the container port, not the mapped one',
          );
      } else if (key === 'options')
        t.note(
          'translated',
          [...path, key],
          'Container options (health checks) are ignored: steps may start before the service is ready',
        );
      else
        t.note('unsupported', [...path, key], `services.${name}.${key} is not supported`);
    }
    out[name] = Object.keys(env).length
      ? { image: svc.image, env }
      : { image: svc.image };
  }
  return out;
}

/** A path or glob a translated step uses unquoted: no spaces, quotes or shell syntax. */
const PLAIN_PATH = /^(~\/)?[\w./*?@+=:-]+$/;
const RUNTIME_AUTH = '-H "authorization: Bearer $YAG_RUNTIME_TOKEN"';
const HASH_FILES =
  'hash_files() { local p f; for p in "$@"; do for f in $p; do if [ -f "$f" ]; then sha256sum "$f"; fi; done; done | sha256sum | cut -c1-64; }';

/** `with.path` lines; null (and noted) unless each is a plain path or glob. */
function plainPaths(t: Translation, raw: string | undefined, at: Key[]): string[] | null {
  const lines = (raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) t.note('unsupported', at, 'Set path');
  else if (lines.some((l) => l.startsWith('!')))
    t.note('unsupported', at, 'Excluded (!) paths are not supported');
  else if (!lines.every((l) => PLAIN_PATH.test(l)))
    t.note('unsupported', at, 'Paths must be literal file paths or globs without spaces');
  else return lines;
  return null;
}

/** A cache key as double-quoted shell text; `hashFiles()` and `runner.os` work too. */
function cacheKey(
  t: Translation,
  value: string,
  at: Key[],
): { text: string; hashes: boolean } | null {
  let ok = true;
  let hashes = false;
  let out = '';
  let last = 0;
  for (const m of value.matchAll(EXPRESSION)) {
    out += dq(value.slice(last, m.index));
    last = m.index + m[0].length;
    const expr = m[1]!;
    const args = /^hashFiles\((.*)\)$/s
      .exec(expr)?.[1]
      ?.split(',')
      .map((a) => a.trim());
    if (expr === 'runner.os') out += 'Linux';
    else if (expr === 'runner.arch') out += 'X64';
    else if (args) {
      if (args.every((a) => /^'[^']+'$/.test(a) && PLAIN_PATH.test(a.slice(1, -1)))) {
        hashes = true;
        out += `$(hash_files ${args.join(' ')})`;
      } else {
        t.note('unsupported', at, 'hashFiles() takes literal globs');
        ok = false;
      }
    } else {
      const word = t.reference(expr, at);
      if (word === null) ok = false;
      else out += word;
    }
  }
  return ok ? { text: out + dq(value.slice(last)), hashes } : null;
}

/**
 * `actions/cache` on the forge's job caches (#51): restore where the step is,
 * save in a step after the job's own steps (its post step). The restore step
 * leaves the key and directory in a state file, so the save step knows them.
 * `cache/restore` and `cache/save` do one half where they stand.
 */
function cache(
  t: Translation,
  name: string,
  w: Map<string, string>,
  at: Key[],
  job: JobState,
): string | null {
  const withAt = [...at, 'with'];
  const files = plainPaths(t, w.get('path'), [...withAt, 'path']);
  const raw = w.get('key');
  if (!raw) t.note('unsupported', withAt, 'Set key');
  const key = raw ? cacheKey(t, raw, [...withAt, 'key']) : null;
  const restoreKeys = (w.get('restore-keys') ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((r) => cacheKey(t, r, [...withAt, 'restore-keys']));
  for (const k of w.keys())
    if (!['path', 'key', 'restore-keys'].includes(k))
      t.note('translated', [...withAt, k], `with.${k} is ignored`);
  if (!files || !key || restoreKeys.some((r) => r === null)) return null;
  const head = [
    'shopt -s globstar nullglob',
    ...(key.hashes || restoreKeys.some((r) => r!.hashes) ? [HASH_FILES] : []),
    `key="${key.text}"`,
    `if [ -z "\${YAG_RUNTIME_URL:-}" ]; then echo 'Cache skipped: this run has no YAG_RUNTIME_URL'; exit 0; fi`,
  ];
  const restore = [
    `restore="${restoreKeys.map((r) => r!.text).join(',')}"`,
    `code=$(curl -sS -G -o /tmp/yag-cache.tgz -w '%{http_code}' ${RUNTIME_AUTH} --data-urlencode "key=$key" --data-urlencode "restore_keys=$restore" "$YAG_RUNTIME_URL/caches") || code=failed`,
    'if [ "$code" = 200 ]; then tar -xzPf /tmp/yag-cache.tgz; echo "Cache restored: $key"; else echo "No cache restored for $key ($code)"; fi',
  ];
  // needs $dir and $key; a failed save only warns, as on GitHub
  const save = [
    'cd "$dir"',
    // relative paths stay relative to the step's directory, as GitHub keeps them
    `f=(); for p in ${files.join(' ')}; do if [ -e "$p" ]; then f+=("$p"); fi; done`,
    `if [ \${#f[@]} -eq 0 ]; then echo 'Cache not saved: no files match its path'; exit 0; fi`,
    'tar -czPf /tmp/yag-cache.tgz -- "${f[@]}"',
    'k=${key//\\\\/\\\\\\\\}; k=${k//\\"/\\\\\\"}',
    `if r=$(curl -fsS -X POST ${RUNTIME_AUTH} -H 'content-type: application/json' -d "{\\"key\\":\\"$k\\"}" "$YAG_RUNTIME_URL/caches"); then`,
    `  id=$(printf '%s' "$r" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')`,
    `  if curl -fsS -X PUT ${RUNTIME_AUTH} --data-binary @/tmp/yag-cache.tgz "$YAG_RUNTIME_URL/caches/$id" >/dev/null; then echo "Cache saved: $key"; else echo 'Cache not saved: the upload failed'; fi`,
    `else echo "Cache not saved: $key exists or is being saved"; fi`,
  ];
  if (name === 'actions/cache/restore') return [...head, ...restore].join('\n');
  if (name === 'actions/cache/save') return [...head, 'dir=$PWD', ...save].join('\n');
  const state = `"\${TMPDIR:-/tmp}/yag-cache-${job.post.length}"`;
  job.post.push({
    name: 'Save cache',
    run: [
      `if [ ! -f ${state} ]; then echo 'Cache not saved: its restore step did not run'; exit 0; fi`,
      `{ read -r dir; read -r key; } < ${state}`,
      'shopt -s globstar nullglob',
      ...save,
    ].join('\n'),
  });
  return [...head, `printf '%s\\n%s\\n' "$PWD" "$key" > ${state}`, ...restore].join('\n');
}

/** An artifact name as double-quoted shell text; one with expressions is checked on upload. */
function artifactName(t: Translation, name: string, at: Key[]): string | null {
  if (hasExpression(name)) return t.text(name, at, true);
  if (ARTIFACT_NAME.test(name)) return name;
  t.note('unsupported', at, 'Artifact names are letters, digits, ., _ or -');
  return null;
}

/** `upload-artifact` as one .tar.gz run artifact (#51), shared by the run's jobs. */
function uploadArtifact(
  t: Translation,
  w: Map<string, string>,
  at: Key[],
): string | null {
  const withAt = [...at, 'with'];
  const name = artifactName(t, w.get('name') ?? 'artifact', [...withAt, 'name']);
  const files = plainPaths(t, w.get('path'), [...withAt, 'path']);
  const missing = w.get('if-no-files-found') ?? 'warn';
  for (const key of w.keys())
    if (key === 'retention-days')
      t.note('translated', [...withAt, key], 'Artifacts are kept 14 days');
    else if (!['name', 'path', 'if-no-files-found'].includes(key))
      t.note('translated', [...withAt, key], `with.${key} is ignored`);
  if (name === null) return null;
  if (!['warn', 'error', 'ignore'].includes(missing)) {
    t.note('unsupported', [...withAt, 'if-no-files-found'], 'Use warn, error or ignore');
    return null;
  }
  if (!files) return null;
  t.note(
    'translated',
    at,
    'The artifact is kept as one .tar.gz archive, which the CI page downloads',
  );
  // one directory or file is the archive's root, as GitHub roots it
  const single = files.length === 1 && !/[*?]/.test(files[0]!);
  return [
    `if [ -z "\${YAG_RUNTIME_URL:-}" ]; then echo 'Artifacts need YAG_RUNTIME_URL, which this run does not have'; exit 1; fi`,
    'shopt -s globstar nullglob',
    `f=(); for p in ${files.join(' ')}; do if [ -e "$p" ]; then f+=("$p"); fi; done`,
    `if [ \${#f[@]} -eq 0 ]; then echo "No files found for artifact ${name}"; exit ${missing === 'error' ? 1 : 0}; fi`,
    single
      ? 'if [ -d "${f[0]}" ]; then tar -czf /tmp/yag-artifact.tgz -C "${f[0]}" .; else tar -czf /tmp/yag-artifact.tgz -C "$(dirname "${f[0]}")" "$(basename "${f[0]}")"; fi'
      : 'tar -czf /tmp/yag-artifact.tgz -- "${f[@]}"',
    `curl -fsS -X PUT ${RUNTIME_AUTH} --data-binary @/tmp/yag-artifact.tgz "$YAG_RUNTIME_URL/artifacts/${name}" >/dev/null`,
  ].join('\n');
}

/** `download-artifact` of one named artifact of this run (#51), unpacked into `path`. */
function downloadArtifact(
  t: Translation,
  w: Map<string, string>,
  at: Key[],
): string | null {
  const withAt = [...at, 'with'];
  const raw = w.get('name');
  const dest = w.get('path') ?? '.';
  let ok = true;
  for (const key of w.keys())
    if (
      ['pattern', 'merge-multiple', 'run-id', 'repository', 'github-token'].includes(key)
    ) {
      t.note('unsupported', [...withAt, key], `with.${key} is not supported`);
      ok = false;
    } else if (key !== 'name' && key !== 'path')
      t.note('translated', [...withAt, key], `with.${key} is ignored`);
  if (!raw) {
    t.note('unsupported', withAt, 'Name one artifact of this run');
    return null;
  }
  const name = artifactName(t, raw, [...withAt, 'name']);
  if (name === null) return null;
  if (!PLAIN_PATH.test(dest)) {
    t.note('unsupported', [...withAt, 'path'], 'path must be a literal directory');
    return null;
  }
  if (!ok) return null;
  return [
    `if [ -z "\${YAG_RUNTIME_URL:-}" ]; then echo 'Artifacts need YAG_RUNTIME_URL, which this run does not have'; exit 1; fi`,
    `mkdir -p ${dest}`,
    `curl -fsS ${RUNTIME_AUTH} -o /tmp/yag-artifact.tgz "$YAG_RUNTIME_URL/artifacts/${name}"`,
    `tar -xzf /tmp/yag-artifact.tgz -C ${dest}`,
  ].join('\n');
}

/** A known action as a step body, null when the runner already does what it does. */
function action(
  t: Translation,
  uses: string,
  w: Map<string, string>,
  at: Key[],
  job: JobState,
  env: Obj,
): string | null {
  const name = uses.split('@')[0]!.toLowerCase();
  const withAt = [...at, 'with'];
  /** An input with a whole `${{ env.NAME }}` replaced by a literal env value. */
  const resolved = (key: string): string | undefined => {
    const v = w.get(key);
    const ref = /^\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(
      v ?? '',
    )?.[1];
    const value = ref === undefined ? undefined : env[ref];
    return isValue(value) && !hasExpression(value) ? String(value) : v;
  };
  const literal = (key: string): string | undefined => {
    const v = resolved(key);
    if (hasExpression(v)) {
      t.note('unsupported', [...withAt, key], `with.${key} must be a literal value here`);
      return undefined;
    }
    return v;
  };
  if (uses.startsWith('./') || uses.startsWith('docker://')) {
    t.note(
      'unsupported',
      at,
      'Local, composite and Docker actions are not supported; use run steps',
    );
    return null;
  }
  switch (name) {
    case 'actions/checkout':
      for (const key of w.keys()) {
        if (key === 'repository' || key === 'ref' || key === 'path')
          t.note(
            'unsupported',
            [...withAt, key],
            `with.${key} is not supported: the job gets the revision that triggered it in its workspace`,
          );
        else if (
          ['fetch-depth', 'fetch-tags', 'submodules', 'lfs', 'sparse-checkout'].includes(
            key,
          )
        )
          t.note(
            'translated',
            [...withAt, key],
            `with.${key} is ignored: the runner provides the source`,
          );
      }
      return null;
    case 'actions/setup-node': {
      const version = w.get('node-version');
      if (
        w.has('node-version-file') ||
        (version && version.replace(/^v/, '').split('.')[0] !== BUILTIN_NODE)
      )
        t.note(
          'translated',
          withAt,
          `Uses the runner's Node.js (${BUILTIN_NODE} on the built-in pool), not ${version ?? 'the version file'}`,
        );
      if (w.has('cache'))
        t.note(
          'translated',
          [...withAt, 'cache'],
          'with.cache is ignored: add an actions/cache step with an explicit key',
        );
      if (w.has('registry-url'))
        t.note(
          'unsupported',
          [...withAt, 'registry-url'],
          'registry-url is not supported; write .npmrc in a run step',
        );
      return null;
    }
    case 'actions/setup-python': {
      const version = w.get('python-version');
      t.note(
        'translated',
        at,
        `Uses the runner's python3 (${BUILTIN_PYTHON} on the built-in pool, without pip or a python command)${version && version !== BUILTIN_PYTHON ? `, not ${version}` : ''}`,
      );
      return null;
    }
    case 'pnpm/action-setup': {
      const version = literal('version');
      if (version !== undefined && !/^[\w.^~*-]+$/.test(version)) {
        t.note(
          'unsupported',
          [...withAt, 'version'],
          'Use a pnpm version such as 9 or 9.12.0',
        );
        return null;
      }
      const install = w.get('run_install');
      if (install !== undefined && install !== 'true' && install !== 'false')
        t.note(
          'unsupported',
          [...withAt, 'run_install'],
          'run_install must be true or false',
        );
      return [
        version ? `npm install -g pnpm@${version}` : 'corepack enable pnpm',
        ...(install === 'true' ? ['pnpm install'] : []),
      ].join('\n');
    }
    case 'actions/cache':
    case 'actions/cache/restore':
    case 'actions/cache/save':
      return cache(t, name, w, at, job);
    case 'actions/upload-artifact':
      return uploadArtifact(t, w, at);
    case 'actions/download-artifact':
      return downloadArtifact(t, w, at);
    case 'github/codeql-action/upload-sarif': {
      const file = literal('sarif_file') ?? 'results.sarif';
      const category = literal('category');
      for (const key of w.keys())
        if (key !== 'sarif_file' && key !== 'category')
          t.note('translated', [...withAt, key], `with.${key} is ignored`);
      if (!PLAIN_PATH.test(file)) {
        t.note(
          'unsupported',
          [...withAt, 'sarif_file'],
          'sarif_file must be one file path',
        );
        return null;
      }
      if (job.permissions.security_events !== 'write') {
        t.note(
          'unsupported',
          at,
          'Uploading SARIF needs permissions: security-events: write',
        );
        return null;
      }
      // the forge's code scanning upload (#67): gzip, base64, JSON
      return [
        `printf '{"sarif":"%s"${category ? `,"category":"%s"` : ''}}' "$(gzip -c ${file} | base64 | tr -d '\\n')"${category ? ` ${sq(category.replace(/[\\"]/g, ''))}` : ''} |`,
        `  curl -fsS -H "authorization: Bearer $YAG_CODE_SCANNING_TOKEN" -H 'content-type: application/json' --data @- "$YAG_CODE_SCANNING_URL"`,
      ].join('\n');
    }
    case 'aws-actions/configure-aws-credentials': {
      if (w.has('aws-access-key-id') || w.has('aws-secret-access-key')) {
        t.note(
          'unsupported',
          withAt,
          'Static AWS keys are not supported: use role-to-assume with OIDC',
        );
        return null;
      }
      for (const key of [
        'role-chaining',
        'web-identity-token-file',
        'output-credentials',
        'audience',
      ])
        if (w.has(key) && !(key === 'audience' && w.get(key) === 'sts.amazonaws.com'))
          t.note('unsupported', [...withAt, key], `with.${key} is not supported`);
      const role = literal('role-to-assume');
      const region = literal('aws-region');
      const session = literal('role-session-name');
      if (!role || !region) {
        t.note('unsupported', withAt, 'Set role-to-assume and aws-region');
        return null;
      }
      if (job.aws) {
        t.note('unsupported', at, 'A job can assume one AWS role');
        return null;
      }
      job.aws = { role_arn: role, region, ...(session ? { session_name: session } : {}) };
      t.note(
        'translated',
        at,
        'AWS credentials come from a web identity token file (AWS_WEB_IDENTITY_TOKEN_FILE) for the whole job, not access keys from this step on',
      );
      return null;
    }
    case 'docker/login-action': {
      const user = w.get('username');
      const password = w.get('password');
      const registry = w.get('registry');
      // Amazon ECR with the job's AWS role, as the action does without a password
      const ecr = /^\d{12}\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/.exec(
        resolved('registry') ?? '',
      );
      if (ecr && !user && !password)
        return `aws ecr get-login-password --region ${ecr[1]} | docker login --username AWS --password-stdin ${ecr[0]}`;
      if (!user || !password) {
        t.note('unsupported', withAt, 'Set username and password');
        return null;
      }
      return `printf '%s' "${t.text(password, [...withAt, 'password'], true)}" | docker login ${registry ? `"${t.text(registry, [...withAt, 'registry'], true)}" ` : ''}-u "${t.text(user, [...withAt, 'username'], true)}" --password-stdin`;
    }
    case 'docker/setup-buildx-action':
    case 'docker/setup-qemu-action':
      t.note(
        'translated',
        at,
        "Images build with the runner's docker build, without Buildx or emulation for other platforms",
      );
      return null;
    case 'docker/build-push-action': {
      const args = ['docker build --network=host'];
      const word = (key: string, v: string): string =>
        `"${t.text(v, [...withAt, key], true)}"`;
      const items = (v: string): string[] =>
        v
          .split(/[\n,]/)
          .map((x) => x.trim())
          .filter(Boolean);
      const tags: string[] = [];
      for (const [key, v] of w) {
        if (key === 'file') args.push(`-f ${word(key, v)}`);
        else if (key === 'target') args.push(`--target ${word(key, v)}`);
        else if (key === 'tags') tags.push(...items(v).map((x) => word(key, x)));
        else if (key === 'build-args' || key === 'labels')
          for (const x of v
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean))
            args.push(`${key === 'labels' ? '--label' : '--build-arg'} ${word(key, x)}`);
        else if (key === 'platforms') {
          if (items(v).some((p) => p !== 'linux/amd64'))
            t.note(
              'unsupported',
              [...withAt, key],
              'Only linux/amd64 images build here; multi-platform builds need Buildx',
            );
        } else if (
          ['cache-from', 'cache-to', 'provenance', 'sbom', 'load', 'pull'].includes(key)
        )
          t.note('translated', [...withAt, key], `with.${key} is ignored`);
        else if (key !== 'context' && key !== 'push')
          t.note('unsupported', [...withAt, key], `with.${key} is not supported`);
      }
      const push = w.get('push');
      if (push !== undefined && push !== 'true' && push !== 'false')
        t.note('unsupported', [...withAt, 'push'], 'push must be true or false');
      args.push(...tags.map((tag) => `-t ${tag}`));
      args.push(word('context', w.get('context') ?? '.'));
      return [
        args.join(' '),
        ...(push === 'true' ? tags.map((tag) => `docker push ${tag}`) : []),
      ].join('\n');
    }
    case 'azure/setup-helm': {
      const version = w.get('version');
      if (version && version !== 'latest' && version.replace(/^v?/, 'v') !== BUILTIN_HELM)
        t.note(
          'translated',
          withAt,
          `Uses the runner's helm (${BUILTIN_HELM} on the built-in pool), not ${version}`,
        );
      return null;
    }
    default:
      t.note(
        'unsupported',
        at,
        `No built-in equivalent for ${name}; replace the step with run steps`,
      );
      return null;
  }
}

function job(
  t: Translation,
  id: string,
  raw: unknown,
  workflow: { env: Obj; defaults: Defaults; permissions: Permissions },
): Obj {
  const at = ['jobs', id];
  if (!isObj(raw)) {
    t.note('unsupported', at, 'A job must be a mapping');
    return { steps: [] };
  }
  if (raw.uses !== undefined) {
    t.note('unsupported', [...at, 'uses'], 'Reusable workflows are not supported');
    return { steps: [] };
  }
  const out: Obj = {};
  const state: JobState = { aws: null, permissions: workflow.permissions, post: [] };
  const env: Obj = { ...workflow.env };
  const defaults: Defaults = { ...workflow.defaults };
  let condition: string | null = null;
  for (const [key, value] of Object.entries(raw)) {
    const path = [...at, key];
    switch (key) {
      case 'name':
      case 'steps':
        break;
      case 'needs':
        out.needs = list(value).map(String);
        break;
      case 'runs-on': {
        const labels = runsOn(t, value, path);
        if (labels) out['runs-on'] = labels;
        break;
      }
      case 'if':
        condition = t.condition(value, path);
        break;
      case 'env':
        if (isObj(value)) Object.assign(env, value);
        else t.note('unsupported', path, 'env must be a mapping');
        break;
      case 'defaults':
        if (isObj(value) && isObj(value.run)) {
          if (value.run.shell !== undefined) defaults.shell = value.run.shell;
          if (value.run['working-directory'] !== undefined)
            defaults.wd = value.run['working-directory'];
        }
        break;
      case 'strategy': {
        if (!isObj(value)) {
          t.note('unsupported', path, 'strategy must be a mapping');
          break;
        }
        for (const k of Object.keys(value))
          if (k === 'fail-fast' || k === 'max-parallel')
            t.note('translated', [...path, k], `strategy.${k} is ignored`);
          else if (k !== 'matrix')
            t.note('unsupported', [...path, k], `strategy.${k} is not supported`);
        const matrix = value.matrix;
        if (matrix === undefined) break;
        if (!isObj(matrix)) {
          t.note('unsupported', [...path, 'matrix'], 'The matrix must list its values');
          break;
        }
        const axes: Obj = {};
        for (const [axis, values] of Object.entries(matrix)) {
          if (axis === 'include' || axis === 'exclude')
            t.note(
              'unsupported',
              [...path, 'matrix', axis],
              `matrix.${axis} is not supported`,
            );
          else if (
            !Array.isArray(values) ||
            !values.every(isValue) ||
            values.some(hasExpression)
          )
            t.note(
              'unsupported',
              [...path, 'matrix', axis],
              'Matrix values must be a list of literal values',
            );
          else axes[axis] = values;
        }
        out.matrix = axes;
        break;
      }
      case 'services': {
        const svc = services(t, value, path);
        if (svc) out.services = svc;
        break;
      }
      case 'permissions':
        state.permissions = permissions(t, value, path);
        break;
      case 'environment': {
        const name = isObj(value) ? value.name : value;
        if (typeof name !== 'string' || hasExpression(name))
          t.note('unsupported', path, 'The environment must be a literal name');
        else out.environment = name;
        if (isObj(value) && value.url !== undefined)
          t.note('translated', [...path, 'url'], 'The environment URL is not shown');
        break;
      }
      case 'timeout-minutes': {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0)
          t.note('unsupported', path, 'timeout-minutes must be a number');
        else {
          if (minutes * 60 > MAX_TIMEOUT_SECONDS)
            t.note(
              'translated',
              path,
              `Jobs stop after ${MAX_TIMEOUT_SECONDS / 60} minutes here`,
            );
          out.timeout_seconds = Math.max(
            30,
            Math.min(MAX_TIMEOUT_SECONDS, Math.round(minutes * 60)),
          );
        }
        break;
      }
      case 'outputs':
        t.note('translated', path, 'Job outputs are dropped');
        break;
      case 'concurrency':
        t.note('translated', path, 'Job concurrency is ignored; set it for the workflow');
        break;
      case 'continue-on-error':
        if (value !== false)
          t.note('unsupported', path, 'continue-on-error is not supported');
        break;
      default:
        t.note('unsupported', path, `jobs.<id>.${key} is not supported`);
    }
  }
  out.timeout_seconds ??= MAX_TIMEOUT_SECONDS;
  const steps: Obj[] = [];
  for (const [i, step] of list(raw.steps).entries()) {
    const path = [...at, 'steps', i];
    if (!isObj(step)) {
      t.note('unsupported', path, 'A step must be a mapping');
      continue;
    }
    const translated = stepOf(t, step, path, state, { env, defaults, condition });
    if (translated) steps.push(translated);
  }
  // post steps run last, in reverse order, only when the job's steps passed
  steps.push(...state.post.reverse());
  out.steps = pack(t, steps, [...at, 'steps']);
  if (state.aws) out.aws = state.aws;
  if (Object.values(state.permissions).includes('write'))
    out.permissions = state.permissions;
  // The job still starts when its condition is false, so a gated job would
  // still ask for its environment's approval and get its credentials.
  if (condition)
    if (
      out.environment !== undefined ||
      state.aws ||
      state.permissions.id_token === 'write'
    )
      t.note(
        'unsupported',
        [...at, 'if'],
        'A job if: only skips steps here, so this job would still wait for its environment approval and get its secrets and cloud credentials; filter with on: branches instead, or move the condition to the steps',
      );
    else
      t.note(
        'translated',
        [...at, 'if'],
        'The job always starts; when the condition is false its steps are skipped and jobs that need it still run',
      );
  return out;
}

const STEP_KEYS = new Set([
  'id',
  'name',
  'run',
  'uses',
  'with',
  'env',
  'if',
  'shell',
  'working-directory',
  'continue-on-error',
  'timeout-minutes',
]);

function stepOf(
  t: Translation,
  step: Obj,
  at: Key[],
  job: JobState,
  inherited: { env: Obj; defaults: Defaults; condition: string | null },
): Obj | null {
  for (const key of Object.keys(step))
    if (!STEP_KEYS.has(key))
      t.note('unsupported', [...at, key], `steps[*].${key} is not supported`);
  const tolerate = step['continue-on-error'] === true;
  if (
    !tolerate &&
    step['continue-on-error'] !== undefined &&
    step['continue-on-error'] !== false
  )
    t.note(
      'unsupported',
      [...at, 'continue-on-error'],
      'continue-on-error must be true or false',
    );
  if (step['timeout-minutes'] !== undefined)
    t.note(
      'translated',
      [...at, 'timeout-minutes'],
      'Step timeouts are ignored; the job timeout applies',
    );
  const env = { ...inherited.env, ...(isObj(step.env) ? step.env : {}) };
  let body: string | null;
  if (typeof step.uses === 'string') {
    body = action(t, step.uses, t.inputs(step.with, [...at, 'with']), at, job, env);
  } else if (typeof step.run === 'string') {
    body = t.text(step.run, [...at, 'run']);
  } else {
    t.note('unsupported', at, 'A step needs run or uses');
    return null;
  }
  if (body === null) return null;
  const lines: string[] = [];
  const shell = step.shell ?? inherited.defaults.shell;
  if (shell === undefined || shell === 'sh') lines.push('set +u +o pipefail');
  else if (shell === 'bash') lines.push('set +u');
  else
    t.note(
      'unsupported',
      [...at, 'shell'],
      `The ${String(shell)} shell is not supported; use bash`,
    );
  if (shell === 'sh') t.note('translated', [...at, 'shell'], 'sh steps run with bash');
  const exports: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      t.note('unsupported', [...at, 'env', name], `Invalid variable name ${name}`);
      continue;
    }
    exports.push(
      `export ${name}="${t.text(isValue(value) ? String(value) : '', [...at, 'env', name], true)}"`,
    );
  }
  const wd = step['working-directory'] ?? inherited.defaults.wd;
  const cd =
    typeof wd === 'string'
      ? `cd "${t.text(wd, [...at, 'working-directory'], true)}"`
      : null;
  const conditions = [inherited.condition, t.condition(step.if, [...at, 'if'])].filter(
    (c): c is string => c !== null,
  );
  const rest = [
    ...exports,
    ...(cd ? [cd] : []),
    ...(conditions.length
      ? [
          `if ! { ${conditions.join(' && ')}; }; then echo 'Skipped: the if condition is false'; exit 0; fi`,
        ]
      : []),
    body,
  ].join('\n');
  // where GitHub would have written these, a run here discards them
  for (const file of ['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'])
    if (rest.includes(file)) lines.push(`export ${file}=/dev/null`);
  for (const file of ['GITHUB_ENV', 'GITHUB_PATH'])
    if (rest.includes(file))
      t.note('unsupported', at, `Values written to $${file} do not reach later steps`);
  if (rest.includes('GITHUB_WORKSPACE'))
    lines.push('export GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"');
  const name = typeof step.name === 'string' ? step.name.slice(0, 100) : undefined;
  const script = [...lines, rest].join('\n');
  // errexit is off in the caller only, so the step still stops at its first failure
  const run = tolerate
    ? `set +e\n(\nset -e\n${script}\n)\ncode=$?\nset -e\n[ "$code" -eq 0 ] || echo "Step failed with status $code; continuing (continue-on-error)"`
    : script;
  return { ...(name ? { name } : {}), run };
}

/**
 * Pipelines allow 8 steps a job, each at most 2000 characters. A longer job
 * runs neighbouring steps together, each in its own subshell so its variables,
 * directory and early exit stay its own; a step failure still ends the job.
 */
const MAX_STEPS = 8;
const MAX_RUN = 2000;
function pack(t: Translation, steps: Obj[], at: Key[]): Obj[] {
  if (steps.length <= MAX_STEPS) return steps;
  const out: { names: string[]; runs: string[] }[] = [];
  for (const step of steps) {
    const body = `(\n${String(step.run)}\n)`;
    const last = out.at(-1);
    if (last && [...last.runs, body].join('\n').length <= MAX_RUN) {
      last.runs.push(body);
      if (typeof step.name === 'string') last.names.push(step.name);
    } else
      out.push({ names: typeof step.name === 'string' ? [step.name] : [], runs: [body] });
  }
  t.note(
    'translated',
    at,
    `${steps.length} steps run as ${out.length}: a pipeline job has ${MAX_STEPS} steps at most`,
  );
  return out.map((g) => ({
    ...(g.names.length ? { name: g.names.join('; ').slice(0, 100) } : {}),
    run: g.runs.join('\n'),
  }));
}

function concurrency(t: Translation, raw: unknown, name: string): Obj | undefined {
  if (raw === undefined) return undefined;
  const at = ['concurrency'];
  const group = isObj(raw) ? raw.group : raw;
  const cancel = isObj(raw) ? (raw['cancel-in-progress'] ?? false) : false;
  if (typeof group !== 'string') {
    t.note('unsupported', at, 'concurrency needs a group');
    return undefined;
  }
  let ok = typeof cancel === 'boolean';
  const translated = group.replace(EXPRESSION, (_, expr: string) => {
    if (expr === 'github.workflow') return name;
    if (/^(github\.head_ref \|\| )?github\.(ref|ref_name)$/.test(expr))
      return '${{ ref }}';
    ok = false;
    return '';
  });
  if (!ok) {
    t.note(
      'translated',
      at,
      'Concurrency is dropped: only github.workflow, github.ref and github.ref_name groups and a literal cancel-in-progress are supported',
    );
    return undefined;
  }
  return { group: translated.slice(0, 100), cancel_in_progress: cancel };
}

const TOP_KEYS = new Set([
  'name',
  'run-name',
  'on',
  'env',
  'defaults',
  'concurrency',
  'permissions',
  'jobs',
]);

/** Translate one workflow file. The pipeline file is what CI runs (errors for an unsupported one). */
export function translateWorkflow(
  path: string,
  text: string,
): { report: WorkflowReport; file: PipelineFile } {
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const t = new Translation(doc, lines);
  let value: unknown;
  if (doc.errors.length)
    for (const e of doc.errors.slice(0, 20))
      t.findings.push({
        status: 'unsupported',
        line: lines.linePos(e.pos[0]).line,
        message: e.message,
      });
  else
    try {
      value = doc.toJS({ maxAliasCount: 50 });
    } catch (err) {
      t.findings.push({
        status: 'unsupported',
        line: 1,
        message: (err as Error).message,
      });
    }
  let name = stem;
  let spec: Obj | null = null;
  if (isObj(value)) {
    if (typeof value.name === 'string' && value.name.trim())
      name = value.name.trim().slice(0, 60);
    for (const key of Object.keys(value))
      if (!TOP_KEYS.has(key)) t.note('unsupported', [key], `${key} is not supported`);
    if (value['run-name'] !== undefined)
      t.note(
        'translated',
        ['run-name'],
        'Runs are named after the workflow, not run-name',
      );
    const defaults: Defaults = {};
    if (isObj(value.defaults) && isObj(value.defaults.run)) {
      defaults.shell = value.defaults.run.shell;
      defaults.wd = value.defaults.run['working-directory'];
    }
    const workflow = {
      env: isObj(value.env) ? value.env : {},
      defaults,
      permissions: permissions(t, value.permissions, ['permissions']),
    };
    const jobs: Obj = {};
    if (!isObj(value.jobs) || Object.keys(value.jobs).length === 0)
      t.note('unsupported', ['jobs'], 'Add at least one job');
    else
      for (const [id, j] of Object.entries(value.jobs))
        jobs[id] = job(t, id, j, workflow);
    const group = concurrency(t, value.concurrency, name);
    if (value.on === undefined) t.note('unsupported', [], 'Add an on: trigger');
    spec = {
      name,
      on: value.on === undefined ? {} : triggers(t, value.on),
      ...(group ? { concurrency: group } : {}),
      jobs,
    };
  } else if (!t.findings.length)
    t.note('unsupported', [], 'A workflow must be a mapping');
  let file: PipelineFile | null = null;
  let pipeline: string | null = null;
  if (spec && !t.findings.some((f) => f.status === 'unsupported')) {
    pipeline = stringify(spec, { lineWidth: 0 });
    file = parseSpec(path, pipeline);
    for (const e of file.errors ?? []) {
      const job = /^jobs\.([^.:]+)/.exec(e.message)?.[1];
      t.note('unsupported', job ? ['jobs', job] : [], `Pipeline limit: ${e.message}`);
    }
    if (file.errors) pipeline = null;
  }
  t.findings.sort((a, b) => a.line - b.line);
  const unsupported = t.findings.filter((f) => f.status === 'unsupported');
  const status: CompatStatus = unsupported.length
    ? 'unsupported'
    : t.findings.length
      ? 'translated'
      : 'supported';
  return {
    report: { path, name, status, findings: t.findings, pipeline },
    file:
      file && !file.errors
        ? file
        : {
            path,
            errors: unsupported
              .slice(0, 20)
              .map((f) => ({ line: f.line, column: 1, message: f.message })),
          },
  };
}
