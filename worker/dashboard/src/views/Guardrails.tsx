import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  api,
  asApiError,
  type AgentPause,
  type ApiError,
  type Approval,
  type Repo,
} from '../api';
import { useToast } from '../toast';
import { Chip, Empty, ErrorNotice, Field, Loading, formatRelative } from '../ui';

/**
 * Agent guardrails (issue #62): the org kill switch, showing who paused
 * agents and why, and the approval queue where people approve or reject the
 * exact agent change a policy held.
 */

function pausedBy(p: AgentPause): string {
  return `${p.paused_by_login ?? p.paused_by} ${formatRelative(p.paused_at)}${
    p.reason ? `: ${p.reason}` : ''
  }`;
}

export function AgentPausePanel({
  org,
  canManage,
}: {
  org: string;
  canManage: boolean;
}): ReactElement {
  const toast = useToast();
  const [state, setState] = useState<{
    paused: AgentPause | null;
    instance: AgentPause | null;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api
      .getAgentPause(org)
      .then(setState)
      .catch((err) => setError(asApiError(err)));
  }, [org]);
  useEffect(load, [load]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      try {
        await fn();
        toast.show(done);
        setReason('');
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [load, toast],
  );

  return (
    <div className="panel">
      <h2>Agents</h2>
      {error && <ErrorNotice error={error} />}
      {state === null ? (
        !error && <Loading />
      ) : (
        <>
          {state.instance && (
            <div>
              <Chip kind="danger">paused on this forge</Chip> by{' '}
              {pausedBy(state.instance)}
            </div>
          )}
          {state.paused ? (
            <div className="row" style={{ alignItems: 'center' }}>
              <span>
                <Chip kind="danger">paused</Chip> by {pausedBy(state.paused)}
              </span>
              {canManage && (
                <button
                  type="button"
                  onClick={() => void act(() => api.resumeAgents(org), 'agents resumed')}
                >
                  Resume agents
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="small muted">
                Agents run in this organisation. Pausing revokes every agent token,
                cancels queued and running agent tasks and refuses agent writes at once.
              </div>
              {canManage && (
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <Field label="Reason">
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      void act(() => api.pauseAgents(org, reason.trim()), 'agents paused')
                    }
                  >
                    Pause all agents
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function ApprovalsPanel({ repos }: { repos: Repo[] }): ReactElement {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    setApprovals(null);
    setError(null);
    if (slug === '') return;
    api
      .listApprovals(slug)
      .then(setApprovals)
      .catch((err) => setError(asApiError(err)));
  }, [slug]);
  useEffect(load, [load]);

  const decide = useCallback(
    async (a: Approval, decision: 'approve' | 'reject') => {
      try {
        await api.decideApproval(slug, a.id, decision);
        toast.show(decision === 'approve' ? 'approved' : 'rejected');
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [slug, toast, load],
  );

  return (
    <div className="panel">
      <h2>Agent approvals</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Agent changes a policy holds for a person. Approving lets the agent retry that
        exact change (same payload hash); anything different asks again.
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
        (approvals === null ? (
          !error && <Loading />
        ) : approvals.length === 0 ? (
          <Empty>Nothing waits for approval.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Agent</th>
                <th>Action</th>
                <th>Why</th>
                <th>Payload</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td>{formatRelative(a.requested_at)}</td>
                  <td>
                    <code>{a.principal}</code>
                    {a.on_behalf_of_login && (
                      <div className="small muted">for {a.on_behalf_of_login}</div>
                    )}
                  </td>
                  <td>
                    <Chip>{a.action}</Chip>
                  </td>
                  <td>
                    {a.reasons.map((r) => (
                      <div key={r.rule} className="small">
                        {r.message}
                      </div>
                    ))}
                  </td>
                  <td>
                    <code className="small">{JSON.stringify(a.payload)}</code>
                    <div className="small faint">
                      sha256 {a.payload_hash.slice(0, 12)}
                    </div>
                  </td>
                  <td>
                    <button type="button" onClick={() => void decide(a, 'approve')}>
                      Approve
                    </button>{' '}
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void decide(a, 'reject')}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
