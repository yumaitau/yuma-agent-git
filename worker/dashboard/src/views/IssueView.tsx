import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import {
  issueCall,
  useIssueData,
  type IssueDetail,
  type IssueEvent,
  type Label,
  type Milestone,
} from '../issues';
import { Markdown } from '../Markdown';
import { useSlug } from '../slug';
import { Chip, ErrorNotice, Field, Loading, formatRelative } from '../ui';
import { RepoNav } from './Collaboration';
import { LabelChip, Progress } from './Issues';

const REASONS: Record<string, string> = {
  completed: 'completed',
  not_planned: 'not planned',
  duplicate: 'duplicate',
};

/** One line of timeline text for an event. */
function describeEvent(e: IssueEvent, name: (p: string) => string): ReactNode {
  const p = e.payload;
  const source = p.source as
    { kind: string; repo: string; ref: number | string } | undefined;
  const from = source
    ? source.kind === 'changeset'
      ? ` in commit ${String(source.ref).slice(0, 8)}`
      : ` from ${source.kind === 'pull' ? 'pull request' : 'issue'} ${source.repo}#${source.ref}`
    : '';
  switch (e.kind) {
    case 'labeled':
    case 'unlabeled':
      return `${e.kind === 'labeled' ? 'added' : 'removed'} label ${String(p.label)}`;
    case 'assigned':
    case 'unassigned':
      return `${e.kind} ${name(String(p.assignee))}`;
    case 'closed':
      return `closed this as ${REASONS[String(p.state_reason)] ?? 'completed'}${from}`;
    case 'referenced':
      return `referenced this${from}`;
    case 'renamed':
      return `renamed this from "${String(p.from)}"`;
    case 'milestoned':
      return p.milestone_id === null ? 'removed the milestone' : 'set the milestone';
    case 'sub_issue_added':
    case 'sub_issue_removed':
      return `${e.kind === 'sub_issue_added' ? 'added' : 'removed'} sub-issue #${String(p.number)}`;
    case 'parent_added':
    case 'parent_removed':
      return `${e.kind === 'parent_added' ? 'added this to' : 'removed this from'} #${String(p.number)}`;
    default:
      return e.kind.replace('_', ' ');
  }
}

