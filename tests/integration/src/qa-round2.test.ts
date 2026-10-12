/**
 * Regression tests for QA round 2 findings (R2-xx ids in the fix list).
 * Every test leaves shared demo data as it found it so suite order does not matter.
 */
import { describe, expect, it } from 'vitest';
import { call, COMPANY, csvFile, PROPERTY, serviceDb, signIn, sql, USER } from './helpers';

describe('R2-01 provisioned companies get a chart of accounts and document categories', () => {
  it('provision_company seeds the standard reporting accounts and categories', async () => {
    // Call the RPC as the platform admin in a 2FA-verified (aal2) session.
    const pa = await signIn(USER.platform);
    const client = await sql().connect();
    let companyId: string;
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: pa.userId, role: 'authenticated', aal: 'aal2' })]);
      const { rows } = await client.query("select public.provision_company($1, 'QA R2 Hotels', 'QA R2 Portal', 'admin@qa-r2.example') as r", [`qa-r2-${Date.now()}`]);
      await client.query('commit');
      companyId = (rows[0] as { r: { company_id: string } }).r.company_id;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    const svc = serviceDb();
    const { data: accounts } = await svc.from('financial_accounts').select('code, name, nature, section, sort_order, kpi_role').eq('company_id', companyId).order('sort_order');
    const { data: seeded } = await svc.from('financial_accounts').select('code, name, nature, section, sort_order, kpi_role').eq('company_id', COMPANY.harborview).order('sort_order');
    // Same standard chart as the demo company.
    expect(accounts).toEqual(seeded);
    expect(accounts!.map((a) => a.code)).toEqual(expect.arrayContaining(['ROOMS_AVAILABLE', 'ROOMS_SOLD', 'REV_ROOMS', 'REV_FB', 'EXP_FFE_RESERVE']));
    const { data: cats } = await svc.from('document_categories').select('key, default_visibility').eq('company_id', companyId).order('sort_order');
    expect(cats!.map((c) => c.key)).toEqual(['financial_statements', 'owner_reports', 'insurance', 'contracts', 'loan_documents', 'tax', 'warranties', 'invoices', 'capex', 'other']);
    expect(cats!.find((c) => c.key === 'loan_documents')!.default_visibility).toBe('confidential');
    expect(cats!.find((c) => c.key === 'capex')!.default_visibility).toBe('owner');
    // The company stays (audit events are append-only); its slug is unique per run.
  });

  it('every existing company has accounts and categories (backfill)', async () => {
    const { rows } = await sql().query(`select c.slug from public.companies c
      where not exists (select 1 from public.financial_accounts f where f.company_id = c.id)
         or not exists (select 1 from public.document_categories k where k.company_id = c.id)`);
    expect(rows).toEqual([]);
  });
});

describe('R2-03 owner packages never include documents without a released version', () => {
  it('rejects them when added, and filters them from the snapshot, items and revisions', async () => {
    const svc = serviceDb();
    const fin = await signIn(USER.hvFinance);
    const { data: doc } = await svc
      .from('documents')
      .insert({ company_id: COMPANY.harborview, property_id: PROPERTY.sea, category_key: 'other', title: 'QA R2 infected attachment', visibility: 'owner', created_by: fin.userId })
      .select('id')
      .single();
    const { data: pkg, error } = await fin.db.rpc('create_reporting_package', { p_property_id: PROPERTY.sea, p_period_month: '2024-03-01', p_title: null });
    expect(error).toBeNull();
    try {
      const add = await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: doc!.id });
      expect(add.error?.code).toBe('22023');
      expect(add.error?.message).toMatch(/no released version/);

      // A legacy item (added before this check existed) must still never reach owners.
      await svc.from('reporting_package_items').insert({ company_id: COMPANY.harborview, package_id: pkg, item_type: 'document', ref_id: doc!.id, title: 'QA R2 infected attachment', sort_order: 60 });
      const GENERAL_DOC = '70000000-0000-4000-8000-000000000001';
      expect((await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: GENERAL_DOC })).error).toBeNull();
      expect((await fin.db.rpc('publish_reporting_package', { p_package_id: pkg, p_comment: 'QA' })).error).toBeNull();

      const { data: snap } = await svc.from('reporting_package_snapshots').select('snapshot').eq('package_id', pkg).single();
      expect(JSON.stringify(snap!.snapshot)).not.toContain(doc!.id);

      const owner = await signIn(USER.olivia);
      const { data: forOwner } = await owner.db.rpc('get_reporting_package', { p_package_id: pkg });
      expect(JSON.stringify(forOwner)).not.toContain('QA R2 infected attachment');
      expect((forOwner.snapshot.documents as Array<{ document_id: string }>).map((d) => d.document_id)).toEqual([GENERAL_DOC]);

      const { data: rev, error: revErr } = await fin.db.rpc('create_reporting_package_revision', { p_package_id: pkg, p_reason: 'QA correction' });
      expect(revErr).toBeNull();
      const { data: revItems } = await svc.from('reporting_package_items').select('ref_id').eq('package_id', rev).eq('item_type', 'document');
      expect(revItems!.map((i) => i.ref_id)).toEqual([GENERAL_DOC]);
    } finally {
      await sql().query('delete from public.reporting_packages where property_id = $1 and period_month = $2', [PROPERTY.sea, '2024-03-01']);
      await svc.from('documents').update({ status: 'archived' }).eq('id', doc!.id);
    }
  });
});

