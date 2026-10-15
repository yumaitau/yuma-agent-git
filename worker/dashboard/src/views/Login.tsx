import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { GITHUB_LOGIN_URL } from '../api';

/** `/login` — GitHub OAuth button (the Worker owns the whole flow). */
export function LoginView(): ReactElement {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return (
    <div
      className="panel"
      style={{ maxWidth: 460, margin: '64px auto', textAlign: 'center' }}
    >
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
      <a className="btn primary" href={GITHUB_LOGIN_URL}>
        Sign in with GitHub
      </a>
      <div className="small faint" style={{ marginTop: 14 }}>
        <Link to="/">Back to repositories</Link>
      </div>
    </div>
  );
}
