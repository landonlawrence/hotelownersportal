import { describe, expect, it } from 'vitest';
import { buildVarianceRows, variance, type StatementLine } from '@hop/core';
import { call, COMPANY, PROPERTY, serviceDb, signIn, USER } from './helpers';

async function sepReport(property: string) {
  const { data } = await serviceDb().from('financial_reports').select('id, status, revision').eq('property_id', property).eq('period_month', '2026-09-01').order('revision', { ascending: false }).limit(1).single();
  return data!;
}

describe('financial report publication workflow', () => {
  it('owners cannot see draft or in-review reports or their lines', async () => {
    const { db } = await signIn(USER.olivia);
    const draft = await sepReport(PROPERTY.pdx);
    expect(draft.status).toBe('draft');
    expect((await db.from('financial_reports').select('id').eq('id', draft.id)).data).toEqual([]);
    expect((await db.from('financial_report_lines').select('id').eq('financial_report_id', draft.id).limit(1)).data).toEqual([]);
    expect((await db.rpc('financial_report_statement', { p_report_id: draft.id })).data).toEqual([]);
    const res = await call(`/exports/financial-reports/${draft.id}.csv`, { token: (await signIn(USER.olivia)).token });
    expect(res.status).toBe(404);
  });

  it('draft → review → publish, with permissions enforced at each step and owners notified', async () => {
    const draft = await sepReport(PROPERTY.pdx);
    const owner = await signIn(USER.olivia);
    const ops = await signIn(USER.hvOps);
    const fin = await signIn(USER.hvFinance);
    expect((await owner.db.rpc('submit_financial_report', { p_report_id: draft.id })).error?.code).toBe('42501');
    expect((await fin.db.rpc('publish_financial_report', { p_report_id: draft.id })).error?.code).toBe('55000'); // must be in review
    expect((await fin.db.rpc('submit_financial_report', { p_report_id: draft.id, p_comment: 'Ready' })).error).toBeNull();
    // Lines are frozen while in review.
    const { error: lineErr } = await fin.db.from('financial_report_lines').update({ amount: 1 }).eq('financial_report_id', draft.id).select('id');
    expect(lineErr?.code).toBe('55000');
    expect((await ops.db.rpc('publish_financial_report', { p_report_id: draft.id })).error?.code).toBe('42501'); // ops cannot publish
    expect((await fin.db.rpc('return_financial_report', { p_report_id: draft.id, p_comment: '' })).error?.code).toBe('22023');
    expect((await fin.db.rpc('publish_financial_report', { p_report_id: draft.id, p_comment: 'September close' })).error).toBeNull();

    const { data: visible } = await owner.db.from('financial_reports').select('status').eq('id', draft.id).single();
    expect(visible!.status).toBe('published');
    const { data: notes } = await owner.db.from('notifications').select('kind, title, body').eq('entity_id', draft.id);
    expect(notes!.map((n) => n.kind)).toEqual(['financial_report_published']);
    // The investor's grant excludes financials → no notification, no access.
    const ian = await signIn(USER.ian);
    expect((await ian.db.from('notifications').select('id').eq('entity_id', draft.id)).data).toEqual([]);
    // Emails carry no figures and no attachments.
    const { data: out } = await serviceDb().from('notification_outbox').select('body_text').eq('notification_id', (await serviceDb().from('notifications').select('id').eq('entity_id', draft.id).limit(1).single()).data!.id);
    expect(out![0]!.body_text).not.toMatch(/\$|\d{3},\d{3}/);
    expect(out![0]!.body_text).toMatch(/never attached/);
  });

  it('published reports are immutable; corrections create revisions with history', async () => {
    const fin = await signIn(USER.hvFinance);
    const owner = await signIn(USER.olivia);
    const published = await sepReport(PROPERTY.pdx);
    const svcUpdate = await serviceDb().from('financial_reports').update({ title: 'tamper' }).eq('id', published.id);
    expect(svcUpdate.error?.code).toBe('55000'); // even the service role cannot edit a published report
    expect((await fin.db.rpc('create_financial_report_revision', { p_report_id: published.id, p_reason: '' })).error?.code).toBe('22023');
    const { data: revId, error } = await fin.db.rpc('create_financial_report_revision', { p_report_id: published.id, p_reason: 'Utilities accrual corrected' });
    expect(error).toBeNull();
    // Owner still sees revision 1 (published) and not the draft revision 2.
    const { data: ownerView } = await owner.db.from('financial_reports').select('revision, status').eq('property_id', PROPERTY.pdx).eq('period_month', '2026-09-01');
    expect(ownerView).toEqual([{ revision: 1, status: 'published' }]);
    const { data: line } = await fin.db.from('financial_report_lines').select('id, amount').eq('financial_report_id', revId).eq('source_account_code', '6400').single();
    expect((await fin.db.from('financial_report_lines').update({ amount: Number(line!.amount) + 1200 }).eq('id', line!.id).select('id')).error).toBeNull();
    await fin.db.rpc('submit_financial_report', { p_report_id: revId });
    await fin.db.rpc('publish_financial_report', { p_report_id: revId, p_comment: 'Corrected' });
    const { data: after } = await owner.db.from('financial_reports').select('revision, status, supersedes_id, correction_reason').eq('property_id', PROPERTY.pdx).eq('period_month', '2026-09-01').order('revision');
    expect(after!.map((r) => `${r.revision}:${r.status}`)).toEqual(['1:superseded', '2:published']);
    expect(after![1]).toMatchObject({ supersedes_id: published.id, correction_reason: 'Utilities accrual corrected' });
    const { data: events } = await owner.db.from('publication_events').select('entity_id, to_status').in('entity_id', [published.id, revId]).order('id');
    expect(events!.map((e) => e.to_status)).toEqual(expect.arrayContaining(['published', 'superseded', 'draft', 'in_review']));
    const { data: rev2Notes } = await owner.db.from('notifications').select('title').eq('entity_id', revId);
    expect(rev2Notes![0]!.title).toMatch(/revised/);
  });

  it('owners can export published statements; exports carry branding and status', async () => {
    const { token } = await signIn(USER.olivia);
    const published = await sepReport(PROPERTY.pdx);
    const res = await call(`/exports/financial-reports/${published.id}.csv`, { token });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Harborview Owner Portal');
    expect(text).toContain('Status: PUBLISHED');
    expect(text).toContain('Rooms revenue');
  });
});

