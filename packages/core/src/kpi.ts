/**
 * Hotel KPI calculations.
 *
 *   Occupancy = rooms sold / available room nights × 100
 *   ADR       = room revenue / rooms sold
 *   RevPAR    = room revenue / available room nights
 *
 * Aggregates (portfolio, month, YTD) are always computed from summed numerators
 * and denominators. Hotel-level percentages or ADRs are never averaged.
 * Missing data is `null` (unavailable), never zero. Zero denominators yield null.
 */
import { daysInclusive, maxIsoDate, minIsoDate, type DateRange, type IsoDate } from './dates.js';

export type OooTreatment = 'exclude' | 'include';
export type CompTreatment = 'exclude' | 'include';

export interface ReportingConfig {
  oooTreatment: OooTreatment;
  compTreatment: CompTreatment;
}

export const DEFAULT_REPORTING_CONFIG: ReportingConfig = { oooTreatment: 'exclude', compTreatment: 'exclude' };

/** Raw, source-normalised daily operating figures for one property and business date. */
export interface DailyOperatingRecord {
  propertyId: string;
  businessDate: IsoDate;
  /** Physical rooms in inventory on the date (from the source or room inventory history). */
  physicalRooms: number;
  roomsOutOfOrder: number;
  /** Paid rooms sold (excluding complimentary). */
  roomsSold: number;
  roomsComp: number;
  roomRevenue: number;
  totalRevenue: number | null;
}

/** Normalised numerators/denominators for one record under a reporting config. */
export interface KpiComponents {
  availableRoomNights: number;
  roomsSold: number;
  roomRevenue: number;
  /** null when any contributing record lacked total revenue. */
  totalRevenue: number | null;
}

export function normaliseDay(rec: DailyOperatingRecord, cfg: ReportingConfig = DEFAULT_REPORTING_CONFIG): KpiComponents {
  const available = cfg.oooTreatment === 'exclude' ? rec.physicalRooms - rec.roomsOutOfOrder : rec.physicalRooms;
  const sold = cfg.compTreatment === 'include' ? rec.roomsSold + rec.roomsComp : rec.roomsSold;
  return {
    availableRoomNights: Math.max(0, available),
    roomsSold: sold,
    roomRevenue: rec.roomRevenue,
    totalRevenue: rec.totalRevenue,
  };
}

export function sumComponents(items: KpiComponents[]): KpiComponents | null {
  if (items.length === 0) return null;
  let totalMissing = false;
  const out = items.reduce<KpiComponents>(
    (acc, c) => {
      if (c.totalRevenue === null) totalMissing = true;
      return {
        availableRoomNights: acc.availableRoomNights + c.availableRoomNights,
        roomsSold: acc.roomsSold + c.roomsSold,
        roomRevenue: roundMoney(acc.roomRevenue + c.roomRevenue),
        totalRevenue: roundMoney((acc.totalRevenue ?? 0) + (c.totalRevenue ?? 0)),
      };
    },
    { availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0 },
  );
  return totalMissing ? { ...out, totalRevenue: null } : out;
}

export interface Kpis {
  occupancyPct: number | null;
  adr: number | null;
  revpar: number | null;
  roomRevenue: number | null;
  totalRevenue: number | null;
  roomsSold: number | null;
  availableRoomNights: number | null;
}

export const EMPTY_KPIS: Kpis = {
  occupancyPct: null,
  adr: null,
  revpar: null,
  roomRevenue: null,
  totalRevenue: null,
  roomsSold: null,
  availableRoomNights: null,
};

export function safeDivide(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  if (denominator === 0 || !Number.isFinite(denominator) || !Number.isFinite(numerator)) return null;
  return numerator / denominator;
}

export function computeKpis(c: KpiComponents | null): Kpis {
  if (!c) return EMPTY_KPIS;
  const occ = safeDivide(c.roomsSold, c.availableRoomNights);
  return {
    occupancyPct: occ === null ? null : occ * 100,
    adr: safeDivide(c.roomRevenue, c.roomsSold),
    revpar: safeDivide(c.roomRevenue, c.availableRoomNights),
    roomRevenue: c.roomRevenue,
    totalRevenue: c.totalRevenue,
    roomsSold: c.roomsSold,
    availableRoomNights: c.availableRoomNights,
  };
}

