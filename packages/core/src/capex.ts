/**
 * CapEx rules.
 *
 * REMAINING FUNDS DEFINITION (shown in the UI):
 *   Remaining = Approved budget − Actual spend − Open commitments
 * "Unspent" (Approved − Actual) is also reported for reference.
 */
import { roundMoney } from './kpi.js';

export const REMAINING_FUNDS_DEFINITION =
  'Remaining funds = Approved budget − Actual spend − Open commitments (commitments are signed POs/contracts not yet invoiced).';

export interface CapexFunds {
  approvedBudget: number;
  actualSpend: number;
  openCommitments: number;
  remaining: number;
  unspent: number;
  overBudget: boolean;
  pctSpent: number | null;
}

export function capexFunds(approvedBudget: number | null, actualSpend: number, openCommitments: number): CapexFunds {
  const approved = approvedBudget ?? 0;
  const remaining = roundMoney(approved - actualSpend - openCommitments);
  return {
    approvedBudget: approved,
    actualSpend: roundMoney(actualSpend),
    openCommitments: roundMoney(openCommitments),
    remaining,
    unspent: roundMoney(approved - actualSpend),
    overBudget: remaining < 0,
    pctSpent: approved > 0 ? actualSpend / approved : null,
  };
}

export type ApproverType = 'corporate' | 'owner';

export interface ApprovalThreshold {
  minAmount: number;
  /** null = no upper bound */
  maxAmount: number | null;
  approverType: ApproverType;
  approvalsRequired: number;
  propertyId?: string | null;
}

/**
 * Pick the approval steps required for an amount. Property-specific thresholds
 * replace company defaults when any exist for the property.
 */
export function requiredApprovals(amount: number, thresholds: ApprovalThreshold[], propertyId?: string): ApprovalThreshold[] {
  const specific = thresholds.filter((t) => propertyId && t.propertyId === propertyId);
  const pool = specific.length > 0 ? specific : thresholds.filter((t) => !t.propertyId);
  return pool
    .filter((t) => amount >= t.minAmount && (t.maxAmount === null || amount < t.maxAmount))
    .sort((a, b) => (a.approverType === b.approverType ? 0 : a.approverType === 'corporate' ? -1 : 1));
}
