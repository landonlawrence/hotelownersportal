import { lazy, Suspense } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { usePortal } from './state/portal';
import { Layout } from './components/Layout';
import { Card, Empty, Loading, PageHeader } from './components/ui';
import { LoginPage } from './pages/Login';
import { AcceptInvitePage } from './pages/AcceptInvite';

const OverviewPage = lazy(() => import('./pages/Overview').then((m) => ({ default: m.OverviewPage })));
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
  const { session, sessionLoading, ctx, ctxLoading, company, refresh } = usePortal();
  const location = useLocation();
  if (sessionLoading) return <Loading label="Starting…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (ctxLoading || !ctx) return <Loading label="Loading your portfolio…" />;
  if (!company) {
    return (
      <div className="content">
        {ctx.is_platform_admin ? (
          <>
            <PageHeader title="Platform administration" subtitle="You have no company memberships. Open an audited support session to view a company." actions={<button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>} />
            <Suspense fallback={<Loading />}>
              <Platform />
            </Suspense>
          </>
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

function NotFound() {
  return <Empty title="Page not found"><Link to="/">Go to overview</Link></Empty>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'properties', element: <PropertiesPage /> },
          { path: 'properties/:id', element: <PropertyDetailPage /> },
          { path: 'performance', element: <PerformancePage /> },
          { path: 'financials', element: <FinancialsPage /> },
          { path: 'financials/reports/:id', element: <FinancialReportPage /> },
          { path: 'financials/budgets/:id', element: <BudgetVersionPage /> },
          { path: 'capex', element: <CapexPage /> },
          { path: 'capex/:id', element: <CapexProjectPage /> },
          { path: 'documents', element: <DocumentsPage /> },
          { path: 'reports', element: <ReportsPage /> },
          { path: 'reports/:id', element: <ReportPackagePage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'imports', element: <ImportsPage /> },
          { path: 'imports/:id', element: <ImportDetailPage /> },
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
