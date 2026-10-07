import { describe, expect, it } from 'vitest';
import {
  computeKpis,
  coverage,
  expectedDaysForProperty,
  kpiDelta,
  normaliseDay,
  portfolioRollup,
  prorate,
  safeDivide,
  sumComponents,
  type DailyOperatingRecord,
} from '../src/kpi';

const day = (over: Partial<DailyOperatingRecord> = {}): DailyOperatingRecord => ({
  propertyId: 'p1',
  businessDate: '2026-05-01',
  physicalRooms: 100,
  roomsOutOfOrder: 0,
  roomsSold: 80,
  roomsComp: 0,
  roomRevenue: 12000,
  totalRevenue: 15000,
  ...over,
});

describe('KPI definitions', () => {
  it('computes occupancy, ADR and RevPAR from components', () => {
    const k = computeKpis(normaliseDay(day()));
    expect(k.occupancyPct).toBeCloseTo(80);
    expect(k.adr).toBeCloseTo(150);
    expect(k.revpar).toBeCloseTo(120);
  });

  it('excludes out-of-order rooms from available room nights by default', () => {
    const c = normaliseDay(day({ roomsOutOfOrder: 20 }));
    expect(c.availableRoomNights).toBe(80);
    expect(computeKpis(c).occupancyPct).toBeCloseTo(100);
  });

  it('can include out-of-order rooms when configured', () => {
    const c = normaliseDay(day({ roomsOutOfOrder: 20 }), { oooTreatment: 'include', compTreatment: 'exclude' });
    expect(c.availableRoomNights).toBe(100);
  });

  it('excludes complimentary rooms from rooms sold by default so they do not dilute ADR', () => {
    const k = computeKpis(normaliseDay(day({ roomsComp: 20 })));
    expect(k.roomsSold).toBe(80);
    expect(k.adr).toBeCloseTo(150);
  });

  it('includes comps when configured', () => {
    const k = computeKpis(normaliseDay(day({ roomsComp: 20 }), { oooTreatment: 'exclude', compTreatment: 'include' }));
    expect(k.roomsSold).toBe(100);
    expect(k.adr).toBeCloseTo(120);
    expect(k.occupancyPct).toBeCloseTo(100);
  });
});

describe('zero denominators and missing data', () => {
  it('returns null instead of Infinity/NaN', () => {
    expect(safeDivide(10, 0)).toBeNull();
    expect(safeDivide(null, 10)).toBeNull();
    const k = computeKpis({ availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0 });
    expect(k.occupancyPct).toBeNull();
    expect(k.adr).toBeNull();
    expect(k.revpar).toBeNull();
  });

  it('treats no records as unavailable, not zero', () => {
    const k = computeKpis(sumComponents([]));
    expect(k.roomRevenue).toBeNull();
    expect(k.occupancyPct).toBeNull();
  });

  it('marks total revenue unavailable when any contributing day lacks it', () => {
    const s = sumComponents([normaliseDay(day()), normaliseDay(day({ totalRevenue: null }))]);
    expect(s?.totalRevenue).toBeNull();
    expect(s?.roomRevenue).toBe(24000);
  });

  it('a property with zero rooms sold has null ADR but valid occupancy', () => {
    const k = computeKpis(normaliseDay(day({ roomsSold: 0, roomRevenue: 0 })));
    expect(k.adr).toBeNull();
    expect(k.occupancyPct).toBe(0);
    expect(k.revpar).toBe(0);
  });
});

describe('portfolio weighting', () => {
  it('uses summed numerators/denominators, never averages hotel ratios', () => {
    // Small hotel: 50 rooms, 100% occ, ADR 300. Large hotel: 450 rooms, 50% occ, ADR 100.
    const small = { propertyId: 's', availableRoomNights: 50, roomsSold: 50, roomRevenue: 15000, totalRevenue: 15000, reportedDays: 1, expectedDays: 1 };
    const large = { propertyId: 'l', availableRoomNights: 450, roomsSold: 225, roomRevenue: 22500, totalRevenue: 22500, reportedDays: 1, expectedDays: 1 };
    const r = portfolioRollup([small, large]);
    // Correct: 275/500 = 55%; naive average would be 75%.
    expect(r.kpis.occupancyPct).toBeCloseTo(55);
    // Correct ADR: 37500/275 = 136.36; naive average would be 200.
    expect(r.kpis.adr).toBeCloseTo(136.3636, 3);
    expect(r.kpis.revpar).toBeCloseTo(75);
    expect(r.partial).toBe(false);
  });

  it('flags partial coverage and excludes missing properties instead of zero-filling', () => {
    const a = { propertyId: 'a', availableRoomNights: 3000, roomsSold: 2400, roomRevenue: 360000, totalRevenue: 400000, reportedDays: 30, expectedDays: 30 };
    const b = { propertyId: 'b', availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0, reportedDays: 0, expectedDays: 30 };
    const c = { propertyId: 'c', availableRoomNights: 1000, roomsSold: 500, roomRevenue: 50000, totalRevenue: 50000, reportedDays: 10, expectedDays: 30 };
    const r = portfolioRollup([a, b, c]);
    expect(r.partial).toBe(true);
    expect(r.coverage.expectedDays).toBe(90);
    expect(r.coverage.reportedDays).toBe(40);
    expect(r.propertiesWithoutData).toEqual(['b']);
    expect(r.propertiesWithGaps).toEqual(['b', 'c']);
    expect(r.properties.find((p) => p.propertyId === 'b')!.kpis.occupancyPct).toBeNull();
    // Occupancy is over reported nights only: 2900/4000
    expect(r.kpis.occupancyPct).toBeCloseTo(72.5);
  });

  it('coverage handles zero expected days', () => {
    expect(coverage(0, 0)).toEqual({ expectedDays: 0, reportedDays: 0, ratio: null, complete: false });
  });
});

describe('expected days', () => {
  it('honours opening date and as-of date', () => {
    expect(expectedDaysForProperty({ from: '2026-01-01', to: '2026-01-31' }, { openedOn: '2026-01-11' })).toBe(21);
    expect(expectedDaysForProperty({ from: '2026-01-01', to: '2026-01-31' }, { asOf: '2026-01-15' })).toBe(15);
    expect(expectedDaysForProperty({ from: '2026-01-01', to: '2026-01-31' }, { openedOn: '2026-02-01' })).toBe(0);
  });

  it('counts leap days', () => {
    expect(expectedDaysForProperty({ from: '2028-02-01', to: '2028-02-29' }, {})).toBe(29);
    expect(expectedDaysForProperty({ from: '2027-02-01', to: '2027-02-28' }, {})).toBe(28);
  });
});

describe('proration and deltas', () => {
  it('prorates budgets linearly, preserving ratios', () => {
    const b = { availableRoomNights: 3000, roomsSold: 2400, roomRevenue: 360000, totalRevenue: 450000 };
    const p = prorate(b, 15, 30);
    expect(p.roomRevenue).toBe(180000);
    expect(computeKpis(p).occupancyPct).toBeCloseTo(computeKpis(b).occupancyPct!);
    expect(computeKpis(p).adr).toBeCloseTo(computeKpis(b).adr!);
  });

  it('reports occupancy change in points and money change in percent', () => {
    expect(kpiDelta(80, 75, true)).toEqual({ change: 5, changePct: null });
    expect(kpiDelta(110, 100).changePct).toBeCloseTo(0.1);
    expect(kpiDelta(null, 100)).toEqual({ change: null, changePct: null });
    expect(kpiDelta(10, 0).changePct).toBeNull();
  });
});
