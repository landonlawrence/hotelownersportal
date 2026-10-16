import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { capexFunds, formatCurrency, formatPercent, isIsoDate, maxIsoDate, REMAINING_FUNDS_DEFINITION, type PeriodView } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { actualsRange, defaultAsOf, requestedRange, toTrendPoints, usePerformance, type TrendMetric } from '../lib/performance';
import { DownloadButton } from '../components/DownloadButton';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Notice, PageHeader, Segmented, StatusBadge, fmtDate, fmtMonth } from '../components/ui';
import { CoverageBadge, FreshnessBadge, KpiCard, fmtKpi } from '../components/kpi';
import { TrendChart } from '../components/TrendChart';
import { PeriodFilter, PropertyMultiSelect, localYesterday } from '../components/filters';
import { downloadFromApi } from '../lib/api';

const METRICS: Array<{ value: TrendMetric; label: string; kind: 'pct' | 'money_cents' | 'money' }> = [
  { value: 'revpar', label: 'RevPAR', kind: 'money_cents' },
  { value: 'occupancyPct', label: 'Occupancy', kind: 'pct' },
  { value: 'adr', label: 'ADR', kind: 'money_cents' },
  { value: 'roomRevenue', label: 'Room revenue', kind: 'money' },
];

const VIEW_LABEL: Record<PeriodView, string> = { day: 'Day', mtd: 'Month to date', month: 'Month', ytd: 'Year to date', custom: 'Custom' };

