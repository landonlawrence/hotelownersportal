import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { computeKpis, formatCurrency, formatNumber, formatPercent, monthEnd, monthStart, normaliseDay } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { downloadFromApi } from '../lib/api';
import { defaultAsOf } from '../lib/performance';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, PageHeader, fmtDate } from '../components/ui';

interface Day {
  business_date: string; physical_rooms: number; rooms_out_of_order: number; rooms_sold: number; rooms_comp: number;
  room_revenue: number; total_revenue: number | null; source_metrics: Record<string, number>; revision: number; updated_at: string;
}

export function PerformancePage() {
  const { properties } = usePortal();
  const company = useCompany();
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [month, setMonth] = useState(defaultAsOf().slice(0, 7));
  const from = monthStart(`${month}-01`);
  const to = monthEnd(`${month}-01`);
  const cfg = useQuery({ queryKey: ['cfg', propertyId], enabled: !!propertyId, queryFn: async () => unwrap(await supabase.from('property_reporting_config').select('ooo_treatment, comp_treatment').eq('property_id', propertyId).maybeSingle()) as { ooo_treatment: 'exclude' | 'include'; comp_treatment: 'exclude' | 'include' } | null });
  const q = useQuery({
    queryKey: ['daily', propertyId, from],
    enabled: !!propertyId,
    queryFn: async () => unwrap(await supabase.from('daily_performance').select('business_date, physical_rooms, rooms_out_of_order, rooms_sold, rooms_comp, room_revenue, total_revenue, source_metrics, revision, updated_at').eq('property_id', propertyId).gte('business_date', from).lte('business_date', to).order('business_date')) as Day[],
  });
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
    return out;
  }, [from, to]);
  const property = properties.find((p) => p.id === propertyId);
  if (properties.length === 0) return <Empty title="No properties" />;
  return (
    <div className="stack">
      <PageHeader title="Daily performance" subtitle="Provisional figures from PMS reports, by property-local business date." actions={<button className="btn" onClick={() => downloadFromApi(`/exports/performance.csv?company_id=${company.company_id}&from=${from}&to=${to}&grain=day&property_ids=${propertyId}`, 'daily.csv')}>Export CSV</button>} />
      <div className="filter-bar">
        <label className="field">Property<select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field">Month<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>
      <Card flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Business date</th><th className="num">Rooms</th><th className="num">OOO</th><th className="num">Available</th><th className="num">Sold</th><th className="num">Comp</th><th className="num">Occupancy</th><th className="num">ADR</th><th className="num">RevPAR</th><th className="num">Room revenue</th><th className="num">Total revenue</th><th className="num">Source occ.</th><th>Rev.</th></tr></thead>
              <tbody>
                {days.map((d) => {
                  const r = q.data?.find((x) => x.business_date === d);
                  if (!r) return <tr key={d}><td>{fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td colSpan={12} className="muted small">{d > defaultAsOf() ? 'Future date' : 'Unavailable — no report loaded'}</td></tr>;
                  const c = normaliseDay({ propertyId, businessDate: d, physicalRooms: r.physical_rooms, roomsOutOfOrder: r.rooms_out_of_order, roomsSold: r.rooms_sold, roomsComp: r.rooms_comp, roomRevenue: Number(r.room_revenue), totalRevenue: r.total_revenue === null ? null : Number(r.total_revenue) }, { oooTreatment: cfg.data?.ooo_treatment ?? 'exclude', compTreatment: cfg.data?.comp_treatment ?? 'exclude' });
                  const k = computeKpis(c);
                  return (
                    <tr key={d}>
                      <td>{fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                      <td className="num">{r.physical_rooms}</td><td className="num">{r.rooms_out_of_order}</td><td className="num">{formatNumber(c.availableRoomNights)}</td>
                      <td className="num">{r.rooms_sold}</td><td className="num">{r.rooms_comp}</td>
                      <td className="num">{formatPercent(k.occupancyPct)}</td><td className="num">{formatCurrency(k.adr, property?.currency, { cents: true })}</td><td className="num">{formatCurrency(k.revpar, property?.currency, { cents: true })}</td>
                      <td className="num">{formatCurrency(Number(r.room_revenue), property?.currency)}</td><td className="num">{formatCurrency(r.total_revenue === null ? null : Number(r.total_revenue), property?.currency)}</td>
                      <td className="num muted" title="As reported by the source system (may use a different definition)">{r.source_metrics?.occupancy_pct !== undefined ? formatPercent(r.source_metrics.occupancy_pct) : '—'}</td>
                      <td className="small">{r.revision > 1 ? `r${r.revision}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="small muted">Occupancy and ADR use this property’s conventions (out-of-order rooms {cfg.data?.ooo_treatment === 'include' ? 'included in' : 'excluded from'} availability; complimentary rooms {cfg.data?.comp_treatment === 'include' ? 'included in' : 'excluded from'} rooms sold). “Source occ.” preserves the PMS-reported value.</p>
    </div>
  );
}
