import type { ReactNode } from 'react';
import { DbError } from '../lib/supabase';
import { ApiError } from '../lib/api';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${flush ? 'card-flush' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof DbError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <strong>We couldn’t load this.</strong>
      <span>{errorMessage(error)}</span>
      {retry && (
        <button className="btn btn-sm" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  published: 'good', approved: 'good', completed: 'good', clean: 'good', current: 'good', active: 'good', sent: 'good',
  draft: 'neutral', superseded: 'neutral', cancelled: 'neutral', duplicate: 'neutral', archived: 'neutral', pending: 'warn',
  in_review: 'info', queued: 'info', processing: 'info', in_progress: 'info', received: 'info', on_hold: 'warn',
  pending_approval: 'warn', needs_review: 'warn', late: 'warn', awaiting_upload: 'warn', skipped: 'warn',
  rejected: 'bad', failed: 'bad', infected: 'bad', error: 'bad', stale: 'bad', no_data: 'bad', revoked: 'bad',
};
const STATUS_ICONS: Record<Tone, string> = { good: '✓', warn: '!', bad: '✕', info: '•', neutral: '' };

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone}>
      {STATUS_ICONS[tone] && <span aria-hidden>{STATUS_ICONS[tone]}</span>}
      {label ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>{children}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="spread">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!d) return '—';
  const date = d.length === 10 ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: d.length === 10 ? 'UTC' : undefined }).format(date);
}

export function fmtMonth(d: string | null | undefined): string {
  return fmtDate(d, { month: 'long', year: 'numeric' });
}
