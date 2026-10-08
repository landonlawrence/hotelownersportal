/**
 * Shared shaping of performance roll-ups (from the `performance_rollup` RPC)
 * into KPI results. Used by the web app, CSV exports and reporting packages so
 * every surface computes identical numbers.
 */
import { daysInclusive, type DateRange, type IsoDate } from './dates.js';
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
    if (list.length === 0) return { bucket: b, components: null, reportedDays: 0, expectedDays: expectedDaysPerBucket(b) };
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
    return {
      bucket: b,
      components: totalMissing ? { ...c, totalRevenue: null } : c,
      reportedDays: list.reduce((a, r) => a + r.reported_days, 0),
      expectedDays: expectedDaysPerBucket(b),
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
