import { afterAll, describe, expect, it } from 'vitest';
import { handleInboundEmail } from '@hop/api';
import { call, COMPANY, csvFile, drainQueue, PROPERTY, serviceDb, signIn, sql, USER } from './helpers';

const PDF_MAGIC = '%PDF-';

describe('branded PDF exports', () => {
  it('owners download published statements as PDF; drafts and unauthorized hotels are 404', async () => {
    const { token } = await signIn(USER.olivia);
    const svc = serviceDb();
    const { data: pub } = await svc.from('financial_reports').select('id').eq('property_id', PROPERTY.sea).eq('status', 'published').limit(1).single();
    const res = await call(`/exports/financial-reports/${pub!.id}.pdf`, { token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
    expect(bytes.byteLength).toBeGreaterThan(2000);

    const { data: draft } = await svc.from('financial_reports').select('id').eq('property_id', PROPERTY.pdx).in('status', ['draft', 'in_review']).limit(1).maybeSingle();
    if (draft) expect((await call(`/exports/financial-reports/${draft.id}.pdf`, { token })).status).toBe(404);
    const { data: sfo } = await svc.from('financial_reports').select('id').eq('property_id', PROPERTY.sfo).eq('status', 'published').limit(1).single();
    expect((await call(`/exports/financial-reports/${sfo!.id}.pdf`, { token })).status).toBe(404);
  });

  it('finance can export a draft, which is watermarked as not for distribution', async () => {
    const { token } = await signIn(USER.hvFinance);
    const { data: draft } = await serviceDb().from('financial_reports').select('id').eq('company_id', COMPANY.harborview).in('status', ['draft', 'in_review']).limit(1).single();
    const res = await call(`/exports/financial-reports/${draft!.id}.pdf`, { token });
    expect(res.status).toBe(200);
  });

  it('package PDFs follow package visibility and are audited', async () => {
    const svc = serviceDb();
    const { data: pkg } = await svc.from('reporting_packages').select('id').eq('property_id', PROPERTY.sea).eq('status', 'published').limit(1).single();
    const ian = await signIn(USER.ian);
    const res = await call(`/exports/packages/${pkg!.id}.pdf`, { token: ian.token });
    expect(res.status).toBe(200);
    const rita = await signIn(USER.rita);
    expect((await call(`/exports/packages/${pkg!.id}.pdf`, { token: rita.token })).status).toBe(404);
    const { data: audit } = await svc.from('audit_events').select('actor_user_id').eq('action', 'export.reporting_package_pdf').eq('entity_id', pkg!.id);
    expect(audit!.some((a) => a.actor_user_id === ian.userId)).toBe(true);
  });

  it('the API is also served under /api (CloudFront + WAF path)', async () => {
    expect((await call('/api/health')).status).toBe(200);
    const { token } = await signIn(USER.olivia);
    expect((await call(`/api/exports/performance.csv?company_id=${COMPANY.harborview}&from=2026-01-01&to=2026-01-31&property_ids=${PROPERTY.sfo}`, { token })).status).toBe(403);
    expect((await call('/api/nope')).status).toBe(404);
  });
});

describe('room inventory changes', () => {
  it('only company admins can change inventory; periods close and reopen without overlap', async () => {
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('set_room_inventory', { p_property_id: PROPERTY.sea, p_effective_from: '2026-11-01', p_room_count: 230, p_reason: 'x' })).error?.code).toBe('42501');
    const admin = await signIn(USER.hvAdmin);
    expect((await admin.db.rpc('set_room_inventory', { p_property_id: PROPERTY.sea, p_effective_from: '2010-01-01', p_room_count: 230, p_reason: 'Backdated' })).error?.code).toBe('22023');
    expect((await admin.db.rpc('set_room_inventory', { p_property_id: PROPERTY.sea, p_effective_from: '2024-12-01', p_room_count: 220, p_reason: 'Same' })).error?.message).toMatch(/unchanged/);
    expect((await admin.db.rpc('set_room_inventory', { p_property_id: PROPERTY.sea, p_effective_from: '2024-12-01', p_room_count: 224, p_reason: 'Four rooms converted from offices' })).error).toBeNull();
    const { data } = await admin.db.from('room_inventory_history').select('room_count, effective_from, effective_to').eq('property_id', PROPERTY.sea).order('effective_from');
    expect(data!.map((r) => `${r.room_count}:${r.effective_from}:${r.effective_to}`)).toEqual(['220:2015-06-01:2024-12-01', '224:2024-12-01:null']);
    // Imports without rooms_available use the inventory in effect on each business date.
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date in ('2024-11-30','2024-12-02')", [PROPERTY.sea]);
    const fin = await signIn(USER.hvFinance);
    const form = new FormData();
    form.set('company_id', COMPANY.harborview);
    form.set('report_type', 'daily_performance');
    form.set('file', csvFile('inv.csv', 'property_code,business_date,rooms_sold,room_revenue\nHV-SEA,2024-11-30,100,20000\nHV-SEA,2024-12-02,100,20000'));
    await call('/imports', { method: 'POST', body: form, token: fin.token });
    await drainQueue();
    const { rows } = await sql().query("select business_date::text d, physical_rooms from public.daily_performance where property_id = $1 and business_date in ('2024-11-30','2024-12-02') order by 1", [PROPERTY.sea]);
    expect(rows).toEqual([{ d: '2024-11-30', physical_rooms: 220 }, { d: '2024-12-02', physical_rooms: 224 }]);
  });

  it('admins create properties in their own company only', async () => {
    const admin = await signIn(USER.hvAdmin);
    const { data: newId, error } = await admin.db.rpc('create_property', { p_company_id: COMPANY.harborview, p_code: 'hv-bos', p_name: 'Harborview Boston Seaport', p_timezone: 'America/New_York', p_status: 'onboarding' });
    expect(error).toBeNull();
    const ok = { data: { id: newId as string } };
    const { data: created } = await admin.db.from('properties').select('code, currency').eq('id', newId).single();
    expect(created).toEqual({ code: 'HV-BOS', currency: 'USD' });
    const { data: cfg } = await admin.db.from('property_reporting_config').select('ooo_treatment').eq('property_id', ok.data!.id).single();
    expect(cfg!.ooo_treatment).toBe('exclude');
    expect((await admin.db.rpc('create_property', { p_company_id: COMPANY.summit, p_code: 'SP-XXX', p_name: 'Not mine', p_timezone: 'America/Denver' })).error?.code).toBe('42501');
    expect((await admin.db.from('properties').insert({ company_id: COMPANY.summit, code: 'SP-XXX', name: 'Not mine', timezone: 'America/Denver' })).error).not.toBeNull();
    expect((await admin.db.rpc('create_property', { p_company_id: COMPANY.harborview, p_code: 'HV-TZ', p_name: 'Bad tz', p_timezone: 'Mars/Olympus' })).error?.code).toBe('22023');
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('create_property', { p_company_id: COMPANY.harborview, p_code: 'HV-OWN', p_name: 'Owner made', p_timezone: 'UTC' })).error?.code).toBe('42501');
    // The owner does not see the new property (no grant), corporate users do.
    expect((await owner.db.from('properties').select('id').eq('id', ok.data!.id)).data).toEqual([]);
    const ops = await signIn(USER.hvOps);
    expect((await ops.db.from('properties').select('id').eq('id', ok.data!.id)).data).toHaveLength(1);
  });
});

