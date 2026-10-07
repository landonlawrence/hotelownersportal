import { describe, expect, it } from 'vitest';
import { dispatchNotifications, sentLog } from '@hop/api';
import { capexFunds } from '@hop/core';
import { COMPANY, PROPERTY, serviceDb, signIn, USER } from './helpers';

const COOLING_TOWER = '81000000-0000-4000-8000-000000000003';
const COOLING_REQUEST = '82000000-0000-4000-8000-000000000003';
const FITNESS_REQUEST = '82000000-0000-4000-8000-000000000007';
const SOFT_GOODS = '81000000-0000-4000-8000-000000000001';

describe('CapEx approvals', () => {
  it('only required approver types may decide; investors and other-property owners are denied', async () => {
    const ian = await signIn(USER.ian);
    expect((await ian.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved' })).error?.code).toBe('42501');
    const ops = await signIn(USER.hvOps);
    // Corporate step already approved by ops.
    expect((await ops.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved' })).error?.code).toBe('23505');
    const fin = await signIn(USER.hvFinance);
    expect((await fin.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved' })).error?.message).toMatch(/already complete/);
    const gm = await signIn(USER.hvGm);
    expect((await gm.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved' })).error?.code).toBe('42501');
  });

  it('owner approval completes the request and sets the approved budget; duplicates are impossible', async () => {
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'rejected', p_comment: '' })).error?.code).toBe('22023');
    const { data: status, error } = await owner.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved', p_comment: 'Approved; schedule before May.' });
    expect(error).toBeNull();
    expect(status).toBe('approved');
    const { data: p } = await owner.db.from('capex_projects').select('status, approved_budget').eq('id', COOLING_TOWER).single();
    expect(p).toEqual({ status: 'approved', approved_budget: 145000 });
    expect((await owner.db.rpc('decide_capex_request', { p_request_id: COOLING_REQUEST, p_decision: 'approved' })).error?.message).toMatch(/already been approved/);
    const { data: hist } = await owner.db.from('capex_approval_decisions').select('approver_type, decision').eq('request_id', COOLING_REQUEST).order('decided_at');
    expect(hist).toEqual([{ approver_type: 'corporate', decision: 'approved' }, { approver_type: 'owner', decision: 'approved' }]);
    // Decisions are append-only, even for the service role.
    expect((await serviceDb().from('capex_approval_decisions').delete().eq('request_id', COOLING_REQUEST)).error).not.toBeNull();
  });

  it('approved amounts cannot be edited directly; increases need a change order routed by threshold', async () => {
    const ops = await signIn(USER.hvOps);
    const direct = await ops.db.from('capex_projects').update({ requested_budget: 999999 }).eq('id', SOFT_GOODS).select('id');
    expect(direct.error?.code).toBe('55000');
    const svcDirect = await serviceDb().from('capex_projects').update({ approved_budget: 1 }).eq('id', SOFT_GOODS);
    expect(svcDirect.error?.code).toBe('55000');
    expect((await ops.db.rpc('submit_capex_request', { p_project_id: SOFT_GOODS, p_new_total: 470000, p_justification: 'Reduce budget please' })).error?.code).toBe('22023');

    // Small change order (< $25k increase) → corporate only.
    const { data: co, error } = await ops.db.rpc('submit_capex_request', { p_project_id: SOFT_GOODS, p_new_total: 495000, p_justification: 'Vendor escalation on floors 5–6 fabric' });
    expect(error).toBeNull();
    const { data: req } = await ops.db.from('capex_approval_requests').select('request_type, amount, required_steps').eq('id', co).single();
    expect(req).toMatchObject({ request_type: 'change_order', amount: 15000, required_steps: [{ approver_type: 'corporate', approvals_required: 1 }] });
    expect((await ops.db.rpc('submit_capex_request', { p_project_id: SOFT_GOODS, p_new_total: 500000, p_justification: 'Duplicate pending request' })).error?.code).toBe('23505');
    // Requester cannot approve their own request.
    expect((await ops.db.rpc('decide_capex_request', { p_request_id: co, p_decision: 'approved' })).error?.message).toMatch(/own request/);
    // The request amount is immutable once submitted.
    expect((await serviceDb().from('capex_approval_requests').update({ new_approved_budget: 600000 }).eq('id', co)).error?.code).toBe('55000');
    const fin = await signIn(USER.hvFinance);
    expect((await fin.db.rpc('decide_capex_request', { p_request_id: co, p_decision: 'approved' })).data).toBe('approved');
    const { data: summary } = await fin.db.rpc('capex_project_summary', { p_company_id: COMPANY.harborview });
    const s = (summary as Array<{ project_id: string; approved_budget: number; actual_spend: number; open_commitments: number; remaining: number }>).find((x) => x.project_id === SOFT_GOODS)!;
    expect(Number(s.approved_budget)).toBe(495000);
    expect(Number(s.remaining)).toBeCloseTo(capexFunds(495000, Number(s.actual_spend), Number(s.open_commitments)).remaining, 2);
    expect(Number(s.remaining)).toBe(495000 - 236300 - 236000);
  });

  it('large change orders also require the owner', async () => {
    const ops = await signIn(USER.hvOps);
    const { data: co } = await ops.db.rpc('submit_capex_request', { p_project_id: SOFT_GOODS, p_new_total: 560000, p_justification: 'Add corridor carpet to scope' });
    const { data: req } = await ops.db.from('capex_approval_requests').select('required_steps').eq('id', co).single();
    expect((req!.required_steps as Array<{ approver_type: string }>).map((x) => x.approver_type)).toEqual(['corporate', 'owner']);
    const fin = await signIn(USER.hvFinance);
    expect((await fin.db.rpc('decide_capex_request', { p_request_id: co, p_decision: 'approved' })).data).toBe('pending');
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('decide_capex_request', { p_request_id: co, p_decision: 'rejected', p_comment: 'Defer corridors to 2027' })).data).toBe('rejected');
    const { data: p } = await owner.db.from('capex_projects').select('approved_budget, status').eq('id', SOFT_GOODS).single();
    expect(p).toEqual({ approved_budget: 495000, status: 'in_progress' });
  });

  it('a multi-company owner approves at the second company within that company’s rules', async () => {
    const sp = await signIn(USER.spFinance);
    expect((await sp.db.rpc('decide_capex_request', { p_request_id: FITNESS_REQUEST, p_decision: 'approved' })).data).toBe('pending');
    const owner = await signIn(USER.olivia);
    expect((await owner.db.rpc('decide_capex_request', { p_request_id: FITNESS_REQUEST, p_decision: 'approved', p_comment: 'OK' })).data).toBe('approved');
  });
});

describe('reporting packages and notifications', () => {
  it('investor sees only the sections their permissions allow', async () => {
    const ian = await signIn(USER.ian);
    const { data: pkgs } = await ian.db.from('reporting_packages').select('id, status').eq('property_id', PROPERTY.sea);
    expect(pkgs!.length).toBeGreaterThan(0);
    const { data } = await ian.db.rpc('get_reporting_package', { p_package_id: pkgs![0]!.id });
    const snap = data.snapshot as Record<string, unknown>;
    expect(snap.performance).toBeDefined();
    expect(snap.commentary).toBeDefined();
    expect(snap.financial_report).toBeUndefined();
    expect(snap.budget_variance).toBeUndefined();
    expect(snap.capex).toBeUndefined();
    // Snapshots are not directly readable.
    expect((await ian.db.from('reporting_package_snapshots').select('package_id')).error).not.toBeNull();
    const owner = await signIn(USER.olivia);
    const { data: full } = await owner.db.rpc('get_reporting_package', { p_package_id: pkgs![0]!.id });
    expect(full.snapshot.budget_variance.length).toBeGreaterThan(5);
    expect((full.snapshot.commentary as Array<{ body: string }>).some((c) => /staffing/i.test(c.body))).toBe(false);
  });

  it('packages cannot include unpublished statements or internal documents; publishing notifies authorized recipients', async () => {
    const fin = await signIn(USER.hvFinance);
    const { data: pkg, error } = await fin.db.rpc('create_reporting_package', { p_property_id: PROPERTY.sea, p_period_month: '2026-09-01', p_title: null });
    expect(error).toBeNull();
    const { data: items } = await fin.db.from('reporting_package_items').select('item_type').eq('package_id', pkg);
    expect(items!.map((i) => i.item_type)).not.toContain('financial_report'); // September SEA is still in review
    expect((await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: '70000000-0000-4000-8000-000000000004' })).error?.code).toBe('22023');
    expect((await fin.db.rpc('add_package_document', { p_package_id: pkg, p_document_id: '70000000-0000-4000-8000-000000000001' })).error).toBeNull();
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('reporting_packages').select('id').eq('id', pkg)).data).toEqual([]); // draft hidden
    expect((await owner.db.rpc('publish_reporting_package', { p_package_id: pkg })).error?.code).toBe('42501');
    expect((await fin.db.rpc('publish_reporting_package', { p_package_id: pkg, p_comment: 'September' })).error).toBeNull();
    const { data: n1 } = await owner.db.from('notifications').select('kind').eq('entity_id', pkg);
    expect(n1).toEqual([{ kind: 'reporting_package_published' }]);
    const ian = await signIn(USER.ian);
    expect((await ian.db.from('notifications').select('kind').eq('entity_id', pkg)).data).toEqual([{ kind: 'reporting_package_published' }]);
    const rita = await signIn(USER.rita);
    expect((await rita.db.from('notifications').select('kind').eq('entity_id', pkg)).data).toEqual([]);
    // Revision supersedes.
    const { data: rev } = await fin.db.rpc('create_reporting_package_revision', { p_package_id: pkg, p_reason: 'Add corrected commentary' });
    await fin.db.rpc('publish_reporting_package', { p_package_id: rev });
    const { data: hist } = await owner.db.from('reporting_packages').select('revision, status').eq('property_id', PROPERTY.sea).eq('period_month', '2026-09-01').order('revision');
    expect(hist!.map((h) => `${h.revision}:${h.status}`)).toEqual(['1:superseded', '2:published']);
  });

  it('dispatcher sends queued emails once, without financial content', async () => {
    const before = sentLog.length;
    const r1 = await dispatchNotifications(500);
    expect(r1.sent).toBeGreaterThan(0);
    const r2 = await dispatchNotifications(500);
    expect(r2.sent).toBe(0);
    const msgs = sentLog.slice(before);
    expect(msgs.every((m) => !/\$\s?\d/.test(m.text))).toBe(true);
    const { count } = await serviceDb().from('notification_outbox').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    expect(count).toBe(0);
  });
});
