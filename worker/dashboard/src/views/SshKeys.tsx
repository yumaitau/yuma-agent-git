import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  api,
  asApiError,
  type ApiError,
  type DeployKey,
  type Repo,
  type SshKey,
} from '../api';
import { useToast } from '../toast';
import { Chip, Empty, ErrorNotice, Field, Loading, formatRelative } from '../ui';

/**
 * Git over SSH (issue #34): `/ssh-keys` lists the keys you clone and push
 * with, and Settings holds each repo's deploy keys (`DeployKeysPanel`).
 * Adding a key needs a second factor from the last 12 hours once you have
 * one. Ed25519, ECDSA, `sk-ssh-ed25519` security keys and RSA of 3072 bits or
 * more are accepted.
 */

const KEY_PLACEHOLDER = 'ssh-ed25519 AAAA… you@laptop';

function useKeyList<T>(load: (() => Promise<T[]>) | null) {
  const toast = useToast();
  const [keys, setKeys] = useState<T[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(() => {
    if (!load) return;
    setKeys(null);
    load()
      .then(setKeys)
      .catch((err) => setError(asApiError(err)));
  }, [load]);
  useEffect(reload, [reload]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string): Promise<boolean> => {
      setError(null);
      try {
        await action();
        toast.show(done);
        reload();
        return true;
      } catch (err) {
        setError(asApiError(err));
        return false;
      }
    },
    [toast, reload],
  );
  return { keys, error, run };
}

function KeyForm({
  label,
  extra,
  onAdd,
}: {
  label: string;
  extra?: ReactElement;
  onAdd: (title: string, publicKey: string) => Promise<boolean>;
}): ReactElement {
  const [title, setTitle] = useState('');
  const [publicKey, setPublicKey] = useState('');
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
        <Field label="Title">
          <input
            type="text"
            placeholder="Work laptop"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        {extra}
      </div>
      <Field label="Public key">
        <textarea
          rows={3}
          placeholder={KEY_PLACEHOLDER}
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
        />
      </Field>
      <button
        className="primary"
        disabled={publicKey.trim() === ''}
        onClick={() =>
          void onAdd(title.trim() || 'SSH key', publicKey).then((added) => {
            if (!added) return;
            setTitle('');
            setPublicKey('');
          })
        }
      >
        {label}
      </button>
    </>
  );
}

export function SshKeysView(): ReactElement {
  const { keys, error, run } = useKeyList<SshKey>(api.listSshKeys);
  return (
    <div>
      <h1>SSH keys</h1>
      <div className="panel">
        <h2>Your SSH keys</h2>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Clone and push with <code>git clone git@&lt;host&gt;:owner/repo.git</code>. A
          key acts as you, with your access to each repository.
        </div>
        {error && <ErrorNotice error={error} />}
        {keys === null ? (
          !error && <Loading />
        ) : keys.length === 0 ? (
          <Empty>No SSH keys yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Fingerprint</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.title}</td>
                  <td className="mono small">{k.key_type}</td>
                  <td className="mono small wrap-any">{k.fingerprint}</td>
                  <td className="small muted">{formatRelative(k.last_used_at)}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() =>
                        void run(() => api.deleteSshKey(k.id), 'SSH key removed')
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <KeyForm
          label="Add SSH key"
          onAdd={(title, publicKey) =>
            run(() => api.addSshKey({ title, public_key: publicKey }), 'SSH key added')
          }
        />
      </div>
    </div>
  );
}

/** Repo deploy keys, for repo admins (in Settings). */
export function DeployKeysPanel({ repos }: { repos: Repo[] }): ReactElement {
  const [slug, setSlug] = useState('');
  const [writable, setWritable] = useState(false);
  const load = useCallback(() => api.listDeployKeys(slug), [slug]);
  const { keys, error, run } = useKeyList<DeployKey>(slug ? load : null);

  return (
    <div className="panel">
      <h2>Deploy keys</h2>
      <Field label="Repository">
        <select value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">select a repo…</option>
          {repos.map((r) => (
            <option key={r.id} value={r.slug}>
              {r.slug}
            </option>
          ))}
        </select>
      </Field>
      {slug && (
        <>
          {error && <ErrorNotice error={error} />}
          {keys === null ? (
            !error && <Loading />
          ) : keys.length === 0 ? (
            <Empty>No deploy keys for this repository.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Access</th>
                  <th>Fingerprint</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.title}</td>
                    <td>
                      <Chip kind={k.read_only ? 'info' : 'warn'}>
                        {k.read_only ? 'read-only' : 'read and write'}
                      </Chip>
                    </td>
                    <td className="mono small wrap-any">{k.fingerprint}</td>
                    <td className="small muted">{formatRelative(k.last_used_at)}</td>
                    <td>
                      <button
                        className="danger"
                        onClick={() =>
                          void run(
                            () => api.deleteDeployKey(slug, k.id),
                            'deploy key removed',
                          )
                        }
                      >
                        Remove {k.title}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <KeyForm
            label="Add deploy key"
            extra={
              <label className="small">
                <input
                  type="checkbox"
                  checked={writable}
                  onChange={(e) => setWritable(e.target.checked)}
                />{' '}
                Allow write access
              </label>
            }
            onAdd={(title, publicKey) =>
              run(
                () =>
                  api.addDeployKey(slug, {
                    title,
                    public_key: publicKey,
                    read_only: !writable,
                  }),
                'deploy key added',
              )
            }
          />
        </>
      )}
    </div>
  );
}
