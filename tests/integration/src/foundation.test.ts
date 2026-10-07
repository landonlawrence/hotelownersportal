import { afterAll, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { PERMISSION_KEYS } from '@hop/core';
import { anonClient, COMPANY, MEMBERSHIP, PROPERTY, serviceDb, signIn, sql, USER } from './helpers';

const codes = (rows: Array<{ code: string }> | null) => (rows ?? []).map((r) => r.code).sort();

describe('company and property isolation (RLS)', () => {
  it('owner sees only granted properties across both companies', async () => {
    const { db } = await signIn(USER.olivia);
    const { data } = await db.from('properties').select('code');
    expect(codes(data)).toEqual(['HV-PDX', 'HV-SEA', 'SP-DEN']);
  });

  it('company admins cannot see the other company', async () => {
    const hv = await signIn(USER.hvAdmin);
    const { data: hvProps } = await hv.db.from('properties').select('code');
    expect(codes(hvProps).every((c) => c.startsWith('HV-'))).toBe(true);
    expect(codes(hvProps)).toHaveLength(4);
    const { data: summit } = await hv.db.from('companies').select('id').eq('id', COMPANY.summit);
    expect(summit).toEqual([]);
    const { data: perf } = await hv.db.from('daily_performance').select('id').eq('company_id', COMPANY.summit).limit(1);
    expect(perf).toEqual([]);

    const sp = await signIn(USER.spAdmin);
    const { data: spProps } = await sp.db.from('properties').select('code');
    expect(codes(spProps)).toEqual(['SP-AUS', 'SP-DEN', 'SP-MIA']);
    const { data: hvMembers } = await sp.db.from('company_memberships').select('id').eq('company_id', COMPANY.harborview);
    expect(hvMembers).toEqual([]);
  });

  it('owner cannot read other members, invitations or audit events', async () => {
    const { db, userId } = await signIn(USER.olivia);
    const { data: members } = await db.from('company_memberships').select('user_id');
    expect(new Set((members ?? []).map((m) => m.user_id))).toEqual(new Set([userId]));
    expect((await db.from('invitations').select('id')).data).toEqual([]);
    expect((await db.from('audit_events').select('id').limit(5)).data).toEqual([]);
    expect((await db.from('profiles').select('id')).data?.map((p) => p.id)).toEqual([userId]);
  });

  it('investor with a restricted grant sees performance but not financials, budgets or owner documents', async () => {
    const { db } = await signIn(USER.ian);
    expect(codes((await db.from('properties').select('code')).data)).toEqual(['HV-SEA']);
    const { count: perf } = await db.from('daily_performance').select('id', { count: 'exact', head: true });
    expect(perf).toBeGreaterThan(100);
    expect((await db.from('financial_reports').select('id').limit(1)).data).toEqual([]);
    expect((await db.from('budget_versions').select('id').limit(1)).data).toEqual([]);
    expect((await db.from('capex_projects').select('id').limit(1)).data).toEqual([]);
    const { data: docs } = await db.from('documents').select('visibility');
    expect(new Set((docs ?? []).map((d) => d.visibility))).toEqual(new Set(['general']));
    const { data: commentary } = await db.from('management_commentary').select('visibility, status');
    expect((commentary ?? []).every((c) => c.visibility === 'owner' && c.status === 'published')).toBe(true);
  });

  it('owner never sees internal notes, confidential documents or draft financials', async () => {
    const { db } = await signIn(USER.olivia);
    const { data: docs } = await db.from('documents').select('visibility');
    expect((docs ?? []).some((d) => d.visibility === 'confidential' || d.visibility === 'internal')).toBe(false);
    const { data: notes } = await db.from('management_commentary').select('visibility');
    expect((notes ?? []).some((n) => n.visibility === 'internal')).toBe(false);
    const { data: reports } = await db.from('financial_reports').select('status');
    expect(new Set((reports ?? []).map((r) => r.status))).toEqual(new Set(['published', 'superseded']));
    const { data: updates } = await db.from('capex_updates').select('visibility');
    expect((updates ?? []).every((u) => u.visibility === 'owner')).toBe(true);
  });

  it('revoked users lose all access', async () => {
    const { db } = await signIn(USER.rita);
    expect((await db.from('properties').select('id')).data).toEqual([]);
    expect((await db.from('daily_performance').select('id').limit(1)).data).toEqual([]);
    const { data: ctx } = await db.rpc('my_context');
    expect(ctx.companies).toEqual([]);
  });

  it('anonymous requests see nothing', async () => {
    const db = anonClient();
    const { data, error } = await db.from('properties').select('id');
    expect(data ?? []).toEqual([]);
    expect(error?.code ?? 'denied').toBeTruthy();
    const { error: rpcErr } = await db.rpc('my_context');
    expect(rpcErr).not.toBeNull();
  });
});

describe('direct API write attempts are rejected', () => {
  it('owner cannot write operating, financial or access tables', async () => {
    const { db } = await signIn(USER.olivia);
    const ins = await db.from('daily_performance').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.sea, business_date: '2026-01-01', physical_rooms: 1, rooms_sold: 1, room_revenue: 1,
    });
    expect(ins.error).not.toBeNull();
    const grant = await db.from('property_access_grants').insert({ company_id: COMPANY.harborview, membership_id: MEMBERSHIP.oliviaHv, property_id: PROPERTY.sfo });
    expect(grant.error).not.toBeNull();
    const upd = await db.from('financial_reports').update({ title: 'hacked' }).eq('property_id', PROPERTY.sea).select('id');
    expect(upd.data ?? []).toEqual([]);
    const self = await db.rpc('grant_property_access', { p_membership_id: MEMBERSHIP.oliviaHv, p_property_id: PROPERTY.sfo });
    expect(self.error?.code).toBe('42501');
  });

  it('service-only functions are not callable by users', async () => {
    const { db, userId } = await signIn(USER.hvAdmin);
    const r1 = await db.rpc('svc_user_has_permission', { p_user: userId, p_perm: 'admin.users', p_company_id: COMPANY.harborview, p_property_id: null });
    expect(r1.error).not.toBeNull();
    const r2 = await db.rpc('svc_apply_daily_performance', { p_import_run_id: '61000000-0000-4000-8000-000000000001', p_records: [], p_replace: true, p_dry_run: true });
    expect(r2.error).not.toBeNull();
  });

  it('records cannot reference another company’s property (composite foreign keys)', async () => {
    const svc = serviceDb();
    const { error } = await svc.from('daily_performance').insert({
      company_id: COMPANY.harborview, property_id: PROPERTY.den, business_date: '2020-01-01', physical_rooms: 10, rooms_sold: 1, room_revenue: 100,
    });
    expect(error?.code).toBe('23503');
    const { error: e2 } = await svc.from('capex_projects').insert({
      company_id: COMPANY.summit, property_id: PROPERTY.sea, project_number: 'X-1', title: 'Cross company', category: 'other', requested_budget: 10,
    });
    expect(e2?.code).toBe('23503');
  });

  it('admins cannot grant access to another company’s property or escalate themselves', async () => {
    const { db } = await signIn(USER.hvAdmin);
    const cross = await db.rpc('grant_property_access', { p_membership_id: MEMBERSHIP.oliviaHv, p_property_id: PROPERTY.den });
    expect(cross.error?.message).toMatch(/does not belong/);
    const selfAllow = await db.rpc('set_permission_override', { p_membership_id: MEMBERSHIP.hvAdmin, p_permission: 'audit.view', p_effect: 'allow' });
    expect(selfAllow.error?.code).toBe('42501');
    const last = await db.rpc('revoke_membership', { p_membership_id: MEMBERSHIP.hvAdmin, p_reason: 'test' });
    expect(last.error?.message).toMatch(/last company administrator/);
  });
});

