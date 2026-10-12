import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, type Permission, type Role } from '@hop/core';
import { supabase } from '../lib/supabase';
import { usePortal, useCompany } from '../state/portal';
import { Icon, type IconName } from './icons';
import { Loading } from './ui';
import { useSectionState } from './RequirePermission';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Any of these grants the item. None = always shown. */
  perms?: Permission[];
  module?: string;
}

const GROUPS: Array<{ label?: string; items: NavItem[] }> = [
  {
    items: [
      { to: '/', label: 'Home', icon: 'home' },
      { to: '/properties', label: 'Properties', icon: 'building' },
      { to: '/performance', label: 'Performance', icon: 'trend', perms: ['performance.view'], module: 'performance' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/financials', label: 'Budgets & Financials', icon: 'money', perms: ['financials.view', 'budgets.view', 'financials.view_draft'], module: 'financials' },
      { to: '/capex', label: 'CapEx', icon: 'tool', perms: ['capex.view'], module: 'capex' },
      { to: '/reports', label: 'Owner Reports', icon: 'report', perms: ['reports.view', 'reports.edit'], module: 'reports' },
    ],
  },
  {
    label: 'Files & data',
    items: [
      { to: '/documents', label: 'Documents', icon: 'folder', perms: ['documents.view', 'documents.view_owner', 'documents.view_internal', 'documents.view_confidential', 'documents.upload', 'documents.manage'], module: 'documents' },
      { to: '/imports', label: 'Data Imports', icon: 'upload', perms: ['ingestion.view', 'ingestion.manage', 'financials.edit', 'budgets.edit'], module: 'ingestion' },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/notifications', label: 'Notifications', icon: 'bell' },
      { to: '/admin', label: 'Administration', icon: 'settings', perms: ['admin.users', 'admin.company', 'audit.view'], module: 'admin' },
      { to: '/security', label: 'Account security', icon: 'shield' },
    ],
  },
];

type ItemState = 'open' | 'locked' | 'hidden';

export function Layout() {
  const { ctx, company, setCompanyId, refresh } = usePortal();
  const [ending, setEnding] = useState(false);
  const endSupport = async () => {
    if (!c.support_session_id || !window.confirm('End this support session now? Access to this company stops immediately.')) return;
    setEnding(true);
    await supabase.rpc('end_support_session', { p_session_id: c.support_session_id });
    setEnding(false);
    navigate('/');
    await refresh();
  };
  const sectionState = useSectionState();
  const c = useCompany();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const narrow = useNarrow();
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Phone-width drawer: closed = inert (not focusable); open = focus the first link, Escape closes.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    if (narrow && !open) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [narrow, open]);
  useEffect(() => {
    if (!open) return;
    asideRef.current?.querySelector<HTMLElement>('nav a')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);
  const unread = useQuery({
    queryKey: ['unread', c.company_id],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('company_id', c.company_id).is('read_at', null);
      return count ?? 0;
    },
  });

  // Shown when granted on any property or company-wide (so admins see sections before hotels exist);
  // locked (not hidden) when the only thing missing is a 2FA-verified session.
  const state = (n: NavItem): ItemState => sectionState(n.perms, n.module);
  const initials = (ctx?.full_name ?? ctx?.email ?? '?').split(/[\s@.]+/).filter(Boolean).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const blocked = c.mfa_blocked_permissions.length > 0;
  const portalName = c.branding?.portal_name ?? c.company_name;

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <aside className="sidebar" id="sidebar" aria-label="Main navigation" ref={asideRef}>
        <div className="brand">
          {c.branding?.logo_mark_url ? <img src={c.branding.logo_mark_url} alt="" /> : <span className="brand-mark" aria-hidden>{portalName.slice(0, 1).toUpperCase()}</span>}
          <span className="brand-name">{portalName}</span>
        </div>
        <nav onClick={() => setOpen(false)}>
          {GROUPS.map((g, gi) => {
            const items = g.items.map((n) => ({ n, s: state(n) })).filter((x) => x.s !== 'hidden');
            if (items.length === 0) return null;
            return (
              <div className="nav-group" key={gi}>
                {g.label && <div className="nav-label">{g.label}</div>}
                {items.map(({ n, s }) =>
                  s === 'locked' ? (
                    <NavLink key={n.to} to={`/security?next=${encodeURIComponent(n.to)}`} className={() => 'nav-locked'} title="Verify with two-factor authentication to open this section">
                      <Icon name={n.icon} />
                      <span>{n.label}</span>
                      <Icon name="lock" size={14} className="nav-trailing" />
                    </NavLink>
                  ) : (
                    <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                      <Icon name={n.icon} />
                      <span>{n.label}</span>
                      {n.to === '/notifications' && (unread.data ?? 0) > 0 && <span className="badge-count">{unread.data}</span>}
                    </NavLink>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <strong>{c.company_name}</strong>
          <span>{c.access === 'support_session' ? 'Support session' : ROLE_LABELS[c.role as Role] ?? c.role}</span>
        </div>
      </aside>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden />}
      <div className="main">
        {company?.is_demo && <div className="demo-banner">DEMO DATA — all companies, properties, people and figures shown here are fictional.</div>}
        {c.access === 'support_session' && (
          <div className="support-banner row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>Read-only support session (audited) — expires {new Date(c.support_expires_at!).toLocaleString()}</span>
            <span className="row" style={{ gap: 6 }}>
              <Link className="btn btn-sm" to="/admin?tab=platform">Back to platform console</Link>
              <button className="btn btn-sm" disabled={ending} onClick={() => void endSupport()}>{ending ? 'Ending…' : 'End support session'}</button>
            </span>
          </div>
        )}
        <header className="topbar">
          <button ref={toggleRef} className="btn btn-ghost menu-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          {ctx && ctx.companies.length > 1 && (
            <label className="company-switcher row" style={{ gap: 6 }}>
              <span className="muted small">Company</span>
              <select aria-label="Switch company" value={c.company_id} onChange={(e) => { setCompanyId(e.target.value); navigate('/'); }}>
                {ctx.companies.map((x) => (
                  <option key={x.company_id} value={x.company_id}>
                    {x.company_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="spacer" />
          {blocked && (
            <NavLink to="/security" className="btn btn-sm btn-attention" title="Some sections and actions need two-factor verification">
              <Icon name="lock" size={14} /> Verify with 2FA
            </NavLink>
          )}
          <NavLink to="/security" className="user-chip" style={{ textDecoration: 'none', color: 'inherit' }} title="Account security">
            <span className="avatar" aria-hidden>{initials}</span>
            <span>{ctx?.full_name ?? ctx?.email}</span>
          </NavLink>
          <button className="btn btn-sm btn-ghost" onClick={() => supabase.auth.signOut()} title="Sign out">
            <Icon name="logout" size={16} /> <span className="hide-sm">Sign out</span>
          </button>
        </header>
        <main className="content" id="main" tabIndex={-1}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

const NARROW = '(max-width: 900px)';

/** Whether the off-canvas (phone-width) navigation is in use. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
