import { describe, expect, it } from 'vitest';
import { computeKpis, normaliseDay, summarizePeriod, sumComponents, type RollupRow } from '@hop/core';
import { COMPANY, PROPERTY, signIn, sql, USER } from './helpers';

describe('performance roll-ups', () => {
  it('SQL roll-up components equal the TypeScript normalisation of raw rows (OOO/comp rules)', async () => {
    await sql().query("update public.property_reporting_config set comp_treatment = 'include' where property_id = $1", [PROPERTY.pdx]);
    try {
      const { db } = await signIn(USER.hvFinance);
      const { data } = await db.rpc('performance_rollup', { p_company_id: COMPANY.harborview, p_from: '2026-06-01', p_to: '2026-06-30', p_grain: 'total', p_property_ids: [PROPERTY.sea, PROPERTY.pdx] });
      const { rows } = await sql().query(
        `select d.*, c.ooo_treatment, c.comp_treatment from public.daily_performance d
         join public.property_reporting_config c on c.property_id = d.property_id
         where d.property_id = any($1) and d.business_date between '2026-06-01' and '2026-06-30'`,
        [[PROPERTY.sea, PROPERTY.pdx]],
      );
      for (const pid of [PROPERTY.sea, PROPERTY.pdx]) {
        const mine = rows.filter((r) => r.property_id === pid);
        const ts = sumComponents(mine.map((r) => normaliseDay({
          propertyId: pid, businessDate: r.business_date, physicalRooms: r.physical_rooms, roomsOutOfOrder: r.rooms_out_of_order,
          roomsSold: r.rooms_sold, roomsComp: r.rooms_comp, roomRevenue: Number(r.room_revenue), totalRevenue: Number(r.total_revenue),
        }, { oooTreatment: r.ooo_treatment, compTreatment: r.comp_treatment })))!;
        const sqlRow = (data as RollupRow[]).find((r) => r.property_id === pid)!;
        expect(Number(sqlRow.available_room_nights)).toBe(ts.availableRoomNights);
        expect(Number(sqlRow.rooms_sold)).toBe(ts.roomsSold);
        expect(Number(sqlRow.room_revenue)).toBeCloseTo(ts.roomRevenue, 2);
      }
    } finally {
      await sql().query("update public.property_reporting_config set comp_treatment = 'exclude' where property_id = $1", [PROPERTY.pdx]);
    }
  });

  it('portfolio KPIs are weighted by room nights, not averaged', async () => {
    const { db } = await signIn(USER.hvAdmin);
    const range = { from: '2026-05-01', to: '2026-05-31' };
    const { data } = await db.rpc('performance_rollup', { p_company_id: COMPANY.harborview, p_from: range.from, p_to: range.to, p_grain: 'total', p_property_ids: null });
    const rows = data as RollupRow[];
    const { data: props } = await db.from('properties').select('id, opened_on, status');
    const s = summarizePeriod(rows, props!.map((p) => ({ id: p.id, openedOn: p.opened_on, status: p.status })), range, range.to);
    const { rows: direct } = await sql().query(
      `select sum(rooms_sold)::numeric / sum(physical_rooms - rooms_out_of_order) * 100 as occ, sum(room_revenue) / sum(rooms_sold) as adr
       from public.daily_performance where company_id = $1 and business_date between $2 and $3`,
      [COMPANY.harborview, range.from, range.to],
    );
    expect(s.kpis.occupancyPct).toBeCloseTo(Number(direct[0].occ), 6);
    expect(s.kpis.adr).toBeCloseTo(Number(direct[0].adr), 6);
    const naive = s.properties.reduce((a, p) => a + (p.kpis.occupancyPct ?? 0), 0) / s.properties.length;
    expect(Math.abs(naive - s.kpis.occupancyPct!)).toBeGreaterThan(0.01);
    expect(s.partial).toBe(false);
  });

  it('missing days are reported as coverage gaps, not zeros', async () => {
    const { db } = await signIn(USER.spAdmin);
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const { data } = await db.rpc('performance_rollup', { p_company_id: COMPANY.summit, p_from: range.from, p_to: range.to, p_grain: 'total', p_property_ids: null });
    const { data: props } = await db.from('properties').select('id, opened_on, status');
    const s = summarizePeriod(data as RollupRow[], props!.map((p) => ({ id: p.id, openedOn: p.opened_on, status: p.status })), range, range.to);
    expect(s.partial).toBe(true);
    expect(s.propertiesWithGaps).toEqual([PROPERTY.aus]);
    expect(s.coverage.expectedDays - s.coverage.reportedDays).toBe(3);
    const aus = s.properties.find((p) => p.propertyId === PROPERTY.aus)!;
    expect(aus.coverage.reportedDays).toBe(27);
    expect(aus.kpis.occupancyPct).not.toBeNull();
    expect(computeKpis(null).occupancyPct).toBeNull();
  });

  it('freshness reflects the latest loaded business date per property', async () => {
    const { db } = await signIn(USER.hvAdmin);
    const { data } = await db.rpc('performance_freshness', { p_company_id: COMPANY.harborview });
    const byId = new Map((data as Array<{ property_id: string; latest_business_date: string }>).map((r) => [r.property_id, r.latest_business_date]));
    expect(byId.get(PROPERTY.hnl)! < byId.get(PROPERTY.sea)!).toBe(true);
  });
});
