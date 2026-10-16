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

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const at = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`);

/**
 * An import's period in the grain of its report type (R3-25): months for monthly actuals and
 * budgets ("May 2019", "Jan – Dec 2029"), days for daily performance.
 */
export function formatImportPeriod(reportType: string, start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return UNAVAILABLE;
  const to = end ?? start;
  if (reportType === 'monthly_actuals' || reportType === 'budget') {
    const y1 = start.slice(0, 4);
    const y2 = to.slice(0, 4);
    const m1 = MONTH_FMT.format(at(start));
    const m2 = MONTH_FMT.format(at(to));
    if (start.slice(0, 7) === to.slice(0, 7)) return `${m1} ${y1}`;
    return y1 === y2 ? `${m1} – ${m2} ${y1}` : `${m1} ${y1} – ${m2} ${y2}`;
  }
  return start === to ? DAY_FMT.format(at(start)) : `${DAY_FMT.format(at(start))} – ${DAY_FMT.format(at(to))}`;
}

const COMMENTARY_SECTION_LABELS: Record<string, string> = {
  executive_summary: 'Month in review',
  financial: 'Profitability',
  variance: 'Variance',
  performance: 'Performance',
  sales_marketing: 'Sales & marketing',
  operations: 'Operations',
  capex: 'CapEx',
  other: 'Other',
};

/** Heading for an owner-facing commentary item (R3-23): the account for variance comments, otherwise its title or section. */
export function commentaryHeading(c: { section: string; title?: string | null; account_name?: string | null }): string {
  if (c.section === 'variance') return c.account_name ? `Variance — ${c.account_name}` : (c.title ?? 'Variance');
  if (c.title) return c.title;
  return COMMENTARY_SECTION_LABELS[c.section] ?? c.section.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
}
