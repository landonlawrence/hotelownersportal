import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
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

/** Friendly messages for database constraints users can run into. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  companies_slug_key: 'That short ID is taken — choose another.',
  companies_slug_check: 'The short ID must be 2–63 lowercase letters, numbers or dashes, starting with a letter or number.',
  companies_name_check: 'The company name must be 2–200 characters.',
  properties_company_id_code_key: 'A property with this code already exists.',
  properties_code_check: 'Property codes are 2–32 capital letters, numbers, dashes or underscores (e.g. HV-BOS).',
  properties_name_check: 'The property name must be 2–200 characters.',
  ingestion_sources_company_id_name_key: 'A source with this name already exists.',
  source_account_mappings_unique: 'That source account code is already mapped.',
  source_account_mappings_code_present: 'Enter a source account code.',
  ingestion_property_mappings_code_ci: 'That code is already mapped for this source.',
  ingestion_property_mappings_source_id_external_code_key: 'That code is already mapped for this source.',
  reporting_packages_one_open: 'An open revision already exists for this period.',
  financial_reports_one_open: 'An open revision already exists for this period.',
  financial_report_lines_financial_report_id_source_account_code_key: 'That source code is already used on this statement.',
  capex_projects_company_id_project_number_key: 'Another project was created at the same moment — please try again.',
  capex_projects_title_check: 'The title must be 3–200 characters.',
  capex_projects_check: 'Target completion must be on or after the target start.',
  capex_projects_requested_budget_check: 'The requested budget must be more than zero.',
  capex_transactions_amount_check: 'The amount cannot be zero.',
  capex_transactions_positive_quotes_commitments: 'Quotes and commitments must be positive amounts.',
  company_branding_logo_url_check: 'The logo URL must start with https:// or /.',
  company_branding_logo_mark_url_check: 'The logo mark URL must start with https:// or /.',
  company_branding_favicon_url_check: 'The favicon URL must start with https:// or /.',
  company_branding_support_email_check: 'Enter a valid support email address.',
  company_branding_portal_name_check: 'The portal name must be 2–120 characters.',
  company_domains_hostname_key: 'That domain is already in use.',
  documents_title_check: 'The title must be 2–200 characters.',
  room_inventory_history_room_count_check: 'Rooms must be a whole number between 1 and 99,999.',
  budget_versions_fiscal_year_check: 'The fiscal year must be between 2000 and 2100.',
  management_commentary_body_check: 'Write the comment first.',
  invitations_email_check: 'Enter a valid email address.',
  support_access_sessions_reason_check: 'Give a reason of at least 10 characters.',
  support_access_sessions_ticket_ref_check: 'Enter a ticket reference.',
};

const GENERIC_BY_CODE: Record<string, string> = {
  '23505': 'That already exists.',
  '23514': 'Some values are out of range or in the wrong format.',
  '23502': 'A required field is missing.',
  '23503': 'Something this refers to no longer exists. Refresh and try again.',
  '22P02': 'One of the values isn’t in the right format — check numbers and dates.',
  '22007': 'One of the dates isn’t valid.',
  '22008': 'One of the dates isn’t valid.',
  '22003': 'A number is too large.',
  '22001': 'One of the values is too long.',
};

/** Turn API, database and validation errors into something a person can act on. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Your session has expired. Sign in again.';
    return friendlyText(e.message);
  }
  if (e instanceof DbError) {
    const constraint = /constraint "([^"]+)"/.exec(e.message)?.[1];
    const known = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;
    if (known) return known;
    if (e.code === 'PGRST301' || /JWT expired/i.test(e.message)) return 'Your session has expired. Sign in again.';
    if (/row-level security|permission denied for (table|column)/i.test(e.message)) return 'You don’t have permission to make this change.';
    const generic = e.code ? GENERIC_BY_CODE[e.code] : undefined;
    if (generic && /violates|invalid input|out of range|too long|null value/i.test(e.message)) return generic;
    return friendlyText(e.message);
  }
  if (e instanceof Error) return friendlyText(e.message);
  return 'Something went wrong';
}

function friendlyText(msg: string): string {
  // zod-style "field: problem" messages from the API.
  if (/(^|; )email: Invalid email/i.test(msg)) return 'Enter a valid email address.';
  if (/^permission denied: /i.test(msg)) return 'You don’t have permission to do that.';
  if (!msg) return 'Something went wrong';
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

/** Wrap a supabase-js `{ error }` as a DbError so errorMessage() can map it. */
export function dbErrorMessage(error: { message: string; code?: string } | null | undefined): string | null {
  return error ? errorMessage(new DbError(error.message, error.code)) : null;
}

/** Strict amount parsing lives in @hop/core so it is unit-tested; re-exported for pages. */
export { parseAmount } from '@hop/core';

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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: focuses the first field, traps Tab, closes on Escape,
 * restores focus on close, and asks before discarding typed input when the
 * backdrop is clicked or Escape is pressed.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirty = useRef(false);
  const requestClose = useRef(() => {
    if (dirty.current && !window.confirm('Discard what you entered?')) return;
    closeRef.current();
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const first = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find((x) => !x.classList.contains('modal-close'));
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose.current()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trap}
        onInput={() => {
          dirty.current = true;
        }}
      >
        <div className="spread">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Tab list with roving tabindex and arrow/Home/End keys (WAI-ARIA tabs pattern). */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void; label: string; idPrefix: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: ReactKeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-controls={`${idPrefix}-panel`}
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, value, children }: { idPrefix: string; value: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-tab-${value}`} className="stack">
      {children}
    </div>
  );
}

/** Ask before a destructive action. */
export function confirmAction(message: string): boolean {
  return window.confirm(message);
}

export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!d) return '—';
  const date = d.length === 10 ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: d.length === 10 ? 'UTC' : undefined }).format(date);
}

export function fmtMonth(d: string | null | undefined): string {
  return fmtDate(d, { month: 'long', year: 'numeric' });
}

/** Today's date on this device (YYYY-MM-DD), not the UTC date. Use for date inputs that default to today. */
export { deviceToday as localToday } from '@hop/core';

/** First day of the current (local) month as YYYY-MM. */
export function currentMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The last closed month (previous month, or `monthsBack` months ago) as YYYY-MM, from the local calendar. */
export function lastClosedMonthValue(monthsBack = 1): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** An exclusive end date (e.g. room inventory effective_to) shown as the inclusive last day. */
export function fmtExclusiveEnd(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(`${d.slice(0, 10)}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return fmtDate(dt.toISOString().slice(0, 10));
}
