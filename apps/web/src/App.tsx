import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, useNavigate, Link } from 'react-router-dom';
import { isAuthError, supabase } from './lib/supabase';
import { usePortal } from './state/portal';
import { Layout } from './components/Layout';
import { RequireProperties } from './components/NoProperties';
import { Card, Empty, Loading, Notice, PageHeader } from './components/ui';
import { RequirePermission } from './components/RequirePermission';
import { LoginPage, ResetPasswordPage } from './pages/Login';
import { AcceptInvitePage } from './pages/AcceptInvite';

const HomePage = lazy(() => import('./pages/Home').then((m) => ({ default: m.HomePage })));
const PropertiesPage = lazy(() => import('./pages/Properties').then((m) => ({ default: m.PropertiesPage })));
const PropertyDetailPage = lazy(() => import('./pages/Properties').then((m) => ({ default: m.PropertyDetailPage })));
const PerformancePage = lazy(() => import('./pages/Performance').then((m) => ({ default: m.PerformancePage })));
const FinancialsPage = lazy(() => import('./pages/Financials').then((m) => ({ default: m.FinancialsPage })));
const FinancialReportPage = lazy(() => import('./pages/FinancialReport').then((m) => ({ default: m.FinancialReportPage })));
const BudgetVersionPage = lazy(() => import('./pages/BudgetVersion').then((m) => ({ default: m.BudgetVersionPage })));
const CapexPage = lazy(() => import('./pages/Capex').then((m) => ({ default: m.CapexPage })));
const CapexProjectPage = lazy(() => import('./pages/Capex').then((m) => ({ default: m.CapexProjectPage })));
const DocumentsPage = lazy(() => import('./pages/Documents').then((m) => ({ default: m.DocumentsPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportsPage })));
const ReportPackagePage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportPackagePage })));
const NotificationsPage = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })));
const ImportsPage = lazy(() => import('./pages/Imports').then((m) => ({ default: m.ImportsPage })));
const ImportDetailPage = lazy(() => import('./pages/Imports').then((m) => ({ default: m.ImportDetailPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
const Platform = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Platform })));
const SecurityPage = lazy(() => import('./pages/Security').then((m) => ({ default: m.SecurityPage })));

