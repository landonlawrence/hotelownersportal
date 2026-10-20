// Operator console: platform RPCs for onboarding and managing companies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, COMPANY, serviceDb, signIn, sql, stepUpToAal2, USER, type Session } from './helpers';

let pa: Session;
let factor: string;
const stamp = Date.now();
const slug = `qa-console-${stamp}`;

beforeAll(async () => {
  pa = await signIn(USER.platform, undefined, true);
});
afterAll(async () => {
  if (factor) await pa.db.auth.mfa.unenroll({ factorId: factor });
});

function provisionPayload(extra: Record<string, unknown> = {}) {
  return {
    name: 'QA Console Hotels',
    slug,
    legal_name: 'QA Console Hotels LLC',
    currency: 'CAD',
    require_mfa: true,
    modules: ['performance', 'financials', 'documents'],
    admins: [`admin.${stamp}@console.example`, `ops.${stamp}@console.example`],
    branding: { portal_name: 'QA Console Portal', primary_color: '#24453f', accent_color: '#d29b47', support_email: 'help@console.example' },
    properties: [
      { code: 'qc-asp', name: 'QA Aspen', city: 'Aspen', region: 'CO', timezone: 'America/Denver', rooms: 112, opened_on: '2024-05-01', status: 'active' },
      { code: 'QC-SB', name: 'QA Santa Barbara', timezone: 'America/Los_Angeles', rooms: null },
    ],
    ...extra,
  };
}

