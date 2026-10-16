import { isNode, LineCounter, parseDocument, type Document } from 'yaml';
import { parseCronExpression } from 'cron-schedule';
import { z } from 'zod';
import type { Env } from '../env';
import { getBlob } from '../core/blobs';
import { getChangeset } from '../core/changesets';
import { getTree, resolvePath } from '../core/trees';
import type { CiPolicy, SpecError } from '../../shared/collaboration';
import {
  accessFields,
  AWS_NEEDS_ID_TOKEN,
  DEFAULT_INSTANCE,
  INSTANCE_NAMES,
  MAX_TIMEOUT_S,
  type InstanceType,
} from './config';

/**
 * Pipeline spec v2 (issue #47): `.yuma/pipelines/*.yml` in the repository.
 * The only expressions are `${{ matrix.<axis> }}`, `${{ secrets.<NAME> }}` and
 * `${{ vars.<NAME> }}` in steps and `${{ ref }}` in a concurrency group; they
 * are plain text substitution, never evaluated. Secrets and variables become
 * `${NAME}` shell references, so their values never enter command text.
 * A job's `environment`, `secrets`, `permissions` and `aws` are the issue #50
 * access fields of the settings pipeline, gated per job.
 * Limits match the settings pipeline so one job reserves what one run did,
 * except `timeout_seconds` (up to 6 hours, within the org's pool, issue #52).
 * `runs-on: [cloudflare, standard-4]` picks a Cloudflare instance type and
 * `matrix.shard: N` splits a job into N shards (YAG_SHARD_INDEX of
 * YAG_SHARD_TOTAL, 1-based, for `vitest --shard`).
 */
const PIPELINE_DIR = ['.yuma', 'pipelines'];
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_JOBS = 16;
const MAX_MATRIX = 8;

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'Use letters, digits, - or _ (40 at most)');
const patterns = z.array(z.string().min(1).max(200)).min(1).max(20);
const one = (v: unknown): unknown => (typeof v === 'string' ? [v] : v);
const validCron = (v: string): boolean => {
  if (v.trim().split(/\s+/).length !== 5) return false;
  try {
    parseCronExpression(v);
    return true;
  } catch {
    return false;
  }
};
const validZone = (v: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: v });
    return true;
  } catch {
    return false;
  }
};

const triggers = z.preprocess(
  (v) =>
    typeof v === 'string' || Array.isArray(v)
      ? Object.fromEntries((one(v) as unknown[]).map((k) => [String(k), null]))
      : v,
  z
    .strictObject({
      push: z
        .strictObject({ branches: patterns, tags: patterns, paths: patterns })
        .partial()
        .nullable()
        .optional(),
      pull_request: z
        .strictObject({ branches: patterns, paths: patterns })
        .partial()
        .nullable()
        .optional(),
      // merge queue groups (#43), filtered by the branch they land on
      merge_group: z.strictObject({ branches: patterns }).partial().nullable().optional(),
      manual: z.strictObject({}).nullable().optional(),
      schedule: z
        .array(
          z.strictObject({
            cron: z.string().refine(validCron, 'Use a five-field cron expression'),
            timezone: z.string().default('UTC').refine(validZone, 'Unknown time zone'),
          }),
        )
        .min(1)
        .max(4)
        .optional(),
    })
    .refine((o) => Object.keys(o).length > 0, 'Add at least one trigger'),
);

const REFERENCE = /^(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]{0,99})$/;

const service = z.strictObject({
  image: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._/:@-]{0,199}$/,
      'Use an image reference such as postgres:16',
    ),
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Invalid variable name'),
      z.union([z.string().max(1000), z.number(), z.boolean()]).transform(String),
    )
    .optional(),
});
const serviceSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,199}$/),
  env: z.record(z.string(), z.string()),
});
export type Service = z.infer<typeof serviceSchema>;

