import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { ErrorNotice, Loading } from '../ui';
import { EntryList, type Entry } from './CiAccess';

/**
 * Organisation CI secrets and variables (issue #50), shared by every repository
 * in the org. Secret values are write-only: this page sets or deletes them and
 * never reads one back. Repository secrets live under each repo's CI page.
 */
export function SecretsView(): ReactElement {
  const { org = '' } = useParams();
  const base = `/orgs/${encodeURIComponent(org)}`;
  const [secrets, setSecrets] = useState<Entry[] | null>(null);
  const [variables, setVariables] = useState<Entry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      call<{ secrets: Entry[] }>(`${base}/secrets`),
      call<{ variables: Entry[] }>(`${base}/variables`),
    ])
      .then(([s, v]) => {
        if (cancelled) return;
        setSecrets(s.secrets);
        setVariables(v.variables);
      })
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [base, nonce]);

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      await fn();
      setNotice(done);
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };

  return (
    <>
      <Link className="small muted" to={`/orgs/${org}`}>
        {org}
      </Link>
      <h1>Organisation secrets and variables</h1>
      <p className="small muted">
        Secret values are encrypted and can never be read back. Pipelines in every
        repository of this organisation can name them; logs mask their values.
      </p>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      {!secrets && !error && <Loading />}
      {secrets && variables && (
        <section className="panel">
          {(['secrets', 'variables'] as const).map((kind) => (
            <EntryList
              key={kind}
              kind={kind}
              entries={kind === 'secrets' ? secrets : variables}
              onSave={(name, value) =>
                act(
                  () =>
                    call(`${base}/${kind}/${encodeURIComponent(name)}`, 'PUT', { value }),
                  `${name} saved.`,
                )
              }
              onDelete={(name) =>
                act(
                  () => call(`${base}/${kind}/${encodeURIComponent(name)}`, 'DELETE'),
                  `${name} deleted.`,
                )
              }
            />
          ))}
        </section>
      )}
    </>
  );
}
