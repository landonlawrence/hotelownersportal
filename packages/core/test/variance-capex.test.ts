import { describe, expect, it } from 'vitest';
import { buildVarianceRows, exceedsThreshold, variance } from '../src/variance';
import { capexFunds, requiredApprovals, type ApprovalThreshold } from '../src/capex';

describe('variance', () => {
  it('revenue above budget is favourable', () => {
    const v = variance(110000, 100000, 'revenue');
    expect(v.amount).toBe(10000);
    expect(v.pct).toBeCloseTo(0.1);
    expect(v.favourable).toBe(true);
  });
  it('expense above budget is unfavourable', () => {
    const v = variance(55000, 50000, 'expense');
    expect(v.amount).toBe(5000);
    expect(v.favourable).toBe(false);
  });
  it('handles zero and missing comparisons', () => {
    expect(variance(100, 0, 'revenue').pct).toBeNull();
    expect(variance(null, 100, 'revenue')).toMatchObject({ amount: null, pct: null, favourable: null });
    expect(variance(100, null, 'expense').amount).toBeNull();
  });
  it('uses absolute base for negative comparisons', () => {
    // Net loss budget −100, actual −50 → improved by 50%
    expect(variance(-50, -100, 'revenue').pct).toBeCloseTo(0.5);
  });
  it('threshold check', () => {
    expect(exceedsThreshold(variance(105, 100, 'revenue'), { pct: 0.1 })).toBe(false);
    expect(exceedsThreshold(variance(115, 100, 'revenue'), { pct: 0.1 })).toBe(true);
    expect(exceedsThreshold(variance(10100, 10000, 'expense'), { amount: 100 })).toBe(true);
  });
  it('builds ordered rows with budget and prior-year variances', () => {
    const rows = buildVarianceRows(
      [
        { accountId: 'b', code: '5000', name: 'Payroll', nature: 'expense', sortOrder: 2 },
        { accountId: 'a', code: '4000', name: 'Rooms', nature: 'revenue', sortOrder: 1 },
      ],
      new Map([['a', 100], ['b', 40]]),
      new Map([['a', 90]]),
      new Map([['b', 50]]),
    );
    expect(rows.map((r) => r.code)).toEqual(['4000', '5000']);
    expect(rows[0]!.vsBudget.favourable).toBe(true);
    expect(rows[1]!.budget).toBeNull();
    expect(rows[1]!.vsPriorYear.favourable).toBe(true);
  });
});

describe('capex', () => {
  it('remaining = approved − actual − open commitments', () => {
    const f = capexFunds(100000, 30000, 25000);
    expect(f.remaining).toBe(45000);
    expect(f.unspent).toBe(70000);
    expect(f.overBudget).toBe(false);
    expect(capexFunds(100000, 80000, 30000).overBudget).toBe(true);
    expect(capexFunds(null, 0, 0).pctSpent).toBeNull();
  });

  const thresholds: ApprovalThreshold[] = [
    { minAmount: 0, maxAmount: 25000, approverType: 'corporate', approvalsRequired: 1 },
    { minAmount: 25000, maxAmount: null, approverType: 'corporate', approvalsRequired: 1 },
    { minAmount: 25000, maxAmount: null, approverType: 'owner', approvalsRequired: 1 },
    { minAmount: 0, maxAmount: null, approverType: 'owner', approvalsRequired: 1, propertyId: 'special' },
  ];
  it('routes small requests to corporate only', () => {
    expect(requiredApprovals(10000, thresholds).map((t) => t.approverType)).toEqual(['corporate']);
  });
  it('routes large requests to corporate then owner', () => {
    expect(requiredApprovals(25000, thresholds).map((t) => t.approverType)).toEqual(['corporate', 'owner']);
  });
  it('property-specific thresholds replace company defaults', () => {
    expect(requiredApprovals(10000, thresholds, 'special').map((t) => t.approverType)).toEqual(['owner']);
  });
});
