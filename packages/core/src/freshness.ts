/**
 * Data freshness for daily operating data.
 *
 * A property's most recent *expected* business date is "yesterday" in the
 * property's local timezone (the night audit closes the previous business day).
 * Before the configured daily deadline, the day before yesterday is acceptable.
 */
import { addDays, daysInclusive, localToday, type IsoDate } from './dates.js';

export type FreshnessStatus = 'current' | 'pending' | 'late' | 'stale' | 'no_data';

export interface Freshness {
  status: FreshnessStatus;
  latestBusinessDate: IsoDate | null;
  expectedBusinessDate: IsoDate;
  /** Whole business days missing since the latest available date. */
  lagDays: number | null;
}

export function freshness(opts: {
  latestBusinessDate: IsoDate | null;
  timeZone: string;
  /** Local deadline "HH:MM" by which yesterday's report is expected. */
  deadlineLocal?: string;
  now?: Date;
  /** Days of lag after which data is considered stale (default 3). */
  staleAfterDays?: number;
}): Freshness {
  const now = opts.now ?? new Date();
  const today = localToday(opts.timeZone, now);
  const yesterday = addDays(today, -1);
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: opts.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const beforeDeadline = opts.deadlineLocal ? localTime < opts.deadlineLocal : false;
  const expected = yesterday;
  if (!opts.latestBusinessDate) {
    return { status: 'no_data', latestBusinessDate: null, expectedBusinessDate: expected, lagDays: null };
  }
  const latest = opts.latestBusinessDate;
  const lag = latest >= expected ? 0 : daysInclusive(latest, expected) - 1;
  let status: FreshnessStatus;
  if (lag === 0) status = 'current';
  else if (lag === 1 && beforeDeadline) status = 'pending';
  else if (lag <= (opts.staleAfterDays ?? 3)) status = 'late';
  else status = 'stale';
  return { status, latestBusinessDate: latest, expectedBusinessDate: expected, lagDays: lag };
}
