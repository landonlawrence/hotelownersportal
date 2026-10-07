/**
 * Calendar helpers operating on ISO business dates (YYYY-MM-DD).
 *
 * Business dates are property-local night-audit dates. They are plain calendar
 * dates and must never be derived from UTC timestamps, so all arithmetic here is
 * done in UTC on date-only values to avoid DST/timezone drift.
 */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseIsoDate(value: IsoDate): Date {
  if (!isIsoDate(value)) throw new Error(`Invalid ISO date: ${value}`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Inclusive number of days between two ISO dates (from <= to). */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  const diff = (parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / 86_400_000;
  return diff < 0 ? 0 : Math.round(diff) + 1;
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

export function minIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: IsoDate): IsoDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${date.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

export function yearStart(date: IsoDate, fiscalYearStartMonth = 1): IsoDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const startYear = m >= fiscalYearStartMonth ? y : y - 1;
  return `${startYear}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`;
}

/**
 * Same calendar date one year earlier. 29 Feb maps to 28 Feb so prior-year
 * ranges stay inside the prior year.
 */
export function priorYearDate(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const py = y - 1;
  const day = m === 2 && d === 29 && !isLeapYear(py) ? 28 : d;
  return `${py}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export function priorYearRange(range: DateRange): DateRange & { containsLeapDay: boolean } {
  return {
    from: priorYearDate(range.from),
    to: priorYearDate(range.to),
    containsLeapDay: rangeContainsLeapDay(range) || rangeContainsLeapDay({
      from: priorYearDate(range.from),
      to: priorYearDate(range.to),
    }),
  };
}

export function rangeContainsLeapDay(range: DateRange): boolean {
  const startYear = Number(range.from.slice(0, 4));
  const endYear = Number(range.to.slice(0, 4));
  for (let y = startYear; y <= endYear; y++) {
    if (!isLeapYear(y)) continue;
    const leap = `${y}-02-29`;
    if (leap >= range.from && leap <= range.to) return true;
  }
  return false;
}

export function eachDay(range: DateRange): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Months (YYYY-MM-01) overlapping the range. */
export function eachMonth(range: DateRange): IsoDate[] {
  const out: IsoDate[] = [];
  let cur = monthStart(range.from);
  while (cur <= range.to) {
    out.push(cur);
    cur = addDays(monthEnd(cur), 1);
  }
  return out;
}

/** Today's calendar date in an IANA timezone. */
export function localToday(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export type PeriodView = 'day' | 'mtd' | 'ytd' | 'month' | 'custom';

/** Resolve a dashboard view to a concrete date range ending at `asOf`. */
export function resolvePeriod(view: PeriodView, asOf: IsoDate, custom?: DateRange, fiscalYearStartMonth = 1): DateRange {
  switch (view) {
    case 'day':
      return { from: asOf, to: asOf };
    case 'mtd':
      return { from: monthStart(asOf), to: asOf };
    case 'ytd':
      return { from: yearStart(asOf, fiscalYearStartMonth), to: asOf };
    case 'month':
      return { from: monthStart(asOf), to: monthEnd(asOf) };
    case 'custom':
      if (!custom || custom.from > custom.to) throw new Error('A valid custom range is required');
      return custom;
  }
}
