import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  api,
  asApiError,
  type ApiError,
  type Security,
  type SigningKey,
  type TotpSetup,
} from '../api';
import { createPasskey, getPasskey, passkeysSupported } from '../passkeys';
import { useToast } from '../toast';
import {
  Chip,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  SecretBox,
  formatRelative,
} from '../ui';

/**
 * `/security` (issue #27): how this session signed in, second factors
 * (passkeys and an authenticator app), linked sign-in identities and the
 * SSH or OpenPGP keys pushed commits are verified against (#58).
 * Sensitive actions such as creating API tokens need a second factor within
 * the last 12 hours once one is enrolled.
 */

function providerLabel(provider: string, names: Security['providers']): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'scim') return 'Directory (SCIM)';
  if (provider === 'passkey') return 'Passkey';
  const id = provider.replace(/^oidc:/, '');
  return names.find((p) => p.id === id)?.name ?? id;
}

function SessionPanel({
  security,
  onChange,
}: {
  security: Security;
  onChange: () => void;
}): ReactElement {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const enrolled = security.passkeys.length > 0 || security.totp.enrolled;

  const verifyPasskey = useCallback(async () => {
    setError(null);
    try {
      await api.verifyMfaPasskey(await getPasskey(await api.mfaPasskeyOptions()));
      toast.show('second factor verified');
      onChange();
    } catch (err) {
      setError(asApiError(err));
    }
  }, [toast, onChange]);

  const verifyCode = useCallback(async () => {
    setError(null);
    try {
      await api.verifyMfaTotp(code.trim());
      setCode('');
      toast.show('second factor verified');
      onChange();
    } catch (err) {
      setError(asApiError(err));
    }
  }, [code, toast, onChange]);

  return (
    <div className="panel">
      <h2>This session</h2>
      {error && <ErrorNotice error={error} />}
      <p>
        Signed in with{' '}
        <strong>{providerLabel(security.session.auth_method, security.providers)}</strong>
        .{' '}
        {security.session.mfa_fresh ? (
          <Chip kind="ok">second factor verified</Chip>
        ) : enrolled ? (
          <Chip kind="warn">second factor needed for sensitive actions</Chip>
        ) : (
          <Chip>no second factor enrolled</Chip>
        )}
      </p>
      {enrolled && !security.session.mfa_fresh && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {security.passkeys.length > 0 && passkeysSupported() && (
            <button className="primary" onClick={() => void verifyPasskey()}>
              Verify with a passkey
            </button>
          )}
          {security.totp.enrolled && (
            <>
              <Field label="Authenticator code">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <button disabled={code.trim() === ''} onClick={() => void verifyCode()}>
                Verify code
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PasskeysPanel({
  security,
  onChange,
}: {
  security: Security;
  onChange: () => void;
}): ReactElement {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const add = useCallback(async () => {
    setError(null);
    try {
      const credential = await createPasskey(await api.passkeyRegistrationOptions());
      await api.registerPasskey(label.trim() || 'Passkey', credential);
      setLabel('');
      toast.show('passkey added');
      onChange();
    } catch (err) {
      setError(asApiError(err));
    }
  }, [label, toast, onChange]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await api.deletePasskey(id);
        toast.show('passkey removed');
        onChange();
      } catch (err) {
        setError(asApiError(err));
      }
    },
    [toast, onChange],
  );

  return (
    <div className="panel">
      <h2>Passkeys</h2>
      {error && <ErrorNotice error={error} />}
      {security.passkeys.length === 0 ? (
        <Empty>No passkeys yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Added</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {security.passkeys.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td className="small muted">{formatRelative(k.created_at)}</td>
                <td className="small muted">
                  {k.last_used_at ? formatRelative(k.last_used_at) : 'never'}
                </td>
                <td>
                  <button className="danger" onClick={() => void remove(k.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {passkeysSupported() ? (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <Field label="Label">
            <input
              type="text"
              placeholder="Work laptop"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <button className="primary" onClick={() => void add()}>
            Add a passkey
          </button>
        </div>
      ) : (
        <div className="small muted">This browser does not support passkeys.</div>
      )}
    </div>
  );
}

/** Keys whose signatures mark your pushed commits verified (#58). */
function SigningKeysPanel(): ReactElement {
  const toast = useToast();
  const [keys, setKeys] = useState<SigningKey[] | null>(null);
  const [kind, setKind] = useState<SigningKey['kind']>('ssh');
  const [title, setTitle] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api
      .listSigningKeys()
      .then(setKeys)
      .catch((err) => setError(asApiError(err)));
  }, []);
  useEffect(load, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setError(null);
      try {
        await action();
        toast.show(done);
        load();
      } catch (err) {
        setError(asApiError(err));
      }
    },
    [toast, load],
  );

  return (
    <div className="panel">
      <h2>Commit signing keys</h2>
      {error && <ErrorNotice error={error} />}
      {keys === null ? (
        !error && <Loading />
      ) : keys.length === 0 ? (
        <Empty>No signing keys yet. Pushed commits you sign show as unverified.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>Fingerprint</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.title}</td>
                <td>{k.kind === 'ssh' ? 'SSH' : 'OpenPGP'}</td>
                <td className="mono small wrap-any">{k.fingerprint}</td>
                <td>
                  <button
                    className="danger"
                    onClick={() =>
                      void run(() => api.deleteSigningKey(k.id), 'signing key removed')
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
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SigningKey['kind'])}
          >
            <option value="ssh">SSH</option>
            <option value="gpg">OpenPGP</option>
          </select>
        </Field>
        <Field label="Title">
          <input
            type="text"
            placeholder="Work laptop"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Public key">
        <textarea
          rows={3}
          placeholder="ssh-ed25519 AAAA… or -----BEGIN PGP PUBLIC KEY BLOCK-----"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
        />
      </Field>
      <button
        className="primary"
        disabled={publicKey.trim() === ''}
        onClick={() =>
          void run(async () => {
            await api.addSigningKey({
              kind,
              title: title.trim() || 'Signing key',
              public_key: publicKey,
            });
            setTitle('');
            setPublicKey('');
          }, 'signing key added')
        }
      >
        Add signing key
      </button>
    </div>
  );
}

function TotpPanel({
  security,
  onChange,
}: {
  security: Security;
  onChange: () => void;
}): ReactElement {
  const toast = useToast();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(asApiError(err));
    }
  }, []);

  return (
    <div className="panel">
      <h2>Authenticator app</h2>
      {error && <ErrorNotice error={error} />}
      {security.totp.enrolled ? (
        <div className="row">
          <Chip kind="ok">enrolled</Chip>
          <button
            className="danger"
            onClick={() =>
              void run(async () => {
                await api.deleteTotp();
                toast.show('authenticator app removed');
                onChange();
              })
            }
          >
            Remove
          </button>
        </div>
      ) : setup ? (
        <>
          <p className="small muted">
            Add this key to your authenticator app (or open the link on your phone), then
            enter the 6-digit code it shows.
          </p>
          <SecretBox secret={setup.secret} />
          <div className="small wrap-any">
            <a href={setup.otpauth_uri}>Open in authenticator app</a>
          </div>
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
            <Field label="Code from the app">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <button
              className="primary"
              disabled={code.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await api.confirmTotp(code.trim());
                  setSetup(null);
                  setCode('');
                  toast.show('authenticator app enrolled');
                  onChange();
                })
              }
            >
              Confirm
            </button>
          </div>
        </>
      ) : (
        <button onClick={() => void run(async () => setSetup(await api.startTotp()))}>
          Set up an authenticator app
        </button>
      )}
    </div>
  );
}

