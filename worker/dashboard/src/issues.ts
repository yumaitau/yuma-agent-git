import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch, asApiError } from './api';
export type {
  Issue,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueTemplate,
  IssueTemplateField,
  Label,
  Milestone,
} from '../../shared/issues';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `/api/v1` JSON call that keeps error details (`pull_id` on `pull_request`). */
export async function issueCall<T>(
  path: string,
  method: Method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await apiFetch(`/api/v1${path}`, { method, body });
  const data = (await response.json()) as T & {
    error?: { code?: string; message?: string } & Record<string, unknown>;
  };
  if (!response.ok) {
    const { code, message, ...details } = data.error ?? {};
    throw new ApiError(
      response.status,
      code ?? 'request_failed',
      message ?? 'Request failed',
      details,
    );
  }
  return data;
}

/** Load `path` once per change (and on `refresh`). */
export function useIssueData<T>(path: string | null): {
  data: T | null;
  error: ApiError | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // A new path clears the old page; a refresh keeps it until new data lands.
  useEffect(() => setData(null), [path]);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setError(null);
    issueCall<T>(path)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((err) => {
        if (!cancelled) setError(asApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);
  return { data, error, refresh };
}
