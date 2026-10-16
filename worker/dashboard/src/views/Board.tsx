import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useIssueData } from '../issues';
import { useSlug } from '../slug';
import { Empty, ErrorNotice, Field, Loading, formatRelative } from '../ui';
import { RepoNav } from './Collaboration';
import { RISKS, type Risk, type WorkItem } from '../../../shared/work';

/** Ready or claimed work that has failed this often needs a person to look. */
const ATTENTION_ATTEMPTS = 3;

const COLUMNS = [
  'Needs preparation',
  'Queued',
  'Running',
  'Waiting',
  'Review',
  'Needs attention',
  'Done',
] as const;
type Column = (typeof COLUMNS)[number];

/** The board column for an item: a view over readiness, dependencies and attempts. */
export function columnOf(item: WorkItem): Column {
  if (item.readiness === 'done') return 'Done';
  if (item.readiness === 'in-review') return 'Review';
  if (item.readiness === 'blocked') return 'Waiting';
  if (item.readiness === 'draft' || item.readiness === 'needs-prep')
    return 'Needs preparation';
  if (item.attempts >= ATTENTION_ATTEMPTS) return 'Needs attention';
  if (item.readiness === 'claimed') return 'Running';
  return item.waiting_on.length > 0 ? 'Waiting' : 'Queued';
}

const RISK_CHIP: Record<Risk, string> = { low: 'ok', medium: 'warn', high: 'danger' };

function Card({ item, slug }: { item: WorkItem; slug: string }): ReactElement {
  return (
    <li className="job-node">
      <Link to={`/r/${slug}/issues/${item.number}`}>
        <strong>{item.title}</strong>
      </Link>
      <span className="small muted">
        #{item.number} ·{' '}
        <span className={`chip ${RISK_CHIP[item.risk]}`}>{item.risk}</span>
        {item.priority !== 0 && ` · priority ${item.priority}`}
        {item.size && ` · ${item.size}`}
        {item.plan && ' · plan'}
      </span>
      {item.claimed_by && (
        <span className="small">
          {item.claimed_by}, lease ends {formatRelative(item.lease_expires_at)}
        </span>
      )}
      {item.waiting_on.length > 0 && (
        <span className="small muted">
          Waits on {item.waiting_on.map((n) => `#${n}`).join(', ')}
        </span>
      )}
      {item.attempts > 0 && (
        <span className="small muted">
          {item.attempts} {item.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
      )}
    </li>
  );
}

/** Work queue board (issue #59): columns by readiness, filters by risk and agent. */
export function BoardView(): ReactElement {
  const slug = useSlug();
  const [params, setParams] = useSearchParams();
  const risk = params.get('risk') ?? '';
  const agent = params.get('agent') ?? '';
  const { data, error } = useIssueData<{ items: WorkItem[] }>(`/repos/${slug}/work`);
  const filter = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const agents = [...new Set((data?.items ?? []).flatMap((i) => i.claimed_by ?? []))];
  const items = (data?.items ?? []).filter(
    (i) => (!risk || i.risk === risk) && (!agent || i.claimed_by === agent),
  );
  return (
    <>
      <RepoNav active="Board" />
      <h1>Board</h1>
      <div className="row">
        <Field label="Risk">
          <select value={risk} onChange={(e) => filter('risk', e.target.value)}>
            <option value="">Any risk</option>
            {RISKS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="Agent">
          <select value={agent} onChange={(e) => filter('agent', e.target.value)}>
            <option value="">Anyone</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </Field>
      </div>
      {error && <ErrorNotice error={error} />}
      {!data && !error && <Loading />}
      {data?.items.length === 0 && (
        <Empty>
          Nothing is queued yet. Give an issue a readiness with <code>yag work set</code>,
          or import Factory labels.
        </Empty>
      )}
      {data && data.items.length > 0 && (
        <div className="job-graph" aria-label="Work board">
          {COLUMNS.map((column) => {
            const cards = items.filter((i) => columnOf(i) === column);
            return (
              <section key={column} aria-label={column}>
                <h2 className="small">
                  {column} <span className="muted">{cards.length}</span>
                </h2>
                <ul className="job-stage">
                  {cards.map((item) => (
                    <Card key={item.number} item={item} slug={slug} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
