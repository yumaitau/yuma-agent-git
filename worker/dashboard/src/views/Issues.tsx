import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import {
  issueCall,
  useIssueData,
  type Issue,
  type IssueTemplate,
  type Label,
} from '../issues';
import { useSlug } from '../slug';
import { Empty, ErrorNotice, Field, Loading, formatRelative } from '../ui';
import { RepoNav } from './Collaboration';

export function LabelChip({
  label,
}: {
  label: Pick<Label, 'name' | 'color'>;
}): ReactElement {
  return (
    <span className="chip label-chip">
      <span className="label-dot" style={{ background: `#${label.color}` }} aria-hidden />
      {label.name}
    </span>
  );
}

export function Progress({ done, total }: { done: number; total: number }): ReactElement {
  return (
    <span className="sub-progress">
      <progress max={total} value={done} aria-hidden /> {done} of {total} done
    </span>
  );
}

function IssueRow({ issue, slug }: { issue: Issue; slug: string }): ReactElement {
  return (
    <li>
      <Link to={`/r/${slug}/issues/${issue.number}`}>
        <strong>{issue.title}</strong>
      </Link>{' '}
      {issue.labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      <div className="small muted">
        #{issue.number} · {issue.state === 'open' ? 'open' : 'closed'} · updated{' '}
        {formatRelative(issue.updated_at)}
        {issue.assignees.length > 0 && ` · ${issue.assignees.length} assigned`}
        {issue.sub_issues.total > 0 && (
          <>
            {' · '}
            <Progress {...issue.sub_issues} />
          </>
        )}
      </div>
    </li>
  );
}

export function IssuesView(): ReactElement {
  const slug = useSlug();
  const [params, setParams] = useSearchParams();
  const state = params.get('state') ?? 'open';
  const label = params.get('label') ?? '';
  const before = params.get('before');
  const query = new URLSearchParams({ state });
  if (label) query.set('label', label);
  if (before) query.set('before', before);
  const { data, error } = useIssueData<{
    issues: Issue[];
    pinned: Issue[];
    next_cursor: number | null;
  }>(`/repos/${slug}/issues?${query}`);
  const labels = useIssueData<{ labels: Label[] }>(`/repos/${slug}/labels`);
  const filter = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    next.delete('before');
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <RepoNav active="Issues" />
      <div className="row between">
        <h1>Issues</h1>
        <Link className="btn primary" to={`/r/${slug}/issues/new`}>
          New issue
        </Link>
      </div>
      <div className="row">
        <Field label="State">
          <select value={state} onChange={(e) => filter('state', e.target.value)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </Field>
        <Field label="Label">
          <select value={label} onChange={(e) => filter('label', e.target.value)}>
            <option value="">Any label</option>
            {labels.data?.labels.map((l) => (
              <option key={l.id} value={l.name}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && <ErrorNotice error={error} />}
      {!data && !error && <Loading />}
      {data && data.pinned.length > 0 && (
        <section aria-label="Pinned issues">
          <h2>Pinned</h2>
          <ul className="history-list">
            {data.pinned.map((issue) => (
              <IssueRow key={issue.id} issue={issue} slug={slug} />
            ))}
          </ul>
        </section>
      )}
      {data?.issues.length === 0 && (
        <Empty>
          No {state === 'all' ? '' : state} issues
          {label ? ` labelled ${label}` : ''}. Open one to track a bug or plan work.
        </Empty>
      )}
      <ul className="history-list">
        {data?.issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} slug={slug} />
        ))}
      </ul>
      <div className="row">
        {before && <button onClick={() => filter('before', '')}>Newest issues</button>}
        {data?.next_cursor && (
          <button onClick={() => filter('before', String(data.next_cursor))}>
            Older issues
          </button>
        )}
      </div>
    </>
  );
}

