/**
 * Regression tests for QA round 1 findings (R1-xx ids in the fix list).
 * Every test leaves shared demo data as it found it so suite order does not matter.
 */
import { describe, expect, it } from 'vitest';
import { handleInboundEmail } from '@hop/api';
import { call, COMPANY, csvFile, drainQueue, MEMBERSHIP, PROPERTY, serviceDb, signIn, sql, stepUpToAal2, USER } from './helpers';

const HEADER = 'property_code,business_date,rooms_available,rooms_out_of_order,rooms_sold,rooms_comp,room_revenue,food_beverage_revenue,other_revenue,total_revenue';
const PDX_PROJECT = '81000000-0000-4000-8000-000000000004';

async function upload(token: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set('company_id', COMPANY.harborview);
  form.set('report_type', 'daily_performance');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', file);
  const res = await call('/imports', { method: 'POST', body: form, token });
  return (await res.json()) as { importRunId: string; status: string };
}

async function runOf(id: string) {
  await drainQueue();
  const { data } = await serviceDb().from('import_runs').select('*').eq('id', id).single();
  return data as Record<string, unknown> & { status: string; property_ids: string[] };
}

describe('R1-02 / R1-53 CapEx property integrity', () => {
  it('a Seattle GM cannot post spend or updates to a Portland project', async () => {
    const gm = await signIn(USER.hvGm);
    const tx = await gm.db.from('capex_transactions').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.sea, project_id: PDX_PROJECT, kind: 'actual', amount: 10,
      transaction_date: '2026-01-01', created_by: gm.userId, reference: 'xprop',
    });
    expect(tx.error).not.toBeNull();
    const up = await gm.db.from('capex_updates').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.sea, project_id: PDX_PROJECT, body: 'injected update', created_by: gm.userId,
    });
    expect(up.error).not.toBeNull();
    // Even the service role cannot create the mismatch (composite foreign key).
    const svc = await serviceDb().from('capex_transactions').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.sea, project_id: PDX_PROJECT, kind: 'actual', amount: 10, transaction_date: '2026-01-01',
    });
    expect(svc.error?.code).toBe('23503');
    const doc = await call('/documents/uploads', {
      method: 'POST', token: gm.token, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: COMPANY.harborview, property_id: PROPERTY.sea, category_key: 'other', title: 'Linked elsewhere', visibility: 'general',
        filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 10, linked_entity_type: 'capex_project', linked_entity_id: PDX_PROJECT }),
    });
    expect(doc.status).toBe(400);
  });

  it('quotes and commitments must be positive', async () => {
    const fin = await signIn(USER.hvFinance);
    const neg = await fin.db.from('capex_transactions').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.pdx, project_id: PDX_PROJECT, kind: 'commitment', amount: -500,
      transaction_date: '2026-01-01', created_by: fin.userId,
    });
    expect(neg.error?.code).toBe('23514');
  });
});

describe('R1-03 import run visibility covers every row', () => {
  it('a property-scoped viewer cannot see runs that mention other hotels; uploaders see their own', async () => {
    const fin = await signIn(USER.hvFinance);
    const gm = await signIn(USER.hvGm);
    const mixed = await upload(fin.token, csvFile('mixed.csv', `${HEADER}\nHV-SEA,2024-11-05,220,0,100,0,20000,,,\nHV-PDX,2024-11-05,148,0,abc,0,99999,,,`));
    const r1 = await runOf(mixed.importRunId);
    expect(r1.status).toBe('rejected');
    expect([...r1.property_ids].sort()).toEqual([PROPERTY.sea, PROPERTY.pdx].sort());
    const unknown = await upload(fin.token, csvFile('unknown.csv', `${HEADER}\nHV-SEA,2024-11-05,220,0,100,0,20000,,,\nZZ-9,2024-11-05,10,0,1,0,1,,,`));
    expect((await runOf(unknown.importRunId)).property_ids).toEqual([]);
    for (const id of [mixed.importRunId, unknown.importRunId]) {
      expect((await gm.db.from('import_runs').select('id').eq('id', id)).data).toEqual([]);
      expect((await gm.db.from('import_validation_issues').select('id').eq('import_run_id', id)).data).toEqual([]);
    }
    // A Seattle-only file stays visible to the Seattle GM (positive control).
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date = '2024-11-06'", [PROPERTY.sea]);
    const sea = await upload(fin.token, csvFile('sea.csv', `${HEADER}\nHV-SEA,2024-11-06,220,0,100,0,20000,,,`));
    expect((await runOf(sea.importRunId)).status).toBe('completed');
    expect((await gm.db.from('import_runs').select('id').eq('id', sea.importRunId)).data).toHaveLength(1);

    // The uploader keeps sight of their own rejected run.
    const admin = await signIn(USER.hvAdmin);
    await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvGm, p_permission: 'ingestion.manage', p_effect: 'allow' });
    try {
      const own = await upload(gm.token, csvFile('gm-own.csv', `${HEADER}\nZZ-9,2024-11-05,10,0,1,0,1,,,`));
      await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvGm, p_permission: 'ingestion.manage', p_effect: null });
      expect((await runOf(own.importRunId)).status).toBe('rejected');
      expect((await gm.db.from('import_runs').select('id').eq('id', own.importRunId)).data).toHaveLength(1);
    } finally {
      await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvGm, p_permission: 'ingestion.manage', p_effect: null });
    }
  });
});

