import { cloneElement, isValidElement, useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from '../../lib/supabase';
import { readableTextColor as readableOn } from '@hop/core';

export interface SetupState {
  admin_joined: boolean;
  properties: number;
  rooms: boolean;
  branded: boolean;
  team: boolean;
  data: boolean;
}

export interface CompanyRow {
  id: string;
  slug: string;
  name: string;
  legal_name: string | null;
  status: 'active' | 'suspended';
  is_demo: boolean;
  created_at: string;
  default_currency: string;
  require_mfa: boolean;
  portal_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo_mark_url: string | null;
  members: number;
  pending_admin_invitations: number;
  expired_admin_invitations: number;
  active_support_sessions: number;
  setup: SetupState;
}

export interface Branding {
  portal_name: string;
  primary_color: string;
  accent_color: string;
  surface_color: string;
  logo_url: string | null;
  logo_mark_url: string | null;
  favicon_url: string | null;
  login_headline: string | null;
  login_message: string | null;
  support_email: string | null;
  email_from_name: string | null;
  report_footer: string | null;
}

export interface CompanyDetail {
  company: Pick<CompanyRow, 'id' | 'slug' | 'name' | 'legal_name' | 'status' | 'is_demo' | 'created_at' | 'default_currency' | 'require_mfa'>;
  branding: Branding | null;
  modules: Record<string, boolean>;
  domains: Array<{ id: string; hostname: string; is_primary: boolean; verification_status: 'pending' | 'verified' | 'failed'; verification_token: string; created_at: string }>;
  admin_invitations: Array<{ id: string; email: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }>;
  members_by_role: Record<string, number>;
  properties: Array<{ id: string; code: string; name: string; city: string | null; region: string | null; status: string; timezone: string; rooms: number | null }>;
  support_sessions: Array<{ id: string; starts_at: string; expires_at: string; ended_at: string | null; ticket_ref: string }>;
  activity: Array<{ action: string; created_at: string; actor_kind: string }>;
  setup: SetupState;
}

export function usePlatformCompanies() {
  return useQuery({
    queryKey: ['platform-companies'],
    queryFn: async () => unwrap(await supabase.rpc('platform_companies')) as CompanyRow[],
  });
}

export function usePlatformCompany(id: string | undefined) {
  return useQuery({
    queryKey: ['platform-company', id],
    enabled: !!id,
    queryFn: async () => unwrap(await supabase.rpc('platform_company_detail', { p_company_id: id })) as CompanyDetail,
  });
}

export const SETUP_STEPS: Array<{ key: keyof SetupState; label: string }> = [
  { key: 'admin_joined', label: 'Admin joined' },
  { key: 'properties', label: 'Hotels added' },
  { key: 'rooms', label: 'Room counts set' },
  { key: 'branded', label: 'Branded' },
  { key: 'team', label: 'Team invited' },
  { key: 'data', label: 'First data imported' },
];

export function setupDone(s: SetupState): number {
  return SETUP_STEPS.filter((x) => !!s[x.key]).length;
}

export type Stage = 'suspended' | 'invited' | 'setting_up' | 'live';

/** Where a company is in its life with us, from the platform's point of view. */
export function stageOf(c: Pick<CompanyRow, 'status' | 'setup'>): Stage {
  if (c.status === 'suspended') return 'suspended';
  if (!c.setup.admin_joined) return 'invited';
  return setupDone(c.setup) === SETUP_STEPS.length ? 'live' : 'setting_up';
}

export const STAGE_LABEL: Record<Stage, string> = {
  invited: 'Waiting for admin',
  setting_up: 'Setting up',
  live: 'Live',
  suspended: 'Suspended',
};

/** A company's short ID as a hotel key tag in its own colours. */
export function KeyTag({ slug, color, size = 'md' }: { slug: string; color?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const bg = color ?? '#1f3a5f';
  const style = { '--tag-bg': bg, '--tag-ink': readableOn(bg) } as CSSProperties;
  return (
    <span className={`key-tag key-tag-${size}`} style={style} aria-label={`Short ID ${slug}`}>
      <span className="key-tag-hole" aria-hidden />
      {slug}
    </span>
  );
}

export function SetupMeter({ setup, showLabel = true }: { setup: SetupState; showLabel?: boolean }) {
  const done = setupDone(setup);
  return (
    <span className="setup-meter" title={SETUP_STEPS.map((s) => `${setup[s.key] ? '✓' : '○'} ${s.label}`).join('\n')}>
      <span className="setup-meter-track" aria-hidden>
        {SETUP_STEPS.map((s) => (
          <span key={s.key} className={setup[s.key] ? 'on' : ''} />
        ))}
      </span>
      {showLabel && <span className="small">{done}/{SETUP_STEPS.length}</span>}
      <span className="sr-only">{done} of {SETUP_STEPS.length} setup steps done</span>
    </span>
  );
}

/** Miniature of the company's sign-in page, so branding choices can be judged before saving. */
export function SignInPreview({ b, companyName }: { b: Partial<Branding>; companyName: string }) {
  const primary = b.primary_color || '#1f3a5f';
  const accent = b.accent_color || '#c8a24a';
  const surface = b.surface_color || '#f6f7f9';
  const portal = b.portal_name || companyName || 'Owner portal';
  return (
    <figure className="signin-preview" aria-label="Preview of the company sign-in page">
      <div className="signin-preview-hero" style={{ background: primary, color: readableOn(primary) }}>
        <div className="signin-preview-logo">
          {b.logo_url ? <img src={b.logo_url} alt="" /> : <strong>{portal}</strong>}
        </div>
        <div>
          <div className="signin-preview-headline">{b.login_headline || 'Hotel ownership reporting'}</div>
          <div className="signin-preview-message">{b.login_message || 'Sign in to view the properties, financial information and documents you are authorized to access.'}</div>
        </div>
      </div>
      <div className="signin-preview-panel" style={{ background: surface }}>
        <div className="signin-preview-form">
          <div className="signin-preview-title">Sign in</div>
          <div className="signin-preview-sub">{portal}</div>
          <span className="signin-preview-input" />
          <span className="signin-preview-input" />
          <span className="signin-preview-button" style={{ background: primary, color: readableOn(primary) }}>Sign in</span>
          <span className="signin-preview-link" style={{ color: accent }}>Forgot password?</span>
        </div>
      </div>
      <figcaption className="small muted">{b.support_email ? `Help: ${b.support_email}` : 'No support email set'}</figcaption>
    </figure>
  );
}

/** Labelled form control. The label points at the control (not wrapping it), so a select's
 * accessible name is the label alone, and the hint or error is announced with it. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>, {
        id,
        'aria-describedby': note ? noteId : undefined,
        'aria-invalid': error ? true : undefined,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {error ? <span id={noteId} className="field-error">{error}</span> : hint ? <span id={noteId} className="small muted">{hint}</span> : null}
    </div>
  );
}

export const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40);
export const slugValid = (v: string) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(v) && !v.endsWith('-');
export const emailValid = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
export const hexValid = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
export const inviteLink = (token: string) => `${window.location.origin}/accept-invite#token=${token}`;

export const MODULES: Array<{ key: string; label: string; detail: string }> = [
  { key: 'performance', label: 'Performance', detail: 'Daily KPIs, dashboards and trends' },
  { key: 'financials', label: 'Budgets & financials', detail: 'Monthly P&L, budgets and variance' },
  { key: 'capex', label: 'CapEx', detail: 'Projects, approvals and spend' },
  { key: 'documents', label: 'Documents', detail: 'Secure document library' },
  { key: 'reports', label: 'Owner reports', detail: 'Monthly owner packages and commentary' },
  { key: 'ingestion', label: 'Data imports', detail: 'File and email report imports' },
];
