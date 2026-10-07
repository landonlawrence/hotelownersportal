import type { IsoDate } from '../dates.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  row: number | null; // 1-based data row (header = row 0), null for file-level
  field: string | null;
  code: string;
  message: string;
}

export type ReportType = 'daily_performance' | 'monthly_actuals' | 'budget';

export interface Table {
  header: string[];
  rows: string[][];
}

export interface PropertyRef {
  id: string;
  code: string;
  openedOn?: IsoDate | null;
  timeZone: string;
  /** Room count effective on a date (from room inventory history). */
  roomsOn?: (date: IsoDate) => number | null;
}

export interface ParseContext {
  /** Property codes (as they appear in the report) → company property. Only the route's company. */
  propertyByCode: Map<string, PropertyRef>;
  /** "Today" (property-local) resolver used to reject future business dates. */
  todayFor: (p: PropertyRef) => IsoDate;
  /** Source account code → reporting account id (company mapping, property overrides first). */
  accountMapping?: (sourceCode: string, propertyId: string) => string | null;
  /** Reporting account codes → ids, for budgets keyed by reporting codes. */
  reportingAccounts?: Map<string, { id: string; code: string }>;
}

export interface ParseResult<T> {
  records: T[];
  issues: ValidationIssue[];
  /** Date coverage of the file, for revision detection. */
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  propertyIds: string[];
}

export interface ReportParser<T> {
  key: string;
  reportType: ReportType;
  label: string;
  description: string;
  /** Header names (normalised) that identify the format. */
  requiredColumns: string[];
  optionalColumns: string[];
  parse(table: Table, ctx: ParseContext): ParseResult<T>;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