describe('R1-33 re-uploading an original after a revision', () => {
  it('is processed as a revision instead of being dropped as a duplicate', async () => {
    const { token } = await signIn(USER.hvFinance);
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date = '2024-10-01'", [PROPERTY.pdx]);
    const original = `${HEADER}\nHV-PDX,2024-10-01,148,0,90,0,15000,,,`;
    const a = await upload(token, csvFile('orig.csv', original));
    expect((await runOf(a.importRunId)).status).toBe('completed');
    const b = await upload(token, csvFile('revised.csv', `${HEADER}\nHV-PDX,2024-10-01,148,0,95,0,15800,,,`), { replace_existing: 'true' });
    expect((await runOf(b.importRunId)).status).toBe('completed');
    const again = await upload(token, csvFile('orig-again.csv', original));
    expect(again.status).toBe('queued');
    expect(await runOf(again.importRunId)).toMatchObject({ status: 'needs_review', conflicts: 1 });
    // An unchanged re-send right after is still a duplicate of the latest effective import.
    const b2 = await upload(token, csvFile('revised-again.csv', `${HEADER}\nHV-PDX,2024-10-01,148,0,95,0,15800,,,`));
    expect(b2.status).toBe('duplicate');
  });
});

describe('R1-10 routed email sources without mappings', () => {
  it('reject internal property codes', async () => {
    const svc = serviceDb();
    const sourceId = '90000000-0000-4000-8000-0000000000a1';
    await svc.from('ingestion_sources').upsert({ id: sourceId, company_id: COMPANY.harborview, name: 'QA email no-map', channel: 'email', report_type: 'daily_performance', parser_key: 'hop.daily_performance.v1' });
    await svc.from('ingestion_source_routes').upsert({ source_id: sourceId, company_id: COMPANY.harborview, inbound_token: 'qanomap0001', allowed_senders: ['night@nomap.example'] });
    const to = 'reports+qanomap0001@inbound.portal.example';
    const mime = new TextEncoder().encode(['From: night@nomap.example', `To: ${to}`, 'Subject: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B',
      'Content-Type: text/csv; name="f.csv"', 'Content-Disposition: attachment; filename="f.csv"', '', 'property_code,business_date,rooms_sold,room_revenue', 'HV-SEA,2024-09-15,100,20000', '--B--', ''].join('\r\n'));
    const out = await handleInboundEmail(mime, { recipients: [to], spfVerdict: 'PASS', dkimVerdict: 'PASS' });
    expect(out.accepted).toBe(true);
    const r = await runOf(out.runs[0]!.importRunId);
    expect(r.status).toBe('rejected');
    const { data: iss } = await svc.from('import_validation_issues').select('code, message').eq('import_run_id', out.runs[0]!.importRunId);
    expect(iss!.map((i) => i.code)).toEqual(['unmapped_property']);
    expect(iss![0]!.message).toMatch(/for this source/);
    await svc.from('ingestion_sources').update({ active: false }).eq('id', sourceId);
  });
});

