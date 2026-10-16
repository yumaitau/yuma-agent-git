import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import type { Org, Repo } from './api';
import { Field } from './ui';

/**
 * App shell: nav + global keyboard shortcuts (progressive enhancement, no
 * dependencies):
 *   `/`  focus the repo filter (navigates home when it is not on screen)
 *   `g` then `t`  open the tree picker (jump to any repo/revision/path)
 */

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function TreePicker({ onClose }: { onClose: () => void }): ReactElement {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [slug, setSlug] = useState('');
  const [rev, setRev] = useState('main');
  const [path, setPath] = useState('');
  const slugRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
    slugRef.current?.focus();
  }, []);

  const go = useCallback(() => {
    const clean = slug.trim().replace(/^\/+|\/+$/g, '');
    if (clean === '') return;
    const tail = `/tree/${encodeURIComponent(rev.trim() || 'main')}${path.trim() === '' ? '' : `/${path.trim().replace(/^\/+/, '')}`}`;
    navigate(`/r/${clean}${tail}`);
    onClose();
  }, [slug, rev, path, navigate, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Jump to tree</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Field label="Repository (owner/name)">
            <input
              ref={slugRef}
              type="text"
              list="tree-picker-repos"
              placeholder="acme/tools"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <datalist id="tree-picker-repos">
              {repos.map((r) => (
                <option key={r.id} value={r.slug} />
              ))}
            </datalist>
          </Field>
          <Field label="Revision (changeset id or ref name)">
            <input type="text" value={rev} onChange={(e) => setRev(e.target.value)} />
          </Field>
          <Field label="Path (optional)">
            <input
              type="text"
              placeholder="src/"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
          <div className="row">
            <button type="submit" className="primary">
              Go
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Org switcher (issue #26): jumps between personal repos and org settings. */
function OrgSwitcher(): ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const current = /^\/orgs\/([^/]+)/.exec(pathname)?.[1] ?? '';

  // refetch when the org in the URL changes so a newly created org shows up
  useEffect(() => {
    api
      .listOrgs()
      .then(setOrgs)
      .catch(() => setOrgs([]));
  }, [current]);

  return (
    <select
      aria-label="Organisation"
      value={current}
      onChange={(e) => navigate(e.target.value === '' ? '/' : `/orgs/${e.target.value}`)}
    >
      <option value="">Personal</option>
      {orgs.map((o) => (
        <option key={o.id} value={o.slug}>
          {o.slug}
        </option>
      ))}
    </select>
  );
}

export function Layout({ children }: { children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const gPressedRef = useRef(false);

  useEffect(() => {
    api
      .checkSession()
      .then(setAuthed)
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    let gTimer: ReturnType<typeof setTimeout> | null = null;
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        INPUT_TAGS.has(target.tagName) &&
        !(e.key === 'Escape')
      ) {
        return;
      }
      if (e.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        const filter = document.getElementById('repo-filter');
        if (filter instanceof HTMLElement) {
          filter.focus();
        } else {
          navigate('/?focus=1');
        }
        return;
      }
      if (e.key === 'g') {
        gPressedRef.current = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          gPressedRef.current = false;
        }, 1200);
        return;
      }
      if (e.key === 't' && gPressedRef.current) {
        gPressedRef.current = false;
        if (gTimer) clearTimeout(gTimer);
        e.preventDefault();
        setPickerOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setAuthed(false);
    navigate('/login');
  }, [navigate]);

  return (
    <div className="shell">
      <header className="topnav">
        <Link to="/" className="brand" aria-label="Yuma Git home">
          <img
            className="brand-logo"
            src="/logo.svg"
            alt="Yuma IT"
            width={84}
            height={30}
          />
          Git
        </Link>
        <nav>
          <Link to="/">Repos</Link>
          <Link to="/search">Search</Link>
          <Link to="/orgs">Organisations</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/security">Security</Link>
        </nav>
        {authed && <OrgSwitcher />}
        <span className="spacer" />
        <span className="hint">
          <kbd>/</kbd> filter · <kbd>g</kbd> <kbd>t</kbd> tree picker
        </span>
        {authed ? (
          <button onClick={() => void signOut()}>Sign out</button>
        ) : (
          <Link className="btn" to="/login">
            Sign in
          </Link>
        )}
      </header>
      <main className="main">{children}</main>
      {pickerOpen && <TreePicker onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
