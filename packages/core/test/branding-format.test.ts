import { describe, expect, it } from 'vitest';
import { contrastRatio, hostCandidates, readableTextColor, themeCssVariables } from '../src/branding';
import { formatCurrency, formatFraction, formatPercent, formatPoints, UNAVAILABLE } from '../src/format';
import { PermissionSet } from '../src/permissions';

describe('branding', () => {
  it('normalises hosts and tries host:port then host', () => {
    expect(hostCandidates('Harborview.LocalHost:5173')).toEqual(['harborview.localhost:5173', 'harborview.localhost']);
    expect(hostCandidates('owners.example.com.')).toEqual(['owners.example.com']);
  });
  it('picks readable text colours', () => {
    expect(readableTextColor('#0f3d5e')).toBe('#ffffff');
    expect(readableTextColor('#f6f5f1')).toBe('#111827');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(themeCssVariables({ portalName: 'x', primaryColor: '#0f3d5e', accentColor: '#2bb3a3', surfaceColor: '#ffffff' })['--brand-on-primary']).toBe('#ffffff');
  });
});

describe('formatting', () => {
  it('shows unavailable values as an em dash, not zero', () => {
    expect(formatCurrency(null)).toBe(UNAVAILABLE);
    expect(formatPercent(undefined)).toBe(UNAVAILABLE);
    expect(formatCurrency(0)).toBe('$0');
  });
  it('formats signed values', () => {
    expect(formatFraction(0.123, 1, true)).toBe('+12.3%');
    expect(formatPoints(-2.25)).toBe('−2.3 pts');
  });
});

describe('PermissionSet (UI gating only)', () => {
  it('evaluates per-property permissions', () => {
    const ps = new PermissionSet(['performance.view'], [{ property_id: 'a', permission_key: 'financials.view' }]);
    expect(ps.has('financials.view', 'a')).toBe(true);
    expect(ps.has('financials.view', 'b')).toBe(false);
    expect(ps.any('financials.view')).toBe(true);
    expect(ps.propertiesWith('financials.view')).toEqual(['a']);
  });
});
