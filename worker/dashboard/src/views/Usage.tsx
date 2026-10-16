import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Chip, Empty, ErrorNotice, formatBytes, formatRelative, Loading } from '../ui';
import { RepoNav } from './Collaboration';

/**
 * Cost and token accounting (issue #61) for a repo or an org: totals, cost
 * per merged pull request, a breakdown by day, agent, model, ticket or pull
 * request, a CSV export of the same, and the org's budgets.
 */

interface Sums {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  ci_seconds: number;
  storage_byte_days: number;
  usd_micros: number;
  unpriced: number;
}

interface Row extends Sums {
  key: string;
  repo?: string | null;
  label?: string | null;
  merged?: boolean;
}

interface Report {
  from: string;
  to: string;
  group_by: string;
  totals: Sums;
  merged_pulls: number;
  usd_micros_per_merged_pull: number | null;
  tokens_per_merged_pull: number | null;
  rows: Row[];
}

interface Budget {
  id: string;
  metric: 'tokens' | 'usd_micros';
  period: 'day' | 'month';
  soft_limit: number | null;
  hard_limit: number | null;
  used: number;
}

interface Alert {
  budget_id: string;
  period_start: string;
  level: 'soft' | 'hard';
  used: number;
  limit_value: number;
  at: number;
}

const GROUPS: [string, string][] = [
  ['day', 'Day'],
  ['pull', 'Pull request'],
  ['ticket', 'Ticket'],
  ['agent', 'Agent'],
  ['model', 'Model'],
  ['kind', 'Kind'],
  ['repo', 'Repository'],
];

export function usd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return '—';
  return `$${(micros / 1_000_000).toFixed(micros !== 0 && Math.abs(micros) < 10_000 ? 4 : 2)}`;
}

const tokens = (s: Sums): number => s.input_tokens + s.output_tokens + s.cached_tokens;
const number = (n: number): string => n.toLocaleString('en-AU');

function amount(budget: Budget, n: number | null): string {
  if (n === null) return '—';
  return budget.metric === 'usd_micros' ? usd(n) : `${number(n)} tokens`;
}

export function UsageView(): ReactElement {
  const { owner, name, org } = useParams();
  const base = org ? `/orgs/${org}/usage` : `/repos/${owner ?? ''}/${name ?? ''}/usage`;
  const [params, setParams] = useSearchParams();
  const group = params.get('group_by') ?? 'pull';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const query = new URLSearchParams({ group_by: group });
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const path = `${base}?${query.toString()}`;
  const [report, setReport] = useState<Report | null>(null);
  const [budgets, setBudgets] = useState<{ budgets: Budget[]; alerts: Alert[] } | null>(
    null,
  );
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    call<Report>(path)
      .then((r) => !cancelled && setReport(r))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    call<{ budgets: Budget[]; alerts: Alert[] }>(
      `/usage/budgets?org=${encodeURIComponent(org)}`,
    )
      .then((b) => !cancelled && setBudgets(b))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [org]);

  const set = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <>
      {org ? (
        <Link className="small muted" to={`/orgs/${org}`}>
          {org}
        </Link>
      ) : (
        <RepoNav active="Usage" />
      )}
      <div className="row between">
        <h1>Usage and cost</h1>
        <a className="btn" href={`/api/v1${path}&format=csv`} download>
          Export CSV
        </a>
      </div>
      <div className="row">
        <label>
          From{' '}
          <input type="date" value={from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          By{' '}
          <select value={group} onChange={(e) => set('group_by', e.target.value)}>
            {GROUPS.filter(([g]) => org || g !== 'repo').map(([g, label]) => (
              <option key={g} value={g}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <ErrorNotice error={error} />}
      {!report && !error && <Loading />}
      {report && (
        <>
          <p className="muted small">
            {report.from} to {report.to}
          </p>
          <div className="panel">
            <div className="kv">
              <span className="k">Cost</span>
              <span>{usd(report.totals.usd_micros)}</span>
              <span className="k">Tokens</span>
              <span>{number(tokens(report.totals))}</span>
              <span className="k">CI minutes</span>
              <span>{number(Math.round(report.totals.ci_seconds / 60))}</span>
              <span className="k">Per merged PR</span>
              <span>
                {usd(report.usd_micros_per_merged_pull)}{' '}
                <span className="small muted">({report.merged_pulls} merged)</span>
              </span>
            </div>
          </div>
          {report.totals.unpriced > 0 && (
            <p className="small muted">
              {report.totals.unpriced} event{report.totals.unpriced === 1 ? '' : 's'} had
              no price for their model and count as $0.
            </p>
          )}
          {report.rows.length === 0 ? (
            <Empty>No usage recorded in this range.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{GROUPS.find(([g]) => g === report.group_by)?.[1] ?? 'Key'}</th>
                    <th>Tokens (in / out / cached)</th>
                    <th>CI minutes</th>
                    <th>Storage</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={`${r.repo ?? ''}${r.key}`}>
                      <td>
                        {r.repo && org ? <span className="muted">{r.repo} </span> : null}
                        {r.key || '—'}
                        {r.label ? <span className="muted"> {r.label}</span> : null}{' '}
                        {r.merged && <Chip kind="ok">merged</Chip>}
                      </td>
                      <td className="mono small">
                        {number(r.input_tokens)} / {number(r.output_tokens)} /{' '}
                        {number(r.cached_tokens)}
                      </td>
                      <td>{number(Math.round(r.ci_seconds / 60))}</td>
                      <td>
                        {r.storage_byte_days ? formatBytes(r.storage_byte_days) : '—'}
                      </td>
                      <td>{usd(r.usd_micros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {budgets && (
        <section aria-label="Budgets">
          <h2>Budgets</h2>
          {budgets.budgets.length === 0 ? (
            <Empty>No budgets. Org owners set them with PUT /api/v1/usage/budgets.</Empty>
          ) : (
            <ul>
              {budgets.budgets.map((b) => {
                const stopped = b.hard_limit !== null && b.used >= b.hard_limit;
                return (
                  <li key={b.id}>
                    {amount(b, b.used)} of {amount(b, b.hard_limit ?? b.soft_limit)} per{' '}
                    {b.period}{' '}
                    {stopped ? (
                      <Chip kind="danger">claims stopped</Chip>
                    ) : b.soft_limit !== null && b.used >= b.soft_limit ? (
                      <Chip kind="warn">over soft limit</Chip>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {budgets.alerts.length > 0 && (
            <ul className="small muted">
              {budgets.alerts.map((a) => (
                <li key={`${a.budget_id}${a.period_start}${a.level}`}>
                  {a.level} limit reached {formatRelative(a.at)} ({number(a.used)} of{' '}
                  {number(a.limit_value)})
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