describe('email route management', () => {
  const SOURCE = '90000000-0000-4000-8000-000000000001';
  // Restore the seeded route so other suites' email tests are order-independent.
  afterAll(async () => {
    await sql().query("update public.ingestion_source_routes set inbound_token = 'hvflash7k2m9', allowed_senders = array['nightaudit@harborview.example', '@pms.harborview.example'] where source_id = $1", [SOURCE]);
  });
  const mime = (to: string) =>
    new TextEncoder().encode(['From: nightaudit@harborview.example', `To: ${to}`, 'Subject: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B',
      'Content-Type: text/csv; name="f.csv"', 'Content-Disposition: attachment; filename="f.csv"', '', 'property_code,business_date,rooms_sold,room_revenue', 'SEA01,2024-12-15,100,20000', '--B--', ''].join('\r\n'));

  it('rotating the token requires ingestion.manage, invalidates the old address and is audited without the secret', async () => {
    const gm = await signIn(USER.hvGm);
    expect((await gm.db.rpc('rotate_ingestion_route_token', { p_source_id: SOURCE })).error?.code).toBe('42501');
    const fin = await signIn(USER.hvFinance);
    const { data: before } = await fin.db.from('ingestion_source_routes').select('inbound_token').eq('source_id', SOURCE).single();
    const { data: token, error } = await fin.db.rpc('rotate_ingestion_route_token', { p_source_id: SOURCE });
    expect(error).toBeNull();
    expect(token).not.toBe(before!.inbound_token);
    const oldAddr = `reports+${before!.inbound_token}@inbound.portal.example`;
    expect((await handleInboundEmail(mime(oldAddr), { recipients: [oldAddr], spfVerdict: 'PASS', dkimVerdict: 'PASS' })).accepted).toBe(false);
    const newAddr = `reports+${token}@inbound.portal.example`;
    expect((await handleInboundEmail(mime(newAddr), { recipients: [newAddr], spfVerdict: 'PASS', dkimVerdict: 'PASS' })).accepted).toBe(true);
    const admin = await signIn(USER.hvAdmin);
    const { data: audit } = await admin.db.from('audit_events').select('action, metadata').eq('company_id', COMPANY.harborview).order('id', { ascending: false }).limit(50);
    expect(audit!.some((a) => a.action === 'ingestion.route_token_rotated')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(String(token));
  });

  it('allowed-sender changes are audited; owners cannot read routes', async () => {
    const fin = await signIn(USER.hvFinance);
    await fin.db.from('ingestion_source_routes').update({ allowed_senders: ['nightaudit@harborview.example', '@pms.harborview.example', 'backup@harborview.example'] }).eq('source_id', SOURCE);
    const admin = await signIn(USER.hvAdmin);
    const { data } = await admin.db.from('audit_events').select('metadata').eq('entity_type', 'ingestion_source_routes').eq('entity_id', SOURCE).order('id', { ascending: false }).limit(1);
    expect(JSON.stringify(data![0]!.metadata)).toContain('backup@harborview.example');
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('ingestion_source_routes').select('inbound_token')).data).toEqual([]);
  });
});

