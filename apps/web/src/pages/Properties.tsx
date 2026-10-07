import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, PageHeader, StatusBadge, fmtDate } from '../components/ui';
import { OverviewPage } from './Overview';

export function PropertiesPage() {
  const { properties } = usePortal();
  const company = useCompany();
  const inv = useQuery({
    queryKey: ['inventory', company.company_id],
    queryFn: async () => unwrap(await supabase.from('room_inventory_history').select('property_id, room_count, effective_from, effective_to').eq('company_id', company.company_id)) as Array<{ property_id: string; room_count: number; effective_from: string; effective_to: string | null }>,
  });
  if (properties.length === 0) return <Empty title="No properties">You have not been granted access to any properties in {company.company_name}.</Empty>;
  return (
    <div className="stack">
      <PageHeader title="Properties" subtitle={`${properties.length} properties you can access in ${company.company_name}`} />
      <div className="grid grid-2">
        {properties.map((p) => {
          const current = inv.data?.find((i) => i.property_id === p.id && i.effective_to === null);
          return (
            <Card key={p.id} title={<Link to={`/properties/${p.id}`}><h2>{p.name}</h2></Link>} actions={<StatusBadge status={p.status} />}>
              <dl className="kv">
                <dt>Code</dt><dd>{p.code}</dd>
                <dt>Location</dt><dd>{[p.city, p.region].filter(Boolean).join(', ')}</dd>
                <dt>Rooms</dt><dd>{current?.room_count ?? '—'}</dd>
                <dt>Timezone</dt><dd>{p.timezone}</dd>
                <dt>Opened</dt><dd>{fmtDate(p.opened_on)}</dd>
              </dl>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function PropertyDetailPage() {
  const { id } = useParams();
  const { properties } = usePortal();
  const property = properties.find((p) => p.id === id);
  const ownership = useQuery({
    queryKey: ['ownership', id],
    enabled: !!property,
    queryFn: async () => unwrap(await supabase.from('property_ownerships').select('ownership_pct, effective_from, effective_to, ownership_groups(name)').eq('property_id', id!)) as unknown as Array<{ ownership_pct: number; effective_from: string; effective_to: string | null; ownership_groups: { name: string } | null }>,
  });
  const inventory = useQuery({
    queryKey: ['inventory-history', id],
    enabled: !!property,
    queryFn: async () => unwrap(await supabase.from('room_inventory_history').select('room_count, effective_from, effective_to, reason').eq('property_id', id!).order('effective_from')) as Array<{ room_count: number; effective_from: string; effective_to: string | null; reason: string | null }>,
  });
  const config = useQuery({
    queryKey: ['reporting-config', id],
    enabled: !!property,
    queryFn: async () => unwrap(await supabase.from('property_reporting_config').select('ooo_treatment, comp_treatment').eq('property_id', id!).maybeSingle()) as { ooo_treatment: string; comp_treatment: string } | null,
  });
  if (!property) return <Empty title="Property not found">It may not exist, or you may not have access to it.</Empty>;
  return (
    <div className="stack">
      <div className="small"><Link to="/properties">← Properties</Link></div>
      <OverviewPage propertyId={property.id} />
      <div className="grid grid-2">
        <Card title="Room inventory history">
          <table className="data">
            <thead><tr><th>From</th><th>To</th><th className="num">Rooms</th><th>Reason</th></tr></thead>
            <tbody>
              {(inventory.data ?? []).map((r) => (
                <tr key={r.effective_from}><td>{fmtDate(r.effective_from)}</td><td>{r.effective_to ? fmtDate(r.effective_to) : 'Current'}</td><td className="num">{r.room_count}</td><td>{r.reason}</td></tr>
              ))}
            </tbody>
          </table>
          {config.data && (
            <p className="small muted">
              KPI conventions: out-of-order rooms are {config.data.ooo_treatment === 'exclude' ? 'excluded from' : 'included in'} available rooms; complimentary rooms are {config.data.comp_treatment === 'exclude' ? 'excluded from' : 'included in'} rooms sold.
            </p>
          )}
        </Card>
        {(ownership.data ?? []).length > 0 && (
          <Card title="Ownership">
            <table className="data">
              <thead><tr><th>Ownership group</th><th className="num">Interest</th><th>Effective</th></tr></thead>
              <tbody>
                {ownership.data!.map((o, i) => (
                  <tr key={i}><td>{o.ownership_groups?.name ?? 'Restricted'}</td><td className="num">{Number(o.ownership_pct).toFixed(2)}%</td><td>{fmtDate(o.effective_from)}{o.effective_to ? ` – ${fmtDate(o.effective_to)}` : ''}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Ownership is recorded separately from portal access; owning an interest does not grant access by itself.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