describe('revocation takes effect immediately', () => {
  afterAll(async () => {
    const { db } = await signIn(USER.hvAdmin);
    await db.rpc('grant_property_access', { p_membership_id: MEMBERSHIP.oliviaHv, p_property_id: PROPERTY.pdx });
  });

  it('revoking a property grant removes data access without a new login', async () => {
    const owner = await signIn(USER.olivia);
    const before = await owner.db.from('daily_performance').select('id', { count: 'exact', head: true }).eq('property_id', PROPERTY.pdx);
    expect(before.count).toBeGreaterThan(0);
    const admin = await signIn(USER.hvAdmin);
    const { data: grant } = await admin.db.from('property_access_grants').select('id').eq('membership_id', MEMBERSHIP.oliviaHv).eq('property_id', PROPERTY.pdx).is('revoked_at', null).single();
    expect((await admin.db.rpc('revoke_property_access', { p_grant_id: grant!.id })).error).toBeNull();
    const after = await owner.db.from('daily_performance').select('id', { count: 'exact', head: true }).eq('property_id', PROPERTY.pdx);
    expect(after.count).toBe(0);
    expect(codes((await owner.db.from('properties').select('code')).data)).toEqual(['HV-SEA', 'SP-DEN']);
    const { data: audit } = await admin.db.from('audit_events').select('action, entity_type').eq('entity_type', 'property_access_grants').eq('entity_id', grant!.id);
    expect(audit?.map((a) => a.action)).toContain('update');
  });
});

