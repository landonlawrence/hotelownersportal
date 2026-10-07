/**
 * Parser registry. Only formats implemented and verified here are registered.
 * PMS-specific parsers must be added from real sample reports with fixtures and
 * tests; until then they are deliberately absent (see docs/INGESTION.md).
 */
import { budgetParser } from './budget.js';
import { dailyPerformanceParser } from './dailyPerformance.js';
import { monthlyActualsParser } from './monthlyActuals.js';
import type { ReportParser, ReportType } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PARSERS: ReportParser<any>[] = [dailyPerformanceParser, monthlyActualsParser, budgetParser];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getParser(key: string): ReportParser<any> | undefined {
  return PARSERS.find((p) => p.key === key);
}

export function listParsers(): Array<Pick<ReportParser<unknown>, 'key' | 'reportType' | 'label' | 'description' | 'requiredColumns' | 'optionalColumns'>> {
  return PARSERS.map(({ key, reportType, label, description, requiredColumns, optionalColumns }) => ({
    key,
    reportType,
    label,
    description,
    requiredColumns,
    optionalColumns,
  }));
}

export function defaultParserFor(reportType: ReportType): string {
  const p = PARSERS.find((x) => x.reportType === reportType);
  if (!p) throw new Error(`No parser for ${reportType}`);
  return p.key;
}
