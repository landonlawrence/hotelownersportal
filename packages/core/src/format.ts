/** Consistent number formatting. `null`/`undefined` always renders as an em dash (unavailable). */
export const UNAVAILABLE = '—';

export function formatCurrency(v: number | null | undefined, currency = 'USD', opts: { compact?: boolean; cents?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: opts.compact ? 'compact' : 'standard',
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.compact ? 2 : opts.cents ? 2 : 0,
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

/** Largest amount accepted from a person (below numeric(15,2) overflow). */
export const MAX_AMOUNT = 1e13;

/**
 * Parse an amount typed by a person: accepts "1,000", "$45,000.50", "-12", ".5" and "(12)".
 * Rejects exponent/hex/Infinity forms, misplaced thousands separators ("1,00"), more than
 * two decimals and values of 10 trillion or more. Returns null if it isn't a valid amount.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    if (neg) return null;
    neg = true;
    s = s.slice(1);
  }
  if (s.startsWith('$')) s = s.slice(1);
  if (s.includes(',') && !/^\d{1,3}(,\d{3})*(\.\d*)?$/.test(s)) return null;
  s = s.replace(/,/g, '');
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n >= MAX_AMOUNT) return null;
  return neg && n !== 0 ? -n : n;
}