/** Services in a stored run config; settings pipeline runs have none. */
export function runnerServices(config: string): Service[] {
  return z
    .object({ services: z.array(serviceSchema).max(4).default([]) })
    .parse(JSON.parse(config)).services;
}

/**
 * Runner routing (issue #48): `runs-on` labels a self-hosted runner must all
 * carry. No `runs-on`, or one naming `cloudflare`, runs on the built-in pool.
 */
export const BUILTIN_LABELS = ['cloudflare', 'linux', 'x64'];
const label = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,49}$/, 'Use lower-case letters, digits, ., _ or -');
export const labelsSchema = z.array(label).min(1).max(10);

/** Self-hosted labels in a stored run config; null for the built-in pool. */
export function runnerLabels(config: string): string[] | null {
  return z
    .object({ runs_on: labelsSchema.nullable().default(null) })
    .parse(JSON.parse(config)).runs_on;
}

/** The Cloudflare instance type in a stored run config (issue #52). */
export function runnerInstance(config: string): InstanceType {
  return z
    .object({ instance_type: z.enum(INSTANCE_NAMES).default(DEFAULT_INSTANCE) })
    .parse(JSON.parse(config)).instance_type;
}

/** Fixed job environment in a stored run config: the shard variables. */
export function jobEnv(config: string): Record<string, string> {
  return z
    .object({ env: z.record(z.string(), z.string()).default({}) })
    .parse(JSON.parse(config)).env;
}

