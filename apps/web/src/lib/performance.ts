import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  budgetComponents,
  comparableRange,
  computeKpis,
  eachDay,
  eachMonth,
  expectedDaysInRange,
  freshness,
  lastClosedBusinessDate,
  minIsoDate,
  monthEnd,
  monthStart,
  portfolioSeries,
  priorYearDate,
  priorYearRange,
  resolvePeriod,
  summarizePeriod,
  type BudgetKpiRow,
  type DateRange,
  type Freshness,
  type IsoDate,
  type Kpis,
  type PeriodView,
  type PortfolioResult,
  type RollupRow,
} from '@hop/core';
import { supabase, unwrap } from './supabase';
import type { Property } from '../state/portal';
import type { TrendPoint } from '../components/TrendChart';

export type TrendMetric = 'revpar' | 'occupancyPct' | 'adr' | 'roomRevenue';

export interface PerformanceData {
  range: DateRange;
  /** The elapsed part of the range used for coverage and like-for-like comparisons. */
  comparable: DateRange & { inProgress: boolean };
  priorRange: DateRange & { containsLeapDay: boolean };
  current: PortfolioResult;
  prior: PortfolioResult;
  budget: Kpis | null;
  budgetByProperty: Map<string, Kpis | null>;
  trend: Array<{ label: string; current: Kpis | null; prior: Kpis | null; budget: Kpis | null; partial: boolean; priorPartial: boolean }>;
  trendGrain: 'day' | 'month';
  freshness: Map<string, Freshness>;
}

async function rollup(companyId: string, range: DateRange, grain: 'day' | 'month' | 'total', ids: string[]): Promise<RollupRow[]> {
  return unwrap(
    await supabase.rpc('performance_rollup', { p_company_id: companyId, p_from: range.from, p_to: range.to, p_grain: grain, p_property_ids: ids }),
  ) as RollupRow[];
}

/**
 * The latest business date that can have been reported: yesterday at the hotel (for several
 * hotels, the earliest of their local yesterdays), so a viewer in Tokyo sees Seattle's business
 * date. Without properties, the viewer's own yesterday.
 */
export function defaultAsOf(properties?: ReadonlyArray<Pick<Property, 'timezone'>>): IsoDate {
  return lastClosedBusinessDate((properties ?? []).map((p) => p.timezone));
}

/** The range a view asks for and the elapsed (comparable) part of it — independent of fetched data. */
export function requestedRange(view: PeriodView, asOf: IsoDate, properties: ReadonlyArray<Pick<Property, 'timezone'>>, custom?: DateRange) {
  const range = resolvePeriod(view, asOf, custom);
  // Never expect days that cannot have been reported yet (today or later), and compare an
  // in-progress period with the same elapsed days of the prior year and budget.
  const comparable = comparableRange(range, minIsoDate(asOf, defaultAsOf(properties)));
  return { range, comparable };
}