function IdentitiesPanel({ security }: { security: Security }): ReactElement {
  const linked = new Set(security.identities.map((i) => i.provider));
  const linkable = security.providers.filter((p) => !linked.has(`oidc:${p.id}`));
  return (
    <div className="panel">
      <h2>Sign-in identities</h2>
      {security.identities.length === 0 ? (
        <Empty>No linked identities.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Email</th>
              <th>Linked</th>
            </tr>
          </thead>
          <tbody>
            {security.identities.map((i) => (
              <tr key={`${i.provider}-${i.linked_at}`}>
                <td>{providerLabel(i.provider, security.providers)}</td>
                <td className="small">{i.email ?? ''}</td>
                <td className="small muted">{formatRelative(i.linked_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {linkable.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          {linkable.map((p) => (
            <a key={p.id} className="btn" href={`/auth/oidc/${p.id}?link=1`}>
              Link {p.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function SecurityView(): ReactElement {
  const [security, setSecurity] = useState<Security | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api
      .getSecurity()
      .then(setSecurity)
      .catch((err) => setError(asApiError(err)));
  }, []);
  useEffect(load, [load]);

  return (
    <div>
      <h1>Security</h1>
      {error && <ErrorNotice error={error} />}
      {security === null ? (
        !error && <Loading />
      ) : (
        <>
          <SessionPanel security={security} onChange={load} />
          <PasskeysPanel security={security} onChange={load} />
          <TotpPanel security={security} onChange={load} />
          <IdentitiesPanel security={security} />
          <SigningKeysPanel />
        </>
      )}
    </div>
  );
}
