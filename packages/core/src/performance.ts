/**
 * Shared shaping of performance roll-ups (from the `performance_rollup` RPC)
 * into KPI results. Used by the web app, CSV exports and reporting packages so
 * every surface computes identical numbers.
 */
import { addDays, daysInclusive, minIsoDate, monthEnd, priorYearDate, resolvePeriod, type DateRange, type IsoDate, type PeriodView } from './dates.js';
import { expectedDaysForProperty, portfolioRollup, type KpiComponents, type PortfolioResult, type PropertyPeriodSums } from './kpi.js';

export interface RollupRow {
  property_id: string;
  bucket: string;
  available_room_nights: number | string;
  rooms_sold: number | string;
  room_revenue: number | string;
  total_revenue: number | string | null;
  total_revenue_days: number;
  reported_days: number;
}

export interface PropertyInfo {
  id: string;
  openedOn?: IsoDate | null;
  /** Onboarding/archived properties are not expected to report; they only count when they do. */
  status?: string | null;
}

const NOT_EXPECTED = new Set(['onboarding', 'archived']);

const n = (v: number | string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

export function rowToComponents(r: RollupRow): KpiComponents & { reportedDays: number } {
  return {
    availableRoomNights: n(r.available_room_nights),
    roomsSold: n(r.rooms_sold),
    roomRevenue: n(r.room_revenue),
    // Total revenue is only meaningful if every reported day carried it.
    totalRevenue: r.total_revenue_days === r.reported_days ? n(r.total_revenue) : null,
    reportedDays: r.reported_days,
  };
}

/** Portfolio summary for a period (rows at grain 'total'). Properties with no rows count as missing. */
export function summarizePeriod(rows: RollupRow[], properties: PropertyInfo[], range: DateRange, asOf: IsoDate): PortfolioResult {
  const byProp = new Map(rows.map((r) => [r.property_id, r]));
  const sums: PropertyPeriodSums[] = properties.map((p) => {
    const r = byProp.get(p.id);
    const expectedDays = NOT_EXPECTED.has(p.status ?? '')
      ? (r?.reported_days ?? 0)
      : expectedDaysForProperty(range, { openedOn: p.openedOn ?? null, asOf });
    if (!r) {
      return { propertyId: p.id, availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0, reportedDays: 0, expectedDays };
    }
    const c = rowToComponents(r);
    return { propertyId: p.id, ...c, expectedDays };
  });
  return portfolioRollup(sums);
}

export interface SeriesPoint {
  bucket: string;
  components: KpiComponents | null;
  reportedDays: number;
  expectedDays: number;
  /** Fewer property-days reported than expected (not all hotels reported). */
  partial: boolean;
}

/**
 * The part of `range` that has elapsed by `asOf` (inclusive). Used so an
 * in-progress period is compared like-for-like with the same elapsed days of
 * the prior year and budget. `inProgress` is true when the range was cut short.
 */
export function comparableRange(range: DateRange, asOf: IsoDate): DateRange & { inProgress: boolean } {
  const to = minIsoDate(range.to, asOf);
  if (to < range.from) return { from: range.from, to: addDays(range.from, -1), inProgress: true };
  return { from: range.from, to, inProgress: to < range.to };
}

/**
 * The range a period view asks for and its like-for-like (comparable) part (R3-03).
 * `lastReportable` is the latest business date that can have been reported. A month view
 * always covers the whole month, whatever day was picked: it is cut only at `lastReportable`,
 * so a closed month is compared in full and the current month over its elapsed days.
 */
export function periodWindows(view: PeriodView, asOf: IsoDate, lastReportable: IsoDate, custom?: DateRange) {
  const range = resolvePeriod(view, asOf, custom);
  const cutoff = view === 'month' ? lastReportable : minIsoDate(asOf, lastReportable);
  return { range, comparable: comparableRange(range, cutoff) };
}

/**
 * Properties expected to report in `range` up to `asOf` (R3-12): operating (not onboarding or
 * archived) and open for at least one day of it.
 */
export function expectedPropertyIds(properties: PropertyInfo[], range: DateRange, asOf: IsoDate): string[] {
  return properties
    .filter((p) => !NOT_EXPECTED.has(p.status ?? '') && expectedDaysForProperty(range, { openedOn: p.openedOn ?? null, asOf }) > 0)
    .map((p) => p.id);
}

/**
 * Portfolio budget for a range: only comparable when every property expected to report has a
 * budget, and summed over exactly those properties (R3-12).
 */
export function portfolioBudgetComponents(rows: BudgetKpiRow[], range: DateRange, expectedIds: string[]): KpiComponents | null {
  if (expectedIds.length === 0) return null;
  const budgeted = new Set(rows.map((r) => r.property_id));
  if (!expectedIds.every((id) => budgeted.has(id))) return null;
  return budgetComponents(rows, range, expectedIds);
}

/**
 * The like-for-like window of one trend bucket (R3-13). A month bucket that is in progress is cut
 * to its elapsed days, so prior year and budget cover the same days as the actuals. Day buckets and
 * months that have not started are returned whole.
 */
export function trendBucketWindow(bucket: IsoDate, grain: 'day' | 'month', lastReportable: IsoDate): DateRange & { inProgress: boolean } {
  const full: DateRange = grain === 'day' ? { from: bucket, to: bucket } : { from: bucket, to: monthEnd(bucket) };
  if (grain === 'day') return { ...full, inProgress: false };
  const c = comparableRange(full, lastReportable);
  return c.to < c.from ? { ...full, inProgress: false } : c;
}

/** The same window one year earlier (29 Feb maps to 28 Feb). */
export function priorYearWindow(range: DateRange): DateRange {
  return { from: priorYearDate(range.from), to: priorYearDate(range.to) };
}

/** Property-days expected in a bucket (operating properties only, never beyond `asOf`). */
export function expectedDaysInRange(properties: PropertyInfo[], range: DateRange, asOf: IsoDate): number {
  return properties.reduce(
    (acc, p) => acc + (NOT_EXPECTED.has(p.status ?? '') ? 0 : expectedDaysForProperty(range, { openedOn: p.openedOn ?? null, asOf })),
    0,
  );
}

/** Combine per-property bucket rows into a portfolio time series (summed components per bucket). */
export function portfolioSeries(rows: RollupRow[], buckets: string[], expectedDaysPerBucket: (bucket: string) => number): SeriesPoint[] {
  const grouped = new Map<string, RollupRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.bucket) ?? [];
    list.push(r);
    grouped.set(r.bucket, list);
  }
  return buckets.map((b) => {
    const list = grouped.get(b) ?? [];
    const expected = expectedDaysPerBucket(b);
    if (list.length === 0) return { bucket: b, components: null, reportedDays: 0, expectedDays: expected, partial: expected > 0 };
    let totalMissing = false;
    const c = list.reduce<KpiComponents>(
      (acc, r) => {
        const x = rowToComponents(r);
        if (x.totalRevenue === null) totalMissing = true;
        return {
          availableRoomNights: acc.availableRoomNights + x.availableRoomNights,
          roomsSold: acc.roomsSold + x.roomsSold,
          roomRevenue: acc.roomRevenue + x.roomRevenue,
          totalRevenue: (acc.totalRevenue ?? 0) + (x.totalRevenue ?? 0),
        };
      },
      { availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0 },
    );
    const reported = list.reduce((a, r) => a + r.reported_days, 0);
    return {
      bucket: b,
      components: totalMissing ? { ...c, totalRevenue: null } : c,
      reportedDays: reported,
      expectedDays: expected,
      partial: reported < expected,
    };
  });
}