describe('budgets and variances', () => {
  it('draft budgets are hidden from owners; approval supersedes the prior approved version', async () => {
    const owner = await signIn(USER.olivia);
    const fin = await signIn(USER.hvFinance);
    const { data: drafts } = await owner.db.from('budget_versions').select('id').eq('property_id', PROPERTY.sea).eq('status', 'draft');
    expect(drafts).toEqual([]);
    const { data: newId, error } = await fin.db.rpc('create_budget_version', { p_property_id: PROPERTY.sea, p_fiscal_year: 2026, p_name: 'FY2026 Reforecast 2', p_copy_from: null });
    expect(error).toBeNull();
    // Manual entry through RLS-protected upsert.
    const { data: acct } = await fin.db.from('financial_accounts').select('id').eq('company_id', COMPANY.harborview).eq('code', 'REV_ROOMS').single();
    const lines = Array.from({ length: 12 }, (_, i) => ({ company_id: COMPANY.harborview, property_id: PROPERTY.sea, budget_version_id: newId, account_id: acct!.id, period_month: `2026-${String(i + 1).padStart(2, '0')}-01`, amount: 1500000 }));
    expect((await fin.db.from('budget_lines').upsert(lines, { onConflict: 'budget_version_id,account_id,period_month' })).error).toBeNull();
    // Owners cannot write budget lines.
    expect((await owner.db.from('budget_lines').insert({ ...lines[0], amount: 1 })).error).not.toBeNull();
    // Out-of-year lines are rejected.
    expect((await fin.db.from('budget_lines').insert({ ...lines[0], period_month: '2027-01-01' })).error?.code).toBe('23514');
    expect((await owner.db.rpc('approve_budget_version', { p_version_id: newId })).error?.code).toBe('42501');
    expect((await fin.db.rpc('approve_budget_version', { p_version_id: newId, p_comment: 'Board approved' })).error).toBeNull();
    const { data: versions } = await owner.db.from('budget_versions').select('version_number, status').eq('property_id', PROPERTY.sea).eq('fiscal_year', 2026).order('version_number');
    expect(versions!.map((v) => `${v.version_number}:${v.status}`)).toEqual(['1:superseded', '2:superseded', '3:approved']);
    // Approved budgets are locked.
    expect((await fin.db.from('budget_lines').update({ amount: 1 }).eq('budget_version_id', newId).select('id')).error?.code).toBe('55000');
  });

  it('actual-vs-budget variances computed from database figures match a direct calculation', async () => {
    const { db } = await signIn(USER.olivia);
    const [{ data: actuals }, { data: budget }, { data: accounts }] = await Promise.all([
      db.rpc('financial_actuals_monthly', { p_company_id: COMPANY.harborview, p_from: '2026-08-01', p_to: '2026-08-01', p_include_drafts: false }),
      db.rpc('budget_monthly', { p_company_id: COMPANY.harborview, p_from: '2026-08-01', p_to: '2026-08-01' }),
      db.from('financial_accounts').select('id, code, name, nature, section, sort_order').eq('company_id', COMPANY.harborview),
    ]);
    const a = new Map((actuals as Array<{ property_id: string; account_id: string; amount: number }>).filter((x) => x.property_id === PROPERTY.pdx).map((x) => [x.account_id, Number(x.amount)]));
    const b = new Map((budget as Array<{ property_id: string; account_id: string; amount: number }>).filter((x) => x.property_id === PROPERTY.pdx).map((x) => [x.account_id, Number(x.amount)]));
    const lines: StatementLine[] = (accounts ?? []).map((x) => ({ accountId: x.id, code: x.code, name: x.name, nature: x.nature, sortOrder: x.sort_order }));
    const rows = buildVarianceRows(lines, a, b, new Map());
    const rooms = rows.find((r) => r.code === 'REV_ROOMS')!;
    expect(rooms.actual).not.toBeNull();
    expect(rooms.budget).not.toBeNull();
    expect(rooms.vsBudget.amount).toBeCloseTo(rooms.actual! - rooms.budget!, 2);
    expect(rooms.vsBudget).toEqual(variance(rooms.actual, rooms.budget, 'revenue'));
    const util = rows.find((r) => r.code === 'EXP_UTIL')!;
    expect(util.vsBudget.favourable).toBe(util.actual! < util.budget!);
  });

  it('owners only see published actuals even when asking for drafts', async () => {
    const { db } = await signIn(USER.olivia);
    const { data } = await db.rpc('financial_actuals_monthly', { p_company_id: COMPANY.harborview, p_from: '2026-09-01', p_to: '2026-09-01', p_include_drafts: true });
    const statuses = new Set((data as Array<{ report_status: string; property_id: string }>).map((r) => r.report_status));
    expect([...statuses]).toEqual(['published']);
    expect((data as Array<{ property_id: string }>).some((r) => r.property_id === PROPERTY.sea)).toBe(false); // SEA Sept is in review
  });
});