const job = z.strictObject({
  needs: z.preprocess(one, z.array(id).max(MAX_JOBS)).optional(),
  matrix: z
    .record(
      id,
      z.union([
        z
          .array(z.union([z.string().min(1).max(100), z.number(), z.boolean()]))
          .min(1)
          .max(MAX_MATRIX),
        // `shard: N` only: N shards, 1-based
        z.number().int().min(1).max(MAX_MATRIX),
      ]),
    )
    .optional(),
  timeout_seconds: z.number().int().min(30).max(MAX_TIMEOUT_S).default(300),
  'runs-on': z.preprocess(one, labelsSchema).optional(),
  services: z
    .record(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'Use lower-case letters, digits or -'),
      service,
    )
    .optional(),
  steps: z
    .array(
      z.strictObject({
        name: z.string().max(100).optional(),
        run: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(8),
  ...accessFields,
});

const EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;

const specSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60).optional(),
    on: triggers,
    concurrency: z
      .strictObject({
        group: z.string().trim().min(1).max(100),
        cancel_in_progress: z.boolean().default(false),
      })
      .optional(),
    jobs: z.record(id, job),
  })
  .superRefine((spec, ctx) => {
    const names = Object.keys(spec.jobs);
    if (names.length === 0)
      ctx.addIssue({ code: 'custom', path: ['jobs'], message: 'Add at least one job' });
    let total = 0;
    for (const [name, j] of Object.entries(spec.jobs)) {
      for (const [i, need] of (j.needs ?? []).entries()) {
        if (!spec.jobs[need] || need === name)
          ctx.addIssue({
            code: 'custom',
            path: ['jobs', name, 'needs', i],
            message: need === name ? 'A job cannot need itself' : `Unknown job "${need}"`,
          });
      }
      for (const [axis, v] of Object.entries(j.matrix ?? {}))
        if (!Array.isArray(v) && axis !== 'shard')
          ctx.addIssue({
            code: 'custom',
            path: ['jobs', name, 'matrix', axis],
            message: 'Use a list of values (only shard takes a number)',
          });
      const size = Object.values(j.matrix ?? {}).reduce(
        (n: number, v) => n * axisValues(v).length,
        1,
      );
      if (size > MAX_MATRIX)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'matrix'],
          message: `A matrix may expand to ${MAX_MATRIX} jobs at most`,
        });
      total += size;
      if (Object.keys(j.services ?? {}).length > 4)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'services'],
          message: 'Use 4 services at most',
        });
      for (const [i, step] of j.steps.entries()) {
        for (const [, expr] of step.run.matchAll(EXPRESSION)) {
          if (REFERENCE.test(expr)) continue;
          const axis = /^matrix\.([A-Za-z0-9_-]+)$/.exec(expr)?.[1];
          if (!axis || !j.matrix?.[axis])
            ctx.addIssue({
              code: 'custom',
              path: ['jobs', name, 'steps', i, 'run'],
              message: `Unsupported expression "${expr}". Use matrix values of this job, secrets.<NAME> or vars.<NAME>`,
            });
        }
      }
      const runsOn = j['runs-on'] ?? [];
      const types = runsOn.filter((l) => (INSTANCE_NAMES as string[]).includes(l));
      if (
        runsOn.includes('cloudflare') &&
        runsOn.some((l) => !BUILTIN_LABELS.includes(l) && !types.includes(l))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'runs-on'],
          message: `Cloudflare runners only carry the labels ${BUILTIN_LABELS.join(', ')} and an instance type (${INSTANCE_NAMES.join(', ')})`,
        });
      if (runsOn.includes('cloudflare') && types.length > 1)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'runs-on'],
          message: 'Pick one instance type',
        });
      if (j.aws && j.permissions.id_token !== 'write')
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'aws'],
          message: AWS_NEEDS_ID_TOKEN,
        });
      if (jobSecrets(j).length > 50)
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'secrets'],
          message: 'A job may use 50 secrets at most',
        });
    }
    if (total > MAX_JOBS)
      ctx.addIssue({
        code: 'custom',
        path: ['jobs'],
        message: `A pipeline may run ${MAX_JOBS} jobs at most, including matrix jobs`,
      });
    for (const [, expr] of (spec.concurrency?.group ?? '').matchAll(EXPRESSION)) {
      if (expr !== 'ref')
        ctx.addIssue({
          code: 'custom',
          path: ['concurrency', 'group'],
          message: `Unsupported expression "${expr}". Only \${{ ref }} can be used`,
        });
    }
    // Depth-first search; a grey node seen again closes a cycle.
    const state = new Map<string, 'grey' | 'black'>();
    const visit = (name: string): boolean => {
      if (state.get(name) === 'black') return false;
      if (state.get(name) === 'grey') return true;
      state.set(name, 'grey');
      const cyclic = (spec.jobs[name]?.needs ?? []).some((n) => spec.jobs[n] && visit(n));
      state.set(name, 'black');
      return cyclic;
    };
    const cyclic = names.find((n) => visit(n));
    if (cyclic)
      ctx.addIssue({
        code: 'custom',
        path: ['jobs', cyclic, 'needs'],
        message: 'Job needs form a cycle',
      });
  });

type Spec = z.infer<typeof specSchema>;

/** Matrix values of one axis; `shard: N` is 1..N. */
function axisValues(v: (string | number | boolean)[] | number): string[] {
  return Array.isArray(v)
    ? v.map(String)
    : Array.from({ length: v }, (_, i) => String(i + 1));
}
type Triggers = Spec['on'];

/** Secrets a job lists or references in its steps, by stored (upper-case) name. */
function jobSecrets(j: z.infer<typeof job>): string[] {
  const names = j.secrets.map((n) => n.toUpperCase());
  for (const step of j.steps)
    for (const [, expr] of step.run.matchAll(EXPRESSION)) {
      const ref = REFERENCE.exec(expr);
      if (ref?.[1] === 'secrets') names.push(ref[2]!.toUpperCase());
    }
  return [...new Set(names)];
}

export interface PlannedJob extends Pick<
  CiPolicy,
  'environment' | 'secrets' | 'permissions' | 'aws'
> {
  key: string;
  job: string;
  needs: string[];
  commands: string[];
  timeout_seconds: number;
  services: Service[];
  /** Self-hosted runner labels, or null for the built-in pool. */
  runs_on: string[] | null;
  /** Cloudflare instance type for the built-in pool (issue #52). */
  instance_type: InstanceType;
  /** Fixed environment: YAG_SHARD_INDEX and YAG_SHARD_TOTAL for a sharded job. */
  env: Record<string, string>;
}

