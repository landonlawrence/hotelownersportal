import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { usePortal, useCompany } from '../state/portal';
import { Icon } from './icons';
import { Card, Empty, Loading, errorMessage } from './ui';

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

/** A failed properties request is an error to retry, never a loss of access. */
export function PropertiesErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <strong>We couldn’t load your properties.</strong>
      <span>{errorMessage(error)}</span>
      <button className="btn btn-sm" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/** Route guard for property-based sections. */
export function RequireProperties({ children }: { children?: ReactNode }) {
  const { properties, propertiesLoading, propertiesError, refetchProperties } = usePortal();
  if (propertiesLoading) return <Loading />;
  if (propertiesError && properties.length === 0) {
    return (
      <Card>
        <PropertiesErrorState error={propertiesError} retry={() => void refetchProperties()} />
      </Card>
    );
  }
  if (properties.length === 0) return <NoProperties />;
  return <>{children ?? <Outlet />}</>;
}
