import { z } from 'zod';
import { globMatch } from './rulesets';

/**
 * Agent policy engine (issue #62, ADR 0003): a typed rules DSL evaluated on
 * every agent action before it takes effect. A policy is JSON data checked by
 * `policySchema`; `evaluatePolicy` is pure and synchronous, so the same code
 * runs in pre-receive, the API, agent tools and `POST /api/v1/policy/test`.
 *
 * A rule names the actions it covers, an effect (`deny` or
 * `require_approval`) and conditions under `when`; every condition present
 * must hold for the rule to match (an empty `when` always matches). The
 * strictest matching effect wins: deny, then require_approval, else allow.
 * A push or commit that changes `.yuma/pipelines/**` is also judged as
 * `pipeline.edit`. `secret.write` and `issue.ready` are accepted for policies
 * written now: agents cannot write secrets (sessions only) and the ready
 * state arrives with the work queue (#59), which calls the engine then.
 */

export const POLICY_ACTIONS = [
  'push',
  'changeset.create',
  'ref.move',
  'pr.merge',
  'release.publish',
  'pipeline.run',
  'pipeline.edit',
  'secret.write',
  'issue.ready',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

const glob = z.string().min(1).max(256);

export const policyRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'lower-case id'),
    description: z.string().max(500).default(''),
    actions: z.array(z.enum(POLICY_ACTIONS)).min(1),
    effect: z.enum(['deny', 'require_approval']),
    when: z
      .object({
        /** Some changed file matches these globs (`!glob` excludes; last match wins). */
        paths: z.array(glob).min(1).max(100).optional(),
        /** The ref matches these globs (`!glob` excludes; last match wins). */
        refs: z.array(glob).min(1).max(100).optional(),
        /** More than this many files change. */
        max_files: z.number().int().nonnegative().optional(),
        /** More than this many bytes of new file content. */
        max_bytes: z.number().int().nonnegative().optional(),
        /** The ref move is not a fast-forward. */
        force_push: z.literal(true).optional(),
        /** The work carries one of these risk levels. */
        risk: z.array(z.enum(RISKS)).min(1).optional(),
        /** A dependency in a changed manifest resolves outside these registries. */
        registries: z.array(z.string().min(1).max(253)).min(1).max(50).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policySchema = z
  .object({
    version: z.literal(1),
    rules: z.array(policyRuleSchema).max(200),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    for (const [i, rule] of policy.rules.entries()) {
      if (seen.has(rule.id))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'id'],
          message: `duplicate id ${rule.id}`,
        });
      seen.add(rule.id);
    }
  });
export type Policy = z.infer<typeof policySchema>;

export interface PolicyFile {
  path: string;
  op: 'add' | 'mod' | 'del';
  /** Bytes of new content, when known. */
  size?: number;
}

export interface Dependency {
  name: string;
  registry: string;
}

/** The facts an action is judged on; absent facts never match a condition. */
export const policyInputSchema = z
  .object({
    action: z.enum(POLICY_ACTIONS),
    ref: z.string().optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          op: z.enum(['add', 'mod', 'del']),
          size: z.number().int().nonnegative().optional(),
        }),
      )
      .max(10_000)
      .optional(),
    force_push: z.boolean().optional(),
    risk: z.enum(RISKS).nullable().optional(),
    dependencies: z
      .array(z.object({ name: z.string(), registry: z.string() }))
      .max(5_000)
      .optional(),
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInputSchema>;

export type PolicyOutcome = 'allow' | 'deny' | 'require_approval';

export interface PolicyMatch {
  rule: string;
  effect: Exclude<PolicyOutcome, 'allow'>;
  message: string;
}

export interface PolicyResult {
  outcome: PolicyOutcome;
  matches: PolicyMatch[];
}

/** gitignore-style: the last pattern that matches decides; `!` excludes. */
function matches(patterns: readonly string[], value: string): boolean {
  let hit = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (globMatch(negated ? p.slice(1) : p, value)) hit = !negated;
  }
  return hit;
}

/** Pipeline definitions: a push or commit that changes one is also `pipeline.edit`. */
export const PIPELINE_PATHS = '.yuma/pipelines/**';

