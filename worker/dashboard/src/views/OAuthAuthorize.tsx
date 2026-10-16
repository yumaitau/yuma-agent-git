import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { ErrorNotice, Loading } from '../ui';

interface Consent {
  app: { client_id: string; name: string };
  scopes: string[];
  redirect_uri: string;
}

const SCOPE_TEXT: Record<string, string> = {
  'repo:read': 'Read the repositories you can read',
  'repo:write': 'Write to the repositories you can write to',
};

/**
 * OAuth consent (issue #75). A third-party tool sends the browser here with
 * an authorization request; approving returns to its registered redirect URI
 * with a code, denying returns `error=access_denied`.
 */
export function OAuthAuthorizeView(): ReactElement {
  const { search } = useLocation();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call<Consent>(`/oauth/authorize${search}`)
      .then((c) => !cancelled && setConsent(c))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [search]);

  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true);
    try {
      const { redirect_to } = await call<{ redirect_to: string }>(
        '/oauth/authorize',
        'POST',
        {
          ...params,
          approve,
        },
      );
      window.location.assign(redirect_to);
    } catch (err) {
      setError(asApiError(err));
      setBusy(false);
    }
  };

  if (error) return <ErrorNotice error={error} />;
  if (!consent) return <Loading />;
  return (
    <section className="panel stack">
      <h1>Authorise {consent.app.name}</h1>
      <p>
        <strong>{consent.app.name}</strong> wants to sign you in
        {consent.scopes.length > 0 ? ' and:' : '. It will see your login only.'}
      </p>
      {consent.scopes.length > 0 && (
        <ul>
          {consent.scopes.map((s) => (
            <li key={s}>{SCOPE_TEXT[s] ?? s}</li>
          ))}
        </ul>
      )}
      <p className="small muted">
        You will return to <code>{consent.redirect_uri}</code>. The access lasts 8 hours
        and appears in your API tokens, where you can revoke it.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide(true)}>
          Authorise
        </button>
        <button disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
      </div>
    </section>
  );
}
