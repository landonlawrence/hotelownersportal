/**
 * Standardized daily performance format ("hop.daily_performance.v1").
 *
 * Required columns: property_code, business_date, rooms_sold, room_revenue
 * Optional columns: rooms_available (physical rooms in inventory that day),
 *   rooms_out_of_order, rooms_comp, food_beverage_revenue, other_revenue,
 *   total_revenue, source_occupancy_pct, source_adr, source_revpar
 *
 * The source_* columns are preserved as reported (the PMS may use different
 * conventions, e.g. occupancy including comps) and never replace the portal's
 * own calculations. A warning is raised when they disagree.
 */
import { normaliseDay, DEFAULT_REPORTING_CONFIG, computeKpis } from '../kpi.js';
import { checkColumns, parseDateCell, readNumber, RowReader } from './common.js';
import type { ParseResult, ReportParser, Table, ParseContext, ValidationIssue } from './types.js';

export interface DailyPerformanceImportRecord {
  propertyId: string;
  propertyCode: string;
  businessDate: string;
  physicalRooms: number;
  roomsOutOfOrder: number;
  roomsSold: number;
  roomsComp: number;
  roomRevenue: number;
  fbRevenue: number | null;
  otherRevenue: number | null;
  totalRevenue: number | null;
  sourceMetrics: Record<string, number>;
  sourceRow: number;
}

const REQUIRED = ['property_code', 'business_date', 'rooms_sold', 'room_revenue'];
const OPTIONAL = [
  'rooms_available',
  'rooms_out_of_order',
  'rooms_comp',
  'food_beverage_revenue',
  'other_revenue',
  'total_revenue',
  'source_occupancy_pct',
  'source_adr',
  'source_revpar',
];
const RECONCILE_TOLERANCE = 1; // currency units

