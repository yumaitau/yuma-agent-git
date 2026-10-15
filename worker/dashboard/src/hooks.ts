import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, asApiError } from './api';

/**
 * Hand-rolled polling primitives (no external state libs):
 *   - `usePolling` — fixed-interval refetch, paused while the tab is hidden
 *     (`document.visibilityState`), immediate refetch on return.
 *   - `useSincePolling` — incremental cursor polling: each fetch receives the
 *     highest `t` seen so far and results are appended + deduped by key (the
 *     server filters `t >= since`, so the boundary entry legitimately repeats).
 */

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export interface PollingState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

export interface PollingOptions<T> {
  /** Stop the loop once a fetched value says so (e.g. terminal task states). */
  stopWhen?: (data: T) => boolean;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
  options: PollingOptions<T> = {},
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const fetcherRef = useRef(fetcher);
  const stopRef = useRef(options.stopWhen);
  useEffect(() => {
    fetcherRef.current = fetcher;
    stopRef.current = options.stopWhen;
  });

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Returns false when the loop should stop (`stopWhen` matched). */
    const poll = async (): Promise<boolean> => {
      try {
        const value = await fetcherRef.current();
        if (cancelled) return false;
        setData(value);
        setError(null);
        setLoading(false);
        return !(stopRef.current?.(value) ?? false);
      } catch (err) {
        if (cancelled) return false;
        setError(asApiError(err));
        setLoading(false);
        return true;
      }
    };

    const schedule = (): void => {
      if (cancelled || isHidden()) return;
      timer = setTimeout(() => {
        void poll().then((keepGoing) => {
          if (keepGoing) schedule();
        });
      }, intervalMs);
    };

    void poll().then((keepGoing) => {
      if (keepGoing) schedule();
    });

    const onVisibility = (): void => {
      if (isHidden()) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void poll().then((keepGoing) => {
        if (keepGoing) schedule();
      });
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs, enabled, nonce]);

  return { data, error, loading, refresh };
}

export interface SincePollingState<E> {
  entries: E[];
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Incremental polling over a `since` cursor. `fetchPage(since)` returns
 * entries with `timeOf(entry) >= since`; entries are appended in arrival
 * order and deduped via `keyOf` (the boundary entry repeats by design).
 */
export function useSincePolling<E>(
  fetchPage: (since: number) => Promise<E[]>,
  timeOf: (entry: E) => number,
  keyOf: (entry: E) => string,
  intervalMs: number,
  enabled = true,
): SincePollingState<E> {
  const [entries, setEntries] = useState<E[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const sinceRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const fetchRef = useRef(fetchPage);
  const timeRef = useRef(timeOf);
  const keyRef = useRef(keyOf);
  useEffect(() => {
    fetchRef.current = fetchPage;
    timeRef.current = timeOf;
    keyRef.current = keyOf;
  });

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const page = await fetchRef.current(sinceRef.current);
        if (cancelled) return;
        setEntries((prev) => {
          const next = [...prev];
          for (const entry of page) {
            const key = keyRef.current(entry);
            if (seenRef.current.has(key)) continue;
            seenRef.current.add(key);
            next.push(entry);
          }
          return next;
        });
        for (const entry of page) {
          sinceRef.current = Math.max(sinceRef.current, timeRef.current(entry));
        }
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(asApiError(err));
        setLoading(false);
      }
    };

    const schedule = (): void => {
      if (cancelled || isHidden()) return;
      timer = setTimeout(() => {
        void poll().then(schedule);
      }, intervalMs);
    };

    void poll().then(schedule);

    const onVisibility = (): void => {
      if (isHidden()) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void poll().then(schedule);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs, enabled, nonce]);

  return { entries, error, loading, refresh };
}