function actionsOf(input: PolicyInput): PolicyAction[] {
  const edits =
    (input.action === 'push' || input.action === 'changeset.create') &&
    (input.files ?? []).some((f) => globMatch(PIPELINE_PATHS, f.path));
  return edits ? [input.action, 'pipeline.edit'] : [input.action];
}

/** Why `rule` matches `input`, or null when some condition does not hold. */
function matchRule(
  rule: PolicyRule,
  input: PolicyInput,
  actions: readonly PolicyAction[],
): string | null {
  const action = actions.find((a) => rule.actions.includes(a));
  if (action === undefined) return null;
  const w = rule.when;
  const files = input.files ?? [];
  const why: string[] = [];
  if (w.paths) {
    const hit = files.find((f) => matches(w.paths!, f.path));
    if (!hit) return null;
    why.push(`changes ${hit.path}`);
  }
  if (w.refs) {
    if (input.ref === undefined || !matches(w.refs, input.ref)) return null;
    why.push(`targets ${input.ref}`);
  }
  if (w.max_files !== undefined) {
    if (files.length <= w.max_files) return null;
    why.push(`changes ${files.length} files (limit ${w.max_files})`);
  }
  if (w.max_bytes !== undefined) {
    const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    if (bytes <= w.max_bytes) return null;
    why.push(`writes ${bytes} bytes (limit ${w.max_bytes})`);
  }
  if (w.force_push) {
    if (input.force_push !== true) return null;
    why.push('is a force push');
  }
  if (w.risk) {
    if (!input.risk || !w.risk.includes(input.risk)) return null;
    why.push(`is ${input.risk} risk`);
  }
  if (w.registries) {
    const outside = (input.dependencies ?? []).find(
      (d) => !w.registries!.includes(d.registry),
    );
    if (!outside) return null;
    why.push(`adds ${outside.name} from ${outside.registry}`);
  }
  return why.length === 0 ? action : why.join(', ');
}

/** Judge one action. Pure: no I/O, no clock. */
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyResult {
  const matches: PolicyMatch[] = [];
  const actions = actionsOf(input);
  for (const rule of policy.rules) {
    const why = matchRule(rule, input, actions);
    if (why === null) continue;
    const verb = rule.effect === 'deny' ? 'denies' : 'needs approval';
    matches.push({
      rule: rule.id,
      effect: rule.effect,
      message: `policy ${rule.id} ${verb}: ${why}`,
    });
  }
  const outcome = matches.some((m) => m.effect === 'deny')
    ? 'deny'
    : matches.length > 0
      ? 'require_approval'
      : 'allow';
  return { outcome, matches };
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
export const NPM_REGISTRY = 'registry.npmjs.org';

/** Where an npm dependency spec resolves from: a host, `local` or the npm registry. */
export function npmRegistryOf(spec: string): string {
  const s = spec.trim();
  if (/^(file|link|workspace|portal):/.test(s)) return 'local';
  if (/^(github|gist):/.test(s)) return 'github.com';
  if (s.startsWith('gitlab:')) return 'gitlab.com';
  if (s.startsWith('bitbucket:')) return 'bitbucket.org';
  const scp = /^(?:git\+)?[\w.-]+@([\w.-]+):/.exec(s);
  if (scp && !s.includes('://')) return scp[1] as string;
  if (/^[a-z+]+:\/\//i.test(s)) {
    try {
      return new URL(s.replace(/^git\+/, '')).hostname;
    } catch {
      return 'invalid';
    }
  }
  // `owner/repo` is GitHub shorthand; `npm:` aliases stay on the registry
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) return 'github.com';
  return NPM_REGISTRY;
}

/**
 * Dependencies a `package.json` declares, with where each resolves from.
 * Malformed manifests yield one `invalid` entry so registry rules still fire.
 */
export function npmDependencies(content: string): Dependency[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return [{ name: 'package.json', registry: 'invalid' }];
  }
  if (typeof manifest !== 'object' || manifest === null) return [];
  const out: Dependency[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = (manifest as Record<string, unknown>)[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [name, spec] of Object.entries(deps)) {
      out.push({
        name,
        registry: typeof spec === 'string' ? npmRegistryOf(spec) : 'invalid',
      });
    }
  }
  return out;
}

export const isManifest = (path: string): boolean =>
  path === 'package.json' || path.endsWith('/package.json');