describe('R1-04 platform administration needs a 2FA-verified session', () => {
  it('aal1 platform writes are refused; aal2 succeeds', async () => {
    const pa = await signIn(USER.platform, undefined, true);
    const upd = await pa.db.from('companies').update({ require_mfa_for_privileged: false }).eq('id', COMPANY.summit).select('id');
    expect(upd.data ?? []).toEqual([]);
    expect((await pa.db.from('company_modules').update({ enabled: true }).eq('company_id', COMPANY.summit).eq('module', 'capex').select('module')).data ?? []).toEqual([]);
    const prov = await pa.db.rpc('provision_company', { p_slug: 'qa-aal1', p_name: 'QA aal1', p_portal_name: 'QA aal1', p_admin_email: 'qa@aal1.example' });
    expect(prov.error?.code).toBe('42501');
    // The console still loads at aal1.
    expect(((await pa.db.from('companies').select('id')).data ?? []).length).toBeGreaterThanOrEqual(2);
    const factor = await stepUpToAal2(pa.db);
    try {
      const ok = await pa.db.from('companies').update({ require_mfa_for_privileged: false }).eq('id', COMPANY.summit).select('id');
      expect(ok.data).toEqual([{ id: COMPANY.summit }]);
    } finally {
      await pa.db.auth.mfa.unenroll({ factorId: factor });
    }
  });
});

describe('R1-05 owners do not see internal review history', () => {
  it('owners see publication outcomes only; finance sees the whole trail', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: rid } = await fin.db.rpc('create_financial_report', { p_property_id: PROPERTY.sea, p_period_month: '2020-01-01', p_title: 'QA history' });
    const { data: acct } = await fin.db.from('financial_accounts').select('id').eq('company_id', COMPANY.harborview).eq('code', 'REV_ROOMS').single();
    await fin.db.from('financial_report_lines').insert({ company_id: COMPANY.harborview, property_id: PROPERTY.sea, financial_report_id: rid, account_id: acct!.id, amount: 100, source_account_code: 'QA-1' });
    expect((await fin.db.rpc('submit_financial_report', { p_report_id: rid, p_comment: 'Reviewer: check the rooms line' })).error).toBeNull();
    expect((await fin.db.rpc('publish_financial_report', { p_report_id: rid, p_comment: 'Published' })).error).toBeNull();
    const owner = await signIn(USER.olivia);
    const { data: ev } = await owner.db.from('publication_events').select('to_status, comment').eq('entity_id', rid);
    expect(ev).toEqual([{ to_status: 'published', comment: 'Published' }]);
    const { data: all } = await fin.db.from('publication_events').select('to_status').eq('entity_id', rid).order('id');
    expect(all!.map((e) => e.to_status)).toEqual(['draft', 'in_review', 'published']);
  });
});

describe('R1-06 company-wide writes need company-wide access', () => {
  it('a Seattle-only GM cannot write company-wide commentary or upload company-wide documents', async () => {
    const gm = await signIn(USER.hvGm);
    const c = await gm.db.from('management_commentary').insert({ company_id: COMPANY.harborview, property_id: null, period_month: '2026-08-01', section: 'other', body: 'GM company note', visibility: 'owner', status: 'published', created_by: gm.userId });
    expect(c.error).not.toBeNull();
    const up = await call('/documents/uploads', {
      method: 'POST', token: gm.token, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: COMPANY.harborview, property_id: null, category_key: 'other', title: 'Company-wide by GM', visibility: 'general', filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 10 }),
    });
    expect(up.status).toBe(403);
    // Corporate (all-properties) users still can.
    const ops = await signIn(USER.hvOps);
    const { data: ok, error } = await ops.db.from('management_commentary').insert({ company_id: COMPANY.harborview, property_id: null, period_month: '2026-08-01', section: 'other', body: 'Ops company note', visibility: 'internal', status: 'draft', created_by: ops.userId }).select('id').single();
    expect(error).toBeNull();
    await ops.db.from('management_commentary').delete().eq('id', ok!.id);
  });
});