export interface Pipeline {
  name: string;
  on: Triggers;
  concurrency: { group: string; cancel_in_progress: boolean } | null;
  jobs: PlannedJob[];
}

export interface PipelineFile {
  path: string;
  pipeline?: Pipeline;
  errors?: SpecError[];
}

function locate(doc: Document, lines: LineCounter, path: PropertyKey[]): SpecError {
  const keys = path.filter((k) => typeof k !== 'symbol');
  for (let n = keys.length; n >= 0; n--) {
    const node = doc.getIn(keys.slice(0, n), true);
    if (isNode(node) && node.range) {
      const pos = lines.linePos(node.range[0]);
      return { line: pos.line, column: pos.col, message: '' };
    }
  }
  return { line: 1, column: 1, message: '' };
}

/** Parse and validate one spec. Errors carry 1-based line and column. */
export function parseSpec(path: string, text: string): PipelineFile {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0)
    return {
      path,
      errors: doc.errors.slice(0, 20).map((e) => {
        const pos = lines.linePos(e.pos[0]);
        return { line: pos.line, column: pos.col, message: e.message };
      }),
    };
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    return {
      path,
      errors: [{ line: 1, column: 1, message: (err as Error).message }],
    };
  }
  const parsed = specSchema.safeParse(value);
  if (!parsed.success)
    return {
      path,
      errors: parsed.error.issues.slice(0, 20).map((issue) => {
        const at = issue.path.filter((k) => typeof k !== 'symbol').join('.');
        return {
          ...locate(doc, lines, issue.path),
          message: at ? `${at}: ${issue.message}` : issue.message,
        };
      }),
    };
  const spec = parsed.data;
  const jobs: PlannedJob[] = [];
  for (const [name, j] of Object.entries(spec.jobs)) {
    let combos: [string, string][][] = [[]];
    for (const [axis, values] of Object.entries(j.matrix ?? {}))
      combos = combos.flatMap((c) =>
        axisValues(values).map((v): [string, string][] => [...c, [axis, v]]),
      );
    const shards = typeof j.matrix?.shard === 'number' ? j.matrix.shard : null;
    const runsOn = j['runs-on'];
    const builtin = !runsOn || runsOn.includes('cloudflare');
    for (const combo of combos) {
      const values = new Map(combo);
      const shard = shards ? values.get('shard')! : null;
      const label = ([axis, v]: [string, string]): string =>
        shards && axis === 'shard' ? `${v}/${shards}` : v;
      jobs.push({
        key: combo.length ? `${name} (${combo.map(label).join(', ')})` : name,
        job: name,
        needs: j.needs ?? [],
        commands: j.steps.map((s) =>
          s.run.replace(EXPRESSION, (_, expr: string) => {
            const ref = REFERENCE.exec(expr);
            if (ref) return `\${${ref[2]!.toUpperCase()}}`;
            return values.get(expr.slice('matrix.'.length)) ?? '';
          }),
        ),
        timeout_seconds: j.timeout_seconds,
        services: Object.entries(j.services ?? {}).map(([n, s]) => ({
          name: n,
          image: s.image,
          env: s.env ?? {},
        })),
        runs_on: builtin ? null : runsOn,
        instance_type:
          ((builtin && runsOn?.find((l) => (INSTANCE_NAMES as string[]).includes(l))) as
            InstanceType | undefined) || DEFAULT_INSTANCE,
        env: shard ? { YAG_SHARD_INDEX: shard, YAG_SHARD_TOTAL: String(shards) } : {},
        environment: j.environment,
        secrets: jobSecrets(j),
        permissions: j.permissions,
        aws: j.aws,
      });
    }
  }
  if (new Set(jobs.map((j) => j.key)).size !== jobs.length)
    return {
      path,
      errors: [{ line: 1, column: 1, message: 'Matrix values must be unique' }],
    };
  return {
    path,
    pipeline: {
      name: spec.name ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, ''),
      on: spec.on,
      concurrency: spec.concurrency ?? null,
      jobs,
    },
  };
}

