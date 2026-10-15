import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';
import { Loading } from './ui';

/**
 * Auth guard for private routes: probes the session cookie and redirects
 * anonymous visitors to /login (remembering where they were headed).
 */
export function RequireAuth({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const [state, setState] = useState<'checking' | 'ok' | 'anon'>('checking');

  useEffect(() => {
    let cancelled = false;
    api
      .checkSession()
      .then((ok) => {
        if (!cancelled) setState(ok ? 'ok' : 'anon');
      })
      .catch(() => {
        if (!cancelled) setState('anon');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') return <Loading label="Checking session…" />;
  if (state === 'anon') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <>{children}</>;
}
