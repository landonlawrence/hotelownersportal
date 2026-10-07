import { normaliseHeader, parseNumberCell } from './csv.js';
import type { Table, ValidationIssue } from './types.js';

export class RowReader {
  private readonly index: Map<string, number>;
  constructor(table: Table) {
    this.index = new Map(table.header.map((h, i) => [normaliseHeader(h), i]));
  }
  has(col: string): boolean {
    return this.index.has(col);
  }
  get(row: string[], col: string): string | undefined {
    const i = this.index.get(col);
    return i === undefined ? undefined : row[i]?.trim();
  }
  columns(): string[] {
    return [...this.index.keys()];
  }
}

export function checkColumns(reader: RowReader, required: string[], issues: ValidationIssue[]): boolean {
  const missing = required.filter((c) => !reader.has(c));
  for (const c of missing) {
    issues.push({ severity: 'error', row: null, field: c, code: 'missing_column', message: `Required column "${c}" is missing` });
  }
  return missing.length === 0;
}

export function readNumber(
  reader: RowReader,
  row: string[],
  col: string,
  rowNo: number,
  issues: ValidationIssue[],
  opts: { required?: boolean; min?: number; integer?: boolean } = {},
): number | null {
  const raw = reader.get(row, col);
  const v = parseNumberCell(raw);
  if (v === 'invalid') {
    issues.push({ severity: 'error', row: rowNo, field: col, code: 'invalid_number', message: `"${raw}" is not a valid number` });
    return null;
  }
  if (v === null) {
    if (opts.required) issues.push({ severity: 'error', row: rowNo, field: col, code: 'required', message: `${col} is required` });
    return null;
  }
  if (opts.integer && !Number.isInteger(v)) {
    issues.push({ severity: 'error', row: rowNo, field: col, code: 'not_integer', message: `${col} must be a whole number` });
    return null;
  }
  if (opts.min !== undefined && v < opts.min) {
    issues.push({ severity: 'error', row: rowNo, field: col, code: 'below_minimum', message: `${col} must be ≥ ${opts.min}` });
    return null;
  }
  return v;
}

/** Accepts YYYY-MM-DD, M/D/YYYY and MM/DD/YYYY. Returns ISO or null. */
export function parseDateCell(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Accepts YYYY-MM, YYYY-MM-01, M/YYYY. Returns first-of-month ISO date. */
export function parsePeriodCell(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})(?:-01)?$/.exec(s);
  if (m) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return `${m[1]}-${String(mo).padStart(2, '0')}-01`;
  }
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) return null;
    return `${m[2]}-${String(mo).padStart(2, '0')}-01`;
  }
  return null;
}
