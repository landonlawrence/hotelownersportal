import { lazy, Suspense, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { usePortal } from '../../state/portal';
import { Icon, type IconName } from '../../components/icons';
import { Loading, Notice } from '../../components/ui';

const Overview = lazy(() => import('./Overview').then((m) => ({ default: m.PlatformOverview })));
const Companies = lazy(() => import('./Companies').then((m) => ({ default: m.CompaniesPage })));
const CompanyDetail = lazy(() => import('./CompanyDetail').then((m) => ({ default: m.CompanyDetailPage })));
const Onboard = lazy(() => import('./Onboard').then((m) => ({ default: m.OnboardPage })));
const SecurityPage = lazy(() => import('../Security').then((m) => ({ default: m.SecurityPage })));

const NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/platform', label: 'Overview', icon: 'overview', end: true },
  { to: '/platform/companies', label: 'Companies', icon: 'building' },
  { to: '/platform/onboard', label: 'Onboard a company', icon: 'users' },
  { to: '/platform/security', label: 'Account security', icon: 'shield' },
];

/** Operator console for platform administrators: onboarding and looking after companies. */
export function PlatformConsole() {
  const { ctx, company } = usePortal();
  const [open, setOpen] = useState(false);
  if (!ctx?.is_platform_admin) return <Navigate to="/" replace />;
  const verified = ctx.aal === 'aal2';
  const awaiting = ctx.support_sessions_awaiting_mfa ?? [];
  return (
    <div className={`console ${open ? 'nav-open' : ''}`}>
      <aside className="console-rail" aria-label="Operator console">
        <div className="console-mark">
          <span className="console-mark-tag" aria-hidden />
          <span>
            <strong>Operator console</strong>
            <span>Hotel Owners Portal</span>
          </span>
        </div>
        <nav aria-label="Platform navigation" onClick={() => setOpen(false)}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="console-foot">
          {company && (
            <Link to="/" className="console-switch">
              <Icon name="home" size={16} /> Back to {company.company_name}
            </Link>
          )}
          <span className="small">{ctx.email}</span>
          <span className={`console-aal ${verified ? 'ok' : ''}`}>{verified ? '2FA verified' : 'Password only'}</span>
          <button className="btn btn-sm btn-ghost console-signout" onClick={() => supabase.auth.signOut()}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </aside>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden />}
      <div className="console-main">
        <header className="console-top">
          <button className="btn btn-ghost console-menu" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          <span className="console-top-title">Operator console</span>
        </header>
        <main className="console-content" id="main">
          {!verified && (
            <Notice tone="warn">
              You’re signed in with a password only. Onboarding, edits and support sessions need a 2FA-verified session.{' '}
              <Link to="/platform/security">Verify with 2FA</Link>
            </Notice>
          )}
          {awaiting.length > 0 && (
            <Notice tone="info">
              You have an open support session for {awaiting.map((a) => a.company_name).join(', ')}. Support access only works in a 2FA-verified session.
            </Notice>
          )}
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<Overview />} />
              <Route path="companies" element={<Companies />} />
              <Route path="companies/:id" element={<CompanyDetail />} />
              <Route path="onboard" element={<Onboard />} />
              <Route path="security" element={<SecurityPage embedded />} />
              <Route path="*" element={<Navigate to="/platform" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