export function IssueView(): ReactElement {
  const slug = useSlug();
  const { number } = useParams();
  const path = `/repos/${slug}/issues/${number}`;
  const { data, error, refresh } = useIssueData<IssueDetail>(path);
  const triage = data?.can_triage ?? false;
  const labels = useIssueData<{ labels: Label[] }>(
    triage ? `/repos/${slug}/labels` : null,
  );
  const milestones = useIssueData<{ milestones: Milestone[] }>(
    triage ? `/repos/${slug}/milestones` : null,
  );
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignees, setAssignees] = useState('');
  const [child, setChild] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  if (error?.code === 'pull_request' && typeof error.details.pull_id === 'number')
    return <Navigate replace to={`/r/${slug}/pulls/${error.details.pull_id}`} />;

  const act = async (
    tail: string,
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    input?: unknown,
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    try {
      await issueCall(`${path}${tail}`, method, input);
      refresh();
      return true;
    } catch (err) {
      setFailure(asApiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const name = (p: string): string => data?.names[p] ?? p;
  const issue = data?.issue;
  const timeline = data
    ? [
        ...data.comments.map((c) => ({ at: c.created_at, key: `c${c.id}`, comment: c })),
        ...data.events.map((e) => ({ at: e.created_at, key: `e${e.id}`, event: e })),
      ].sort((a, b) => a.at - b.at)
    : [];
  return (
    <>
      <RepoNav active="Issues" />
      {(failure || error) && <ErrorNotice error={(failure || error)!} />}
      {!data && !error && <Loading />}
      {data && issue && (
        <>
          {editing ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act('', 'PATCH', { title, body }).then(
                  (ok) => ok && setEditing(false),
                );
              }}
            >
              <Field label="Title">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Description (Markdown)">
                <textarea value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
              <div className="row">
                <button className="primary" disabled={busy}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <h1>
              {issue.title} <span className="muted">#{issue.number}</span>
            </h1>
          )}
          <p className="muted">
            <Chip kind={issue.state === 'open' ? 'ok' : 'info'}>
              {issue.state === 'open'
                ? 'Open'
                : `Closed · ${REASONS[issue.state_reason ?? ''] ?? 'completed'}`}
            </Chip>{' '}
            {name(`user:${issue.author_id}`)} opened this{' '}
            {formatRelative(issue.created_at)}
            {issue.locked && ' · locked'}
            {issue.pinned && ' · pinned'}
          </p>
          {data.parent && (
            <p className="small">
              Sub-issue of{' '}
              <Link to={`/r/${slug}/issues/${data.parent.number}`}>
                #{data.parent.number} {data.parent.title}
              </Link>
            </p>
          )}
          <Markdown source={issue.body} slug={slug} />
          <div className="row">
            {!editing && (
              <button
                disabled={busy}
                onClick={() => {
                  setTitle(issue.title);
                  setBody(issue.body);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
            {issue.state === 'open' ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act('', 'PATCH', { state: 'closed', state_reason: 'completed' })
                  }
                >
                  Close as completed
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act('', 'PATCH', {
                      state: 'closed',
                      state_reason: 'not_planned',
                    })
                  }
                >
                  Close as not planned
                </button>
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() => void act('', 'PATCH', { state: 'open' })}
              >
                Reopen
              </button>
            )}
            {triage && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void act('/lock', 'PUT', { on: !issue.locked })}
                >
                  {issue.locked ? 'Unlock' : 'Lock'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void act('/pin', 'PUT', { on: !issue.pinned })}
                >
                  {issue.pinned ? 'Unpin' : 'Pin'}
                </button>
              </>
            )}
          </div>

          <section aria-label="Labels">
            <h2>Labels</h2>
            <p>
              {issue.labels.length === 0 && <span className="muted">None yet</span>}
              {issue.labels.map((l) => (
                <LabelChip key={l.id} label={l} />
              ))}
            </p>
            {triage && labels.data && (
              <div className="row">
                {labels.data.labels.map((l) => {
                  const on = issue.labels.some((x) => x.id === l.id);
                  return (
                    <label key={l.id}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy}
                        onChange={() =>
                          void act('/labels', 'PUT', {
                            labels: on
                              ? issue.labels
                                  .filter((x) => x.id !== l.id)
                                  .map((x) => x.name)
                              : [...issue.labels.map((x) => x.name), l.name],
                          })
                        }
                      />{' '}
                      {l.name}
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-label="Assignees">
            <h2>Assignees</h2>
            <p>
              {issue.assignees.length === 0
                ? 'No one'
                : issue.assignees.map(name).join(', ')}
            </p>
            {triage && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('/assignees', 'PUT', {
                    assignees: assignees
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }).then((ok) => ok && setAssignees(''));
                }}
              >
                <input
                  type="text"
                  aria-label="Assignees"
                  placeholder="login, team:ID or agent:ID, comma separated"
                  value={assignees}
                  onChange={(e) => setAssignees(e.target.value)}
                />
                <button disabled={busy}>Set assignees</button>
              </form>
            )}
          </section>

          <section aria-label="Milestone">
            <h2>Milestone</h2>
            {triage && milestones.data ? (
              <select
                aria-label="Milestone"
                value={issue.milestone_id ?? ''}
                disabled={busy}
                onChange={(e) =>
                  void act('', 'PATCH', {
                    milestone_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">No milestone</option>
                {milestones.data.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            ) : (
              <p>{data.milestone?.title ?? 'None'}</p>
            )}
          </section>

          <section aria-label="Sub-issues">
            <h2>Sub-issues</h2>
            {data.sub_issues.length > 0 && <Progress {...issue.sub_issues} />}
            <ol>
              {data.sub_issues.map((s, i) => (
                <li key={s.number}>
                  <Link to={`/r/${slug}/issues/${s.number}`}>
                    #{s.number} {s.title}
                  </Link>{' '}
                  <span className="small muted">{s.state}</span>
                  {triage && (
                    <>
                      {' '}
                      <button
                        disabled={busy || i === 0}
                        aria-label={`Move #${s.number} up`}
                        onClick={() => {
                          const order = data.sub_issues.map((x) => x.number);
                          order.splice(i - 1, 2, order[i]!, order[i - 1]!);
                          void act('/sub-issues', 'PUT', { order });
                        }}
                      >
                        ↑
                      </button>{' '}
                      <button
                        disabled={busy}
                        aria-label={`Remove #${s.number}`}
                        onClick={() => void act(`/sub-issues/${s.number}`, 'DELETE')}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ol>
            {triage && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('/sub-issues', 'POST', { number: Number(child) }).then(
                    (ok) => ok && setChild(''),
                  );
                }}
              >
                <input
                  type="text"
                  aria-label="Sub-issue number"
                  placeholder="Issue number"
                  value={child}
                  onChange={(e) => setChild(e.target.value)}
                />
                <button disabled={busy || !/^\d+$/.test(child)}>Add sub-issue</button>
              </form>
            )}
          </section>

          <h2>Activity</h2>
          <ol className="history-list">
            {timeline.map((item) =>
              'comment' in item && item.comment ? (
                <li key={item.key}>
                  <div className="small muted">
                    <strong>{name(`user:${item.comment.author_id}`)}</strong> commented{' '}
                    {formatRelative(item.at)}
                  </div>
                  <Markdown source={item.comment.body} slug={slug} />
                </li>
              ) : 'event' in item && item.event ? (
                <li key={item.key} className="timeline-event small muted">
                  {name(item.event.actor)} {describeEvent(item.event, name)}{' '}
                  {formatRelative(item.at)}
                </li>
              ) : null,
            )}
          </ol>
          {issue.locked && !triage ? (
            <p className="muted">This issue is locked. Only triagers can comment.</p>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act('/comments', 'POST', { body: comment }).then(
                  (ok) => ok && setComment(''),
                );
              }}
            >
              <Field label="Comment (Markdown)">
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
              </Field>
              <button className="primary" disabled={busy || !comment.trim()}>
                Comment
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