function RequireAuth() {
  const { session, sessionLoading, ctx, ctxLoading, ctxError, refetchCtx, company, refresh, revalidate } = usePortal();
  const location = useLocation();
  const navigate = useNavigate();
  const authFailed = !!session && isAuthError(ctxError);
  // Re-check access on navigation (throttled) so a revoked user doesn't keep browsing a cached shell.
  useEffect(() => {
    if (session) revalidate();
  }, [location.pathname, session, revalidate]);
  useEffect(() => {
    if (!authFailed) return;
    void supabase.auth.signOut().finally(() =>
      navigate('/login', { replace: true, state: { from: location.pathname + location.search + location.hash, reason: 'expired' } }),
    );
  }, [authFailed, navigate, location.pathname, location.search, location.hash]);
  if (sessionLoading) return <Loading label="Starting…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  if (authFailed) return <Loading label="Your session has expired. Taking you to sign in…" />;
  if (ctxError && !ctx) {
    return (
      <div className="content">
        <Card>
          <div className="state state-error" role="alert">
            <strong>We couldn’t load your account.</strong>
            <span>Check your connection and try again. If this keeps happening, sign out and sign in again.</span>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={() => void refetchCtx()}>Try again</button>
            <button
              className="btn"
              onClick={() => void supabase.auth.signOut().finally(() => navigate('/login', { replace: true }))}
            >
              Sign out
            </button>
          </div>
        </Card>
      </div>
    );
  }
  if (ctxLoading || !ctx) return <Loading label="Loading your portfolio…" />;
  if (!company) {
    return (
      <div className="content">
        {ctx.is_platform_admin ? (
          <PlatformShell email={ctx.email} aal={ctx.aal} awaiting={ctx.support_sessions_awaiting_mfa ?? []} />
        ) : (
          <Card>
            <Empty title="No active access">
              Your account ({ctx.email}) is not currently linked to any management company, or your access has been revoked. Contact your management company if you believe this is a mistake.
            </Empty>
            <div className="row">
              <button className="btn btn-primary" onClick={() => void refresh()}>Check again</button>
              <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
            </div>
          </Card>
        )}
      </div>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <Outlet />
    </Suspense>
  );
}

/** Platform administrators without a company membership: provisioning, support sessions and their own 2FA. */
function PlatformShell({ email, aal, awaiting }: { email: string; aal: string; awaiting: Array<{ company_name: string; support_expires_at: string }> }) {
  const location = useLocation();
  const onSecurity = location.pathname.startsWith('/security');
  return (
    <>
      <PageHeader
        title="Platform administration"
        subtitle={`Signed in as ${email}. You see company data only through an audited support session.`}
        actions={
          <>
            <Link className="btn" to={onSecurity ? '/' : '/security'}>{onSecurity ? 'Companies' : 'Account security'}</Link>
            <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </>
        }
      />
      {aal !== 'aal2' && (
        <Notice tone="warn">
          Verify with two-factor authentication to make changes: provisioning companies, branding, domains, modules and support sessions all need a 2FA-verified session.{' '}
          {!onSecurity && <Link to="/security">Verify with 2FA</Link>}
        </Notice>
      )}
      {awaiting.length > 0 && (
        <Notice tone="info">
          You have an open support session for {awaiting.map((a) => a.company_name).join(', ')}. Support access only works in a 2FA-verified session — verify to continue.
        </Notice>
      )}
      <Suspense fallback={<Loading />}>{onSecurity ? <SecurityPage embedded /> : <Platform />}</Suspense>
    </>
  );
}

function NotFound() {
  return <Empty page title="Page not found"><Link to="/">Go to the home page</Link></Empty>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'properties', element: <PropertiesPage /> },
          { path: 'properties/:id', element: <PropertyDetailPage /> },
          {
            element: <RequireProperties />,
            children: [
              {
                element: <RequirePermission perms={['performance.view']} module="performance" section="Performance" />,
                children: [{ path: 'performance', element: <PerformancePage /> }],
              },
              {
                element: <RequirePermission perms={['financials.view', 'financials.view_draft', 'financials.edit', 'budgets.view', 'budgets.edit', 'budgets.approve']} module="financials" section="Budgets & financials" />,
                children: [
                  { path: 'financials', element: <FinancialsPage /> },
                  { path: 'financials/reports/:id', element: <FinancialReportPage /> },
                  { path: 'financials/budgets/:id', element: <BudgetVersionPage /> },
                ],
              },
              {
                element: <RequirePermission perms={['capex.view']} module="capex" section="CapEx" />,
                children: [
                  { path: 'capex', element: <CapexPage /> },
                  { path: 'capex/:id', element: <CapexProjectPage /> },
                ],
              },
              {
                element: <RequirePermission perms={['documents.view', 'documents.view_owner', 'documents.view_internal', 'documents.view_confidential', 'documents.upload', 'documents.manage']} module="documents" section="Documents" />,
                children: [{ path: 'documents', element: <DocumentsPage /> }],
              },
              {
                element: <RequirePermission perms={['reports.view', 'reports.edit']} module="reports" section="Owner reports" />,
                children: [
                  { path: 'reports', element: <ReportsPage /> },
                  { path: 'reports/:id', element: <ReportPackagePage /> },
                ],
              },
            ],
          },
          { path: 'notifications', element: <NotificationsPage /> },
          {
            element: <RequirePermission perms={['ingestion.view', 'ingestion.manage', 'financials.edit', 'budgets.edit']} module="ingestion" section="Data imports" />,
            children: [
              { path: 'imports', element: <ImportsPage /> },
              { path: 'imports/:id', element: <ImportDetailPage /> },
            ],
          },
          { path: 'admin', element: <AdminPage /> },
          { path: 'security', element: <SecurityPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
