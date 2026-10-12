import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { usePortal, useCompany } from '../state/portal';
import { Icon } from './icons';
import { Card, Empty } from './ui';

/** Shown instead of property-based pages until the user can see at least one hotel. */
export function NoProperties({ title }: { title?: string }) {
  const { isCompanyAdmin } = usePortal();
  const company = useCompany();
  return (
    <Card>
      {isCompanyAdmin ? (
        <Empty title={title ?? 'Add a hotel first'}>
          This section fills in once {company.company_name} has at least one property.
          <span className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <Link className="btn btn-primary" to="/admin?tab=properties"><Icon name="building" size={16} /> Add a property</Link>
            <Link className="btn" to="/">Setup checklist</Link>
          </span>
        </Empty>
      ) : (
        <Empty title="No properties shared with you yet">Once {company.company_name} gives you access to a hotel, it will appear here.</Empty>
      )}
    </Card>
  );
}

/** Route guard for property-based sections. */
export function RequireProperties({ children }: { children?: ReactNode }) {
  const { properties } = usePortal();
  if (properties.length === 0) return <NoProperties />;
  return <>{children ?? <Outlet />}</>;
}
