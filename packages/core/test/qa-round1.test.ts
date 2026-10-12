import { describe, expect, it } from 'vitest';
import { portfolioRollup } from '../src/kpi';
import { buildStatement, sub, type Account } from '../src/statement';
import { comparableRange, expectedDaysInRange, portfolioSeries, summarizePeriod, type RollupRow } from '../src/performance';
import { tablePropertyScope } from '../src/ingestion/common';
import { parseDailyPerformance } from '../src/ingestion/dailyPerformance';
import { isInternalOnlyPermission } from '../src/permissions';

describe('incomplete-data notice (R1-43)', () => {
  it('does not list onboarding properties that are not expected to report', () => {
    const r = portfolioRollup([
      { propertyId: 'active', availableRoomNights: 100, roomsSold: 80, roomRevenue: 8000, totalRevenue: 9000, reportedDays: 1, expectedDays: 1 },
      { propertyId: 'onboarding', availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0, reportedDays: 0, expectedDays: 0 },
      { propertyId: 'silent', availableRoomNights: 0, roomsSold: 0, roomRevenue: 0, totalRevenue: 0, reportedDays: 0, expectedDays: 1 },
    ]);
    expect(r.propertiesWithoutData).toEqual(['silent']);
  });
});

describe('statement subtotals (R1-44)', () => {
  const accounts: Account[] = [
    { id: 'rev', code: 'REV', name: 'Rooms revenue', nature: 'revenue', section: 'Revenue', sort_order: 1 },
    { id: 'dept', code: 'DEPT', name: 'Rooms expense', nature: 'expense', section: 'Departmental expenses', sort_order: 2 },
    { id: 'und', code: 'UND', name: 'A&G', nature: 'expense', section: 'Undistributed expenses', sort_order: 3 },
  ];
  it('treats an empty section as zero unless both sides are empty', () => {
    expect(sub(null, null)).toBeNull();
    expect(sub(100, null)).toBe(100);
    expect(sub(null, 40)).toBe(-40);
    const { rows } = buildStatement(accounts, new Map([['rev', 1000], ['und', 100]]), new Map(), new Map());
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by('dept-profit').actual).toBe(1000);
    expect(by('gop').actual).toBe(900);
    expect(by('noi').actual).toBe(900);
    expect(by('noi').budget).toBeNull();
  });
});

describe('like-for-like periods (R1-20, R1-21)', () => {
  it('cuts an in-progress month to the elapsed days', () => {
    expect(comparableRange({ from: '2026-10-01', to: '2026-10-31' }, '2026-10-11')).toEqual({ from: '2026-10-01', to: '2026-10-11', inProgress: true });
    expect(comparableRange({ from: '2026-09-01', to: '2026-09-30' }, '2026-10-11')).toEqual({ from: '2026-09-01', to: '2026-09-30', inProgress: false });
  });
  it('a month view does not expect future days', () => {
    const range = { from: '2026-10-01', to: '2026-10-31' };
    const row: RollupRow = { property_id: 'a', bucket: range.from, available_room_nights: 1100, rooms_sold: 800, room_revenue: 80000, total_revenue: 90000, total_revenue_days: 11, reported_days: 11 };
    const s = summarizePeriod([row], [{ id: 'a', status: 'active' }], range, comparableRange(range, '2026-10-11').to);
    expect(s.coverage.expectedDays).toBe(11);
    expect(s.partial).toBe(false);
  });
  it('trend points are flagged partial when not every operating hotel reported', () => {
    const props = [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c', status: 'onboarding' }];
    const rows: RollupRow[] = [
      { property_id: 'a', bucket: '2026-10-01', available_room_nights: 100, rooms_sold: 80, room_revenue: 8000, total_revenue: 9000, total_revenue_days: 1, reported_days: 1 },
      { property_id: 'b', bucket: '2026-10-01', available_room_nights: 100, rooms_sold: 70, room_revenue: 7000, total_revenue: 8000, total_revenue_days: 1, reported_days: 1 },
      { property_id: 'a', bucket: '2026-10-02', available_room_nights: 100, rooms_sold: 80, room_revenue: 8000, total_revenue: 9000, total_revenue_days: 1, reported_days: 1 },
    ];
    const series = portfolioSeries(rows, ['2026-10-01', '2026-10-02'], (b) => expectedDaysInRange(props, { from: b, to: b }, '2026-10-11'));
    expect(series.map((p) => p.partial)).toEqual([false, true]);
    expect(series.map((p) => p.expectedDays)).toEqual([2, 2]);
  });
});

describe('import scope (R1-03)', () => {
  const sea = { id: 'p-sea', code: 'HV-SEA', timeZone: 'UTC' };
  const pdx = { id: 'p-pdx', code: 'HV-PDX', timeZone: 'UTC' };
  const map = new Map([['HV-SEA', sea], ['HV-PDX', pdx]]);
  it('covers properties on invalid rows and flags unknown codes', () => {
    const table = { header: ['property_code', 'business_date', 'rooms_sold', 'room_revenue'], rows: [['HV-SEA', '2026-01-01', '1', '1'], ['hv-pdx', 'bad', 'x', '1'], ['ZZZ', '2026-01-01', '1', '1']] };
    expect(tablePropertyScope(table, map)).toEqual({ propertyIds: ['p-sea', 'p-pdx'], unresolved: true });
    expect(tablePropertyScope({ header: table.header, rows: [table.rows[0]!] }, map)).toEqual({ propertyIds: ['p-sea'], unresolved: false });
  });
  it('only mentions the source when codes resolve through source mappings', () => {
    const table = { header: ['property_code', 'business_date', 'rooms_sold', 'room_revenue'], rows: [['ZZZ', '2026-01-01', '1', '1']] };
    const manual = parseDailyPerformance(table, { propertyByCode: map, todayFor: () => '2026-10-01' });
    expect(manual.issues[0]!.message).not.toMatch(/for this source/);
    const routed = parseDailyPerformance(table, { propertyByCode: map, todayFor: () => '2026-10-01', routed: true });
    expect(routed.issues[0]!.message).toMatch(/for this source/);
  });
});

describe('owner/investor permission ceiling (R1-11)', () => {
  it('marks admin, audit and internal-only permissions', () => {
    expect(isInternalOnlyPermission('admin.users')).toBe(true);
    expect(isInternalOnlyPermission('audit.view')).toBe(true);
    expect(isInternalOnlyPermission('financials.view_draft')).toBe(true);
    expect(isInternalOnlyPermission('capex.approve')).toBe(false);
    expect(isInternalOnlyPermission('documents.view_owner')).toBe(false);
  });
});
