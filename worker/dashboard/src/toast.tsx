import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ApiError, asApiError } from './api';

export type ToastKind = 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
  showError: (err: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => dismiss(id), 8000);
    },
    [dismiss],
  );

  const showError = useCallback(
    (err: unknown) => {
      const apiErr: ApiError = asApiError(err);
      if (apiErr.code === 'ref_stale') {
        // Compare-and-swap race: show what was expected vs what the ref holds.
        show(
          `ref moved underneath this update — expected ${apiErr.expected ?? '(empty)'}, ` +
            `actual ${apiErr.actual ?? '(empty)'}; reload and retry`,
          'warn',
        );
        return;
      }
      show(`${apiErr.code}: ${apiErr.message}`, 'error');
    },
    [show],
  );

  const value = useMemo(() => ({ show, showError }), [show, showError]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.kind}`}
            onClick={() => dismiss(toast.id)}
            role="status"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  // Outside a provider (tests rendering a bare view): degrade to console.
  return {
    show: (message) => console.warn(message),
    showError: (err) => console.warn(asApiError(err).message),
  };
}