export function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Coverage of reported property-days against expected property-days. */
export interface Coverage {
  expectedDays: number;
  reportedDays: number;
  ratio: number | null;
  complete: boolean;
}

export function coverage(expectedDays: number, reportedDays: number): Coverage {
  return {
    expectedDays,
    reportedDays,
    ratio: expectedDays === 0 ? null : reportedDays / expectedDays,
    complete: expectedDays > 0 && reportedDays >= expectedDays,
  };
}

/**
 * Number of days in `range` during which a property was operating and data is
 * expected (from opening date, and never beyond `asOf`).
 */
export function expectedDaysForProperty(
  range: DateRange,
  opts: { openedOn?: IsoDate | null; closedOn?: IsoDate | null; asOf?: IsoDate },
): number {
  let from = range.from;
  let to = range.to;
  if (opts.openedOn) from = maxIsoDate(from, opts.openedOn);
  if (opts.closedOn) to = minIsoDate(to, opts.closedOn);
  if (opts.asOf) to = minIsoDate(to, opts.asOf);
  return from > to ? 0 : daysInclusive(from, to);
}

export interface PropertyPeriodSums extends KpiComponents {
  propertyId: string;
  reportedDays: number;
  expectedDays: number;
}

export interface PortfolioResult {
  kpis: Kpis;
  coverage: Coverage;
  /** True when at least one expected property-day is missing. */
  partial: boolean;
  propertiesWithGaps: string[];
  propertiesWithoutData: string[];
  properties: Array<{ propertyId: string; kpis: Kpis; coverage: Coverage }>;
}

/**
 * Portfolio roll-up from per-property sums. Ratios use summed numerators and
 * denominators. Properties with no data contribute nothing (not zeros) and are
 * reported as gaps.
 */
export function portfolioRollup(rows: PropertyPeriodSums[]): PortfolioResult {
  const withData = rows.filter((r) => r.reportedDays > 0);
  const sums = sumComponents(withData);
  const expected = rows.reduce((a, r) => a + r.expectedDays, 0);
  const reported = rows.reduce((a, r) => a + Math.min(r.reportedDays, r.expectedDays || r.reportedDays), 0);
  const cov = coverage(expected, reported);
  return {
    kpis: computeKpis(sums),
    coverage: cov,
    partial: !cov.complete,
    propertiesWithGaps: rows.filter((r) => r.reportedDays < r.expectedDays).map((r) => r.propertyId),
    propertiesWithoutData: rows.filter((r) => r.reportedDays === 0).map((r) => r.propertyId),
    properties: rows.map((r) => ({
      propertyId: r.propertyId,
      kpis: r.reportedDays > 0 ? computeKpis(r) : EMPTY_KPIS,
      coverage: coverage(r.expectedDays, r.reportedDays),
    })),
  };
}

/** Linear proration of monthly budget components to a partial month. */
export function prorate(c: KpiComponents, daysCovered: number, daysInPeriod: number): KpiComponents {
  if (daysInPeriod <= 0) return { availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0 };
  const f = Math.min(1, Math.max(0, daysCovered / daysInPeriod));
  return {
    availableRoomNights: c.availableRoomNights * f,
    roomsSold: c.roomsSold * f,
    roomRevenue: roundMoney(c.roomRevenue * f),
    totalRevenue: c.totalRevenue === null ? null : roundMoney(c.totalRevenue * f),
  };
}

export interface KpiDelta {
  /** Absolute difference (percentage points for occupancy). */
  change: number | null;
  /** Relative change (fraction) – null for occupancy points or zero base. */
  changePct: number | null;
}

export function kpiDelta(current: number | null, comparison: number | null, isPercentage = false): KpiDelta {
  if (current === null || comparison === null) return { change: null, changePct: null };
  const change = current - comparison;
  return { change, changePct: isPercentage ? null : safeDivide(change, Math.abs(comparison)) };
}
