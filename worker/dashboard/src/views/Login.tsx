import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, GITHUB_LOGIN_URL } from '../api';
import { usePolling } from '../hooks';
import { ErrorNotice, Loading } from '../ui';

/** `/login` — GitHub OAuth button (the Worker owns the whole flow). */
export function LoginView(): ReactElement {
  const { data: auth, error } = usePolling(() => api.authStatus(), 30_000);
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return (
    <div
      className="panel"
      style={{ maxWidth: 460, margin: '64px auto', textAlign: 'center' }}
    >
      <img
        className="brand-logo"
        src="/logo.svg"
        alt="Yuma IT"
        width={180}
        height={65}
        style={{ height: 65, margin: '8px auto 16px', padding: '4px 8px' }}
      />
      <h1>Sign in</h1>
      <p className="muted">
        Sign in to create repositories, review changes and run CI on Yuma. GitHub verifies
        your identity; your repositories and builds are hosted here.
      </p>
      {from && (
        <div className="notice info small">
          You need to sign in to open <code>{from}</code>.
        </div>
      )}
      {error && <ErrorNotice error={error} />}
      {!auth && !error && <Loading label="Checking sign-in availability…" />}
      {auth?.github_configured === false && (
        <div className="notice warn" role="alert">
          <strong>Sign-in setup is incomplete</strong>
          <p>
            The site administrator needs to configure GitHub sign-in before private
            repositories can be opened in the browser. No GitHub repository connection is
            required.
          </p>
        </div>
      )}
      {auth?.github_configured && (
        <a className="btn primary" href={GITHUB_LOGIN_URL}>
          Sign in with GitHub
        </a>
      )}
      <div className="small faint" style={{ marginTop: 14 }}>
        <Link to="/">Back to repositories</Link>
      </div>
    </div>
  );
}