describe('R2-12 CapEx edits carry an updated_at precondition', () => {
  it('a stale copy updates nothing; a fresh copy applies', async () => {
    const fin = await signIn(USER.hvFinance);
    const PDX_PROJECT = '81000000-0000-4000-8000-000000000004';
    const { data: before } = await fin.db.from('capex_projects').select('title, priority, updated_at').eq('id', PDX_PROJECT).single();
    // Tab A saves first (touches updated_at).
    const a = await fin.db.from('capex_projects').update({ priority: before!.priority === 'high' ? 'normal' : 'high' }).eq('id', PDX_PROJECT).eq('updated_at', before!.updated_at).select('id');
    expect(a.data).toHaveLength(1);
    // Tab B still holds the old updated_at: its save matches no row instead of overwriting.
    const b = await fin.db.from('capex_projects').update({ title: 'QA stale overwrite' }).eq('id', PDX_PROJECT).eq('updated_at', before!.updated_at).select('id');
    expect(b.error).toBeNull();
    expect(b.data).toEqual([]);
    const { data: after } = await fin.db.from('capex_projects').select('title').eq('id', PDX_PROJECT).single();
    expect(after!.title).toBe(before!.title);
    await fin.db.from('capex_projects').update({ priority: before!.priority }).eq('id', PDX_PROJECT);
  });
});

describe('R2-16 / R2-21 property guards', () => {
  it('activating an onboarding property that opens more than two years out is refused', async () => {
    const sp = await signIn(USER.spAdmin);
    const { data: id, error } = await sp.db.rpc('create_property', { p_company_id: COMPANY.summit, p_code: 'SP-QAFUT', p_name: 'QA Future', p_timezone: 'America/Denver', p_status: 'onboarding', p_opened_on: '2040-06-01' });
    expect(error).toBeNull();
    try {
      const upd = await sp.db.from('properties').update({ status: 'active' }).eq('id', id);
      expect(upd.error?.code).toBe('22023');
      expect((await serviceDb().from('properties').select('status').eq('id', id).single()).data!.status).toBe('onboarding');
      // Other edits to the onboarding property are unaffected.
      expect((await sp.db.from('properties').update({ city: 'Boulder' }).eq('id', id)).error).toBeNull();
    } finally {
      await sql().query('delete from public.properties where id = $1', [id]);
    }
  });

  it('room-count errors name the full range', async () => {
    const sp = await signIn(USER.spAdmin);
    const bad = await sp.db.rpc('create_property', { p_company_id: COMPANY.summit, p_code: 'SP-QABIG', p_name: 'QA Big', p_timezone: 'America/Denver', p_room_count: 100000 });
    expect(bad.error?.code).toBe('22023');
    expect(bad.error?.message).toBe('rooms must be a whole number between 1 and 99,999');
  });
});

describe('R2-17 paused ingestion sources', () => {
  it('refuse manual uploads', async () => {
    const svc = serviceDb();
    const sourceId = '90000000-0000-4000-8000-0000000000b2';
    await svc.from('ingestion_sources').upsert({ id: sourceId, company_id: COMPANY.harborview, name: 'QA paused manual', channel: 'manual', report_type: 'daily_performance', parser_key: 'hop.daily_performance.v1', active: false });
    const fin = await signIn(USER.hvFinance);
    const form = new FormData();
    form.set('company_id', COMPANY.harborview);
    form.set('report_type', 'daily_performance');
    form.set('source_id', sourceId);
    form.set('file', csvFile('paused.csv', 'property_code,business_date,rooms_sold,room_revenue\nHV-SEA,2024-11-07,100,20000'));
    const res = await call('/imports', { method: 'POST', body: form, token: fin.token });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('This source is paused');
    expect((await svc.from('import_runs').select('id').eq('source_id', sourceId)).data).toEqual([]);
  });
});

describe('R2-22 performance CSV coverage', () => {
  it('fills coverage for every property row', async () => {
    const fin = await signIn(USER.hvFinance);
    // A closed range in the current month (two days back keeps every hotel's local "yesterday" covered).
    const { rows: [r] } = await sql().query(`select to_char(least(current_date - 2, current_date - 2), 'YYYY-MM-DD') as "to",
      to_char(date_trunc('month', current_date - 2), 'YYYY-MM-DD') as "from"`);
    const { from, to } = r as { from: string; to: string };
    const res = await call(`/exports/performance.csv?company_id=${COMPANY.harborview}&from=${from}&to=${to}&grain=total&property_ids=${PROPERTY.sea},${PROPERTY.hnl}`, { token: fin.token });
    expect(res.status).toBe(200);
    const lines = (await res.text()).split(/\r?\n/);
    const header = lines.find((l) => l.startsWith('property_code'))!.split(',');
    const col = header.indexOf('coverage');
    expect(col).toBeGreaterThan(0);
    const expectedDays = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    for (const [code, pid] of [['HV-SEA', PROPERTY.sea], ['HV-HNL', PROPERTY.hnl]] as const) {
      const line = lines.find((l) => l.startsWith(`${code},`));
      expect(line, code).toBeDefined();
      const { rows: [c] } = await sql().query('select count(*)::int as n from public.daily_performance where property_id = $1 and business_date between $2 and $3', [pid, from, to]);
      const n = (c as { n: number }).n;
      const cell = line!.split(',')[col];
      expect(cell, code).toBe(n >= expectedDays ? 'complete' : `${n}/${expectedDays} days`);
    }
  });
});
