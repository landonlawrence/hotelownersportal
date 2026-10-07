import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInclusive,
  eachMonth,
  isIsoDate,
  localToday,
  monthEnd,
  priorYearDate,
  priorYearRange,
  rangeContainsLeapDay,
  resolvePeriod,
  yearStart,
} from '../src/dates';

describe('dates', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
  });

  it('adds days across DST changes without drifting', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('maps leap day to Feb 28 in prior year', () => {
    expect(priorYearDate('2028-02-29')).toBe('2027-02-28');
    expect(priorYearDate('2028-03-01')).toBe('2027-03-01');
    const r = priorYearRange({ from: '2028-02-01', to: '2028-02-29' });
    expect(r).toMatchObject({ from: '2027-02-01', to: '2027-02-28', containsLeapDay: true });
    expect(rangeContainsLeapDay({ from: '2026-01-01', to: '2026-12-31' })).toBe(false);
  });

  it('resolves MTD / YTD / month periods', () => {
    expect(resolvePeriod('mtd', '2026-05-17')).toEqual({ from: '2026-05-01', to: '2026-05-17' });
    expect(resolvePeriod('ytd', '2026-05-17')).toEqual({ from: '2026-01-01', to: '2026-05-17' });
    expect(resolvePeriod('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(yearStart('2026-03-15', 7)).toBe('2025-07-01');
    expect(() => resolvePeriod('custom', '2026-01-01', { from: '2026-02-01', to: '2026-01-01' })).toThrow();
  });

  it('computes inclusive day counts and month lists', () => {
    expect(daysInclusive('2026-01-01', '2026-12-31')).toBe(365);
    expect(daysInclusive('2028-01-01', '2028-12-31')).toBe(366);
    expect(monthEnd('2026-04-10')).toBe('2026-04-30');
    expect(eachMonth({ from: '2026-01-15', to: '2026-03-02' })).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('derives property-local business dates from timezone, not UTC', () => {
    // 2026-07-01 05:30 UTC is still June 30 in Honolulu and Los Angeles.
    const now = new Date('2026-07-01T05:30:00Z');
    expect(localToday('Pacific/Honolulu', now)).toBe('2026-06-30');
    expect(localToday('America/Los_Angeles', now)).toBe('2026-06-30');
    expect(localToday('America/New_York', now)).toBe('2026-07-01');
  });
});
