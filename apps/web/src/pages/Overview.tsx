import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { capexFunds, formatCurrency, formatPercent, REMAINING_FUNDS_DEFINITION, type PeriodView } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { defaultAsOf, toTrendPoints, usePerformance, type TrendMetric } from '../lib/performance';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Notice, PageHeader, Segmented, StatusBadge, fmtDate, fmtMonth } from '../components/ui';
import { CoverageBadge, FreshnessBadge, KpiCard, fmtKpi } from '../components/kpi';
import { TrendChart } from '../components/TrendChart';
import { PeriodFilter, PropertyMultiSelect } from '../components/filters';
import { downloadFromApi } from '../lib/api';

const METRICS: Array<{ value: TrendMetric; label: string; kind: 'pct' | 'money_cents' | 'money' }> = [
  { value: 'revpar', label: 'RevPAR', kind: 'money_cents' },
  { value: 'occupancyPct', label: 'Occupancy', kind: 'pct' },
  { value: 'adr', label: 'ADR', kind: 'money_cents' },
  { value: 'roomRevenue', label: 'Room revenue', kind: 'money' },
];

const VIEW_LABEL: Record<PeriodView, string> = { day: 'Day', mtd: 'Month to date', month: 'Month', ytd: 'Year to date', custom: 'Custom' };