describe('operator console', () => {
  it('anonymous callers cannot execute platform functions', async () => {
    const { rows } = await sql().query(
      "select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'platform\\_%'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.anon)).toEqual([]);
  });

  it('an empty feature list turns on administration only', async () => {
    const own = await signIn(USER.platform, undefined, true);
    const f = await stepUpToAal2(own.db);
    try {
      const { data, error } = await own.db.rpc('platform_provision_company', { p: provisionPayload({ slug: `qa-mods-${stamp}`, modules: [], properties: [] }) });
      expect(error).toBeNull();
      const { data: mods } = await serviceDb().from('company_modules').select('module, enabled').eq('company_id', (data as { company_id: string }).company_id);
      expect((mods ?? []).filter((m) => m.enabled).map((m) => m.module)).toEqual(['admin']);
    } finally {
      await own.db.auth.mfa.unenroll({ factorId: f });
    }
  });

  it('reads work for platform admins only; writes need a 2FA-verified session', async () => {
    const list = await pa.db.rpc('platform_companies');
    expect(list.error).toBeNull();
    expect((list.data as Array<{ id: string }>).some((c) => c.id === COMPANY.harborview)).toBe(true);
    const detail = await pa.db.rpc('platform_company_detail', { p_company_id: COMPANY.harborview });
    expect(detail.error).toBeNull();

    const tenant = await signIn(USER.hvAdmin);
    expect((await tenant.db.rpc('platform_companies')).error?.code).toBe('42501');
    expect((await tenant.db.rpc('platform_company_detail', { p_company_id: COMPANY.harborview })).error?.code).toBe('42501');
    expect((await tenant.db.rpc('platform_provision_company', { p: provisionPayload() })).error?.code).toBe('42501');

    // Password-only platform session: no writes.
    expect((await pa.db.rpc('platform_provision_company', { p: provisionPayload() })).error?.code).toBe('42501');
    expect((await pa.db.rpc('platform_set_company_status', { p_company_id: COMPANY.summit, p_status: 'suspended', p_reason: 'qa' })).error?.code).toBe('42501');
  });

  it('platform detail shows operational metadata, never member identities or money', async () => {
    const { data } = await pa.db.rpc('platform_company_detail', { p_company_id: COMPANY.harborview });
    const d = data as { members_by_role: Record<string, number>; admin_invitations: Array<{ email: string }> };
    expect(Object.values(d.members_by_role).every((n) => typeof n === 'number')).toBe(true);
    const text = JSON.stringify(data);
    // Member emails are not exposed (only the company-admin invitations the platform issues).
    expect(text).not.toContain('finance@harborview.example');
    expect(text).not.toContain('olivia.owner@owners.example');
    expect(text).not.toMatch(/"(amount|approved_budget|requested_budget|room_revenue)"/);
  });

  it('provisions a ready-to-use company in one step, and its admin can join', async () => {
    pa = await signIn(USER.platform, undefined, true);
    factor = await stepUpToAal2(pa.db);
    const { data, error } = await pa.db.rpc('platform_provision_company', { p: provisionPayload() });
    expect(error).toBeNull();
    const r = data as { company_id: string; invitations: Array<{ email: string; token: string }> };
    expect(r.invitations.map((i) => i.email).sort()).toEqual([`admin.${stamp}@console.example`, `ops.${stamp}@console.example`]);

    const svc = serviceDb();
    const { data: company } = await svc.from('companies').select('slug, legal_name, default_currency, require_mfa_for_privileged').eq('id', r.company_id).single();
    expect(company).toEqual({ slug, legal_name: 'QA Console Hotels LLC', default_currency: 'CAD', require_mfa_for_privileged: true });
    const { data: brand } = await svc.from('company_branding').select('portal_name, primary_color, support_email').eq('company_id', r.company_id).single();
    expect(brand).toEqual({ portal_name: 'QA Console Portal', primary_color: '#24453f', support_email: 'help@console.example' });
    const { data: mods } = await svc.from('company_modules').select('module, enabled').eq('company_id', r.company_id);
    const enabled = Object.fromEntries((mods ?? []).map((m) => [m.module, m.enabled]));
    expect(enabled).toMatchObject({ performance: true, financials: true, documents: true, admin: true, capex: false, reports: false, ingestion: false });
    const { data: props } = await svc.from('properties').select('id, code, currency, status').eq('company_id', r.company_id).order('code');
    expect(props!.map((p) => [p.code, p.currency, p.status])).toEqual([['QC-ASP', 'CAD', 'active'], ['QC-SB', 'CAD', 'onboarding']]);
    const { data: inv } = await svc.from('room_inventory_history').select('effective_from, room_count').eq('company_id', r.company_id);
    expect(inv).toEqual([{ effective_from: '2024-05-01', room_count: 112 }]);
    expect(((await svc.from('financial_accounts').select('id').eq('company_id', r.company_id)).data ?? []).length).toBeGreaterThan(5);
    const { rows: audit } = await sql().query("select action, metadata from public.audit_events where company_id = $1 and action like 'platform.%'", [r.company_id]);
    expect(audit.map((a) => a.action)).toContain('platform.company_provisioned');
    expect((await pa.db.rpc('platform_company_detail', { p_company_id: r.company_id })).data.activity.length).toBeGreaterThan(0);

    // The short ID must be unique.
    expect((await pa.db.rpc('platform_provision_company', { p: provisionPayload() })).error?.code).toBe('23505');

    // While nobody has joined, a new link for the same email replaces the pending one.
    const first = await pa.db.rpc('platform_invite_admin', { p_company_id: r.company_id, p_email: 'late.admin@console.example' });
    const second = await pa.db.rpc('platform_invite_admin', { p_company_id: r.company_id, p_email: 'Late.Admin@console.example' });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const { data: pending } = await svc.from('invitations').select('revoked_at').eq('company_id', r.company_id).eq('email', 'late.admin@console.example').order('created_at');
    expect(pending!.map((p) => p.revoked_at !== null)).toEqual([true, false]);
    const late = anonClient();
    await late.auth.signUp({ email: 'late.admin@console.example', password: 'Sup3r-secret-pass!' });
    expect((await late.rpc('accept_invitation', { p_token: first.data })).error).not.toBeNull();
    // Platform admins can never invite themselves into a company.
    expect((await pa.db.rpc('platform_invite_admin', { p_company_id: r.company_id, p_email: USER.platform })).error?.code).toBe('42501');

    // The first admin accepts and becomes company admin.
    const db = anonClient();
    expect((await db.auth.signUp({ email: `admin.${stamp}@console.example`, password: 'Sup3r-secret-pass!' })).error).toBeNull();
    expect((await db.rpc('accept_invitation', { p_token: r.invitations[0]!.token })).error).toBeNull();
    const { data: ctx } = await db.rpc('my_context');
    expect((ctx as { companies: Array<{ company_id: string; role: string }> }).companies).toEqual(
      expect.arrayContaining([expect.objectContaining({ company_id: r.company_id, role: 'company_admin' })]),
    );
    const { data: list } = await pa.db.rpc('platform_companies');
    const row = (list as Array<{ id: string; setup: { admin_joined: boolean; properties: number; rooms: boolean; branded: boolean } }>).find((c) => c.id === r.company_id)!;
    expect(row.setup).toMatchObject({ admin_joined: true, properties: 2, rooms: true, branded: true });

    // Once the company has an administrator, the platform can no longer hand out admin access.
    expect((await pa.db.rpc('platform_invite_admin', { p_company_id: r.company_id, p_email: 'another@console.example' })).error?.code).toBe('42501');

    // Accepted admins' emails and tenant-issued admin invitations stay private.
    await stepUpToAal2(db); // this company requires 2FA for administration
    const tenantInvite = await db.rpc('create_invitation', {
      p_company_id: r.company_id, p_email: `tenant.admin.${stamp}@console.example`, p_role: 'company_admin', p_all_properties: true, p_property_ids: [], p_expires_in_days: 7,
    });
    expect(tenantInvite.error).toBeNull();
    const detail = JSON.stringify((await pa.db.rpc('platform_company_detail', { p_company_id: r.company_id })).data);
    expect(detail).not.toContain(`tenant.admin.${stamp}@console.example`);
    expect(detail).not.toContain(`admin.${stamp}@console.example"`);
    expect(detail).toContain(`ops.${stamp}@console.example`);

    // Suspending cuts every member off without deleting anything; reactivating restores access.
    expect((await pa.db.rpc('platform_set_company_status', { p_company_id: r.company_id, p_status: 'suspended', p_reason: '' })).error?.code).toBe('22023');
    expect((await pa.db.rpc('platform_set_company_status', { p_company_id: r.company_id, p_status: 'suspended', p_reason: 'QA: unpaid invoice' })).error).toBeNull();
    expect((await db.from('properties').select('id').eq('company_id', r.company_id)).data).toEqual([]);
    expect((await pa.db.rpc('platform_set_company_status', { p_company_id: r.company_id, p_status: 'suspended', p_reason: 'again' })).error?.code).toBe('55000');
    expect((await pa.db.rpc('platform_set_company_status', { p_company_id: r.company_id, p_status: 'active', p_reason: 'QA: paid' })).error).toBeNull();
    expect(((await db.from('properties').select('id').eq('company_id', r.company_id)).data ?? []).length).toBe(2);

    // Platform edits to branding are recorded in the company's audit trail.
    await pa.db.from('company_branding').update({ login_headline: 'QA headline' }).eq('company_id', r.company_id);
    const { rows: after } = await sql().query("select action from public.audit_events where company_id = $1 and action like 'platform.%' order by id", [r.company_id]);
    expect(after.map((a) => a.action)).toEqual(expect.arrayContaining(['platform.company_suspended', 'platform.company_reactivated', 'platform.admin_invited']));
    const { rows: brandAudit } = await sql().query("select actor_kind from public.audit_events where company_id = $1 and entity_type = 'company_branding' and action = 'update'", [r.company_id]);
    expect(brandAudit.map((a) => a.actor_kind)).toContain('platform_admin');
  });

  it('rejects bad input with clear messages', async () => {
    const bad = async (p: Record<string, unknown>) => (await pa.db.rpc('platform_provision_company', { p: provisionPayload({ slug: `qa-bad-${stamp}`, ...p }) })).error;
    expect((await bad({ admins: [] }))?.message).toMatch(/at least one company administrator/);
    expect((await bad({ admins: ['not-an-email'] }))?.message).toMatch(/not a valid email/);
    expect((await bad({ slug: 'Bad Slug' }))?.message).toMatch(/short ID/);
    expect((await bad({ properties: [{ code: 'QB-1', name: 'Hotel', timezone: 'Mars/Olympus' }] }))?.message).toMatch(/time zone/);
    expect((await bad({ currency: 'ABCD' }))?.code).toBe('22023');
    expect((await bad({ require_mfa: 'yes' }))?.code).toBe('22023');
    expect((await bad({ modules: ['payroll'] }))?.code).toBe('22023');
    expect((await bad({ branding: { primary_color: 'blue' } }))?.code).toBe('22023');
    const hotel = { code: 'QB-1', name: 'Hotel', timezone: 'America/Denver' };
    expect((await bad({ properties: [{ ...hotel, rooms: '12.5' }] }))?.code).toBe('22023');
    expect((await bad({ properties: [{ ...hotel, status: 'sold' }] }))?.code).toBe('22023');
    expect((await bad({ properties: [{ ...hotel, country: 'USA' }] }))?.code).toBe('22023');
    expect((await bad({ properties: [{ ...hotel, code: null }] }))?.code).toBe('22023');
    expect((await bad({ properties: [hotel, hotel] }))?.message).toMatch(/two hotels use the code/);
    expect((await bad({ admins: [USER.platform] }))?.code).toBe('42501');
    // Nothing was half-created.
    expect((await serviceDb().from('companies').select('id').eq('slug', `qa-bad-${stamp}`)).data).toEqual([]);
  });
});
