/**
 * SECURITY ACCEPTANCE TEST
 * An owner authorized for two hotels (Olivia: HV-SEA, HV-PDX) cannot access a
 * third hotel (HV-SFO) of the same management company through the API (direct
 * PostgREST and RPC), exports, or document URLs. The UI path is covered by the
 * Playwright test e2e/security-acceptance.spec.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { localStorageDriver } from '@hop/api';
import { call, COMPANY, ensureDemoFiles, PROPERTY, serviceDb, signIn, USER } from './helpers';

const SFO_DOC_VERSION = '71000000-0000-4000-8000-000000000006';
const SEA_DOC_VERSION = '71000000-0000-4000-8000-000000000001';
let token: string;
let db: Awaited<ReturnType<typeof signIn>>['db'];
let sfoReportId: string;
let sfoPackageId: string | null = null;
let sfoProjectRequestId: string;

beforeAll(async () => {
  await ensureDemoFiles();
  ({ token, db } = await signIn(USER.olivia));
  const svc = serviceDb();
  const { data: r } = await svc.from('financial_reports').select('id').eq('property_id', PROPERTY.sfo).eq('status', 'published').limit(1).single();
  sfoReportId = r!.id;
  // Create and publish an SFO package as Harborview finance so there is something to steal.
  const fin = await signIn(USER.hvFinance);
  const { data: pkg } = await fin.db.rpc('create_reporting_package', { p_property_id: PROPERTY.sfo, p_period_month: '2026-07-01', p_title: null });
  sfoPackageId = pkg as string;
  await fin.db.rpc('publish_reporting_package', { p_package_id: sfoPackageId, p_comment: 'test' });
  const { data: req } = await svc.from('capex_approval_requests').select('id').eq('property_id', PROPERTY.sfo).limit(1).single();
  sfoProjectRequestId = req!.id;
});

describe('owner with two hotels cannot reach a third hotel', () => {
  it('positive control: the owner can access her two hotels', async () => {
    const { data } = await db.from('properties').select('id').eq('company_id', COMPANY.harborview);
    expect(data!.map((p) => p.id).sort()).toEqual([PROPERTY.sea, PROPERTY.pdx].sort());
    const res = await call(`/documents/versions/${SEA_DOC_VERSION}/download`, { token });
    expect(res.status).toBe(200);
  });

  it('direct table reads filtered to the third hotel return nothing', async () => {
    const tables = ['properties', 'daily_performance', 'financial_reports', 'financial_report_lines', 'budget_versions', 'budget_lines',
      'documents', 'document_versions', 'capex_projects', 'capex_transactions', 'capex_approval_requests', 'capex_updates',
      'management_commentary', 'reporting_packages', 'room_inventory_history', 'property_reporting_config', 'property_ownerships'];
    for (const t of tables) {
      const col = t === 'properties' ? 'id' : 'property_id';
      const sel = t === 'document_versions' ? 'id' : t === 'property_reporting_config' ? 'property_id' : '*';
      const { data, error } = await db.from(t).select(sel).eq(col, PROPERTY.sfo).limit(5);
      expect({ t, rows: data?.length ?? 0, error: error?.code ?? null }).toEqual({ t, rows: 0, error: null });
    }
  });

  it('RPCs return nothing or are denied for the third hotel', async () => {
    const roll = await db.rpc('performance_rollup', { p_company_id: COMPANY.harborview, p_from: '2026-01-01', p_to: '2026-06-30', p_grain: 'total', p_property_ids: [PROPERTY.sfo] });
    expect(roll.data).toEqual([]);
    const all = await db.rpc('performance_rollup', { p_company_id: COMPANY.harborview, p_from: '2026-01-01', p_to: '2026-06-30', p_grain: 'total', p_property_ids: null });
    expect((all.data as Array<{ property_id: string }>).some((r) => r.property_id === PROPERTY.sfo)).toBe(false);
    expect((await db.rpc('financial_report_statement', { p_report_id: sfoReportId })).data).toEqual([]);
    expect((await db.rpc('get_reporting_package', { p_package_id: sfoPackageId })).data).toBeNull();
    const fin = await db.rpc('financial_actuals_monthly', { p_company_id: COMPANY.harborview, p_from: '2026-01-01', p_to: '2026-08-01', p_include_drafts: true });
    expect((fin.data as Array<{ property_id: string }>).some((r) => r.property_id === PROPERTY.sfo)).toBe(false);
    const decide = await db.rpc('decide_capex_request', { p_request_id: sfoProjectRequestId, p_decision: 'approved', p_comment: 'x' });
    expect(decide.error?.code).toBe('42501');
    expect((await db.rpc('check_permission', { p_perm: 'performance.view', p_company_id: COMPANY.harborview, p_property_id: PROPERTY.sfo })).data).toBe(false);
    const props = await db.rpc('my_property_permissions', { p_company_id: COMPANY.harborview });
    expect((props.data as Array<{ property_id: string }>).some((p) => p.property_id === PROPERTY.sfo)).toBe(false);
    const authz = await db.rpc('authorize_document_download', { p_version_id: SFO_DOC_VERSION });
    expect(authz.data).toBe(false);
  });

  it('exports reject the third hotel', async () => {
    const perf = await call(`/exports/performance.csv?company_id=${COMPANY.harborview}&from=2026-01-01&to=2026-06-30&property_ids=${PROPERTY.sfo}`, { token });
    expect(perf.status).toBe(403);
    const mixed = await call(`/exports/performance.csv?company_id=${COMPANY.harborview}&from=2026-01-01&to=2026-06-30&property_ids=${PROPERTY.sea},${PROPERTY.sfo}`, { token });
    expect(mixed.status).toBe(403);
    const whole = await call(`/exports/performance.csv?company_id=${COMPANY.harborview}&from=2026-01-01&to=2026-06-30&grain=total`, { token });
    expect(whole.status).toBe(200);
    const text = await whole.text();
    expect(text).toContain('HV-SEA');
    expect(text).not.toContain('HV-SFO');
    expect(text).not.toContain('Embarcadero');
    const statement = await call(`/exports/financial-reports/${sfoReportId}.csv`, { token });
    expect(statement.status).toBe(404);
  });

  it('document URLs for the third hotel cannot be obtained or forged', async () => {
    const res = await call(`/documents/versions/${SFO_DOC_VERSION}/download`, { token });
    expect(res.status).toBe(404);

    // A legitimately issued URL for an authorized document cannot be re-pointed at the third hotel's object.
    const ok = await call(`/documents/versions/${SEA_DOC_VERSION}/download`, { token });
    const { url } = (await ok.json()) as { url: string };
    const u = new URL(url);
    const svc = serviceDb();
    const { data: sfoVersion } = await svc.from('document_versions').select('storage_key').eq('id', SFO_DOC_VERSION).single();
    u.searchParams.set('key', sfoVersion!.storage_key);
    const forged = await call(`${u.pathname}${u.search}`);
    expect(forged.status).toBe(403);

    // The genuine URL works without a session (bearer URL) but only briefly.
    const genuine = await call(`${new URL(url).pathname}${new URL(url).search}`);
    expect(genuine.status).toBe(200);
    expect(genuine.headers.get('content-type')).toBe('application/pdf');
    const drv = localStorageDriver()!;
    const p = Object.fromEntries(new URL(url).searchParams.entries());
    expect(drv.verify({ op: 'get', bucket: p.bucket!, key: p.key!, exp: Number(p.exp), ct: p.ct!, fn: p.fn }, p.sig!, Date.now() + 61_000)).toBe(false);
  });

  it('denied download attempts are audited', async () => {
    const admin = await signIn(USER.hvAdmin);
    const { data } = await admin.db.from('audit_events').select('action, actor_user_id').eq('entity_id', SFO_DOC_VERSION).eq('action', 'document.download_denied');
    const { userId } = await signIn(USER.olivia);
    expect((data ?? []).some((a) => a.actor_user_id === userId)).toBe(true);
  });

  it('the third hotel does not leak through notifications, commentary or CapEx summaries', async () => {
    const { data: n } = await db.from('notifications').select('property_id');
    expect((n ?? []).some((x) => x.property_id === PROPERTY.sfo)).toBe(false);
    const { data: c } = await db.rpc('capex_project_summary', { p_company_id: COMPANY.harborview });
    expect((c as Array<{ property_id: string }>).some((x) => x.property_id === PROPERTY.sfo)).toBe(false);
  });
});
