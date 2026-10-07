import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { usePortal } from './state/portal';
import { Layout } from './components/Layout';
import { Card, Empty, Loading, PageHeader } from './components/ui';
import { LoginPage } from './pages/Login';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { SecurityPage } from './pages/Security';
import { OverviewPage } from './pages/Overview';
import { PropertiesPage, PropertyDetailPage } from './pages/Properties';
import { PerformancePage } from './pages/Performance';
import { FinancialsPage } from './pages/Financials';
import { FinancialReportPage } from './pages/FinancialReport';
import { BudgetVersionPage } from './pages/BudgetVersion';
import { CapexPage, CapexProjectPage } from './pages/Capex';
import { DocumentsPage } from './pages/Documents';
import { ReportPackagePage, ReportsPage } from './pages/Reports';
import { NotificationsPage } from './pages/Notifications';
import { ImportDetailPage, ImportsPage } from './pages/Imports';
import { AdminPage, Platform } from './pages/Admin';

function RequireAuth() {
  const { session, sessionLoading, ctx, ctxLoading, company } = usePortal();
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
            <Platform />
          </>
        ) : (
          <Card>
            <Empty title="No active access">
              Your account ({ctx.email}) is not currently linked to any management company, or your access has been revoked. Contact your management company if you believe this is a mistake.
            </Empty>
            <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </Card>
        )}
      </div>
    );
  }
  return <Outlet />;
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
