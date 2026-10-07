/**
 * Budget / prior-year variance.
 *
 * variance amount  = actual − comparison
 * variance percent = (actual − comparison) / |comparison|   (null when comparison is 0 or missing)
 * favourable       = revenue: actual > comparison; expense: actual < comparison.
 */
import { safeDivide, roundMoney } from './kpi.js';

export type AccountNature = 'revenue' | 'expense' | 'statistic' | 'other';

export interface Variance {
  actual: number | null;
  comparison: number | null;
  amount: number | null;
  pct: number | null;
  favourable: boolean | null;
}

export function variance(actual: number | null, comparison: number | null, nature: AccountNature): Variance {
  if (actual === null || comparison === null) {
    return { actual, comparison, amount: null, pct: null, favourable: null };
  }
  const amount = roundMoney(actual - comparison);
  const pct = safeDivide(actual - comparison, Math.abs(comparison));
  let favourable: boolean | null = null;
  if (amount !== 0) {
    if (nature === 'revenue') favourable = amount > 0;
    else if (nature === 'expense') favourable = amount < 0;
  } else if (nature === 'revenue' || nature === 'expense') {
    favourable = true;
  }
  return { actual, comparison, amount, pct, favourable };
}

/** Variance threshold check used to require commentary. */
export function exceedsThreshold(v: Variance, opts: { pct?: number; amount?: number }): boolean {
  if (v.amount === null) return false;
  const overAmount = opts.amount !== undefined && Math.abs(v.amount) >= opts.amount;
  const overPct = opts.pct !== undefined && v.pct !== null && Math.abs(v.pct) >= opts.pct;
  return overAmount || overPct;
}

export interface StatementLine {
  accountId: string;
  code: string;
  name: string;
  nature: AccountNature;
  sortOrder: number;
  parentId?: string | null;
  isSubtotal?: boolean;
}

export interface VarianceRow extends StatementLine {
  actual: number | null;
  budget: number | null;
  priorYear: number | null;
  vsBudget: Variance;
  vsPriorYear: Variance;
}

export function buildVarianceRows(
  lines: StatementLine[],
  actual: Map<string, number>,
  budget: Map<string, number>,
  priorYear: Map<string, number>,
): VarianceRow[] {
  return [...lines]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((l) => {
      const a = actual.has(l.accountId) ? actual.get(l.accountId)! : null;
      const b = budget.has(l.accountId) ? budget.get(l.accountId)! : null;
      const p = priorYear.has(l.accountId) ? priorYear.get(l.accountId)! : null;
      return { ...l, actual: a, budget: b, priorYear: p, vsBudget: variance(a, b, l.nature), vsPriorYear: variance(a, p, l.nature) };
    });
}
