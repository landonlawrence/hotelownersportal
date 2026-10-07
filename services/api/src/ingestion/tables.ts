import ExcelJS from 'exceljs';
import { parseCsv, type Table } from '@hop/core';

export const IMPORT_CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export function fileKind(filename: string, contentType?: string): 'csv' | 'xlsx' | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv' || contentType === 'text/csv') return 'csv';
  if (ext === 'xlsx' || contentType === IMPORT_CONTENT_TYPES.xlsx) return 'xlsx';
  return null;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    return '';
  }
  return String(v);
}

/** Parse CSV or the first worksheet of an XLSX workbook into a header + rows table. */
export async function toTable(bytes: Uint8Array, kind: 'csv' | 'xlsx'): Promise<Table> {
  let rows: string[][];
  if (kind === 'csv') {
    rows = parseCsv(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Workbook has no worksheets');
    rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) values.push(cellText(row.getCell(c).value).trim());
      rows.push(values);
    });
  }
  const [header, ...data] = rows;
  if (!header) throw new Error('File is empty');
  return { header, rows: data.filter((r) => r.some((c) => c.trim() !== '')) };
}