/** Budget components for a range from monthly budget KPI rows, prorated for partial months. */
export interface BudgetKpiRow {
  property_id: string;
  period_month: string;
  kpi_role: string;
  amount: number | string;
}

export function budgetComponents(rows: BudgetKpiRow[], range: DateRange, propertyIds?: string[]): KpiComponents | null {
  const filtered = rows.filter((r) => !propertyIds || propertyIds.includes(r.property_id));
  if (filtered.length === 0) return null;
  const acc = { availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0 };
  let any = false;
  for (const r of filtered) {
    const monthStartDate = r.period_month.slice(0, 10);
    const [y, m] = monthStartDate.split('-').map(Number) as [number, number];
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEndDate = `${monthStartDate.slice(0, 8)}${String(dim).padStart(2, '0')}`;
    const from = range.from > monthStartDate ? range.from : monthStartDate;
    const to = range.to < monthEndDate ? range.to : monthEndDate;
    if (from > to) continue;
    const f = daysInclusive(from, to) / dim;
    const amt = Number(r.amount) * f;
    any = true;
    if (r.kpi_role === 'rooms_available') acc.availableRoomNights += amt;
    else if (r.kpi_role === 'rooms_sold') acc.roomsSold += amt;
    else if (r.kpi_role === 'room_revenue') acc.roomRevenue += amt;
    else if (r.kpi_role === 'total_revenue') acc.totalRevenue += amt;
  }
  if (!any) return null;
  return acc;
}
