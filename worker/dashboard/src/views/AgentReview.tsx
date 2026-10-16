import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { call } from '../collaboration';
import { Chip, formatRelative } from '../ui';

/**
 * Agent review loop and risk of one pull request (issue #60): the change's
 * risk and why, each round's verdicts, and whether a person was asked.
 */

interface Finding {
  severity: 'high' | 'medium' | 'low';
  body: string;
  path?: string;
  line?: number;
}

export interface AgentReviewData {
  max_rounds: number;
  round: number;
  escalation: { round: number; requested: string | null; at: number } | null;
  verdicts: {
    revision: number;
    reviewer: string;
    verdict: 'pass' | 'fail';
    confidence: number;
    summary: string;
    findings: Finding[];
    round: number;
    created_at: number;
  }[];
  risk: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
    lines: number;
    files: number;
  };
}

const RISK_CHIP = { low: 'ok', medium: 'warn', high: 'danger' } as const;

export function AgentReviewPanel({
  slug,
  id,
  revision,
}: {
  slug: string;
  id: string;
  /** Refetch when the pull request moves to a new revision. */
  revision: number;
}): ReactElement | null {
  const [data, setData] = useState<AgentReviewData | null>(null);
  useEffect(() => {
    let cancelled = false;
    call<AgentReviewData>(`/repos/${slug}/pulls/${id}/agent-review`)
      .then((d) => !cancelled && setData(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug, id, revision]);
  if (!data?.risk) return null;
  return (
    <section aria-label="Agent review">
      <h2>
        Agent review <Chip kind={RISK_CHIP[data.risk.level]}>{data.risk.level} risk</Chip>
      </h2>
      {data.risk.reasons.length > 0 && (
        <p className="small muted">{data.risk.reasons.join('; ')}</p>
      )}
      {data.escalation && (
        <div className="notice warn" role="alert">
          Agent review still failed after {data.escalation.round} rounds, so a person was
          asked to review {formatRelative(data.escalation.at)}. Agents cannot push more
          revisions.
        </div>
      )}
      {data.verdicts.length === 0 ? (
        <p className="muted">No agent verdicts yet.</p>
      ) : (
        <ul>
          {data.verdicts.map((v) => (
            <li key={`${v.revision}:${v.reviewer}`}>
              Round {v.round} (revision {v.revision}): <code>{v.reviewer}</code>{' '}
              <Chip kind={v.verdict === 'pass' ? 'ok' : 'danger'}>{v.verdict}</Chip>{' '}
              <span className="small muted">
                confidence {Math.round(v.confidence * 100)}%
              </span>
              {v.summary && <div className="small">{v.summary}</div>}
              {v.findings.length > 0 && (
                <ul className="small">
                  {v.findings.map((f, i) => (
                    <li key={i}>
                      {f.severity}: {f.body}
                      {f.path && (
                        <span className="muted">
                          {' '}
                          {f.path}
                          {f.line ? `:${f.line}` : ''}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        Round {data.round} of {data.max_rounds}.
      </p>
    </section>
  );
}
