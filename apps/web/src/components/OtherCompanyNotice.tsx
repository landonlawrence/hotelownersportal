import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Card, Empty, Loading } from './ui';

/**
 * Shown instead of a page when a deep link points at something in another company than the
 * active one (RLS already decided the user may see it). Offers to switch when the user belongs
 * to that company; otherwise reads as not found. Pages render it before resolving properties,
 * accounts or permissions from the active company.
 */
export function OtherCompanyNotice({ companyId, propertyId, fallbackName }: { companyId: string; propertyId?: string | null; fallbackName: string }) {
  const { ctx, setCompanyId } = usePortal();
  const other = ctx?.companies.find((c) => c.company_id === companyId);
  const property = useQuery({
    queryKey: ['property-elsewhere', propertyId, companyId],
    enabled: !!propertyId && !!other,
    queryFn: async () => unwrap(await supabase.from('properties').select('id, company_id, name').eq('id', propertyId!).maybeSingle()) as { id: string; company_id: string; name: string } | null,
  });
  if (!other) return <Empty page title="Not found">It may not exist, or you may not have access to it.</Empty>;
  if (propertyId && property.isLoading) return <Loading />;
  const name = property.data?.name ?? fallbackName;
  return (
    <Card>
      <Empty page title={`${name} belongs to ${other.company_name}`}>
        <span className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => setCompanyId(other.company_id)}>
            Switch to {other.company_name}
          </button>
        </span>
      </Empty>
    </Card>
  );
}

/** True when an entity belongs to a company other than the active one. */
export function useIsOtherCompany(companyId: string | null | undefined): boolean {
  const { company } = usePortal();
  return !!companyId && !!company && companyId !== company.company_id;
}
