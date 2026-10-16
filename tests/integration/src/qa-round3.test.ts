/**
 * Regression tests for QA round 3 findings (R3-xx ids in the fix list).
 * Database checks run as the user inside a transaction that is rolled back, so shared
 * demo data is left as it was.
 */
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { call, COMPANY, csvFile, drainQueue, MEMBERSHIP, PROPERTY, serviceDb, signIn, sql, USER } from './helpers';

const UID = {
  platform: '30000000-0000-4000-8000-000000000001',
  hvAdmin: '30000000-0000-4000-8000-000000000011',
  hvFinance: '30000000-0000-4000-8000-000000000012',
  hvGm: '30000000-0000-4000-8000-000000000014',
  ian: '30000000-0000-4000-8000-000000000022',
} as const;
const HV_FINANCE_MEMBERSHIP = '50000000-0000-4000-8000-000000000012';
const FLASH_SOURCE = '90000000-0000-4000-8000-000000000001';

/** Run `fn` as a signed-in user (aal2 unless given) in a transaction that is always rolled back. `setup` runs first as the superuser. */
async function asUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>, setup?: (c: PoolClient) => Promise<void>, aal: 'aal1' | 'aal2' = 'aal2'): Promise<T> {
  const c = await sql().connect();
  try {
    await c.query('begin');
    if (setup) await setup(c);
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated', aal })]);
    return await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** One statement under a savepoint: returns its rows or the error code, and keeps the transaction usable. */
async function attempt(c: PoolClient, text: string, params: unknown[] = []): Promise<{ code: string | null; rows: Array<Record<string, unknown>>; message?: string }> {
  await c.query('savepoint s');
  try {
    const r = await c.query(text, params);
    await c.query('release savepoint s');
    return { code: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint s');
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? 'unknown', rows: [], message: err.message };
  }
}

const allowGm = (perms: string[]) => async (c: PoolClient) => {
  for (const p of perms) {
    await c.query("insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect) values ($1, $2, $3, 'allow')", [MEMBERSHIP.hvGm, COMPANY.harborview, p]);
  }
};

describe('R3-01 property-scoped editors cannot write other properties or company-wide configuration', () => {
  it('a Seattle PM with financials.edit / ingestion.manage overrides writes only Seattle rows', async () => {
    await asUser(UID.hvGm, async (c) => {
      const account = (await c.query("select id from public.financial_accounts where company_id = $1 and code = 'REV_ROOMS'", [COMPANY.harborview])).rows[0]!.id as string;
      // Account mappings: other property and company-wide are refused; Seattle works.
      expect((await attempt(c, "insert into public.source_account_mappings (company_id, property_id, source_account_code, account_id) values ($1, $2, 'QA3X', $3)", [COMPANY.harborview, PROPERTY.sfo, account])).code).toBe('42501');
      expect((await attempt(c, "insert into public.source_account_mappings (company_id, property_id, source_account_code, account_id) values ($1, null, 'QA3X', $2)", [COMPANY.harborview, account])).code).toBe('42501');
      expect((await attempt(c, "update public.source_account_mappings set source_account_name = 'x' where property_id = $1 returning id", [PROPERTY.sfo])).rows).toEqual([]);
      expect((await attempt(c, "update public.source_account_mappings set source_account_name = 'x' where property_id is null returning id")).rows).toEqual([]);
      expect((await attempt(c, "delete from public.source_account_mappings where property_id is null returning id")).rows).toEqual([]);
      const sea = await attempt(c, "insert into public.source_account_mappings (company_id, property_id, source_account_code, account_id) values ($1, $2, 'QA3X', $3) returning id", [COMPANY.harborview, PROPERTY.sea, account]);
      expect(sea.code).toBeNull();
      // An update cannot move a Seattle row to another property.
      expect((await attempt(c, 'update public.source_account_mappings set property_id = $1 where id = $2', [PROPERTY.sfo, sea.rows[0]!.id])).code).toBe('42501');

      // Chart of accounts is company-wide.
      expect((await attempt(c, "insert into public.financial_accounts (company_id, code, name, nature, section, sort_order) values ($1, 'QA3_REGR', 'x', 'revenue', 'Revenue', 999)", [COMPANY.harborview])).code).toBe('42501');
      expect((await attempt(c, "update public.financial_accounts set name = 'x' where company_id = $1 returning id", [COMPANY.harborview])).rows).toEqual([]);

      // Ingestion configuration.
      expect((await attempt(c, "update public.ingestion_sources set name = 'x' where company_id = $1 returning id", [COMPANY.harborview])).rows).toEqual([]);
      expect((await attempt(c, 'update public.ingestion_source_routes set require_spf_dkim_pass = false where source_id = $1 returning source_id', [FLASH_SOURCE])).rows).toEqual([]);
      expect((await attempt(c, "update public.integration_connections set status = status where company_id = $1 returning id", [COMPANY.harborview])).rows).toEqual([]);
      expect((await attempt(c, 'select public.rotate_ingestion_route_token($1)', [FLASH_SOURCE])).code).toBe('42501');
      expect((await attempt(c, "update public.ingestion_property_mappings set external_code = 'X' where property_id = $1 returning id", [PROPERTY.sfo])).rows).toEqual([]);
      expect((await attempt(c, "insert into public.ingestion_property_mappings (company_id, source_id, external_code, property_id) values ($1, $2, 'QA3SFO', $3)", [COMPANY.harborview, FLASH_SOURCE, PROPERTY.sfo])).code).toBe('42501');
      expect((await attempt(c, "update public.ingestion_property_mappings set external_code = 'SEA01' where property_id = $1 returning id", [PROPERTY.sea])).rows).toHaveLength(1);
    }, allowGm(['financials.edit', 'ingestion.manage']));
  });

  it('corporate finance (all properties) still manages company-wide rows', async () => {
    await asUser(UID.hvFinance, async (c) => {
      expect((await attempt(c, "update public.financial_accounts set name = name where company_id = $1 and code = 'REV_ROOMS' returning id", [COMPANY.harborview])).rows).toHaveLength(1);
      expect((await attempt(c, "update public.source_account_mappings set source_account_name = source_account_name where property_id is null returning id")).rows.length).toBeGreaterThan(0);
      expect((await attempt(c, 'update public.ingestion_source_routes set require_spf_dkim_pass = true where source_id = $1 returning source_id', [FLASH_SOURCE])).rows).toHaveLength(1);
    });
  });
});

describe('R3-19 property-specific mappings are visible only for permitted properties', () => {
  it('a Seattle PM sees Seattle code mappings, company-level account mappings and every source', async () => {
    await asUser(UID.hvGm, async (c) => {
      const codes = (await c.query('select external_code from public.ingestion_property_mappings order by 1')).rows.map((r) => r.external_code);
      expect(codes).toEqual(['SEA01']);
      const props = (await c.query('select distinct property_id from public.source_account_mappings')).rows.map((r) => r.property_id);
      expect(props).toEqual([null]);
      expect((await c.query('select id from public.ingestion_sources')).rows.length).toBe(2);
    });
  });
});

describe('R3-02 platform administrators see no tenant money or profiles without a support session', () => {
  it('CapEx audit metadata carries no amounts; row diffs name money fields without values', async () => {
    await asUser(UID.hvFinance, async (c) => {
      const id = (await c.query("select public.create_capex_project($1, 'QA3 audit', 'other', null, 98765) as id", [PROPERTY.sea])).rows[0]!.id as string;
      await c.query('reset role'); // read the trail as the superuser (finance has no audit.view)
      const created = (await c.query("select metadata from public.audit_events where entity_id = $1 and action = 'capex.project_created'", [id])).rows[0]!.metadata;
      expect(created).toEqual({ has_budget: true });
      await c.query("update public.capex_projects set requested_budget = 12345, title = 'QA3 audit renamed' where id = $1", [id]);
      const row = (await c.query("select metadata from public.audit_events where entity_type = 'capex_projects' and entity_id = $1 and action = 'update'", [id])).rows[0]!.metadata;
      expect(row.changes).toEqual({ title: 'QA3 audit renamed' });
      expect(row.changed_fields).toEqual(['requested_budget', 'title']);
      expect(JSON.stringify(row)).not.toContain('12345');
      expect(JSON.stringify(created)).not.toContain('98765');
    });
  });

  it('a platform admin cannot read tenant profiles, nor older events that hold figures', async () => {
    await asUser(
      UID.platform,
      async (c) => {
        expect((await c.query("select id from public.profiles where email = 'gm.seattle@harborview.example'")).rows).toEqual([]);
        const visible = (await c.query("select metadata from public.audit_events where action like 'qa3.%' order by action")).rows.map((r) => r.metadata);
        expect(visible).toEqual([{ note: 'plain' }]);
      },
      async (c) => {
        await c.query("insert into public.audit_events (company_id, actor_kind, action, entity_type, metadata) values ($1, 'system', 'qa3.legacy', 'x', '{\"amount\": 5000}'), ($1, 'system', 'qa3.legacy_diff', 'x', '{\"changes\": {\"approved_budget\": 1}}'), ($1, 'system', 'qa3.plain', 'x', '{\"note\": \"plain\"}')", [COMPANY.harborview]);
      },
    );
    // The company's own auditors still see the full trail.
    await asUser(
      UID.hvAdmin,
      async (c) => {
        expect((await c.query("select action from public.audit_events where action like 'qa3.%'")).rows).toHaveLength(3);
        expect((await c.query("select id from public.profiles where email = 'gm.seattle@harborview.example'")).rows).toHaveLength(1);
      },
      async (c) => {
        await c.query("insert into public.audit_events (company_id, actor_kind, action, entity_type, metadata) values ($1, 'system', 'qa3.legacy', 'x', '{\"amount\": 5000}'), ($1, 'system', 'qa3.legacy_diff', 'x', '{\"changes\": {\"approved_budget\": 1}}'), ($1, 'system', 'qa3.plain', 'x', '{\"note\": \"plain\"}')", [COMPANY.harborview]);
      },
    );
  });

  it('a support session does not open tenant profiles without two-factor (aal1)', async () => {
    await asUser(
      UID.platform,
      async (c) => {
        expect((await c.query("select id from public.profiles where email = 'gm.seattle@harborview.example'")).rows).toEqual([]);
      },
      async (c) => {
        await c.query("insert into public.support_access_sessions (company_id, user_id, reason, ticket_ref, starts_at, expires_at) values ($1, $2, 'QA round 3 profile visibility check', 'T-3', now() - interval '1 minute', now() + interval '1 hour')", [COMPANY.harborview, UID.platform]);
      },
      'aal1',
    );
  });

  it('a support session shows the company’s member profiles', async () => {
    await asUser(
      UID.platform,
      async (c) => {
        expect((await c.query("select id from public.profiles where email = 'gm.seattle@harborview.example'")).rows).toHaveLength(1);
        expect((await c.query("select id from public.profiles where email = 'admin@summitpeak.example'")).rows).toEqual([]);
      },
      async (c) => {
        await c.query("insert into public.support_access_sessions (company_id, user_id, reason, ticket_ref, starts_at, expires_at) values ($1, $2, 'QA round 3 profile visibility check', 'T-3', now() - interval '1 minute', now() + interval '1 hour')", [COMPANY.harborview, UID.platform]);
      },
    );
  });
});

describe('R3-04 room inventory can start before the first period', () => {
  it('backdates inventory as a closed period, and an untouched opening inventory follows the opening date', async () => {
    await asUser(UID.hvAdmin, async (c) => {
      const first = (await c.query('select effective_from::text as f, room_count from public.room_inventory_history where property_id = $1 order by effective_from limit 1', [PROPERTY.sea])).rows[0]!;
      const before = new Date(Date.parse(`${first.f}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
      const ok = await attempt(c, "select public.set_room_inventory($1, $2, $3, 'QA3 history backfill')", [PROPERTY.sea, before, first.room_count]);
      expect(ok.code).toBeNull();
      const periods = (await c.query('select effective_from::text as f, effective_to::text as t from public.room_inventory_history where property_id = $1 order by effective_from limit 2', [PROPERTY.sea])).rows;
      expect(periods[0]).toEqual({ f: before, t: first.f });
      // Between existing periods is still refused.
      expect((await attempt(c, "select public.set_room_inventory($1, $2, 10, 'QA3 overlap')", [PROPERTY.sea, first.f])).code).toBe('22023');

      // Created without an opening date: inventory starts today; moving the opening date earlier extends it.
      const pid = (await c.query("select public.create_property($1, 'QA3-NEW', 'QA3 New Hotel', 'America/Los_Angeles', 'onboarding', null, null, null, null, 'US', null, 120) as id", [COMPANY.harborview])).rows[0]!.id;
      await c.query("update public.properties set opened_on = '2020-01-01' where id = $1", [pid]);
      const inv = (await c.query('select effective_from::text as f, effective_to, reason from public.room_inventory_history where property_id = $1', [pid])).rows;
      expect(inv).toEqual([{ f: '2020-01-01', effective_to: null, reason: 'Opening inventory' }]);
      expect((await attempt(c, "select public.set_room_inventory($1, '2019-06-01', 100, 'Before renovation')", [pid])).code).toBeNull();
    });
  });
});

describe('R3-06 linked partial invoices are not counted twice', () => {
  it('open commitment is reduced by the invoices against it (partial, full and over-invoice)', async () => {
    const PROJECT = '81000000-0000-4000-8000-000000000006'; // HV-SFO, in progress
    const summary = async (c: PoolClient) =>
      (await c.query('select approved_budget::float a, actual_spend::float s, open_commitments::float o, remaining::float r from public.capex_project_summary($1) where project_id = $2', [COMPANY.harborview, PROJECT])).rows[0]!;
    await asUser(UID.hvFinance, async (c) => {
      const base = await summary(c);
      const cm = (await c.query("insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, created_by) values ($1, $2, $3, 'commitment', 'open', 15000, current_date, $4) returning id", [COMPANY.harborview, PROPERTY.sfo, PROJECT, UID.hvFinance])).rows[0]!.id;
      await c.query("insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, related_commitment_id, created_by) values ($1, $2, $3, 'actual', 'open', 5000, current_date, $4, $5)", [COMPANY.harborview, PROPERTY.sfo, PROJECT, cm, UID.hvFinance]);
      let s = await summary(c);
      expect(s.s - base.s).toBe(5000);
      expect(s.o - base.o).toBe(10000);
      expect(s.r - base.r).toBe(-15000);
      // Fully invoiced, then over-invoiced: the commitment counts 0, never negative.
      await c.query("insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, related_commitment_id, created_by) values ($1, $2, $3, 'actual', 'open', 10000, current_date, $4, $5)", [COMPANY.harborview, PROPERTY.sfo, PROJECT, cm, UID.hvFinance]);
      s = await summary(c);
      expect(s.o - base.o).toBe(0);
      await c.query("insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, related_commitment_id, created_by) values ($1, $2, $3, 'actual', 'open', 2000, current_date, $4, $5)", [COMPANY.harborview, PROPERTY.sfo, PROJECT, cm, UID.hvFinance]);
      s = await summary(c);
      expect(s.o - base.o).toBe(0);
      expect(s.r - base.r).toBe(-17000);
      // The package snapshot uses the same rule.
      await c.query('reset role');
      const snap = (
        await c.query(
          "select app.build_package_snapshot(jsonb_populate_record(null::public.reporting_packages, jsonb_build_object('id', gen_random_uuid(), 'company_id', $1::uuid, 'property_id', $2::uuid, 'period_month', '2026-09-01'))) as s",
          [COMPANY.harborview, PROPERTY.sfo],
        )
      ).rows[0]!.s;
      const proj = (snap.capex as Array<{ project_id: string; open_commitments: number; remaining: number }>).find((p) => p.project_id === PROJECT)!;
      expect(Number(proj.open_commitments)).toBe(s.o);
      expect(Number(proj.remaining)).toBe(s.r);
    });
  });
});

// Files are deduplicated by content: make each run's files unique.
const NONCE = `qa3-${Date.now()}`;

async function upload(token: string, name: string, text: string, reportType = 'monthly_actuals') {
  const form = new FormData();
  form.set('company_id', COMPANY.harborview);
  form.set('report_type', reportType);
  form.set('file', csvFile(name, text));
  const res = await call('/imports', { method: 'POST', body: form, token });
  const body = (await res.json()) as { importRunId: string };
  await drainQueue();
  const { data } = await serviceDb().from('import_runs').select('*').eq('id', body.importRunId).single();
  return data as Record<string, unknown> & { id: string; status: string; result: { preview?: { conflictDetails?: Array<Record<string, unknown>> } } };
}

describe('R3-07 / R3-21 / R3-24 monthly actuals imports', () => {
  it('a partial file over a published statement lists changed, added and removed accounts', async () => {
    const { token } = await signIn(USER.hvFinance);
    // HV-HNL 2026-08 is published with 18 accounts; this file has two, one of them changed.
    const svc = serviceDb();
    const { data: rep } = await svc.from('financial_reports').select('id').eq('property_id', PROPERTY.hnl).eq('period_month', '2026-08-01').eq('status', 'published').single();
    const { data: lines } = await svc.from('financial_report_lines').select('account_id, amount, financial_accounts(code)').eq('financial_report_id', rep!.id);
    const rooms = lines!.find((l) => (l.financial_accounts as unknown as { code: string }).code === 'REV_ROOMS')!;
    const fb = lines!.find((l) => (l.financial_accounts as unknown as { code: string }).code === 'REV_FB')!;
    const r = await upload(token, 'hnl-partial.csv', `property_code,period,account_code,account_name,amount\nHV-HNL,2026-08,REV_ROOMS,${NONCE},${Number(rooms.amount) + 100}\nHV-HNL,2026-08,REV_FB,,${Number(fb.amount)}`);
    expect(r.status).toBe('needs_review');
    const detail = r.result.preview!.conflictDetails![0]!;
    const accounts = new Set(lines!.map((l) => l.account_id)).size;
    expect(detail).toMatchObject({ replacesStatement: true, changed: 1, added: 0, removed: accounts - 2 });
    const changes = detail.lineChanges as Array<{ accountId: string; code: string; change: string }>;
    expect(changes.find((x) => x.code === 'REV_ROOMS')).toMatchObject({ change: 'changed' });
    expect(changes.filter((x) => x.change === 'removed')).toHaveLength(accounts - 2);
    expect(changes.find((x) => x.code === 'REV_FB')).toBeUndefined();
    // Draft amounts are not stored on the run; finance reads them through the RPC.
    expect(changes.every((x) => !('old' in x) && !('new' in x))).toBe(true);
    await asUser(UID.hvFinance, async (c) => {
      const diff = (await c.query('select public.import_statement_diff($1) as d', [r.id])).rows[0]!.d as Array<{ propertyId: string; lineChanges: Array<{ accountId: string; old: number | null; new: number | null }> }>;
      expect(diff).toHaveLength(1);
      expect(diff[0]!.propertyId).toBe(PROPERTY.hnl);
      expect(diff[0]!.lineChanges.find((x) => x.accountId === rooms.account_id)).toMatchObject({ old: Number(rooms.amount), new: Number(rooms.amount) + 100 });
    });
    await call(`/imports/${r.id}/reject`, { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: '{}' });
  });

  it('a property manager with ingestion.view sees which accounts change, but not the draft amounts', async () => {
    const { token } = await signIn(USER.hvFinance);
    const { data: rep } = await serviceDb().from('financial_reports').select('id').eq('property_id', PROPERTY.sea).eq('period_month', '2026-08-01').eq('status', 'published').single();
    const { data: lines } = await serviceDb().from('financial_report_lines').select('amount, financial_accounts(code)').eq('financial_report_id', rep!.id);
    const rooms = lines!.find((l) => (l.financial_accounts as unknown as { code: string }).code === 'REV_ROOMS')!;
    const draft = (Number(rooms.amount) + 4321.17).toFixed(2);
    const r = await upload(token, 'sea-partial.csv', `property_code,period,account_code,account_name,amount\nHV-SEA,2026-08,REV_ROOMS,${NONCE},${draft}`);
    try {
      expect(r.status).toBe('needs_review');
      await asUser(UID.hvGm, async (c) => {
        const seen = (await c.query('select result from public.import_runs where id = $1', [r.id])).rows;
        expect(seen).toHaveLength(1);
        const text = JSON.stringify(seen[0]!.result);
        expect(text).toContain('REV_ROOMS');
        expect(text).not.toContain(draft);
        expect((await c.query('select public.import_statement_diff($1) as d', [r.id])).rows[0]!.d).toEqual([]);
        expect((await attempt(c, 'select * from public.import_statement_diffs')).code).toBe('42501');
      });
      await asUser(UID.hvFinance, async (c) => {
        const diff = (await c.query('select public.import_statement_diff($1) as d', [r.id])).rows[0]!.d;
        expect(JSON.stringify(diff)).toContain(draft);
      });
    } finally {
      await call(`/imports/${r.id}/reject`, { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: '{}' });
    }
  });

  it('re-importing identical lines into a draft counts as unchanged', async () => {
    const { token } = await signIn(USER.hvFinance);
    await sql().query("delete from public.financial_reports where property_id = $1 and period_month = '2019-05-01'", [PROPERTY.sea]);
    try {
      const first = await upload(token, 'sea-2019-05.csv', `property_code,period,account_code,account_name,amount\nHV-SEA,2019-05,REV_ROOMS,${NONCE},1000\nHV-SEA,2019-05,4000,,0`);
      expect(first).toMatchObject({ status: 'completed', rows_inserted: 1 });
      // Same lines, different formatting (a different file).
      const again = await upload(token, 'sea-2019-05-v2.csv', `property_code,period,account_code,account_name,amount\nHV-SEA,2019-05,4000,,0.00\nHV-SEA,2019-05,REV_ROOMS,${NONCE},"1,000.00"`);
      expect(again).toMatchObject({ status: 'completed', rows_inserted: 0, rows_updated: 0, rows_unchanged: 1 });
      const { data: lines } = await serviceDb().from('financial_report_lines').select('import_run_id').eq('property_id', PROPERTY.sea).eq('import_run_id', first.id);
      expect(lines).toHaveLength(2);
    } finally {
      await sql().query("delete from public.financial_reports where property_id = $1 and period_month = '2019-05-01'", [PROPERTY.sea]);
    }
  });
});

describe('R3-08 authorship and timestamps are set by the database', () => {
  it('ignores client-sent authors, approvers and timestamps', async () => {
    await asUser(UID.hvGm, async (c) => {
      const m = (await c.query("insert into public.management_commentary (company_id, property_id, period_month, section, body, visibility, status, created_by, created_at, published_by, published_at) values ($1, $2, '2026-08-01', 'other', 'QA3', 'owner', 'published', $3, '2020-01-01', $3, '2020-01-01') returning created_by, published_by, created_at > now() - interval '1 minute' as fresh, published_at > now() - interval '1 minute' as pub_fresh", [COMPANY.harborview, PROPERTY.sea, UID.hvFinance])).rows[0]!;
      expect(m).toEqual({ created_by: UID.hvGm, published_by: UID.hvGm, fresh: true, pub_fresh: true });
      // Moving it back to draft clears the publication stamp.
      const back = (await c.query("update public.management_commentary set status = 'draft', published_by = $2 where body = 'QA3' and property_id = $1 returning published_by, published_at", [PROPERTY.sea, UID.hvFinance])).rows[0]!;
      expect(back).toEqual({ published_by: null, published_at: null });
      // A forged author is replaced by the caller.
      const u = (await c.query("insert into public.capex_updates (company_id, property_id, project_id, body, visibility, created_by, created_at) values ($1, $2, '81000000-0000-4000-8000-000000000001', 'QA3', 'owner', $3, '2099-01-01') returning id, created_by, created_at < now() + interval '1 second' as now_ok", [COMPANY.harborview, PROPERTY.sea, UID.hvFinance])).rows[0]!;
      expect(u).toMatchObject({ created_by: UID.hvGm, now_ok: true });
      const t = (await c.query("insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, created_by, created_at) values ($1, $2, '81000000-0000-4000-8000-000000000001', 'quote', 'open', 10, current_date, $3, '2099-01-01') returning id, created_by, created_at < now() + interval '1 second' as now_ok", [COMPANY.harborview, PROPERTY.sea, UID.hvFinance])).rows[0]!;
      expect(t).toMatchObject({ created_by: UID.hvGm, now_ok: true });
      // Clients cannot write the author column on update (column grants); permitted updates keep it.
      expect((await attempt(c, 'update public.capex_transactions set created_by = $2 where id = $1', [t.id, UID.hvFinance])).code).toBe('42501');
      expect((await attempt(c, 'update public.capex_updates set created_by = $2 where id = $1', [u.id, UID.hvFinance])).code).toBe('42501');
      expect((await c.query("update public.capex_transactions set description = 'QA3 edited' where id = $1 returning created_by", [t.id])).rows[0]!.created_by).toBe(UID.hvGm);
    });
    await asUser(UID.hvFinance, async (c) => {
      const b = (await c.query("insert into public.budget_versions (company_id, property_id, fiscal_year, version_number, name, created_by, approved_by, approved_at) values ($1, $2, 2031, 1, 'QA3', $3, $3, '2020-01-01') returning id, created_by, approved_by, approved_at", [COMPANY.harborview, PROPERTY.sea, UID.hvAdmin])).rows[0]!;
      expect(b).toMatchObject({ created_by: UID.hvFinance, approved_by: null, approved_at: null });
      expect((await attempt(c, "update public.budget_versions set created_by = $2, approved_by = $2, approved_at = '2020-01-01' where id = $1", [b.id, UID.hvAdmin])).code).toBe('42501');
      const upd = (await c.query("update public.budget_versions set name = 'QA3 renamed' where id = $1 returning name, created_by, approved_by, approved_at", [b.id])).rows[0]!;
      expect(upd).toEqual({ name: 'QA3 renamed', created_by: UID.hvFinance, approved_by: null, approved_at: null });
    });
  });
});

describe('R3-09 the last company administrator keeps admin access', () => {
  it('refuses self-deny of admin permissions and denying the last holder', async () => {
    await asUser(UID.hvAdmin, async (c) => {
      const self = await attempt(c, "select public.set_permission_override($1, 'admin.users', 'deny')", [MEMBERSHIP.hvAdmin]);
      expect(self.code).toBe('23514');
      expect(self.message).toMatch(/cannot remove your own administration access/);
    });
    // Finance has admin.users (override) but not admin.company: Hannah is the last admin.company holder.
    await asUser(
      UID.hvFinance,
      async (c) => {
        const last = await attempt(c, "select public.set_permission_override($1, 'admin.company', 'deny')", [MEMBERSHIP.hvAdmin]);
        expect(last.code).toBe('23514');
        expect(last.message).toMatch(/last company administrator/);
        expect((await attempt(c, "select public.set_permission_override($1, 'admin.users', 'deny')", [MEMBERSHIP.hvAdmin])).code).toBeNull();
      },
      async (c) => {
        await c.query("insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect) values ($1, $2, 'admin.users', 'allow')", [HV_FINANCE_MEMBERSHIP, COMPANY.harborview]);
      },
    );
  });
});

describe('R3-09 role changes and denials use the same last-administrator rule', () => {
  it('a demotion is refused when the other company admin was denied user management', async () => {
    await asUser(
      UID.hvAdmin,
      async (c) => {
        const r = await attempt(c, "select public.update_membership($1, 'corporate_finance', true)", [MEMBERSHIP.hvAdmin]);
        expect(r.code).toBe('23514');
        expect(r.message).toMatch(/last company administrator/);
      },
      async (c) => {
        await c.query("update public.company_memberships set role = 'company_admin' where id = $1", [HV_FINANCE_MEMBERSHIP]);
        await c.query("insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect) values ($1, $2, 'admin.users', 'deny')", [HV_FINANCE_MEMBERSHIP, COMPANY.harborview]);
      },
    );
  });

  it('denying admin access to someone who does not hold it is not a last-holder error', async () => {
    await asUser(
      UID.hvFinance,
      async (c) => {
        expect((await attempt(c, "select public.set_permission_override($1, 'admin.company', 'deny')", [MEMBERSHIP.hvGm])).code).toBeNull();
      },
      async (c) => {
        // Nobody holds admin.company; finance manages users through an override.
        await c.query("insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect) values ($1, $2, 'admin.users', 'allow')", [HV_FINANCE_MEMBERSHIP, COMPANY.harborview]);
        await c.query("insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect) values ($1, $2, 'admin.company', 'deny')", [MEMBERSHIP.hvAdmin, COMPANY.harborview]);
      },
    );
  });
});

describe('R3-11 allowed senders change atomically', () => {
  it('add is idempotent and normalised; remove from a stale view does not restore others', async () => {
    await asUser(UID.hvFinance, async (c) => {
      const added = (await c.query("select public.add_allowed_sender($1, '  QA3@Example.com ') as s", [FLASH_SOURCE])).rows[0]!.s as string[];
      expect(added).toContain('qa3@example.com');
      const twice = (await c.query("select public.add_allowed_sender($1, 'qa3@example.com') as s", [FLASH_SOURCE])).rows[0]!.s as string[];
      expect(twice.filter((x) => x === 'qa3@example.com')).toHaveLength(1);
      const removed = (await c.query("select public.remove_allowed_sender($1, 'nightaudit@harborview.example') as s", [FLASH_SOURCE])).rows[0]!.s as string[];
      expect(removed).not.toContain('nightaudit@harborview.example');
      // Another tab adding a sender keeps the removal.
      const later = (await c.query("select public.add_allowed_sender($1, 'other@example.com') as s", [FLASH_SOURCE])).rows[0]!.s as string[];
      expect(later).not.toContain('nightaudit@harborview.example');
      expect((await attempt(c, "select public.add_allowed_sender($1, 'not an email')", [FLASH_SOURCE])).code).toBe('22023');
    });
    await asUser(UID.hvGm, async (c) => {
      expect((await attempt(c, "select public.add_allowed_sender($1, 'evil@example.com')", [FLASH_SOURCE])).code).toBe('42501');
    });
  });
});

describe('R3-20 CapEx transactions only reference documents in scope', () => {
  it('rejects another property’s document or one the author cannot view', async () => {
    await asUser(UID.hvGm, async (c) => {
      const ins = (doc: string) =>
        attempt(c, "insert into public.capex_transactions (company_id, property_id, project_id, kind, status, amount, transaction_date, document_id, created_by) values ($1, $2, '81000000-0000-4000-8000-000000000001', 'quote', 'open', 10, current_date, $3, $4)", [COMPANY.harborview, PROPERTY.sea, doc, UID.hvGm]);
      const pdx = await ins('70000000-0000-4000-8000-000000000005');
      const confidential = await ins('70000000-0000-4000-8000-000000000003');
      const missing = await ins('70000000-0000-4000-8000-0000000000ff');
      expect([pdx.code, confidential.code, missing.code]).toEqual(['22023', '22023', '22023']);
      expect(pdx.message).toBe(missing.message);
      expect((await ins('70000000-0000-4000-8000-000000000001')).code).toBeNull();
      expect((await ins('70000000-0000-4000-8000-000000000007')).code).toBeNull();
    });
  });
});

describe('R3-22 / R3-23 package content for investors', () => {
  it('investors with financials.view keep the statement and actuals, without budget figures; variance commentary names its account', async () => {
    const PKG = (await sql().query("select id from public.reporting_packages where property_id = $1 and status = 'published' limit 1", [PROPERTY.sea])).rows[0]!.id as string;
    await asUser(
      UID.ian,
      async (c) => {
        const s = (await c.query('select public.get_reporting_package($1) as p', [PKG])).rows[0]!.p.snapshot;
        expect(s.financial_report).toBeTruthy();
        expect(s.budget_hidden).toBe(true);
        expect(s.budget_variance.length).toBeGreaterThan(0);
        expect(s.budget_variance.every((l: Record<string, unknown>) => !('budget' in l) && l.actual !== null)).toBe(true);
      },
      async (c) => {
        // Ian's Seattle grant normally excludes financials; give it for this check.
        await c.query("update public.property_access_grants set permissions = array_append(permissions, 'financials.view') where membership_id = $1 and property_id = $2", [MEMBERSHIP.ianHv, PROPERTY.sea]);
      },
    );
    const c = await sql().connect();
    try {
      await c.query('begin');
      const acct = (await c.query("select id, name from public.financial_accounts where company_id = $1 and code = 'REV_FB'", [COMPANY.harborview])).rows[0]!;
      await c.query("insert into public.management_commentary (company_id, property_id, period_month, section, account_id, body, visibility, status) values ($1, $2, '2026-08-01', 'variance', $3, 'Banquets slower', 'owner', 'published')", [COMPANY.harborview, PROPERTY.sea, acct.id]);
      const snap = (await c.query("select app.build_package_snapshot(k) as s from public.reporting_packages k where id = $1", [PKG])).rows[0]!.s;
      expect(snap.commentary.find((m: { body: string }) => m.body === 'Banquets slower')).toMatchObject({ section: 'variance', account_name: acct.name });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('R3-39 notifications name the property', () => {
  it('appends the property name to property-specific titles once', async () => {
    const { rows } = await sql().query("select app.notification_title('FY2026 budget approved', $1) a, app.notification_title('x', null) c, (select name from public.properties where id = $1) n", [PROPERTY.sea]);
    expect(rows[0].a).toBe(`FY2026 budget approved — ${rows[0].n}`);
    expect(rows[0].c).toBe('x');
  });
});

describe('R3-14 package comparisons for a partial period', () => {
  it('hides every vs-PY change when fewer days were reported than expected', async () => {
    const { packageKpiTiles, INCOMPLETE_PERIOD_NOTE } = await import('@hop/api');
    const perf = { available_room_nights: 3000, rooms_sold: 2400, room_revenue: 480000, total_revenue: 600000, reported_days: 12, expected_days: 31 };
    const py = { ...perf, reported_days: 31, expected_days: 31, total_revenue: 1600000 };
    const tiles = packageKpiTiles({ property: { name: 'X', code: 'X' }, performance: perf, performance_prior_year: py }, 'USD');
    expect(tiles.map((t) => t.note)).toEqual([INCOMPLETE_PERIOD_NOTE, INCOMPLETE_PERIOD_NOTE, INCOMPLETE_PERIOD_NOTE, INCOMPLETE_PERIOD_NOTE]);
    const full = packageKpiTiles({ property: { name: 'X', code: 'X' }, performance: { ...perf, reported_days: 31 }, performance_prior_year: py }, 'USD');
    expect(full.every((t) => t.note.endsWith('vs PY'))).toBe(true);
  });
});

describe('R3-22 investor package PDF', () => {
  it('a financials.view investor without budgets.view downloads the package with the statement', async () => {
    const PKG = (await sql().query("select id from public.reporting_packages where property_id = $1 and status = 'published' limit 1", [PROPERTY.sea])).rows[0]!.id as string;
    await sql().query("update public.property_access_grants set permissions = array_append(permissions, 'financials.view') where membership_id = $1 and property_id = $2", [MEMBERSHIP.ianHv, PROPERTY.sea]);
    try {
      const ian = await signIn(USER.ian);
      const res = await call(`/exports/packages/${PKG}.pdf`, { token: ian.token });
      expect(res.status).toBe(200);
      const { data } = await ian.db.rpc('get_reporting_package', { p_package_id: PKG });
      expect(data.snapshot.financial_report).toBeTruthy();
      expect(data.snapshot.budget_hidden).toBe(true);
    } finally {
      await sql().query("update public.property_access_grants set permissions = array_remove(permissions, 'financials.view') where membership_id = $1 and property_id = $2", [MEMBERSHIP.ianHv, PROPERTY.sea]);
    }
  });
});

describe('R3-26 statement CSV', () => {
  it('has the screen rows (subtotals, budget, variances) with plain numbers', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: rep } = await serviceDb().from('financial_reports').select('id').eq('property_id', PROPERTY.sea).eq('period_month', '2026-08-01').eq('status', 'published').single();
    const res = await call(`/exports/financial-reports/${rep!.id}`, { token: fin.token });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    expect(lines.find((l) => l.startsWith('section,'))).toBe('section,row_type,account_code,account_name,actual,budget,variance,variance_pct');
    for (const label of ['Total revenue', 'Gross operating profit (GOP)', 'Net operating income (NOI)']) expect(lines.some((l) => l.includes(`,subtotal,,${label},`))).toBe(true);
    const rooms = lines.find((l) => l.includes(',ROOMS_SOLD,'))!.split(',');
    expect(rooms[4]).toMatch(/^-?\d+$/);
    const rev = lines.find((l) => l.includes(',REV_ROOMS,'))!.split(',');
    expect(rev[4]).toMatch(/^-?\d+\.\d{2}$/);
    expect(text).not.toMatch(/"\d{1,3},\d{3}/);
  });
});

describe('R3-28 performance CSV lists every selected property', () => {
  it('adds a not-expected line for an onboarding property so the count matches', async () => {
    const svc = serviceDb();
    const { data: prop } = await svc.from('properties').insert({ company_id: COMPANY.harborview, code: 'QA3-ONB', name: 'QA3 Onboarding', timezone: 'America/Los_Angeles', status: 'onboarding' }).select('id').single();
    try {
      const fin = await signIn(USER.hvFinance);
      const res = await call(`/exports/performance.csv?company_id=${COMPANY.harborview}&from=2026-08-01&to=2026-08-31&grain=total`, { token: fin.token });
      const lines = (await res.text()).split(/\r?\n/);
      const footer = lines.find((l) => l.startsWith('PORTFOLIO,'))!;
      const count = Number(/All properties \((\d+)\)/.exec(footer)![1]);
      const propertyLines = lines.filter((l) => /^HV-|^QA3-/.test(l));
      expect(propertyLines).toHaveLength(count);
      expect(propertyLines.find((l) => l.startsWith('QA3-ONB,'))).toMatch(/not expected \(onboarding\)$/);
    } finally {
      await svc.from('properties').delete().eq('id', prop!.id);
    }
  });
});
