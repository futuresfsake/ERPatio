import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

const ToastCtx = createContext<(message: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2400);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-title">
      <h3 id="dlg-title">{title}</h3>
      {open && children}
    </dialog>
  );
}

export const errorText = (e: unknown): string =>
  e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.';

export function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      {errorText(error)}
      {error instanceof ApiError && error.requestId && <span className="muted"> (ref {error.requestId.slice(0, 8)})</span>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="loading" role="status">
      Loading {what}
    </p>
  );
}

export const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00`).toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' });

export const todayIso = () => new Date().toISOString().slice(0, 10);