describe('R1-08 / R1-11 / R1-34 access administration', () => {
  it('rejects past grant expiry and internal permissions for owners and investors; audits who got what', async () => {
    const admin = await signIn(USER.hvAdmin);
    const past = await admin.db.rpc('grant_property_access', { p_membership_id: MEMBERSHIP.ianHv, p_property_id: PROPERTY.sea, p_permissions: null, p_expires_at: '2020-01-01T00:00:00Z' });
    expect(past.error?.code).toBe('22023');
    const esc = await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.ianHv, p_permission: 'admin.users', p_effect: 'allow' });
    expect(esc.error?.code).toBe('22023');
    expect((await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.ianHv, p_permission: 'audit.view', p_effect: 'allow' })).error?.code).toBe('22023');

    expect((await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvGm, p_permission: 'capex.approve', p_effect: 'deny' })).error).toBeNull();
    const { data: audit } = await admin.db.from('audit_events').select('metadata, search_text').eq('entity_type', 'membership_permission_overrides').order('id', { ascending: false }).limit(1).single();
    expect(audit!.metadata).toMatchObject({ permission: 'capex.approve', effect: 'deny', user_email: USER.hvGm });
    expect(audit!.search_text).toContain(USER.hvGm);
    await admin.db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvGm, p_permission: 'capex.approve', p_effect: null });
  });
});

describe('R1-12 email route tokens', () => {
  it('cannot be set directly; rotations are recorded without the value', async () => {
    const fin = await signIn(USER.hvFinance);
    const SOURCE = '90000000-0000-4000-8000-000000000002';
    const direct = await fin.db.from('ingestion_source_routes').update({ inbound_token: 'attacker-chosen' }).eq('source_id', SOURCE);
    expect(direct.error).not.toBeNull();
    const { data: senders } = await fin.db.from('ingestion_source_routes').select('allowed_senders').eq('source_id', SOURCE).single();
    expect((await fin.db.from('ingestion_source_routes').update({ allowed_senders: senders!.allowed_senders }).eq('source_id', SOURCE)).error).toBeNull();
    const { data: token } = await fin.db.rpc('rotate_ingestion_route_token', { p_source_id: SOURCE });
    const { data: audit } = await (await signIn(USER.hvAdmin)).db.from('audit_events').select('metadata').eq('entity_type', 'ingestion_source_routes').eq('entity_id', SOURCE).order('id', { ascending: false }).limit(1).single();
    expect(audit!.metadata).toMatchObject({ token_changed: true });
    expect(JSON.stringify(audit)).not.toContain(String(token));
    await sql().query("update public.ingestion_source_routes set inbound_token = 'hvgl4p8q1z' where source_id = $1", [SOURCE]);
  });
});

describe('R1-13 owner package documents follow document visibility', () => {
  it('investors do not see titles of owner-only documents; adding a document twice is harmless', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: pkg, error } = await fin.db.rpc('create_reporting_package', { p_property_id: PROPERTY.sea, p_period_month: '2026-05-01', p_title: null });
    expect(error).toBeNull();
    const OWNER_DOC = '70000000-0000-4000-8000-000000000002';
    const GENERAL_DOC = '70000000-0000-4000-8000-000000000001';
    const first = await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: OWNER_DOC });
    const second = await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: OWNER_DOC });
    expect(second.data).toBe(first.data);
    await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: GENERAL_DOC });
    expect((await fin.db.rpc('publish_reporting_package', { p_package_id: pkg, p_comment: 'May' })).error).toBeNull();

    const ian = await signIn(USER.ian);
    const { data: forIan } = await ian.db.rpc('get_reporting_package', { p_package_id: pkg });
    const titles = (forIan.snapshot.documents as Array<{ title: string }>).map((d) => d.title);
    expect(titles).toEqual(['August 2026 P&L (PDF)']);
    expect(JSON.stringify(forIan)).not.toContain('insurance certificate');
    const { data: items } = await ian.db.from('reporting_package_items').select('title').eq('package_id', pkg);
    expect(JSON.stringify(items)).not.toContain('insurance certificate');
    const owner = await signIn(USER.olivia);
    const { data: forOwner } = await owner.db.rpc('get_reporting_package', { p_package_id: pkg });
    expect((forOwner.snapshot.documents as unknown[]).length).toBe(2);
    await sql().query('delete from public.reporting_packages where id = $1', [pkg]);
  });
});

