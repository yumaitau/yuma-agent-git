import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, asApiError, GITHUB_LOGIN_URL, type ApiError } from '../api';
import { usePolling } from '../hooks';
import { getPasskey, passkeysSupported } from '../passkeys';
import { ErrorNotice, Loading } from '../ui';

/** `/login` — every configured sign-in method (the Worker owns each flow). */
export function LoginView(): ReactElement {
  const { data: auth, error } = usePolling(() => api.authStatus(), 30_000);
  const [passkeyError, setPasskeyError] = useState<ApiError | null>(null);
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const providers = auth?.providers ?? [];
  const nothingConfigured = auth && !auth.github_configured && providers.length === 0;

  const passkeySignIn = async (): Promise<void> => {
    setPasskeyError(null);
    try {
      const credential = await getPasskey(await api.passkeySignInOptions());
      await api.signInWithPasskey(credential);
      window.location.assign(from ?? '/');
    } catch (err) {
      setPasskeyError(asApiError(err));
    }
  };

  return (
    <div
      className="panel"
      style={{ maxWidth: 460, margin: '64px auto', textAlign: 'center' }}
    >
      <h1>Sign in</h1>
      <p className="muted">
        Sign in to create repositories, review changes and run CI on Yuma. Your
        organisation's identity provider or a passkey verifies who you are; your
        repositories and builds are hosted here.
      </p>
      {from && (
        <div className="notice info small">
          You need to sign in to open <code>{from}</code>.
        </div>
      )}
      {error && <ErrorNotice error={error} />}
      {passkeyError && <ErrorNotice error={passkeyError} />}
      {!auth && !error && <Loading label="Checking sign-in availability…" />}
      {nothingConfigured && (
        <div className="notice warn" role="alert">
          <strong>Sign-in setup is incomplete</strong>
          <p>
            The site administrator needs to configure an identity provider before private
            repositories can be opened in the browser. No GitHub repository connection is
            required.
          </p>
        </div>
      )}
      {auth && !nothingConfigured && (
        <div style={{ display: 'grid', gap: 8 }}>
          {providers.map((p) => (
            <a key={p.id} className="btn primary" href={`/auth/oidc/${p.id}`}>
              Sign in with {p.name}
            </a>
          ))}
          {passkeysSupported() && (
            <button onClick={() => void passkeySignIn()}>Sign in with a passkey</button>
          )}
          {auth.github_configured && (
            <a
              className={providers.length > 0 ? 'btn' : 'btn primary'}
              href={GITHUB_LOGIN_URL}
            >
              Sign in with GitHub
            </a>
          )}
        </div>
      )}
      <div className="small faint" style={{ marginTop: 14 }}>
        <Link to="/">Back to repositories</Link>
      </div>
    </div>
  );
}