describe('invitations', () => {
  it('invite → sign up → accept creates membership and property grants', async () => {
    const admin = await signIn(USER.hvAdmin);
    const email = `new.owner.${Date.now()}@owners.example`;
    const { data: inv, error } = await admin.db.rpc('create_invitation', {
      p_company_id: COMPANY.harborview, p_email: email, p_role: 'owner', p_all_properties: false, p_property_ids: [PROPERTY.hnl], p_expires_in_days: 7,
    });
    expect(error).toBeNull();

    // Another user cannot accept it.
    const other = await signIn(USER.ian, undefined, true);
    expect((await other.db.rpc('accept_invitation', { p_token: inv.token })).error?.code).toBe('42501');

    const db = anonClient();
    const { data: su, error: suErr } = await db.auth.signUp({ email, password: 'Sup3r-secret-pass!' });
    expect(suErr).toBeNull();
    expect(su.session).not.toBeNull();
    // Before accepting: nothing visible.
    expect((await db.from('properties').select('id')).data).toEqual([]);
    expect((await db.rpc('accept_invitation', { p_token: inv.token })).error).toBeNull();
    expect(codes((await db.from('properties').select('code')).data)).toEqual(['HV-HNL']);
    // Token is single-use.
    expect((await db.rpc('accept_invitation', { p_token: inv.token })).error?.code).toBe('22023');
  });

  it('owners and investors cannot be given company-wide access', async () => {
    const admin = await signIn(USER.hvAdmin);
    const { error } = await admin.db.rpc('create_invitation', {
      p_company_id: COMPANY.harborview, p_email: 'x@owners.example', p_role: 'investor', p_all_properties: true, p_property_ids: [], p_expires_in_days: 7,
    });
    expect(error?.code).toBe('22023');
  });

  it('non-admins cannot invite', async () => {
    const owner = await signIn(USER.olivia);
    const { error } = await owner.db.rpc('create_invitation', {
      p_company_id: COMPANY.harborview, p_email: 'y@owners.example', p_role: 'owner', p_all_properties: false, p_property_ids: [PROPERTY.sea], p_expires_in_days: 7,
    });
    expect(error?.code).toBe('42501');
  });
});

