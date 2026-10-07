/**
 * Standardized budget format ("hop.budget.v1"), wide layout:
 *   property_code, fiscal_year, account_code, jan, feb, …, dec
 * account_code may be a reporting account code or a mapped source account code.
 * Statistical accounts (e.g. ROOMS_AVAILABLE, ROOMS_SOLD) carry operating budgets.
 */
import { checkColumns, readNumber, RowReader } from './common.js';
import type { ParseContext, ParseResult, ReportParser, Table, ValidationIssue } from './types.js';

export interface BudgetImportRecord {
  propertyId: string;
  fiscalYear: number;
  accountId: string;
  accountCode: string;
  periodMonth: string;
  amount: number;
  sourceRow: number;
}

export const MONTH_COLUMNS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const REQUIRED = ['property_code', 'fiscal_year', 'account_code', ...MONTH_COLUMNS];

export function parseBudget(table: Table, ctx: ParseContext): ParseResult<BudgetImportRecord> {
  const issues: ValidationIssue[] = [];
  const reader = new RowReader(table);
  const records: BudgetImportRecord[] = [];
  if (!checkColumns(reader, REQUIRED, issues)) return { records, issues, periodStart: null, periodEnd: null, propertyIds: [] };
  if (table.rows.length === 0) issues.push({ severity: 'error', row: null, field: null, code: 'empty_file', message: 'The file contains no data rows' });
  const seen = new Map<string, number>();
  const years = new Set<number>();

  table.rows.forEach((row, i) => {
    const rowNo = i + 1;
    const code = reader.get(row, 'property_code') ?? '';
    const property = ctx.propertyByCode.get(code) ?? ctx.propertyByCode.get(code.toUpperCase());
    if (!property) {
      issues.push({ severity: 'error', row: rowNo, field: 'property_code', code: 'unmapped_property', message: `Property code "${code}" is not a property of this company` });
      return;
    }
    const fy = readNumber(reader, row, 'fiscal_year', rowNo, issues, { required: true, integer: true });
    if (fy === null) return;
    if (fy < 2000 || fy > 2100) {
      issues.push({ severity: 'error', row: rowNo, field: 'fiscal_year', code: 'invalid_year', message: `Fiscal year ${fy} is out of range` });
      return;
    }
    years.add(fy);
    const acct = reader.get(row, 'account_code') ?? '';
    const accountId =
      ctx.reportingAccounts?.get(acct)?.id ?? ctx.reportingAccounts?.get(acct.toUpperCase())?.id ?? ctx.accountMapping?.(acct, property.id) ?? null;
    if (!accountId) {
      issues.push({ severity: 'error', row: rowNo, field: 'account_code', code: 'unmapped_account', message: `Account "${acct}" is not a reporting account or mapped source account` });
      return;
    }
    const key = `${property.id}|${fy}|${accountId}`;
    if (seen.has(key)) {
      issues.push({ severity: 'error', row: rowNo, field: 'account_code', code: 'duplicate_row', message: `Duplicate budget row for account ${acct} (also row ${seen.get(key)})` });
      return;
    }
    seen.set(key, rowNo);
    MONTH_COLUMNS.forEach((m, idx) => {
      const amount = readNumber(reader, row, m, rowNo, issues, { required: true });
      if (amount === null) return;
      records.push({
        propertyId: property.id,
        fiscalYear: fy,
        accountId,
        accountCode: acct,
        periodMonth: `${fy}-${String(idx + 1).padStart(2, '0')}-01`,
        amount,
        sourceRow: rowNo,
      });
    });
  });
  if (years.size > 1) {
    issues.push({ severity: 'error', row: null, field: 'fiscal_year', code: 'multiple_years', message: 'A budget file must contain a single fiscal year' });
  }
  const periods = records.map((r) => r.periodMonth).sort();
  return {
    records,
    issues,
    periodStart: periods[0] ?? null,
    periodEnd: periods[periods.length - 1] ?? null,
    propertyIds: [...new Set(records.map((r) => r.propertyId))],
  };
}

export const budgetParser: ReportParser<BudgetImportRecord> = {
  key: 'hop.budget.v1',
  reportType: 'budget',
  label: 'Standard annual budget by month (CSV/XLSX)',
  description: 'One row per property and account, with twelve month columns.',
  requiredColumns: REQUIRED,
  optionalColumns: [],
  parse: parseBudget,
};