export function OverviewPage({ propertyId }: { propertyId?: string } = {}) {
  const { properties: allProperties, canAny, can } = usePortal();
  const properties = useMemo(() => (propertyId ? allProperties.filter((p) => p.id === propertyId) : allProperties), [allProperties, propertyId]);
  const company = useCompany();
  const [view, setView] = useState<PeriodView>('mtd');
  const [asOf, setAsOf] = useState(defaultAsOf());
  const [selected, setSelected] = useState<string[]>([]);
  const [metric, setMetric] = useState<TrendMetric>('revpar');
  const scope = useMemo(() => (selected.length ? properties.filter((p) => selected.includes(p.id)) : properties), [properties, selected]);
  const perf = usePerformance({ companyId: company.company_id, properties: scope, view, asOf });
  const currency = scope[0]?.currency ?? 'USD';
  const d = perf.data;
  const m = METRICS.find((x) => x.value === metric)!;
  const showBudget = scope.some((p) => can('budgets.view', p.id));

  if (properties.length === 0) return <Empty title="No properties yet">You don’t have access to any properties in {company.company_name}.</Empty>;

  return (
    <div className="stack">
      <PageHeader
        title={propertyId ? properties[0]?.name ?? 'Property' : 'Portfolio overview'}
        subtitle={d ? `${VIEW_LABEL[view]} · ${fmtDate(d.range.from)} – ${fmtDate(d.range.to)} · daily figures are provisional` : company.company_name}
        actions={
          <button
            className="btn"
            disabled={!d}
            onClick={() => d && downloadFromApi(`/exports/performance.csv?company_id=${company.company_id}&from=${d.range.from}&to=${d.range.to}&grain=total${(propertyId ? [propertyId] : selected).length ? `&property_ids=${(propertyId ? [propertyId] : selected).join(',')}` : ''}`, 'performance.csv')}
          >
            Export CSV
          </button>
        }
      />
      <div className="filter-bar">
        <PeriodFilter view={view} asOf={asOf} onView={setView} onAsOf={setAsOf} />
        {!propertyId && <PropertyMultiSelect properties={properties} selected={selected} onChange={setSelected} />}
      </div>

      {perf.isLoading && <Loading />}
      {perf.error && <ErrorState error={perf.error} retry={() => perf.refetch()} />}
      {d && (
        <div className={`stack ${perf.isFetching ? 'refetching' : ''}`}>
          {d.current.partial && (
            <Notice tone="warn">
              Incomplete data: {d.current.coverage.reportedDays} of {d.current.coverage.expectedDays} property-days reported
              {d.current.propertiesWithoutData.length > 0 && ` (no data: ${d.current.propertiesWithoutData.map((id) => properties.find((p) => p.id === id)?.code).join(', ')})`}. Totals cover reported days only; ratios are not
              extrapolated.
            </Notice>
          )}
          {d.priorRange.containsLeapDay && <Notice tone="info">This comparison spans 29 February; prior-year totals cover one day fewer/more. Ratios remain comparable.</Notice>}
          <div className="grid grid-kpi">
            <KpiCard label="Occupancy" value={d.current.kpis.occupancyPct} kind="pct" priorYear={d.prior.kpis.occupancyPct} budget={!showBudget ? undefined : d.budget?.occupancyPct ?? null} partial={d.current.partial} hint="Rooms sold ÷ available room nights" />
            <KpiCard label="ADR" value={d.current.kpis.adr} kind="money_cents" currency={currency} priorYear={d.prior.kpis.adr} budget={!showBudget ? undefined : d.budget?.adr ?? null} partial={d.current.partial} hint="Room revenue ÷ rooms sold" />
            <KpiCard label="RevPAR" value={d.current.kpis.revpar} kind="money_cents" currency={currency} priorYear={d.prior.kpis.revpar} budget={!showBudget ? undefined : d.budget?.revpar ?? null} partial={d.current.partial} hint="Room revenue ÷ available room nights" />
            <KpiCard label="Room revenue" value={d.current.kpis.roomRevenue} kind="money" currency={currency} priorYear={d.prior.kpis.roomRevenue} budget={!showBudget ? undefined : d.budget?.roomRevenue ?? null} partial={d.current.partial} />
            <KpiCard label="Total revenue" value={d.current.kpis.totalRevenue} kind="money" currency={currency} priorYear={d.prior.kpis.totalRevenue} budget={!showBudget ? undefined : d.budget?.totalRevenue ?? null} partial={d.current.partial} />
          </div>
          {!d.budget && showBudget && <p className="small muted">Budget comparison unavailable: not every selected property has an approved budget for this period.</p>}

          <Card title={`${m.label} trend${d.trendGrain === 'day' ? ` — ${fmtMonth(asOf)}` : ' — trailing 12 months'}`} actions={<Segmented label="Trend metric" value={metric} onChange={setMetric} options={METRICS} />}>
            <TrendChart data={toTrendPoints(d, metric)} kind={m.kind} title={m.label} currency={currency} />
          </Card>

          <Card title={propertyId ? 'Period summary' : 'Property comparison'} flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th className="num">Occupancy</th>
                    <th className="num">ADR</th>
                    <th className="num">RevPAR</th>
                    <th className="num">RevPAR vs PY</th>
                    {showBudget && <th className="num">RevPAR vs budget</th>}
                    <th className="num">Room revenue</th>
                    <th>Coverage</th>
                    <th>Data freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {scope.map((p) => {
                    const cur = d.current.properties.find((x) => x.propertyId === p.id)!;
                    const py = d.prior.properties.find((x) => x.propertyId === p.id);
                    const bud = d.budgetByProperty.get(p.id);
                    const vsPy = cur.kpis.revpar !== null && py?.kpis.revpar ? cur.kpis.revpar / py.kpis.revpar - 1 : null;
                    const vsBud = cur.kpis.revpar !== null && bud?.revpar ? cur.kpis.revpar / bud.revpar - 1 : null;
                    return (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/properties/${p.id}`}>{p.name}</Link>
                          <div className="small muted">{p.code} · {p.city}</div>
                        </td>
                        <td className="num">{formatPercent(cur.kpis.occupancyPct)}</td>
                        <td className="num">{fmtKpi(cur.kpis.adr, 'money_cents', currency)}</td>
                        <td className="num">{fmtKpi(cur.kpis.revpar, 'money_cents', currency)}</td>
                        <DeltaCell value={vsPy} />
                        {showBudget && <DeltaCell value={vsBud} />}
                        <td className="num">{fmtKpi(cur.kpis.roomRevenue, 'money', currency)}</td>
                        <td><CoverageBadge coverage={cur.coverage} /></td>
                        <td><FreshnessBadge f={d.freshness.get(p.id)!} /></td>
                      </tr>
                    );
                  })}
                </tbody>
                {scope.length > 1 && (
                  <tfoot>
                    <tr className="subtotal">
                      <td>Portfolio{d.current.partial ? ' (partial)' : ''}</td>
                      <td className="num">{formatPercent(d.current.kpis.occupancyPct)}</td>
                      <td className="num">{fmtKpi(d.current.kpis.adr, 'money_cents', currency)}</td>
                      <td className="num">{fmtKpi(d.current.kpis.revpar, 'money_cents', currency)}</td>
                      <DeltaCell value={d.prior.kpis.revpar && d.current.kpis.revpar !== null ? d.current.kpis.revpar / d.prior.kpis.revpar - 1 : null} />
                      {showBudget && <DeltaCell value={d.budget?.revpar && d.current.kpis.revpar !== null ? d.current.kpis.revpar / d.budget.revpar - 1 : null} />}
                      <td className="num">{fmtKpi(d.current.kpis.roomRevenue, 'money', currency)}</td>
                      <td><CoverageBadge coverage={d.current.coverage} /></td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="small muted" style={{ padding: '8px 16px' }}>
              Portfolio ratios are calculated from summed rooms and revenue, never by averaging hotel percentages. Out-of-order rooms are excluded from availability and complimentary rooms from rooms sold unless a property is configured otherwise.
            </p>
          </Card>
        </div>
      )}
      <div className="grid grid-2">
        {canAny('capex.view') && company.modules.capex !== false && <CapexSummary propertyIds={scope.map((p) => p.id)} currency={currency} />}
        {canAny('reports.view') && company.modules.reports !== false && <RecentReports />}
        {canAny('commentary.view') && company.modules.reports !== false && <LatestCommentary />}
      </div>
    </div>
  );
}

function CapexSummary({ propertyIds, currency }: { propertyIds: string[]; currency: string }) {
  const company = useCompany();
  const q = useQuery({
    queryKey: ['capex-summary', company.company_id],
    queryFn: async () => {
      const [summary, projects] = await Promise.all([
        supabase.rpc('capex_project_summary', { p_company_id: company.company_id }),
        supabase.from('capex_projects').select('id, status').eq('company_id', company.company_id),
      ]);
      return { summary: unwrap(summary) as Array<{ project_id: string; property_id: string; approved_budget: number; actual_spend: number; open_commitments: number }>, projects: unwrap(projects) as Array<{ id: string; status: string }> };
    },
  });
  if (!q.data) return <Card title="CapEx">{q.error ? <ErrorState error={q.error} /> : <Loading />}</Card>;
  const rows = q.data.summary.filter((s) => propertyIds.includes(s.property_id));
  const tot = rows.reduce((a, r) => ({ approved: a.approved + Number(r.approved_budget), actual: a.actual + Number(r.actual_spend), committed: a.committed + Number(r.open_commitments) }), { approved: 0, actual: 0, committed: 0 });
  const f = capexFunds(tot.approved, tot.actual, tot.committed);
  const pending = q.data.projects.filter((p) => p.status === 'pending_approval' && rows.some((r) => r.project_id === p.id)).length;
  return (
    <Card title="CapEx" actions={<Link to="/capex" className="small">View projects</Link>}>
      <dl className="kv">
        <dt>Approved budget</dt><dd className="num" style={{ textAlign: 'left' }}>{formatCurrency(f.approvedBudget, currency)}</dd>
        <dt>Actual spend</dt><dd>{formatCurrency(f.actualSpend, currency)}</dd>
        <dt>Open commitments</dt><dd>{formatCurrency(f.openCommitments, currency)}</dd>
        <dt>Remaining funds</dt><dd><strong>{formatCurrency(f.remaining, currency)}</strong></dd>
        <dt>Awaiting approval</dt><dd>{pending} project(s)</dd>
      </dl>
      <p className="small muted">{REMAINING_FUNDS_DEFINITION}</p>
    </Card>
  );
}

function RecentReports() {
  const company = useCompany();
  const q = useQuery({
    queryKey: ['recent-reports', company.company_id],
    queryFn: async () =>
      unwrap(
        await supabase.from('reporting_packages').select('id, title, period_month, published_at, revision, properties(code, name)').eq('company_id', company.company_id).eq('status', 'published').order('published_at', { ascending: false }).limit(5),
      ) as unknown as Array<{ id: string; title: string; period_month: string; published_at: string; revision: number; properties: { code: string; name: string } }>,
  });
  return (
    <Card title="Recent owner reports" actions={<Link to="/reports" className="small">All reports</Link>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (q.data ?? []).length === 0 ? <Empty title="No published reports yet" /> : (
        <ul className="timeline">
          {q.data!.map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`}>{r.properties.name} — {fmtMonth(r.period_month)}</Link>
              <div className="small muted">Published {fmtDate(r.published_at)}{r.revision > 1 ? ` · revision ${r.revision}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function LatestCommentary() {
  const company = useCompany();
  const q = useQuery({
    queryKey: ['latest-commentary', company.company_id],
    queryFn: async () =>
      unwrap(
        await supabase.from('management_commentary').select('id, title, body, period_month, visibility, status, properties(code)').eq('company_id', company.company_id).eq('status', 'published').eq('visibility', 'owner').order('period_month', { ascending: false }).order('created_at', { ascending: false }).limit(4),
      ) as unknown as Array<{ id: string; title: string | null; body: string; period_month: string; properties: { code: string } | null }>,
  });
  return (
    <Card title="Management commentary">
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <Empty title="No commentary published" /> : (
        <ul className="timeline">
          {q.data!.map((c) => (
            <li key={c.id}>
              <div className="row" style={{ gap: 6 }}>
                <strong>{c.title ?? 'Commentary'}</strong>
                <StatusBadge status="published" label={`${c.properties?.code ?? 'Portfolio'} · ${fmtMonth(c.period_month)}`} />
              </div>
              <p style={{ margin: '4px 0 0' }}>{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeltaCell({ value }: { value: number | null }) {
  if (value === null) return <td className="num">—</td>;
  return (
    <td className={`num ${value >= 0 ? 'delta-good' : 'delta-bad'}`}>
      <span aria-hidden>{value >= 0 ? '▲ ' : '▼ '}</span>
      {`${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`}
    </td>
  );
}