describe('R1-14 / R1-16 CapEx routing and numbering', () => {
  it('refuses requests no one can approve, notifies only needed approvers and tells the requester the outcome', async () => {
    const ops = await signIn(USER.hvOps);
    const { data: sfoProject } = await ops.db.rpc('create_capex_project', { p_property_id: PROPERTY.sfo, p_title: 'QA lobby refresh', p_category: 'public_areas', p_description: null, p_requested_budget: 40000 });
    const stuck = await ops.db.rpc('submit_capex_request', { p_project_id: sfoProject, p_new_total: 40000, p_justification: 'Needs an owner approval step' });
    expect(stuck.error?.code).toBe('22023');
    expect(stuck.error?.message).toMatch(/No owner can approve CapEx requests for HV-SFO/);

    const { data: small } = await ops.db.rpc('create_capex_project', { p_property_id: PROPERTY.sea, p_title: 'QA small corporate-only', p_category: 'other', p_description: null, p_requested_budget: 5000 });
    const { data: smallReq, error } = await ops.db.rpc('submit_capex_request', { p_project_id: small, p_new_total: 5000, p_justification: 'Small item under owner threshold' });
    expect(error).toBeNull();
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('notifications').select('id').eq('entity_id', small)).data).toEqual([]);
    const ownerTry = await owner.db.rpc('decide_capex_request', { p_request_id: smallReq, p_decision: 'approved' });
    expect(ownerTry.error?.message).toBe('An owner approval is not required for this request');
    const fin = await signIn(USER.hvFinance);
    expect((await fin.db.from('notifications').select('kind').eq('entity_id', small)).data).toEqual([{ kind: 'capex_approval_requested' }]);
    expect((await fin.db.rpc('decide_capex_request', { p_request_id: smallReq, p_decision: 'approved' })).data).toBe('approved');
    expect((await ops.db.from('notifications').select('kind, title').eq('entity_id', small)).data).toEqual([{ kind: 'capex_request_decided', title: 'CapEx request approved: QA small corporate-only' }]);

    const { data: big } = await ops.db.rpc('create_capex_project', { p_property_id: PROPERTY.sea, p_title: 'QA owner-level item', p_category: 'other', p_description: null, p_requested_budget: 30000 });
    const { data: bigReq } = await ops.db.rpc('submit_capex_request', { p_project_id: big, p_new_total: 30000, p_justification: 'Above the owner threshold' });
    expect((await owner.db.from('notifications').select('kind').eq('entity_id', big)).data).toEqual([{ kind: 'capex_approval_requested' }]);
    expect((await owner.db.rpc('decide_capex_request', { p_request_id: bigReq, p_decision: 'rejected', p_comment: 'Not this year' })).data).toBe('rejected');
    const { data: n } = await ops.db.from('notifications').select('title, body').eq('entity_id', big);
    expect(n).toEqual([{ title: 'CapEx request rejected: QA owner-level item', body: 'Reason: Not this year' }]);
  });

  it('concurrent project creation allocates distinct numbers', async () => {
    const ops = await signIn(USER.hvOps);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => ops.db.rpc('create_capex_project', { p_property_id: PROPERTY.pdx, p_title: `QA concurrent ${i}`, p_category: 'other', p_description: null, p_requested_budget: 1000 })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    const { data } = await ops.db.from('capex_projects').select('project_number').in('id', results.map((r) => r.data as string));
    expect(new Set(data!.map((d) => d.project_number)).size).toBe(5);
  });
});

describe('R1-19 future periods', () => {
  it('statements and owner packages cannot be created for a future month', async () => {
    const fin = await signIn(USER.hvFinance);
    const d = new Date();
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    expect((await fin.db.rpc('create_financial_report', { p_property_id: PROPERTY.hnl, p_period_month: next, p_title: null })).error?.code).toBe('22023');
    expect((await fin.db.rpc('create_reporting_package', { p_property_id: PROPERTY.hnl, p_period_month: next, p_title: null })).error?.code).toBe('22023');
  });
});

