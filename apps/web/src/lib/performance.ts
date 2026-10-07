import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  budgetComponents,
  computeKpis,
  eachDay,
  eachMonth,
  freshness,
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
  priorRange: DateRange & { containsLeapDay: boolean };
  current: PortfolioResult;
  prior: PortfolioResult;
  budget: Kpis | null;
  budgetByProperty: Map<string, Kpis | null>;
  trend: Array<{ label: string; current: Kpis | null; prior: Kpis | null; budget: Kpis | null }>;
  trendGrain: 'day' | 'month';
  freshness: Map<string, Freshness>;
}

async function rollup(companyId: string, range: DateRange, grain: 'day' | 'month' | 'total', ids: string[]): Promise<RollupRow[]> {
  return unwrap(
    await supabase.rpc('performance_rollup', { p_company_id: companyId, p_from: range.from, p_to: range.to, p_grain: grain, p_property_ids: ids }),
  ) as RollupRow[];
}

export function defaultAsOf(): IsoDate {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function usePerformance(opts: { companyId: string; properties: Property[]; view: PeriodView; asOf: IsoDate; custom?: DateRange }) {
  const ids = opts.properties.map((p) => p.id).sort();
  return useQuery({
    queryKey: ['performance', opts.companyId, ids.join(','), opts.view, opts.asOf, opts.custom?.from, opts.custom?.to],
    enabled: ids.length > 0,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<PerformanceData> => {
      const range = resolvePeriod(opts.view, opts.asOf, opts.custom);
      const priorRange = priorYearRange(range);
      const infos = opts.properties.map((p) => ({ id: p.id, openedOn: p.opened_on }));
      const trendGrain: 'day' | 'month' = opts.view === 'ytd' || opts.view === 'custom' ? 'month' : 'day';
      const trendRange: DateRange =
        trendGrain === 'day'
          ? { from: monthStart(opts.asOf), to: monthEnd(opts.asOf) }
          : { from: monthStart(addDays(monthStart(opts.asOf), -334)), to: monthEnd(opts.asOf) };
      const trendPrior = priorYearRange(trendRange);

      const [cur, pri, budgetRows, trendCur, trendPri, fresh] = await Promise.all([
        rollup(opts.companyId, range, 'total', ids),
        rollup(opts.companyId, priorRange, 'total', ids),
        supabase.rpc('budget_kpi_monthly', { p_company_id: opts.companyId, p_from: trendRange.from < range.from ? trendRange.from : range.from, p_to: trendRange.to > range.to ? trendRange.to : range.to }),
        rollup(opts.companyId, trendRange, trendGrain, ids),
        rollup(opts.companyId, trendPrior, trendGrain, ids),
        supabase.rpc('performance_freshness', { p_company_id: opts.companyId }),
      ]);
      const budget = ((budgetRows.data ?? []) as BudgetKpiRow[]).filter((b) => ids.includes(b.property_id));
      const current = summarizePeriod(cur, infos, range, range.to);
      const prior = summarizePeriod(pri, infos, priorRange, priorRange.to);
      // Budget totals are only comparable when every selected property has a budget.
      const budgetedIds = new Set(budget.map((b) => b.property_id));
      const portfolioBudget = ids.every((id) => budgetedIds.has(id)) ? budgetComponents(budget, range) : null;
      const budgetByProperty = new Map(ids.map((id) => [id, budgetedIds.has(id) ? computeKpis(budgetComponents(budget, range, [id])) : null]));

      const buckets = trendGrain === 'day' ? eachDay(trendRange) : eachMonth(trendRange);
      const curSeries = portfolioSeries(trendCur, buckets, () => 0);
      const priBuckets = buckets.map((b) => (trendGrain === 'day' ? priorYearDate(b) : `${Number(b.slice(0, 4)) - 1}${b.slice(4)}`));
      const priSeries = portfolioSeries(trendPri, priBuckets, () => 0);
      const trend = buckets.map((b, i) => {
        const bucketRange = trendGrain === 'day' ? { from: b, to: b } : { from: b, to: monthEnd(b) };
        const isFuture = b > opts.asOf;
        return {
          label: trendGrain === 'day' ? String(Number(b.slice(8))) : new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${b}T12:00:00Z`)),
          current: isFuture ? null : curSeries[i]!.components ? computeKpis(curSeries[i]!.components) : null,
          prior: priSeries[i]!.components ? computeKpis(priSeries[i]!.components) : null,
          budget: ids.every((id) => budgetedIds.has(id)) ? computeKpis(budgetComponents(budget, bucketRange)) : null,
        };
      });

      const freshnessMap = new Map<string, Freshness>();
      const latest = new Map(((fresh.data ?? []) as Array<{ property_id: string; latest_business_date: string }>).map((r) => [r.property_id, r.latest_business_date]));
      for (const p of opts.properties) freshnessMap.set(p.id, freshness({ latestBusinessDate: latest.get(p.id) ?? null, timeZone: p.timezone, deadlineLocal: '11:00' }));

      return {
        range,
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
  }));
}
