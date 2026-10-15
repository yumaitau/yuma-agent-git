import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ApiError, authorName } from './api';
import type { Author } from './api';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function shortId(id: string | null | undefined, len = 8): string {
  return id ? id.slice(0, len) : '—';
}

export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function formatRelative(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function authorLabel(author: Author | undefined): string {
  return author ? authorName(author) : '—';
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Spinner(): ReactElement {
  return <span className="spinner" aria-label="loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }): ReactElement {
  return (
    <div className="row muted" style={{ padding: '18px 4px' }}>
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="empty">{children}</div>;
}

/**
 * Inline error surface — 403 responses render the `denied_by` path rule when
 * the server named one (the monorepo permission story, front and center).
 */
export function ErrorNotice({ error }: { error: ApiError }): ReactElement {
  const denied = error.deniedBy;
  return (
    <div className="notice error" role="alert">
      <div>
        <strong>
          {error.status > 0 ? `Error ${error.status}` : 'Error'} — {error.code}
        </strong>
      </div>
      <div className="wrap-any">{error.message}</div>
      {denied && (
        <div className="small muted" style={{ marginTop: 6 }}>
          Denied by path rule <code>#{denied.id}</code>:{' '}
          <code>
            {denied.effect} {denied.path_prefix}
          </code>{' '}
          for <code>{denied.principal}</code>
        </div>
      )}
    </div>
  );
}

export function Chip({
  kind = 'default',
  children,
}: {
  kind?: 'default' | 'ok' | 'warn' | 'danger' | 'info';
  children: ReactNode;
}): ReactElement {
  return <span className={`chip ${kind === 'default' ? '' : kind}`}>{children}</span>;
}

const STATUS_CHIPS: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  landed: 'ok',
  done: 'ok',
  queued: 'info',
  running: 'info',
  thinking: 'info',
  acting: 'info',
  waiting: 'warn',
  failed: 'danger',
  cancelled: 'warn',
};

export function StatusChip({ status }: { status: string }): ReactElement {
  return <Chip kind={STATUS_CHIPS[status] ?? 'default'}>{status}</Chip>;
}

export function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  }, [text]);
  return <button onClick={copy}>{copied ? 'Copied' : label}</button>;
}

/** One-shot secret box: shown until dismissed, never re-fetchable. */
export function SecretBox({ secret }: { secret: string }): ReactElement {
  return (
    <div className="notice warn" role="alert">
      <strong>
        Copy this now — it is shown exactly once and cannot be retrieved again.
      </strong>
      <div className="row" style={{ marginTop: 8 }}>
        <code className="grow wrap-any">{secret}</code>
        <CopyButton text={secret} />
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}