describe('R1-22 / R1-23 / R1-50 setup and property administration', () => {
  it('setup status counts other members and pending invitations only', async () => {
    const admin = await signIn(USER.hvAdmin);
    const { data } = await admin.db.rpc('company_setup_status', { p_company_id: COMPANY.harborview });
    expect(data.other_members).toBeGreaterThan(0);
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('company_setup_status', { p_company_id: COMPANY.harborview })).error?.code).toBe('42501');
  });

  it('creates a property and its opening inventory atomically; invalid rooms create nothing', async () => {
    const sp = await signIn(USER.spAdmin);
    const bad = await sp.db.rpc('create_property', { p_company_id: COMPANY.summit, p_code: 'SP-QAR', p_name: 'QA Rooms', p_timezone: 'America/Denver', p_room_count: 0 });
    expect(bad.error?.code).toBe('22023');
    expect((await serviceDb().from('properties').select('id').eq('code', 'SP-QAR')).data).toEqual([]);
    const { data: id, error } = await sp.db.rpc('create_property', { p_company_id: COMPANY.summit, p_code: 'SP-QAR', p_name: 'QA Rooms', p_timezone: 'America/Denver', p_opened_on: '2026-09-01', p_room_count: 120 });
    expect(error).toBeNull();
    const { data: inv } = await serviceDb().from('room_inventory_history').select('room_count, effective_from').eq('property_id', id);
    expect(inv).toEqual([{ room_count: 120, effective_from: '2026-09-01' }]);
    await sql().query('delete from public.properties where id = $1', [id]);
  });

  it('opened-on cannot move after data already loaded', async () => {
    const admin = await signIn(USER.hvAdmin);
    const { error } = await admin.db.from('properties').update({ opened_on: '2026-10-01' }).eq('id', PROPERTY.sea);
    expect(error?.code).toBe('22023');
  });
});

describe('R1-27 budget notifications', () => {
  it('link to the approved budget version', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: v } = await fin.db.rpc('create_budget_version', { p_property_id: PROPERTY.pdx, p_fiscal_year: 2029, p_name: 'QA link test', p_copy_from: null });
    const { data: acct } = await fin.db.from('financial_accounts').select('id').eq('company_id', COMPANY.harborview).eq('code', 'REV_ROOMS').single();
    await fin.db.from('budget_lines').insert({ company_id: COMPANY.harborview, property_id: PROPERTY.pdx, budget_version_id: v, account_id: acct!.id, period_month: '2029-01-01', amount: 1 });
    expect((await fin.db.rpc('approve_budget_version', { p_version_id: v })).error).toBeNull();
    const owner = await signIn(USER.olivia);
    const { data: n } = await owner.db.from('notifications').select('link_path').eq('entity_id', v);
    expect(n).toEqual([{ link_path: `/financials/budgets/${v}` }]);
  });
});

describe('R1-28 / R1-31 mappings', () => {
  it('account mappings need a code; property-code mappings are case-insensitive', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: acct } = await fin.db.from('financial_accounts').select('id').eq('company_id', COMPANY.harborview).eq('code', 'REV_ROOMS').single();
    const blank = await fin.db.from('source_account_mappings').insert({ company_id: COMPANY.harborview, source_account_code: '   ', account_id: acct!.id });
    expect(blank.error?.code).toBe('23514');
    const SOURCE = '90000000-0000-4000-8000-000000000001';
    const { data: m, error } = await fin.db.from('ingestion_property_mappings').insert({ company_id: COMPANY.harborview, source_id: SOURCE, external_code: ' sea-qa ', property_id: PROPERTY.sea }).select('id, external_code').single();
    expect(error).toBeNull();
    expect(m!.external_code).toBe('SEA-QA');
    const dup = await fin.db.from('ingestion_property_mappings').insert({ company_id: COMPANY.harborview, source_id: SOURCE, external_code: 'Sea-Qa', property_id: PROPERTY.pdx });
    expect(dup.error?.code).toBe('23505');
    await fin.db.from('ingestion_property_mappings').delete().eq('id', m!.id);
  });
});

describe('R1-18 documents without a released version', () => {
  it('are hidden from viewers but visible to the uploader and document managers', async () => {
    const svc = serviceDb();
    const gm = await signIn(USER.hvGm);
    const { data: doc } = await svc.from('documents').insert({ company_id: COMPANY.harborview, property_id: PROPERTY.sea, category_key: 'other', title: 'QA pending upload', visibility: 'general', created_by: gm.userId }).select('id').single();
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('documents').select('id').eq('id', doc!.id)).data).toEqual([]);
    expect((await gm.db.from('documents').select('id').eq('id', doc!.id)).data).toHaveLength(1);
    const fin = await signIn(USER.hvFinance);
    expect((await fin.db.from('documents').select('id').eq('id', doc!.id)).data).toHaveLength(1);
    await svc.from('documents').update({ status: 'archived' }).eq('id', doc!.id);
  });
});
