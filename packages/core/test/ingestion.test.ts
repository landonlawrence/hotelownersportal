import { describe, expect, it } from 'vitest';
import {
  getParser,
  hasErrors,
  parseBudget,
  parseCsv,
  parseDailyPerformance,
  parseMonthlyActuals,
  parseNumberCell,
  toCsv,
  type ParseContext,
  type PropertyRef,
} from '../src/ingestion';

const sea: PropertyRef = { id: 'p-sea', code: 'HV-SEA', openedOn: '2015-06-01', timeZone: 'America/Los_Angeles', roomsOn: () => 220 };
const pdx: PropertyRef = { id: 'p-pdx', code: 'HV-PDX', openedOn: '2018-03-15', timeZone: 'America/Los_Angeles', roomsOn: (d) => (d >= '2026-03-01' ? 160 : 148) };
const ctx: ParseContext = {
  propertyByCode: new Map([['HV-SEA', sea], ['HV-PDX', pdx]]),
  todayFor: () => '2026-07-10',
  accountMapping: (code) => ({ '4000': 'acc-rooms', '5000': 'acc-payroll' } as Record<string, string>)[code] ?? null,
  reportingAccounts: new Map([['ROOMS_REV', { id: 'acc-rooms', code: 'ROOMS_REV' }], ['ROOMS_SOLD', { id: 'acc-stat-sold', code: 'ROOMS_SOLD' }]]),
};
const table = (csv: string) => {
  const [header, ...rows] = parseCsv(csv);
  return { header: header!, rows };
};

describe('CSV', () => {
  it('parses quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('a,"b\n')).toThrow();
  });
  it('parses accounting numbers', () => {
    expect(parseNumberCell('$1,234.50')).toBe(1234.5);
    expect(parseNumberCell('(12.5)')).toBe(-12.5);
    expect(parseNumberCell('')).toBeNull();
    expect(parseNumberCell('abc')).toBe('invalid');
  });
  it('escapes formula injection on export', () => {
    expect(toCsv([['=SUM(A1)', '-5', 'ok']])).toBe("'=SUM(A1),-5,ok");
  });
});

describe('daily performance parser', () => {
  const header = 'property_code,business_date,rooms_available,rooms_out_of_order,rooms_sold,rooms_comp,room_revenue,food_beverage_revenue,other_revenue,total_revenue,source_occupancy_pct';

  it('accepts a valid file and preserves source metrics', () => {
    const r = parseDailyPerformance(table(`${header}\nHV-SEA,2026-07-08,220,4,180,3,32400,5000,1000,38400,83.2`), ctx);
    expect(hasErrors(r.issues)).toBe(false);
    expect(r.records[0]).toMatchObject({ propertyId: 'p-sea', physicalRooms: 220, roomsSold: 180, totalRevenue: 38400 });
    expect(r.records[0]!.sourceMetrics).toEqual({ occupancy_pct: 83.2 });
    expect(r.periodStart).toBe('2026-07-08');
  });

  it('warns when source occupancy uses a different definition', () => {
    const r = parseDailyPerformance(table(`${header}\nHV-SEA,2026-07-08,220,20,180,20,32400,,,,90.9`), ctx);
    expect(r.issues.map((i) => i.code)).toContain('source_definition_differs');
    expect(hasErrors(r.issues)).toBe(false);
  });

  it('rejects unmapped property codes (including another company\'s hotel)', () => {
    const r = parseDailyPerformance(table(`${header}\nSP-DEN,2026-07-08,250,0,200,0,30000,,,,`), ctx);
    expect(r.issues[0]).toMatchObject({ severity: 'error', code: 'unmapped_property' });
    expect(r.records).toHaveLength(0);
  });

  it('rejects duplicates, future dates, impossible room counts and unreconciled totals', () => {
    const csv = [
      header,
      'HV-SEA,2026-07-01,220,0,100,0,15000,,,,',
      'HV-SEA,2026-07-01,220,0,100,0,15000,,,,',
      'HV-SEA,2026-07-11,220,0,100,0,15000,,,,',
      'HV-SEA,2026-07-02,220,0,230,0,15000,,,,',
      'HV-SEA,2026-07-03,220,0,100,0,15000,100,100,20000,',
      'HV-SEA,2026-07-04,220,0,0,0,500,,,,',
      'HV-SEA,07/05/2026,220,0,100,0,15000,,,,',
      'HV-SEA,2026-02-30,220,0,100,0,15000,,,,',
    ].join('\n');
    const r = parseDailyPerformance(table(csv), ctx);
    const codes = r.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes).toEqual(['duplicate_row', 'future_date', 'sold_exceeds_inventory', 'total_mismatch', 'revenue_without_rooms', 'invalid_date']);
    expect(r.records.map((x) => x.businessDate)).toEqual(['2026-07-01', '2026-07-05']);
  });

  it('uses room inventory history when rooms_available is omitted (inventory change)', () => {
    const r = parseDailyPerformance(
      table('property_code,business_date,rooms_sold,room_revenue\nHV-PDX,2026-02-28,100,10000\nHV-PDX,2026-03-01,100,10000'),
      ctx,
    );
    expect(r.records.map((x) => x.physicalRooms)).toEqual([148, 160]);
  });

  it('reports missing required columns', () => {
    const r = parseDailyPerformance(table('property_code,business_date\nHV-SEA,2026-07-01'), ctx);
    expect(r.issues.map((i) => i.field)).toEqual(['rooms_sold', 'room_revenue']);
  });
});

