import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  api,
  asApiError,
  type ApiError,
  type Repo,
  type Ruleset,
  type RulesetEvaluation,
  type RulesetInput,
} from '../api';
import { useToast } from '../toast';
import { Chip, Empty, ErrorNotice, Field, Loading, formatRelative } from '../ui';

/**
 * Repo rulesets (issue #41): branch, tag and push rules with bypass actors,
 * the org rulesets that reach the repo, and the evaluate-mode report.
 */

type Target = Ruleset['target'];
type Enforcement = Ruleset['enforcement'];

const REF_RULES: Record<Exclude<Target, 'push'>, [string, string][]> = {
  branch: [
    ['deletion', 'Block deletion'],
    ['non_fast_forward', 'Block force pushes'],
    ['update', 'Require a pull request'],
    ['required_status_checks', 'Require CI to pass'],
    ['required_review_thread_resolution', 'Require review threads resolved'],
  ],
  tag: [
    ['deletion', 'Block deletion'],
    ['non_fast_forward', 'Block force pushes'],
    ['update', 'Block updates'],
  ],
};

const MB = 1024 * 1024;

function list(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** One rule in a few words. */
export function describeRule(rule: Ruleset['rules'][number]): string {
  switch (rule.type) {
    case 'deletion':
      return 'no deletion';
    case 'non_fast_forward':
      return 'no force push';
    case 'update':
      return 'pull request only';
    case 'pull_request':
      return `${String(rule.required_approvals)} approval(s)`;
    case 'required_status_checks':
      return 'CI must pass';
    case 'merge_methods':
      return `merge by ${(rule.allowed as string[]).join(' or ')}`;
    case 'required_review_thread_resolution':
      return 'all threads resolved';
    case 'max_file_size':
      return `files up to ${Number(rule.max_bytes) / MB} MB`;
    case 'file_path_restriction':
      return `no ${(rule.paths as string[]).join(', ')}`;
    case 'file_extension_restriction':
      return `no ${(rule.extensions as string[]).join(', ')}`;
    default:
      return rule.type;
  }
}

function inputOf(r: Ruleset): RulesetInput {
  return {
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    conditions: r.conditions,
    rules: r.rules,
    bypass: r.bypass,
  };
}

function RulesetRows({
  rulesets,
  onEnforce,
  onDelete,
}: {
  rulesets: Ruleset[];
  onEnforce?: (r: Ruleset, e: Enforcement) => void;
  onDelete?: (r: Ruleset) => void;
}): ReactElement {
  return (
    <>
      {rulesets.map((r) => (
        <tr key={r.id}>
          <td>
            {r.name} {r.scope === 'org' && <Chip kind="info">org</Chip>}
          </td>
          <td>{r.target}</td>
          <td className="mono small">
            {r.target === 'push'
              ? '—'
              : (r.conditions.ref_name?.include ?? []).join(', ')}
          </td>
          <td className="small">{r.rules.map(describeRule).join('; ')}</td>
          <td className="mono small">{r.bypass.join(', ') || '—'}</td>
          <td>
            {onEnforce ? (
              <select
                aria-label={`Enforcement of ${r.name}`}
                value={r.enforcement}
                onChange={(e) => onEnforce(r, e.target.value as Enforcement)}
              >
                <option value="active">active</option>
                <option value="evaluate">evaluate</option>
                <option value="disabled">disabled</option>
              </select>
            ) : (
              <Chip kind={r.enforcement === 'active' ? 'ok' : 'warn'}>
                {r.enforcement}
              </Chip>
            )}
          </td>
          <td>
            {onDelete && (
              <button className="danger" onClick={() => onDelete(r)}>
                Delete
              </button>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

function NewRuleset({
  slug,
  onCreated,
}: {
  slug: string;
  onCreated: () => void;
}): ReactElement {
  const toast = useToast();
  const [name, setName] = useState('');
  const [target, setTarget] = useState<Target>('branch');
  const [enforcement, setEnforcement] = useState<Enforcement>('active');
  const [refs, setRefs] = useState('~DEFAULT_BRANCH');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [approvals, setApprovals] = useState('0');
  const [methods, setMethods] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [paths, setPaths] = useState('');
  const [extensions, setExtensions] = useState('');
  const [bypass, setBypass] = useState('');

  const create = useCallback(async () => {
    const rules: RulesetInput['rules'] =
      target === 'push'
        ? [
            ...(maxMb
              ? [{ type: 'max_file_size', max_bytes: Math.round(Number(maxMb) * MB) }]
              : []),
            ...(paths ? [{ type: 'file_path_restriction', paths: list(paths) }] : []),
            ...(extensions
              ? [{ type: 'file_extension_restriction', extensions: list(extensions) }]
              : []),
          ]
        : [
            ...REF_RULES[target]
              .filter(([type]) => checked[type])
              .map(([type]) => ({ type })),
            ...(target === 'branch' && Number(approvals) > 0
              ? [{ type: 'pull_request', required_approvals: Number(approvals) }]
              : []),
            ...(target === 'branch' && methods
              ? [{ type: 'merge_methods', allowed: list(methods) }]
              : []),
          ];
    try {
      await api.createRuleset(slug, {
        name: name.trim(),
        target,
        enforcement,
        conditions:
          target === 'push' ? {} : { ref_name: { include: list(refs), exclude: [] } },
        rules,
        bypass: list(bypass),
      });
      toast.show('ruleset created');
      setName('');
      onCreated();
    } catch (err) {
      toast.showError(err);
    }
  }, [
    slug,
    name,
    target,
    enforcement,
    refs,
    checked,
    approvals,
    methods,
    maxMb,
    paths,
    extensions,
    bypass,
    toast,
    onCreated,
  ]);

  return (
    <>
      <h3>New ruleset</h3>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Target">
          <select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            <option value="branch">branches</option>
            <option value="tag">tags</option>
            <option value="push">pushes</option>
          </select>
        </Field>
        <Field label="Enforcement">
          <select
            value={enforcement}
            onChange={(e) => setEnforcement(e.target.value as Enforcement)}
          >
            <option value="active">active</option>
            <option value="evaluate">evaluate (log only)</option>
            <option value="disabled">disabled</option>
          </select>
        </Field>
        {target !== 'push' && (
          <Field label="Ref patterns (comma separated, ~DEFAULT_BRANCH, ~ALL)">
            <input type="text" value={refs} onChange={(e) => setRefs(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
        {target === 'push' ? (
          <>
            <Field label="Max file size (MB)">
              <input
                type="number"
                min={1}
                value={maxMb}
                onChange={(e) => setMaxMb(e.target.value)}
              />
            </Field>
            <Field label="Restricted paths (globs)">
              <input
                type="text"
                placeholder="secrets/**"
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
              />
            </Field>
            <Field label="Restricted extensions">
              <input
                type="text"
                placeholder=".exe, .pem"
                value={extensions}
                onChange={(e) => setExtensions(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <fieldset className="checks">
              <legend className="small">Rules</legend>
              {REF_RULES[target].map(([type, label]) => (
                <label key={type}>
                  <input
                    type="checkbox"
                    checked={checked[type] ?? false}
                    onChange={(e) =>
                      setChecked((prev) => ({ ...prev, [type]: e.target.checked }))
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {target === 'branch' && (
              <Field label="Required approvals">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={approvals}
                  onChange={(e) => setApprovals(e.target.value)}
                />
              </Field>
            )}
            {target === 'branch' && (
              <Field label="Allowed merge methods (blank for any)">
                <input
                  type="text"
                  placeholder="merge, squash, rebase"
                  value={methods}
                  onChange={(e) => setMethods(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        <Field label="Bypass (role:admin, team:slug, agent:ID, user:ID)">
          <input type="text" value={bypass} onChange={(e) => setBypass(e.target.value)} />
        </Field>
        <button
          className="primary"
          disabled={name.trim() === ''}
          onClick={() => void create()}
        >
          Create ruleset
        </button>
      </div>
    </>
  );
}

export function RulesetsPanel({ repos }: { repos: Repo[] }): ReactElement {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [data, setData] = useState<{ rulesets: Ruleset[]; inherited: Ruleset[] } | null>(
    null,
  );
  const [evaluations, setEvaluations] = useState<RulesetEvaluation[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    setData(null);
    setError(null);
    if (slug === '') return;
    Promise.all([api.listRulesets(slug), api.listRulesetEvaluations(slug)])
      .then(([rulesets, evals]) => {
        setData(rulesets);
        setEvaluations(evals);
      })
      .catch((err) => setError(asApiError(err)));
  }, [slug]);
  useEffect(load, [load]);

  const enforce = useCallback(
    async (r: Ruleset, enforcement: Enforcement) => {
      try {
        await api.updateRuleset(slug, r.id, { ...inputOf(r), enforcement });
        toast.show(`${r.name} is now ${enforcement}`);
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [slug, toast, load],
  );

  const remove = useCallback(
    async (r: Ruleset) => {
      try {
        await api.deleteRuleset(slug, r.id);
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [slug, toast, load],
  );

  const all = data ? [...data.rulesets, ...data.inherited] : [];
  return (
    <div className="panel">
      <h2>Rulesets</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Rules for branches, tags and pushes, applied to API ref moves,{' '}
        <code>git push</code>, pull request merges and agent lands alike. Bypass actors
        pass active rules and every bypass is audited. Evaluate mode logs what a ruleset
        would refuse.
      </div>
      {error && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Repository">
          <select value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">select a repo…</option>
            {repos.map((r) => (
              <option key={r.id} value={r.slug}>
                {r.slug}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {slug !== '' &&
        (data === null ? (
          !error && <Loading />
        ) : all.length === 0 ? (
          <Empty>No rulesets apply to this repository.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Target</th>
                <th>Refs</th>
                <th>Rules</th>
                <th>Bypass</th>
                <th>Enforcement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <RulesetRows
                rulesets={data.rulesets}
                onEnforce={(r, e) => void enforce(r, e)}
                onDelete={(r) => void remove(r)}
              />
              <RulesetRows rulesets={data.inherited} />
            </tbody>
          </table>
        ))}
      {slug !== '' && data !== null && (
        <>
          <NewRuleset slug={slug} onCreated={load} />
          <h3>Evaluate-mode report</h3>
          {evaluations.length === 0 ? (
            <Empty>No evaluate-mode violations recorded.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Ruleset</th>
                  <th>Ref</th>
                  <th>Via</th>
                  <th>Actor</th>
                  <th>Would have refused</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((e) => (
                  <tr key={e.id}>
                    <td className="small muted">{formatRelative(e.at)}</td>
                    <td>{e.ruleset}</td>
                    <td className="mono small">{e.ref ?? '—'}</td>
                    <td className="small">{e.via}</td>
                    <td className="mono small wrap-any">{e.actor_id}</td>
                    <td className="small">
                      {e.violations.map((v) => v.message).join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
