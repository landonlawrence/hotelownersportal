/** Consistent number formatting. `null`/`undefined` always renders as an em dash (unavailable). */
export const UNAVAILABLE = '—';

export function formatCurrency(v: number | null | undefined, currency = 'USD', opts: { compact?: boolean; cents?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: opts.compact ? 'compact' : 'standard',
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.compact ? 1 : opts.cents ? 2 : 0,
  }).format(v);
}

export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  return `${v.toFixed(digits)}%`;
}

/** Fraction (0.123) → "12.3%" */
export function formatFraction(v: number | null | undefined, digits = 1, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  const s = `${(v * 100).toFixed(digits)}%`;
  return signed && v > 0 ? `+${s}` : s;
}

export function formatNumber(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function formatSignedCurrency(v: number | null | undefined, currency = 'USD'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  const s = formatCurrency(Math.abs(v), currency);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function formatPoints(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)} pts`;
}
