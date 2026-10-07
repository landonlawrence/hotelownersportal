import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, type Permission, type Role } from '@hop/core';
import { supabase } from '../lib/supabase';
import { usePortal, useCompany } from '../state/portal';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perm?: Permission;
  module?: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: '◎', perm: 'performance.view', module: 'performance' },
  { to: '/properties', label: 'Properties', icon: '▦' },
  { to: '/performance', label: 'Performance', icon: '↗', perm: 'performance.view', module: 'performance' },
  { to: '/financials', label: 'Budgets & Financials', icon: '$', perm: 'financials.view', module: 'financials' },
  { to: '/capex', label: 'CapEx', icon: '⚒', perm: 'capex.view', module: 'capex' },
  { to: '/documents', label: 'Documents', icon: '❐', perm: 'documents.view', module: 'documents' },
  { to: '/reports', label: 'Owner Reports', icon: '☰', perm: 'reports.view', module: 'reports' },
  { to: '/notifications', label: 'Notifications', icon: '✉' },
  { to: '/imports', label: 'Data Imports', icon: '⇪', perm: 'ingestion.view', module: 'ingestion' },
  { to: '/admin', label: 'Administration', icon: '⚙', perm: 'admin.users', module: 'admin' },
];

export function Layout() {
  const { ctx, company, setCompanyId, canAny, can } = usePortal();
  const c = useCompany();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unread = useQuery({
    queryKey: ['unread', c.company_id],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('company_id', c.company_id).is('read_at', null);
      return count ?? 0;
    },
  });
  const items = NAV.filter((n) => {
    if (n.module && c.modules[n.module] === false) return false;
    if (!n.perm) return true;
    if (n.to === '/financials') return canAny('financials.view') || canAny('budgets.view') || canAny('financials.view_draft');
    if (n.to === '/admin') return can('admin.users') || can('admin.company') || can('audit.view');
    if (n.to === '/documents') return canAny('documents.view') || canAny('documents.view_owner') || canAny('documents.upload');
    return canAny(n.perm);
  });
  const initials = (ctx?.full_name ?? ctx?.email ?? '?').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const blocked = c.mfa_blocked_permissions.length > 0;

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          {c.branding?.logo_mark_url ? <img src={c.branding.logo_mark_url} alt="" /> : null}
          <span>{c.branding?.portal_name ?? c.company_name}</span>
        </div>
        <nav onClick={() => setOpen(false)}>
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <span aria-hidden style={{ width: 18, textAlign: 'center' }}>{n.icon}</span>
              {n.label}
              {n.to === '/notifications' && (unread.data ?? 0) > 0 && <span className="badge-count">{unread.data}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {c.company_name}
          <br />
          {c.access === 'support_session' ? 'Support session' : ROLE_LABELS[c.role as Role] ?? c.role}
        </div>
      </aside>
      <div className="main">
        {company?.is_demo && <div className="demo-banner">DEMO DATA — all companies, properties, people and figures shown here are fictional.</div>}
        {c.access === 'support_session' && (
          <div className="support-banner">Read-only support session (audited) — expires {new Date(c.support_expires_at!).toLocaleString()}</div>
        )}
        <header className="topbar">
          <button className="btn btn-ghost menu-toggle" aria-label="Open navigation" onClick={() => setOpen((o) => !o)}>
            ☰
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
            <NavLink to="/security" className="btn btn-sm" title="Some actions require two-factor authentication">
              🔒 Verify with 2FA
            </NavLink>
          )}
          <NavLink to="/security" className="user-chip" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="avatar" aria-hidden>{initials}</span>
            <span>{ctx?.full_name ?? ctx?.email}</span>
          </NavLink>
          <button className="btn btn-sm" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