export function parseDailyPerformance(table: Table, ctx: ParseContext): ParseResult<DailyPerformanceImportRecord> {
  const issues: ValidationIssue[] = [];
  const reader = new RowReader(table);
  const records: DailyPerformanceImportRecord[] = [];
  if (!checkColumns(reader, REQUIRED, issues)) {
    return { records, issues, periodStart: null, periodEnd: null, propertyIds: [] };
  }
  if (table.rows.length === 0) {
    issues.push({ severity: 'error', row: null, field: null, code: 'empty_file', message: 'The file contains no data rows' });
  }
  const seen = new Map<string, number>();

  table.rows.forEach((row, i) => {
    const rowNo = i + 1;
    const before = issues.length;
    const code = reader.get(row, 'property_code') ?? '';
    const property = ctx.propertyByCode.get(code) ?? ctx.propertyByCode.get(code.toUpperCase());
    if (!code) {
      issues.push({ severity: 'error', row: rowNo, field: 'property_code', code: 'required', message: 'property_code is required' });
    } else if (!property) {
      issues.push({
        severity: 'error',
        row: rowNo,
        field: 'property_code',
        code: 'unmapped_property',
        message: `Property code "${code}" is not mapped to a property of this company for this source`,
      });
    }
    const rawDate = reader.get(row, 'business_date');
    const businessDate = parseDateCell(rawDate);
    if (!businessDate) {
      issues.push({ severity: 'error', row: rowNo, field: 'business_date', code: 'invalid_date', message: `"${rawDate ?? ''}" is not a valid date` });
    }
    const roomsSold = readNumber(reader, row, 'rooms_sold', rowNo, issues, { required: true, min: 0, integer: true });
    const roomRevenue = readNumber(reader, row, 'room_revenue', rowNo, issues, { required: true, min: 0 });
    const roomsAvail = readNumber(reader, row, 'rooms_available', rowNo, issues, { min: 0, integer: true });
    const ooo = readNumber(reader, row, 'rooms_out_of_order', rowNo, issues, { min: 0, integer: true }) ?? 0;
    const comp = readNumber(reader, row, 'rooms_comp', rowNo, issues, { min: 0, integer: true }) ?? 0;
    const fb = readNumber(reader, row, 'food_beverage_revenue', rowNo, issues, { min: 0 });
    const other = readNumber(reader, row, 'other_revenue', rowNo, issues);
    const total = readNumber(reader, row, 'total_revenue', rowNo, issues, { min: 0 });
    const srcOcc = readNumber(reader, row, 'source_occupancy_pct', rowNo, issues, { min: 0 });
    const srcAdr = readNumber(reader, row, 'source_adr', rowNo, issues, { min: 0 });
    const srcRevpar = readNumber(reader, row, 'source_revpar', rowNo, issues, { min: 0 });

    if (issues.length > before && issues.slice(before).some((x) => x.severity === 'error')) return;
    if (!property || !businessDate || roomsSold === null || roomRevenue === null) return;

    if (businessDate > ctx.todayFor(property)) {
      issues.push({ severity: 'error', row: rowNo, field: 'business_date', code: 'future_date', message: `Business date ${businessDate} is in the future for ${property.code}` });
      return;
    }
    if (property.openedOn && businessDate < property.openedOn) {
      issues.push({ severity: 'error', row: rowNo, field: 'business_date', code: 'before_opening', message: `Business date ${businessDate} is before ${property.code} opened (${property.openedOn})` });
      return;
    }
    const key = `${property.id}|${businessDate}`;
    if (seen.has(key)) {
      issues.push({ severity: 'error', row: rowNo, field: 'business_date', code: 'duplicate_row', message: `Duplicate row for ${property.code} on ${businessDate} (also row ${seen.get(key)})` });
      return;
    }
    seen.set(key, rowNo);

    const inventory = property.roomsOn?.(businessDate) ?? null;
    const physical = roomsAvail ?? inventory;
    if (physical === null) {
      issues.push({ severity: 'error', row: rowNo, field: 'rooms_available', code: 'unknown_inventory', message: `No rooms_available supplied and no room inventory configured for ${property.code} on ${businessDate}` });
      return;
    }
    if (roomsAvail !== null && inventory !== null && roomsAvail !== inventory) {
      issues.push({ severity: 'warning', row: rowNo, field: 'rooms_available', code: 'inventory_mismatch', message: `Reported rooms (${roomsAvail}) differ from configured inventory (${inventory}); the reported value is used` });
    }
    if (ooo > physical) {
      issues.push({ severity: 'error', row: rowNo, field: 'rooms_out_of_order', code: 'ooo_exceeds_inventory', message: `Out-of-order rooms (${ooo}) exceed rooms in inventory (${physical})` });
      return;
    }
    if (roomsSold + comp > physical) {
      issues.push({ severity: 'error', row: rowNo, field: 'rooms_sold', code: 'sold_exceeds_inventory', message: `Rooms sold + comp (${roomsSold + comp}) exceed rooms in inventory (${physical})` });
      return;
    }
    if (roomsSold + comp > physical - ooo) {
      issues.push({ severity: 'warning', row: rowNo, field: 'rooms_sold', code: 'sold_exceeds_available', message: `Rooms sold + comp exceed rooms available after out-of-order rooms` });
    }
    if (roomsSold === 0 && roomRevenue > 0) {
      issues.push({ severity: 'error', row: rowNo, field: 'room_revenue', code: 'revenue_without_rooms', message: 'Room revenue reported with zero rooms sold' });
      return;
    }
    if (total !== null) {
      if (total + RECONCILE_TOLERANCE < roomRevenue) {
        issues.push({ severity: 'error', row: rowNo, field: 'total_revenue', code: 'total_below_rooms', message: 'Total revenue is less than room revenue' });
        return;
      }
      if (fb !== null && other !== null && Math.abs(roomRevenue + fb + other - total) > RECONCILE_TOLERANCE) {
        issues.push({
          severity: 'error',
          row: rowNo,
          field: 'total_revenue',
          code: 'total_mismatch',
          message: `Total revenue ${total} does not equal room + F&B + other (${(roomRevenue + fb + other).toFixed(2)})`,
        });
        return;
      }
    }
    const derivedTotal = total ?? (fb !== null && other !== null ? roomRevenue + fb + other : null);

    const sourceMetrics: Record<string, number> = {};
    if (srcOcc !== null) sourceMetrics.occupancy_pct = srcOcc;
    if (srcAdr !== null) sourceMetrics.adr = srcAdr;
    if (srcRevpar !== null) sourceMetrics.revpar = srcRevpar;

    const rec: DailyPerformanceImportRecord = {
      propertyId: property.id,
      propertyCode: property.code,
      businessDate,
      physicalRooms: physical,
      roomsOutOfOrder: ooo,
      roomsSold,
      roomsComp: comp,
      roomRevenue,
      fbRevenue: fb,
      otherRevenue: other,
      totalRevenue: derivedTotal,
      sourceMetrics,
      sourceRow: rowNo,
    };

    if (srcOcc !== null) {
      const ours = computeKpis(normaliseDay({ ...rec, totalRevenue: derivedTotal }, DEFAULT_REPORTING_CONFIG)).occupancyPct;
      if (ours !== null && Math.abs(ours - srcOcc) > 0.5) {
        issues.push({
          severity: 'warning',
          row: rowNo,
          field: 'source_occupancy_pct',
          code: 'source_definition_differs',
          message: `Source occupancy ${srcOcc.toFixed(1)}% differs from portal definition ${ours.toFixed(1)}% (source may include comps or out-of-order rooms); source value preserved`,
        });
      }
    }
    records.push(rec);
  });

  const dates = records.map((r) => r.businessDate).sort();
  return {
    records,
    issues,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    propertyIds: [...new Set(records.map((r) => r.propertyId))],
  };
}

export const dailyPerformanceParser: ReportParser<DailyPerformanceImportRecord> = {
  key: 'hop.daily_performance.v1',
  reportType: 'daily_performance',
  label: 'Standard daily performance (CSV/XLSX)',
  description: 'One row per property and business date. See docs/IMPORT_FORMATS.md.',
  requiredColumns: REQUIRED,
  optionalColumns: OPTIONAL,
  parse: parseDailyPerformance,
};