export function usePerformance(opts: { companyId: string; properties: Property[]; view: PeriodView; asOf: IsoDate; custom?: DateRange }) {
  const ids = opts.properties.map((p) => p.id).sort();
  return useQuery({
    queryKey: ['performance', opts.companyId, ids.join(','), opts.view, opts.asOf, opts.custom?.from, opts.custom?.to],
    enabled: ids.length > 0,
    // Keep the previous render while refetching, but never across companies or property scopes.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === opts.companyId && prevQuery?.queryKey[2] === ids.join(',') ? prev : undefined),
    queryFn: async (): Promise<PerformanceData> => {
      const { range, comparable } = requestedRange(opts.view, opts.asOf, opts.properties, opts.custom);
      const priorRange = priorYearRange(comparable);
      const infos = opts.properties.map((p) => ({ id: p.id, openedOn: p.opened_on, status: p.status }));
      const trendGrain: 'day' | 'month' = opts.view === 'ytd' || opts.view === 'custom' ? 'month' : 'day';
      const trendRange: DateRange =
        trendGrain === 'day'
          ? { from: monthStart(opts.asOf), to: monthEnd(opts.asOf) }
          : { from: monthStart(addDays(monthStart(opts.asOf), -334)), to: monthEnd(opts.asOf) };
      const trendPrior = priorYearRange(trendRange);

      const [cur, pri, budgetRows, trendCur, trendPri, fresh, cfg] = await Promise.all([
        rollup(opts.companyId, range, 'total', ids),
        rollup(opts.companyId, priorRange, 'total', ids),
        supabase.rpc('budget_kpi_monthly', { p_company_id: opts.companyId, p_from: trendRange.from < range.from ? trendRange.from : range.from, p_to: trendRange.to > range.to ? trendRange.to : range.to }),
        rollup(opts.companyId, trendRange, trendGrain, ids),
        rollup(opts.companyId, trendPrior, trendGrain, ids),
        supabase.rpc('performance_freshness', { p_company_id: opts.companyId }),
        supabase.from('property_reporting_config').select('property_id, daily_report_deadline_local').in('property_id', ids),
      ]);
      const budget = ((budgetRows.data ?? []) as BudgetKpiRow[]).filter((b) => ids.includes(b.property_id));
      const current = summarizePeriod(cur, infos, range, comparable.to);
      const prior = summarizePeriod(pri, infos, priorRange, priorRange.to);
      // Budget totals are only comparable when every selected property has a budget.
      const budgetedIds = new Set(budget.map((b) => b.property_id));
      const portfolioBudget = ids.every((id) => budgetedIds.has(id)) ? budgetComponents(budget, comparable) : null;
      const budgetByProperty = new Map(ids.map((id) => [id, budgetedIds.has(id) ? computeKpis(budgetComponents(budget, comparable, [id])) : null]));

      const buckets = trendGrain === 'day' ? eachDay(trendRange) : eachMonth(trendRange);
      const bucketRange = (b: string): DateRange => (trendGrain === 'day' ? { from: b, to: b } : { from: b, to: monthEnd(b) });
      const lastReportable = defaultAsOf(opts.properties);
      const curSeries = portfolioSeries(trendCur, buckets, (b) => expectedDaysInRange(infos, bucketRange(b), lastReportable));
      const priBuckets = buckets.map((b) => (trendGrain === 'day' ? priorYearDate(b) : `${Number(b.slice(0, 4)) - 1}${b.slice(4)}`));
      const priSeries = portfolioSeries(trendPri, priBuckets, (b) => expectedDaysInRange(infos, bucketRange(b), lastReportable));
      const trend = buckets.map((b, i) => {
        const isFuture = b > opts.asOf;
        return {
          label: trendGrain === 'day' ? String(Number(b.slice(8))) : new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${b}T12:00:00Z`)),
          current: isFuture ? null : curSeries[i]!.components ? computeKpis(curSeries[i]!.components) : null,
          prior: priSeries[i]!.components ? computeKpis(priSeries[i]!.components) : null,
          budget: ids.every((id) => budgetedIds.has(id)) ? computeKpis(budgetComponents(budget, bucketRange(b))) : null,
          partial: !isFuture && curSeries[i]!.components !== null && curSeries[i]!.partial,
          priorPartial: priSeries[i]!.components !== null && priSeries[i]!.partial,
        };
      });

      const freshnessMap = new Map<string, Freshness>();
      const latest = new Map(((fresh.data ?? []) as Array<{ property_id: string; latest_business_date: string }>).map((r) => [r.property_id, r.latest_business_date]));
      const deadlines = new Map(((cfg.data ?? []) as Array<{ property_id: string; daily_report_deadline_local: string | null }>).map((c) => [c.property_id, c.daily_report_deadline_local?.slice(0, 5)]));
      for (const p of opts.properties) {
        freshnessMap.set(p.id, freshness({ latestBusinessDate: latest.get(p.id) ?? null, timeZone: p.timezone, deadlineLocal: deadlines.get(p.id) || '11:00' }));
      }

      return {
        range,
        comparable,
        priorRange,
        current,
        prior,
        budget: portfolioBudget ? computeKpis(portfolioBudget) : null,
        budgetByProperty,
        trend,
        trendGrain,
        freshness: freshnessMap,
      };
    },
  });
}

export function toTrendPoints(d: PerformanceData, metric: TrendMetric): TrendPoint[] {
  return d.trend.map((t) => ({
    label: t.label,
    actual: t.current?.[metric] ?? null,
    priorYear: t.prior?.[metric] ?? null,
    budget: t.budget?.[metric] ?? null,
    partial: t.partial,
  }));
}