describe('branding and company switching', () => {
  it('resolves verified domains only; domains never grant access', async () => {
    const db = anonClient();
    const hv = (await db.rpc('resolve_branding', { p_host: 'Harborview.localhost:5173' })).data;
    expect(hv).toMatchObject({ company_slug: 'harborview', portal_name: 'Harborview Owner Portal', primary_color: '#0f3d5e', is_demo: true });
    const sp = (await db.rpc('resolve_branding', { p_host: 'summit.localhost' })).data;
    expect(sp.company_slug).toBe('summit');
    expect((await db.rpc('resolve_branding', { p_host: 'owners.harborview.example' })).data).toBeNull(); // pending verification
    expect((await db.rpc('resolve_branding', { p_host: 'evil.example' })).data).toBeNull();
    // Branding lookup returns presentation only; anonymous users still see no data.
    expect((await db.from('company_branding').select('*')).data ?? []).toEqual([]);
  });

  it('multi-company owner gets both companies with separate branding and permissions', async () => {
    const { db } = await signIn(USER.olivia);
    const { data: ctx } = await db.rpc('my_context');
    const companies = ctx.companies as Array<{ company_slug: string; role: string; branding: { portal_name: string }; company_permissions: string[] }>;
    expect(companies.map((c) => c.company_slug).sort()).toEqual(['harborview', 'summit']);
    expect(companies.find((c) => c.company_slug === 'summit')!.branding.portal_name).toBe('Summit Peak Investor Center');
    expect(ctx.cross_company_rollups_enabled).toBe(false);
    // Company-scoped queries return only that company's rows even for a multi-company user.
    const { data: perf } = await db.rpc('performance_rollup', { p_company_id: COMPANY.summit, p_from: '2026-01-01', p_to: '2026-01-31', p_grain: 'total', p_property_ids: null });
    expect((perf as Array<{ property_id: string }>).map((r) => r.property_id)).toEqual([PROPERTY.den]);
  });

  it('per-property permissions reflect grants', async () => {
    const { db } = await signIn(USER.ian);
    const { data } = await db.rpc('my_property_permissions', { p_company_id: COMPANY.harborview });
    const perms = (data as Array<{ property_id: string; permission_key: string }>).map((p) => p.permission_key).sort();
    expect(perms).toEqual(['commentary.view', 'documents.view', 'performance.view', 'reports.view']);
  });
});

describe('MFA for privileged permissions', () => {
  afterAll(async () => {
    await sql().query('update public.companies set require_mfa_for_privileged = false where id = $1', [COMPANY.harborview]);
  });

  it('privileged permissions require aal2 when the company enforces MFA', async () => {
    await sql().query('update public.companies set require_mfa_for_privileged = true where id = $1', [COMPANY.harborview]);
    const fin = await signIn(USER.hvFinance, undefined, true);
    const { data: drafts } = await fin.db.from('financial_reports').select('id').in('status', ['draft', 'in_review']).eq('company_id', COMPANY.harborview);
    expect(drafts).toEqual([]); // view_draft is privileged
    const { count: published } = await fin.db.from('financial_reports').select('id', { count: 'exact', head: true }).eq('status', 'published');
    expect(published).toBeGreaterThan(0); // financials.view is not privileged
    const { data: ctx } = await fin.db.rpc('my_context');
    const hv = (ctx.companies as Array<{ company_slug: string; mfa_blocked_permissions: string[] }>).find((c) => c.company_slug === 'harborview')!;
    expect(hv.mfa_blocked_permissions).toContain('financials.publish');

    // Enroll TOTP and step up to aal2.
    const { data: enroll, error: enrollErr } = await fin.db.auth.mfa.enroll({ factorType: 'totp', friendlyName: `test-${Date.now()}` });
    expect(enrollErr).toBeNull();
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll!.totp.secret) });
    const { data: ch } = await fin.db.auth.mfa.challenge({ factorId: enroll!.id });
    const { error: vErr } = await fin.db.auth.mfa.verify({ factorId: enroll!.id, challengeId: ch!.id, code: totp.generate() });
    expect(vErr).toBeNull();
    const { data: aal } = await fin.db.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal?.currentLevel).toBe('aal2');
    const { data: drafts2 } = await fin.db.from('financial_reports').select('id').in('status', ['draft', 'in_review']).eq('company_id', COMPANY.harborview);
    expect((drafts2 ?? []).length).toBeGreaterThan(0);
    await fin.db.auth.mfa.unenroll({ factorId: enroll!.id });
  });
});