describe('notification email preferences', () => {
  it('disabling email keeps the in-app notification but queues no email', async () => {
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('notification_preferences').upsert({ user_id: owner.userId, company_id: COMPANY.harborview, kind: 'budget_approved', email_enabled: false }, { onConflict: 'user_id,company_id,kind' })).error).toBeNull();
    // Preferences of other users are not writable.
    const ian = await signIn(USER.ian);
    expect((await ian.db.from('notification_preferences').insert({ user_id: owner.userId, company_id: COMPANY.harborview, kind: 'x', email_enabled: true })).error).not.toBeNull();
    const fin = await signIn(USER.hvFinance);
    const { data: v } = await fin.db.rpc('create_budget_version', { p_property_id: PROPERTY.pdx, p_fiscal_year: 2028, p_name: 'Pref test', p_copy_from: null });
    const { data: acct } = await fin.db.from('financial_accounts').select('id').eq('company_id', COMPANY.harborview).eq('code', 'REV_ROOMS').single();
    await fin.db.from('budget_lines').insert({ company_id: COMPANY.harborview, property_id: PROPERTY.pdx, budget_version_id: v, account_id: acct!.id, period_month: '2028-01-01', amount: 1 });
    expect((await fin.db.rpc('approve_budget_version', { p_version_id: v })).error).toBeNull();
    const { data: n } = await owner.db.from('notifications').select('id').eq('entity_id', v);
    expect(n).toHaveLength(1);
    const { count } = await serviceDb().from('notification_outbox').select('id', { count: 'exact', head: true }).eq('notification_id', n![0]!.id);
    expect(count).toBe(0);
  });
});