/** Every pipeline file at a revision, valid or not, sorted by path. */
export async function loadPipelines(
  env: Env,
  repoId: string,
  csId: string,
): Promise<PipelineFile[]> {
  const cs = await getChangeset(env, repoId, csId);
  if (!cs?.root_tree) return [];
  const dir = await resolvePath(env, repoId, cs.root_tree, PIPELINE_DIR);
  const tree = dir?.kind === 'tree' ? await getTree(env, repoId, dir.hash) : null;
  const entries = (tree?.entries ?? [])
    .filter((e) => e.kind === 'blob' && /\.ya?ml$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const out: PipelineFile[] = [];
  for (const [i, entry] of entries.entries()) {
    const path = `${PIPELINE_DIR.join('/')}/${entry.name}`;
    const fail = (message: string): void => {
      out.push({ path, errors: [{ line: 1, column: 1, message }] });
    };
    if (i >= MAX_FILES) {
      fail(`Use ${MAX_FILES} pipeline files at most`);
      continue;
    }
    const blob = await getBlob(env, repoId, entry.hash);
    if (!blob || blob.content.byteLength > MAX_FILE_BYTES) {
      fail(`Pipeline files are limited to ${MAX_FILE_BYTES / 1024} KiB`);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        blob.content,
      );
    } catch {
      fail('Pipeline files must be UTF-8 text');
      continue;
    }
    out.push(parseSpec(path, text));
  }
  return out;
}

/**
 * `*` and `?` stay within one path segment; `**` crosses segments, and `**`
 * then `/` also matches no directory at all. Steps the set of reachable value
 * positions through the pattern, so time is O(pattern × value) whatever the
 * pattern (patterns come from repo YAML; a backtracking regex could hang).
 */
export function globMatch(pattern: string, value: string): boolean {
  const n = value.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    let next = new Uint8Array(n + 1);
    if (ch === '*') {
      const any = pattern[i + 1] === '*';
      if (any) i++;
      for (let k = 0; k <= n; k++)
        next[k] =
          at[k] || (k > 0 && next[k - 1] && (any || value[k - 1] !== '/')) ? 1 : 0;
      if (any && pattern[i + 1] === '/') {
        i++;
        const dirs = new Uint8Array(n + 1);
        for (let k = 0; k <= n; k++)
          dirs[k] = at[k] || (k > 0 && next[k - 1] && value[k - 1] === '/') ? 1 : 0;
        next = dirs;
      }
    } else {
      for (let k = 1; k <= n; k++)
        next[k] =
          at[k - 1] && (ch === '?' ? value[k - 1] !== '/' : value[k - 1] === ch) ? 1 : 0;
    }
    at = next;
  }
  return at[n] === 1;
}

/** Wall-clock fields of `ms` in `zone`, as a UTC timestamp. */
function wall(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

/**
 * Next instant after `after` that matches `cron` read as wall-clock time in
 * `zone`. cron-schedule works in the runtime's local time, which is UTC on
 * Workers, so it searches wall-clock time and the result is converted back.
 * Times skipped by a daylight saving change do not fire.
 */
export function nextRun(cron: string, zone: string, after: number): number {
  const schedule = parseCronExpression(cron);
  let cursor = wall(after, zone);
  for (let i = 0; i < 1000; i++) {
    const local = schedule.getNextDate(new Date(cursor)).getTime();
    let at = local - (wall(local, zone) - local);
    at = local - (wall(at, zone) - at);
    if (wall(at, zone) === local && at > after) return at;
    cursor = local;
  }
  throw new Error('No upcoming schedule time');
}