describe('platform support access', () => {
  it('platform admins have no implicit financial access; support sessions are MFA-gated, scoped, audited and read-only', async () => {
    const pa = await signIn(USER.platform, undefined, true);
    expect((await pa.db.from('daily_performance').select('id').limit(1)).data).toEqual([]);
    expect((await pa.db.from('financial_reports').select('id').limit(1)).data).toEqual([]);
    // Platform admins can manage company configuration.
    expect(((await pa.db.from('companies').select('slug')).data ?? []).length).toBe(2);

    const noMfa = await pa.db.rpc('open_support_session', { p_company_id: COMPANY.harborview, p_reason: 'Investigating import issue', p_ticket_ref: 'SUP-1', p_hours: 2 });
    expect(noMfa.error?.message).toMatch(/MFA/);

    const { data: enroll } = await pa.db.auth.mfa.enroll({ factorType: 'totp', friendlyName: `pa-${Date.now()}` });
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll!.totp.secret) });
    const { data: ch } = await pa.db.auth.mfa.challenge({ factorId: enroll!.id });
    await pa.db.auth.mfa.verify({ factorId: enroll!.id, challengeId: ch!.id, code: totp.generate() });

    const tooLong = await pa.db.rpc('open_support_session', { p_company_id: COMPANY.harborview, p_reason: 'Investigating import issue', p_ticket_ref: 'SUP-1', p_hours: 48 });
    expect(tooLong.error).not.toBeNull();
    const { data: sessionId, error } = await pa.db.rpc('open_support_session', { p_company_id: COMPANY.harborview, p_reason: 'Investigating import issue', p_ticket_ref: 'SUP-1', p_hours: 2 });
    expect(error).toBeNull();

    const { count } = await pa.db.from('daily_performance').select('id', { count: 'exact', head: true }).eq('company_id', COMPANY.harborview);
    expect(count).toBeGreaterThan(0);
    expect((await pa.db.from('daily_performance').select('id').eq('company_id', COMPANY.summit).limit(1)).data).toEqual([]);
    const { data: docs } = await pa.db.from('documents').select('visibility').eq('company_id', COMPANY.harborview);
    expect((docs ?? []).every((d) => d.visibility === 'general')).toBe(true);
    const publish = await pa.db.rpc('publish_financial_report', { p_report_id: '00000000-0000-0000-0000-000000000000' });
    expect(publish.error?.code).toBe('42501');

    const admin = await signIn(USER.hvAdmin);
    const { data: audit } = await admin.db.from('audit_events').select('action, actor_kind').eq('entity_type', 'support_access_sessions').eq('entity_id', sessionId);
    expect(audit?.[0]).toMatchObject({ action: 'insert' });
    // Company admins can see and end support sessions on their company.
    expect((await admin.db.rpc('end_support_session', { p_session_id: sessionId })).error).toBeNull();
    expect((await pa.db.from('daily_performance').select('id').eq('company_id', COMPANY.harborview).limit(1)).data).toEqual([]);
    await pa.db.auth.mfa.unenroll({ factorId: enroll!.id });
  });
});

describe('permission catalogue', () => {
  it('database permissions match the shared catalogue', async () => {
    const { rows } = await sql().query('select key from public.permissions order by key');
    expect(rows.map((r) => r.key)).toEqual([...PERMISSION_KEYS].sort());
  });

  it('every public table has row level security enabled', async () => {
    const { rows } = await sql().query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('anon role has no table privileges in public', async () => {
    const { rows } = await sql().query(
      `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(rows).toEqual([]);
  });
});