export function OverviewPage({ propertyId, intro }: { propertyId?: string; intro?: ReactNode } = {}) {
  const { properties: allProperties, canAny, can } = usePortal();
  const properties = useMemo(() => (propertyId ? allProperties.filter((p) => p.id === propertyId) : allProperties), [allProperties, propertyId]);
  const company = useCompany();
  // Filters live in the URL so Back and reload restore them.
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');
  const view: PeriodView = viewParam === 'day' || viewParam === 'mtd' || viewParam === 'month' || viewParam === 'ytd' ? viewParam : 'mtd';
  const asOfParam = params.get('asOf');
  // Default to the hotels' latest closed business date; never accept a future date from the URL.
  const businessDefault = defaultAsOf(properties);
  const maxAsOf = maxIsoDate(localYesterday(), businessDefault);
  const asOfValid = !!asOfParam && isIsoDate(asOfParam) && asOfParam <= maxAsOf;
  const asOf = asOfValid ? asOfParam! : businessDefault;
  const selected = useMemo(() => (params.get('props') ?? '').split(',').filter((id) => id && properties.some((p) => p.id === id)), [params, properties]);
  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: false },
    );
  const setView = (v: PeriodView) => update({ view: v === 'mtd' ? null : v });
  const setAsOf = (d: string) => update({ asOf: d === businessDefault || d > maxAsOf ? null : d });
  // Drop an invalid or future asOf from the URL so links and Back stay clean.
  useEffect(() => {
    if (asOfParam && !asOfValid) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('asOf');
          return next;
        },
        { replace: true },
      );
    }
  }, [asOfParam, asOfValid, setParams]);
  const setSelected = (ids: string[]) => update({ props: ids.length ? ids.join(',') : null });
  const [metric, setMetric] = useState<TrendMetric>('revpar');
  const scope = useMemo(() => (selected.length ? properties.filter((p) => selected.includes(p.id)) : properties), [properties, selected]);
  const perf = usePerformance({ companyId: company.company_id, properties: scope, view, asOf });
  const currency = scope[0]?.currency ?? 'USD';
  const d = perf.data;
  // Header and export follow the selected view, not the (possibly previous) data on screen.
  const requested = requestedRange(view, asOf, scope);
  const stale = perf.isPlaceholderData || (perf.isFetching && !d);
  const m = METRICS.find((x) => x.value === metric)!;
  const showBudget = scope.some((p) => can('budgets.view', p.id));

  if (properties.length === 0) return <Empty title="No properties yet">You don’t have access to any properties in {company.company_name}.</Empty>;

  return (
    <div className="stack">
      <PageHeader
        title={propertyId ? properties[0]?.name ?? 'Property' : 'Portfolio overview'}
        subtitle={
          stale
            ? `${VIEW_LABEL[view]} · Loading…`
            : d
              ? requested.comparable.inProgress && requested.comparable.to >= requested.range.from
                ? `${VIEW_LABEL[view]} · ${fmtDate(requested.range.from)} – ${fmtDate(requested.comparable.to)} (${view === 'month' ? 'month' : 'period'} in progress) · daily figures are provisional`
                : `${VIEW_LABEL[view]} · ${fmtDate(requested.range.from)} – ${fmtDate(requested.range.to)}${view === 'month' ? ' (closed)' : ''} · daily figures are provisional`
              : company.company_name
        }
        actions={
          d && !stale ? (
            <DownloadButton
              label="Export CSV"
              run={() => downloadFromApi(`/exports/performance.csv?company_id=${company.company_id}&from=${actualsRange(requested).from}&to=${actualsRange(requested).to}&grain=total${(propertyId ? [propertyId] : selected).length ? `&property_ids=${(propertyId ? [propertyId] : selected).join(',')}` : ''}`, 'performance.csv')}
            />
          ) : (
            <button className="btn" disabled>
              Export CSV
            </button>
          )
        }
      />
      {intro}
      <div className="filter-bar">
        <PeriodFilter view={view} asOf={asOf} onView={setView} onAsOf={setAsOf} max={maxAsOf} />
        {!propertyId && <PropertyMultiSelect properties={properties} selected={selected} onChange={setSelected} />}
      </div>

      {perf.isLoading && <Loading />}
      {perf.error && <ErrorState error={perf.error} retry={() => perf.refetch()} />}
      {d && d.current.coverage.reportedDays === 0 && (
        <Card>
          <Empty title={`No performance data for ${VIEW_LABEL[view].toLowerCase()} yet`}>
            Occupancy, ADR and RevPAR appear here once daily performance reports are imported
            {properties.length === 1 ? ` for ${properties[0]!.name}` : ''}. Try a longer period, or bring in a report.
            {canAny('ingestion.view') && (
              <span className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                <Link className="btn btn-primary" to="/imports">Import data</Link>
                <button className="btn" onClick={() => setView('ytd')}>Show year to date</button>
              </span>
            )}
          </Empty>
        </Card>
      )}
      {d && d.current.coverage.reportedDays > 0 && (
        <div className={`stack ${perf.isFetching ? 'refetching' : ''}`}>
          {d.current.partial && (
            <Notice tone="warn">
              Incomplete data: {d.current.coverage.reportedDays} of {Math.max(d.current.coverage.expectedDays, d.current.coverage.reportedDays)} property-days reported
              {d.current.propertiesWithoutData.length > 0 && ` (no data: ${d.current.propertiesWithoutData.map((id) => properties.find((p) => p.id === id)?.code).join(', ')})`}. Totals cover reported days only; ratios are not
              extrapolated.
            </Notice>
          )}
          {d.priorRange.containsLeapDay && <Notice tone="info">This comparison spans 29 February; prior-year totals cover one day fewer/more. Ratios remain comparable.</Notice>}
          {(() => {
            // Ratio comparisons are only like-for-like when every expected hotel-day is in.
            const ratioNote = d.current.partial ? (scope.length === 1 ? 'Comparisons hidden — this property hasn’t reported every day' : 'Comparisons hidden — not all hotels reported') : undefined;
            const totalNote = d.current.partial ? 'Comparisons hidden — incomplete period' : undefined;
            const bud = (v: number | null | undefined) => (!showBudget ? undefined : v ?? null);
            return (
              <div className="grid grid-kpi">
                <KpiCard label="Occupancy" value={d.current.kpis.occupancyPct} kind="pct" priorYear={d.prior.kpis.occupancyPct} budget={bud(d.budget?.occupancyPct)} partial={d.current.partial} comparisonNote={ratioNote} hint="Rooms sold ÷ available room nights" />
                <KpiCard label="ADR" value={d.current.kpis.adr} kind="money_cents" currency={currency} priorYear={d.prior.kpis.adr} budget={bud(d.budget?.adr)} partial={d.current.partial} comparisonNote={ratioNote} hint="Room revenue ÷ rooms sold" />
                <KpiCard label="RevPAR" value={d.current.kpis.revpar} kind="money_cents" currency={currency} priorYear={d.prior.kpis.revpar} budget={bud(d.budget?.revpar)} partial={d.current.partial} comparisonNote={ratioNote} hint="Room revenue ÷ available room nights" />
                <KpiCard label="Room revenue" value={d.current.kpis.roomRevenue} kind="money" currency={currency} priorYear={d.prior.kpis.roomRevenue} budget={bud(d.budget?.roomRevenue)} partial={d.current.partial} comparisonNote={totalNote} />
                <KpiCard label="Total revenue" value={d.current.kpis.totalRevenue} kind="money" currency={currency} priorYear={d.prior.kpis.totalRevenue} budget={bud(d.budget?.totalRevenue)} partial={d.current.partial} comparisonNote={totalNote} />
              </div>
            );
          })()}
          {!d.budget && showBudget && <p className="small muted">{scope.length === 1 ? 'Budget comparison unavailable: this property has no approved budget for this period.' : 'Budget comparison unavailable: not every property expected to report has an approved budget for this period.'}</p>}

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
                    const cur = d.current.properties.find((x) => x.propertyId === p.id);
                    if (!cur) return null;
                    const py = d.prior.properties.find((x) => x.propertyId === p.id);
                    const bud = d.budgetByProperty.get(p.id);
                    const vsPy = cur.kpis.revpar !== null && py?.kpis.revpar ? cur.kpis.revpar / py.kpis.revpar - 1 : null;
                    const vsBud = cur.kpis.revpar !== null && bud?.revpar ? cur.kpis.revpar / bud.revpar - 1 : null;
                    // Prior year and budget cover days this hotel hasn't reported yet: not comparable.
                    const rowHidden = !cur.coverage.complete ? PARTIAL_PROPERTY_NOTE : undefined;
                    return (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/properties/${p.id}`}>{p.name}</Link>
                          <div className="small muted">{p.code} · {p.city}</div>
                        </td>
                        <td className="num">{formatPercent(cur.kpis.occupancyPct)}</td>
                        <td className="num">{fmtKpi(cur.kpis.adr, 'money_cents', currency)}</td>
                        <td className="num">{fmtKpi(cur.kpis.revpar, 'money_cents', currency)}</td>
                        <DeltaCell value={vsPy} hiddenNote={rowHidden} />
                        {showBudget && <DeltaCell value={vsBud} hiddenNote={rowHidden} />}
                        <td className="num">{formatCurrency(cur.kpis.roomRevenue, currency)}</td>
                        <td><CoverageBadge coverage={cur.coverage} /></td>
                        <td>{d.freshness.get(p.id) && <FreshnessBadge f={d.freshness.get(p.id)!} />}</td>
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
                      <DeltaCell value={d.prior.kpis.revpar && d.current.kpis.revpar !== null ? d.current.kpis.revpar / d.prior.kpis.revpar - 1 : null} hiddenNote={d.current.partial ? PARTIAL_PORTFOLIO_NOTE : undefined} />
                      {showBudget && <DeltaCell value={d.budget?.revpar && d.current.kpis.revpar !== null ? d.current.kpis.revpar / d.budget.revpar - 1 : null} hiddenNote={d.current.partial ? PARTIAL_PORTFOLIO_NOTE : undefined} />}
                      <td className="num">{formatCurrency(d.current.kpis.roomRevenue, currency)}</td>
                      <td><CoverageBadge coverage={d.current.coverage} /></td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="small muted" style={{ padding: '8px 16px' }}>
              {d.current.partial && `${PARTIAL_PORTFOLIO_NOTE}. `}
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

const PARTIAL_PORTFOLIO_NOTE = 'Comparison hidden: not all selected properties have reported every day';
const PARTIAL_PROPERTY_NOTE = 'Comparison hidden: this property has not reported every day of the period';

function DeltaCell({ value, hiddenNote }: { value: number | null; hiddenNote?: string }) {
  if (hiddenNote) {
    return (
      <td className="num muted" title={hiddenNote}>
        —<span className="sr-only"> ({hiddenNote})</span>
      </td>
    );
  }
  if (value === null) return <td className="num">—</td>;
  return (
    <td className={`num ${value >= 0 ? 'delta-good' : 'delta-bad'}`}>
      <span aria-hidden>{value >= 0 ? '▲ ' : '▼ '}</span>
      {`${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`}
    </td>
  );
}
