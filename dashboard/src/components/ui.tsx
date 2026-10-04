/** Small shared UI pieces: status pill, dialog, toast, copyable snippet, empty state. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EscalationState, IntegrationKind, TicketStatus } from '@snitch/contract';
import { STATUS_LABEL, initials } from '../lib/format';
import { Copy, Github, Mail, Webhook } from './icons';

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function EscalationPill({ state }: { state: EscalationState }) {
  return <span className={`pill ${state}`}>{state === 'sent' ? 'Sent' : state === 'failed' ? 'Failed' : 'Queued'}</span>;
}

export function IntegrationIcon({ kind, className }: { kind: IntegrationKind; className?: string }) {
  const C = kind === 'github' ? Github : kind === 'email' ? Mail : Webhook;
  return <C className={className ?? 'icon-inline'} />;
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" title={name}>
      {initials(name)}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-header">
          <h2>{title}</h2>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

const ToastContext = createContext<(msg: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => toast('Copied'));
      }}
    >
      <Copy /> {label}
    </button>
  );
}

export function Snippet({ code }: { code: string }) {
  return (
    <div className="snippet">
      <pre>{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

export function Spinner() {
  return <div className="empty">Loading…</div>;
}
