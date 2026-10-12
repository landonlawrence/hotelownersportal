import { describe, expect, it } from 'vitest';
import { clampVisibility } from '../src/permissions';
import { MAX_AMOUNT, parseAmount } from '../src/format';
import { deviceToday, lastClosedBusinessDate } from '../src/dates';

describe('upload visibility clamp (R2-04)', () => {
  it('keeps an allowed default', () => {
    expect(clampVisibility('confidential', ['general', 'owner', 'internal', 'confidential'])).toBe('confidential');
  });
  it('never widens to owners when a narrower option exists', () => {
    // A GM uploading a loan document (category default: confidential).
    expect(clampVisibility('confidential', ['general', 'owner', 'internal'])).toBe('internal');
    expect(clampVisibility('internal', ['general', 'owner', 'confidential'])).toBe('confidential');
    expect(clampVisibility('owner', ['general', 'internal', 'confidential'])).toBe('internal');
  });
  it('falls back to the most restrictive allowed value', () => {
    expect(clampVisibility('confidential', ['general', 'owner'])).toBe('owner');
    expect(clampVisibility('internal', ['general'])).toBe('general');
    expect(clampVisibility('owner', [])).toBeUndefined();
  });
});

describe('strict amount parsing (R2-15)', () => {
  it('accepts the formats people type', () => {
    expect(parseAmount('12,500')).toBe(12500);
    expect(parseAmount('$1,000')).toBe(1000);
    expect(parseAmount('$45,000.50')).toBe(45000.5);
    expect(parseAmount('(500)')).toBe(-500);
    expect(parseAmount('-12.25')).toBe(-12.25);
    expect(parseAmount(' 1 000 ')).toBe(1000);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('1234567')).toBe(1234567);
  });
  it('rejects exponent, hex, infinity and malformed separators', () => {
    for (const bad of ['1e3', '0x10', 'Infinity', '-Infinity', 'NaN', '1,00', '12,50', '1.2.3', '1.234', 'abc', '', '  ', '--5', '(-5)', '$', '.']) {
      expect(parseAmount(bad), bad).toBeNull();
    }
  });
  it('rejects values that would overflow numeric(15,2)', () => {
    expect(parseAmount('100000000000000000000')).toBeNull();
    expect(parseAmount(String(MAX_AMOUNT))).toBeNull();
    expect(parseAmount('9,999,999,999.99')).toBe(9999999999.99);
  });
});

describe('local and business dates (R2-13)', () => {
  it('uses the device calendar, not UTC', () => {
    // 22:30 local on 12 Oct is still 12 Oct regardless of the UTC date.
    expect(deviceToday(new Date(2026, 9, 12, 22, 30))).toBe('2026-10-12');
  });
  it('uses the hotel time zone and the earliest date across a portfolio', () => {
    // 2026-10-12T02:00Z: Tokyo is on 12 Oct, Seattle still on 11 Oct.
    const now = new Date('2026-10-12T02:00:00Z');
    expect(lastClosedBusinessDate(['Asia/Tokyo'], now)).toBe('2026-10-11');
    expect(lastClosedBusinessDate(['America/Los_Angeles'], now)).toBe('2026-10-10');
    expect(lastClosedBusinessDate(['Asia/Tokyo', 'America/Los_Angeles'], now)).toBe('2026-10-10');
  });
  it('ignores invalid zones and falls back to the device yesterday', () => {
    const now = new Date(2026, 9, 12, 12, 0);
    expect(lastClosedBusinessDate([], now)).toBe('2026-10-11');
    expect(lastClosedBusinessDate(['Not/AZone'], now)).toBe('2026-10-11');
  });
});
