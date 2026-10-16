import { describe, expect, it } from 'vitest';
import {
  expectedPropertyIds,
  periodWindows,
  portfolioBudgetComponents,
  priorYearWindow,
  trendBucketWindow,
  type BudgetKpiRow,
  type PropertyInfo,
} from '../src/performance';
import { resolveAccountMapping } from '../src/ingestion/common';
import { parseMonthlyActuals } from '../src/ingestion/monthlyActuals';
import { unknownInventoryMessage } from '../src/ingestion/dailyPerformance';
import { commentaryHeading, formatImportPeriod } from '../src/format';

describe('month view windows (R3-03)', () => {
  it('a closed month is compared in full, whatever day was picked', () => {
    // Picked 5 Sep; the hotels have reported up to 15 Oct.
    const w = periodWindows('month', '2026-09-05', '2026-10-15');
    expect(w.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(w.comparable).toEqual({ from: '2026-09-01', to: '2026-09-30', inProgress: false });
  });
  it('the current month is cut at the last reportable day, not at the picked day', () => {
    const w = periodWindows('month', '2026-10-03', '2026-10-15');
    expect(w.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(w.comparable).toEqual({ from: '2026-10-01', to: '2026-10-15', inProgress: true });
  });
  it('month-to-date still ends at the picked day', () => {
    expect(periodWindows('mtd', '2026-09-05', '2026-10-15').comparable).toEqual({ from: '2026-09-01', to: '2026-09-05', inProgress: false });
  });
});

const budgetRow = (property_id: string, kpi_role: string, amount: number): BudgetKpiRow => ({ property_id, period_month: '2026-09-01', kpi_role, amount });

describe('portfolio budget ignores properties not expected to report (R3-12)', () => {
  const props: PropertyInfo[] = [
    { id: 'sea', status: 'active', openedOn: '2010-01-01' },
    { id: 'pdx', status: 'active', openedOn: null },
    { id: 'new', status: 'onboarding', openedOn: null },
    { id: 'old', status: 'archived', openedOn: '2001-01-01' },
    { id: 'future', status: 'active', openedOn: '2027-01-01' },
  ];
  const range = { from: '2026-09-01', to: '2026-09-30' };
  const rows = [budgetRow('sea', 'room_revenue', 3000), budgetRow('pdx', 'room_revenue', 1500)];

  it('lists only operating properties open in the range', () => {
    expect(expectedPropertyIds(props, range, range.to)).toEqual(['sea', 'pdx']);
  });
  it('shows the budget when every expected property has one, summed over those properties', () => {
    const c = portfolioBudgetComponents([...rows, budgetRow('new', 'room_revenue', 999)], range, expectedPropertyIds(props, range, range.to));
    expect(c?.roomRevenue).toBe(4500);
  });
  it('hides it when an expected property has no budget', () => {
    expect(portfolioBudgetComponents([rows[0]!], range, ['sea', 'pdx'])).toBeNull();
    expect(portfolioBudgetComponents(rows, range, [])).toBeNull();
  });
});

describe('trend buckets are like-for-like (R3-13)', () => {
  it('cuts the in-progress month to its elapsed days', () => {
    expect(trendBucketWindow('2026-10-01', 'month', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-15', inProgress: true });
    expect(trendBucketWindow('2026-09-01', 'month', '2026-10-15')).toEqual({ from: '2026-09-01', to: '2026-09-30', inProgress: false });
    // Not started yet: whole month (nothing to compare).
    expect(trendBucketWindow('2026-11-01', 'month', '2026-10-15')).toEqual({ from: '2026-11-01', to: '2026-11-30', inProgress: false });
    expect(trendBucketWindow('2026-10-20', 'day', '2026-10-15')).toEqual({ from: '2026-10-20', to: '2026-10-20', inProgress: false });
  });
  it('prorates the budget and maps the prior-year window to the same elapsed days', () => {
    const w = trendBucketWindow('2026-09-01', 'month', '2026-09-15');
    const c = portfolioBudgetComponents([budgetRow('sea', 'room_revenue', 3000)], w, ['sea']);
    expect(c?.roomRevenue).toBeCloseTo(1500);
    expect(priorYearWindow(w)).toEqual({ from: '2025-09-01', to: '2025-09-15' });
    expect(priorYearWindow({ from: '2028-02-01', to: '2028-02-29' })).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });
});

describe('monthly actuals accept reporting account codes (R3-21)', () => {
  const accounts = [
    { id: 'acc-rooms', code: 'REV_ROOMS', active: true },
    { id: 'acc-old', code: 'REV_OLD', active: false },
    { id: 'acc-fb', code: 'REV_FB', active: true },
  ];
  const mappings = [
    { property_id: null, source_account_code: '4000', account_id: 'acc-rooms' },
    { property_id: 'sea', source_account_code: 'REV_FB', account_id: 'acc-rooms' },
  ];
  it('falls back to an exact active reporting-account code; mappings take precedence', () => {
    const map = resolveAccountMapping(mappings, accounts);
    expect(map('4000', 'pdx')).toBe('acc-rooms');
    expect(map('REV_ROOMS', 'pdx')).toBe('acc-rooms');
    expect(map('REV_FB', 'pdx')).toBe('acc-fb');
    expect(map('REV_FB', 'sea')).toBe('acc-rooms');
    expect(map('REV_OLD', 'pdx')).toBeNull();
    expect(map('rev_rooms', 'pdx')).toBeNull();
  });
  it('parses a file using the company chart and names where to add mappings', () => {
    const prop = { id: 'pdx', code: 'PDX', timeZone: 'America/Los_Angeles' };
    const ctx = { propertyByCode: new Map([['PDX', prop]]), todayFor: () => '2026-10-16', accountMapping: resolveAccountMapping([], accounts) };
    const res = parseMonthlyActuals({ header: ['property_code', 'period', 'account_code', 'amount'], rows: [['PDX', '2026-09', 'REV_ROOMS', '100'], ['PDX', '2026-09', '9999', '5']] }, ctx);
    expect(res.records.map((r) => r.accountId)).toEqual(['acc-rooms']);
    expect(res.issues[0]!.message).toMatch(/Budgets & financials > Account mappings/);
  });
});

describe('unknown inventory message (R3-04)', () => {
  it('says where inventory starts and where to add earlier inventory', () => {
    expect(unknownInventoryMessage({ code: 'SEA', inventoryStart: '2026-10-01' }, '2026-09-30')).toBe(
      'No room inventory covers 2026-09-30 for SEA (inventory starts 2026-10-01); add earlier inventory under Administration > Properties > Room inventory, or include a rooms_available column',
    );
    expect(unknownInventoryMessage({ code: 'SEA', inventoryStart: null }, '2026-09-30')).toMatch(/No room inventory is configured for SEA on 2026-09-30; add inventory under Administration > Properties > Room inventory/);
  });
});

describe('import periods use the report grain (R3-25)', () => {
  it('formats months for monthly actuals and budgets, days for daily performance', () => {
    expect(formatImportPeriod('monthly_actuals', '2019-05-01', '2019-05-01')).toBe('May 2019');
    expect(formatImportPeriod('budget', '2029-01-01', '2029-12-01')).toBe('Jan – Dec 2029');
    expect(formatImportPeriod('monthly_actuals', '2025-12-01', '2026-01-01')).toBe('Dec 2025 – Jan 2026');
    expect(formatImportPeriod('daily_performance', '2026-10-01', '2026-10-15')).toBe('Oct 1, 2026 – Oct 15, 2026');
    expect(formatImportPeriod('daily_performance', null, null)).toBe('—');
  });
});

describe('commentary headings (R3-23)', () => {
  it('names the account for variance comments and maps section keys', () => {
    expect(commentaryHeading({ section: 'variance', account_name: 'Food & beverage revenue' })).toBe('Variance — Food & beverage revenue');
    expect(commentaryHeading({ section: 'variance', title: null })).toBe('Variance');
    expect(commentaryHeading({ section: 'executive_summary', title: null })).toBe('Month in review');
    expect(commentaryHeading({ section: 'financial' })).toBe('Profitability');
    expect(commentaryHeading({ section: 'other', title: 'Renovation' })).toBe('Renovation');
    expect(commentaryHeading({ section: 'guest_feedback' })).toBe('Guest feedback');
  });
});
