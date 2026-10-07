import { describe, expect, it } from 'vitest';
import { freshness } from '../src/freshness';

describe('freshness', () => {
  const now = new Date('2026-07-10T20:00:00Z'); // 13:00 in Los Angeles
  it('is current when yesterday is loaded', () => {
    expect(freshness({ latestBusinessDate: '2026-07-09', timeZone: 'America/Los_Angeles', now }).status).toBe('current');
  });
  it('is pending before the local deadline', () => {
    const early = new Date('2026-07-10T15:00:00Z'); // 08:00 LA
    expect(freshness({ latestBusinessDate: '2026-07-08', timeZone: 'America/Los_Angeles', deadlineLocal: '11:00', now: early }).status).toBe('pending');
  });
  it('is late after the deadline and stale after several days', () => {
    expect(freshness({ latestBusinessDate: '2026-07-08', timeZone: 'America/Los_Angeles', deadlineLocal: '11:00', now }).status).toBe('late');
    const f = freshness({ latestBusinessDate: '2026-07-01', timeZone: 'America/Los_Angeles', now });
    expect(f.status).toBe('stale');
    expect(f.lagDays).toBe(8);
  });
  it('reports no data', () => {
    expect(freshness({ latestBusinessDate: null, timeZone: 'America/Denver', now }).status).toBe('no_data');
  });
});