describe('monthly actuals parser', () => {
  it('maps source accounts and preserves original values', () => {
    const r = parseMonthlyActuals(table('property_code,period,account_code,account_name,amount\nHV-SEA,2026-06,4000,Room Revenue,"$1,000,000.00"\nHV-SEA,2026-06,5000,Payroll,(250000)'), ctx);
    expect(hasErrors(r.issues)).toBe(false);
    expect(r.records[0]).toMatchObject({ accountId: 'acc-rooms', amount: 1000000, sourceValue: '$1,000,000.00', sourceAccountCode: '4000' });
    expect(r.records[1]!.amount).toBe(-250000);
  });
  it('blocks unmapped accounts and invalid periods', () => {
    const r = parseMonthlyActuals(table('property_code,period,account_code,amount\nHV-SEA,2026-06,9999,1\nHV-SEA,2026-13,4000,1\nHV-SEA,2026-08,4000,1'), ctx);
    expect(r.issues.map((i) => i.code)).toEqual(['unmapped_account', 'invalid_period', 'future_period']);
  });
});

describe('budget parser', () => {
  const head = 'property_code,fiscal_year,account_code,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec';
  it('expands twelve months', () => {
    const r = parseBudget(table(`${head}\nHV-SEA,2026,ROOMS_REV,1,2,3,4,5,6,7,8,9,10,11,12`), ctx);
    expect(r.records).toHaveLength(12);
    expect(r.records[11]).toMatchObject({ periodMonth: '2026-12-01', amount: 12, accountId: 'acc-rooms' });
  });
  it('rejects multiple fiscal years and unknown accounts', () => {
    const r = parseBudget(
      table(`${head}\nHV-SEA,2026,ROOMS_REV,1,2,3,4,5,6,7,8,9,10,11,12\nHV-SEA,2027,ROOMS_SOLD,1,2,3,4,5,6,7,8,9,10,11,12\nHV-SEA,2026,NOPE,1,2,3,4,5,6,7,8,9,10,11,12`),
      ctx,
    );
    expect(r.issues.map((i) => i.code).sort()).toEqual(['multiple_years', 'unmapped_account']);
  });
  it('registry exposes only implemented parsers', () => {
    expect(getParser('hop.daily_performance.v1')).toBeDefined();
    expect(getParser('opera.manager_report')).toBeUndefined();
  });
});
