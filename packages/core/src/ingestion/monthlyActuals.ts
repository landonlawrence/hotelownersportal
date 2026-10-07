/**
 * Standardized monthly financial actuals ("hop.monthly_actuals.v1").
 * Columns: property_code, period (YYYY-MM), account_code, account_name (optional), amount
 * Source account codes are preserved and mapped to reporting accounts through
 * the company's source-account mappings. Unmapped accounts block the import.
 */
import { checkColumns, parsePeriodCell, readNumber, RowReader } from './common.js';
import type { ParseContext, ParseResult, ReportParser, Table, ValidationIssue } from './types.js';

export interface MonthlyActualImportRecord {
  propertyId: string;
  propertyCode: string;
  periodMonth: string; // YYYY-MM-01
  sourceAccountCode: string;
  sourceAccountName: string | null;
  accountId: string;
  amount: number;
  sourceValue: string;
  sourceRow: number;
}

const REQUIRED = ['property_code', 'period', 'account_code', 'amount'];

export function parseMonthlyActuals(table: Table, ctx: ParseContext): ParseResult<MonthlyActualImportRecord> {
  const issues: ValidationIssue[] = [];
  const reader = new RowReader(table);
  const records: MonthlyActualImportRecord[] = [];
  if (!checkColumns(reader, REQUIRED, issues)) return { records, issues, periodStart: null, periodEnd: null, propertyIds: [] };
  if (!ctx.accountMapping) throw new Error('accountMapping is required for monthly actuals');
  if (table.rows.length === 0) issues.push({ severity: 'error', row: null, field: null, code: 'empty_file', message: 'The file contains no data rows' });
  const seen = new Map<string, number>();

  table.rows.forEach((row, i) => {
    const rowNo = i + 1;
    const code = reader.get(row, 'property_code') ?? '';
    const property = ctx.propertyByCode.get(code) ?? ctx.propertyByCode.get(code.toUpperCase());
    if (!property) {
      issues.push({ severity: 'error', row: rowNo, field: 'property_code', code: 'unmapped_property', message: `Property code "${code}" is not mapped to a property of this company` });
      return;
    }
    const period = parsePeriodCell(reader.get(row, 'period'));
    if (!period) {
      issues.push({ severity: 'error', row: rowNo, field: 'period', code: 'invalid_period', message: `"${reader.get(row, 'period') ?? ''}" is not a valid period (YYYY-MM)` });
      return;
    }
    if (period > ctx.todayFor(property)) {
      issues.push({ severity: 'error', row: rowNo, field: 'period', code: 'future_period', message: `Period ${period.slice(0, 7)} is in the future` });
      return;
    }
    const acct = reader.get(row, 'account_code') ?? '';
    if (!acct) {
      issues.push({ severity: 'error', row: rowNo, field: 'account_code', code: 'required', message: 'account_code is required' });
      return;
    }
    const raw = reader.get(row, 'amount') ?? '';
    const amount = readNumber(reader, row, 'amount', rowNo, issues, { required: true });
    if (amount === null) return;
    const accountId = ctx.accountMapping!(acct, property.id);
    if (!accountId) {
      issues.push({ severity: 'error', row: rowNo, field: 'account_code', code: 'unmapped_account', message: `Source account "${acct}" has no reporting-account mapping` });
      return;
    }
    const key = `${property.id}|${period}|${acct}`;
    if (seen.has(key)) {
      issues.push({ severity: 'error', row: rowNo, field: 'account_code', code: 'duplicate_row', message: `Duplicate account ${acct} for ${property.code} ${period.slice(0, 7)} (also row ${seen.get(key)})` });
      return;
    }
    seen.set(key, rowNo);
    records.push({
      propertyId: property.id,
      propertyCode: property.code,
      periodMonth: period,
      sourceAccountCode: acct,
      sourceAccountName: reader.get(row, 'account_name') || null,
      accountId,
      amount,
      sourceValue: raw,
      sourceRow: rowNo,
    });
  });
  const periods = records.map((r) => r.periodMonth).sort();
  return {
    records,
    issues,
    periodStart: periods[0] ?? null,
    periodEnd: periods[periods.length - 1] ?? null,
    propertyIds: [...new Set(records.map((r) => r.propertyId))],
  };
}

export const monthlyActualsParser: ReportParser<MonthlyActualImportRecord> = {
  key: 'hop.monthly_actuals.v1',
  reportType: 'monthly_actuals',
  label: 'Standard monthly financial actuals (CSV/XLSX)',
  description: 'One row per property, month and source account.',
  requiredColumns: REQUIRED,
  optionalColumns: ['account_name'],
  parse: parseMonthlyActuals,
};