/** GitHub-style form answers: one `### Label` section per field. */
function formBody(template: IssueTemplate, values: Record<string, string>): string {
  return template.fields
    .filter((f) => f.type !== 'markdown')
    .map((f) => `### ${f.label}\n\n${values[f.id]?.trim() || '_No response_'}`)
    .join('\n\n');
}

export function NewIssueView(): ReactElement {
  const slug = useSlug();
  const navigate = useNavigate();
  const { data, error } = useIssueData<{
    templates: IssueTemplate[];
    errors: { path: string; message: string }[];
  }>(`/repos/${slug}/issue-templates`);
  const [template, setTemplate] = useState<IssueTemplate | null>(null);
  const [chosen, setChosen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const choose = (t: IssueTemplate | null): void => {
    setTemplate(t);
    setChosen(true);
    setTitle(t?.title ?? '');
    setBody(t?.body ?? '');
    setValues(Object.fromEntries((t?.fields ?? []).map((f) => [f.id, f.value])));
  };
  const submit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await issueCall<{ issue: Issue }>(`/repos/${slug}/issues`, 'POST', {
        title,
        body: template?.fields.length ? formBody(template, values) : body,
        labels: template?.labels ?? [],
        assignees: template?.assignees ?? [],
      });
      navigate(`/r/${slug}/issues/${result.issue.number}`);
    } catch (err) {
      setFailure(asApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const templates = data?.templates ?? [];
  return (
    <>
      <RepoNav active="Issues" />
      <h1>New issue</h1>
      {(failure || error) && <ErrorNotice error={(failure || error)!} />}
      {!data && !error && <Loading />}
      {data?.errors.map((e) => (
        <p key={e.path} className="small muted">
          Template <code>{e.path}</code> could not be read: {e.message}
        </p>
      ))}
      {data && !chosen && templates.length > 0 && (
        <ul className="history-list" aria-label="Issue templates">
          {templates.map((t) => (
            <li key={t.path}>
              <strong>{t.name}</strong>
              <p className="small muted">{t.about}</p>
              <button onClick={() => choose(t)}>Use template</button>
            </li>
          ))}
          <li>
            <button onClick={() => choose(null)}>Open a blank issue</button>
          </li>
        </ul>
      )}
      {data && (chosen || templates.length === 0) && (
        <form
          className="setup-flow stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Title">
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          {template?.fields.length ? (
            template.fields.map((f) =>
              f.type === 'markdown' ? (
                <p key={f.id} className="small muted preserve-lines">
                  {f.value}
                </p>
              ) : f.type === 'dropdown' ? (
                <Field key={f.id} label={f.label}>
                  <select
                    required={f.required}
                    value={values[f.id] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
              ) : f.type === 'checkboxes' ? (
                <fieldset key={f.id}>
                  <legend>{f.label}</legend>
                  {f.options.map((o) => (
                    <label key={o}>
                      <input
                        type="checkbox"
                        onChange={(e) => {
                          const lines = (values[f.id] ?? '').split('\n').filter(Boolean);
                          const rest = lines.filter((l) => !l.endsWith(`] ${o}`));
                          setValues({
                            ...values,
                            [f.id]: [
                              ...rest,
                              `- [${e.target.checked ? 'x' : ' '}] ${o}`,
                            ].join('\n'),
                          });
                        }}
                      />{' '}
                      {o}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <Field key={f.id} label={f.label}>
                  {f.type === 'input' ? (
                    <input
                      type="text"
                      required={f.required}
                      placeholder={f.placeholder}
                      value={values[f.id] ?? ''}
                      onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                    />
                  ) : (
                    <textarea
                      required={f.required}
                      placeholder={f.placeholder}
                      value={values[f.id] ?? ''}
                      onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                    />
                  )}
                </Field>
              ),
            )
          ) : (
            <Field label="Description (Markdown)">
              <textarea value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Opening…' : 'Open issue'}
          </button>
        </form>
      )}
    </>
  );
}
