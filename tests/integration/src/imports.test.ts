import { describe, expect, it } from 'vitest';
import { checkMissingReports, handleInboundEmail } from '@hop/api';
import { addDays, localToday } from '@hop/core';
import { call, COMPANY, csvFile, drainQueue, localQueue, PROPERTY, serviceDb, signIn, sql, USER } from './helpers';

const HEADER = 'property_code,business_date,rooms_available,rooms_out_of_order,rooms_sold,rooms_comp,room_revenue,food_beverage_revenue,other_revenue,total_revenue';

async function upload(token: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set('company_id', fields.company_id ?? COMPANY.harborview);
  form.set('report_type', fields.report_type ?? 'daily_performance');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', file);
  const res = await call('/imports', { method: 'POST', body: form, token });
  return { status: res.status, body: (await res.json()) as { importRunId: string; status: string; message?: string } };
}

async function run(id: string) {
  await drainQueue();
  const { data } = await serviceDb().from('import_runs').select('*').eq('id', id).single();
  return data as Record<string, unknown> & { status: string };
}

async function issues(id: string) {
  const { data } = await serviceDb().from('import_validation_issues').select('severity, code, row_number').eq('import_run_id', id).order('row_number');
  return data ?? [];
}

describe('manual daily performance imports', () => {
  it('requires ingestion.manage (owners are denied)', async () => {
    const { token } = await signIn(USER.olivia);
    const res = await upload(token, csvFile('x.csv', `${HEADER}\nHV-SEA,2026-01-01,220,0,100,0,10000,,,`));
    expect(res.status).toBe(403);
  });

  it('rejects files with another company’s property code (invalid mapping) and records issues', async () => {
    const { token } = await signIn(USER.hvFinance);
    const res = await upload(token, csvFile('bad.csv', `${HEADER}\nSP-DEN,2026-01-02,250,0,200,0,30000,,,\nHV-ZZZ,2026-01-02,100,0,10,0,1000,,,`));
    expect(res.status).toBe(202);
    const r = await run(res.body.importRunId);
    expect(r.status).toBe('rejected');
    expect((await issues(res.body.importRunId)).map((i) => i.code)).toEqual(['unmapped_property', 'unmapped_property']);
  });

  it('loads new dates, then detects an exact duplicate file', async () => {
    const { token } = await signIn(USER.hvFinance);
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date in ('2024-12-30', '2024-12-31')", [PROPERTY.sea]);
    const text = `${HEADER}\nHV-SEA,2024-12-30,220,2,150,2,30000,6000,1500,37500\nHV-SEA,2024-12-31,220,2,210,2,52500,12000,3000,67500`;
    const first = await upload(token, csvFile('flash-2024-12-31.csv', text));
    const r1 = await run(first.body.importRunId);
    expect(r1).toMatchObject({ status: 'completed', rows_inserted: 2, rows_updated: 0, rows_unchanged: 0 });
    const { data: rows } = await serviceDb().from('daily_performance').select('import_run_id, revision').eq('property_id', PROPERTY.sea).eq('business_date', '2024-12-31').single();
    expect(rows).toMatchObject({ import_run_id: first.body.importRunId, revision: 1 }); // lineage

    const again = await upload(token, csvFile('flash-2024-12-31 (copy).csv', text));
    expect(again.body.status).toBe('duplicate');
    const r2 = await run(again.body.importRunId);
    expect(r2).toMatchObject({ status: 'duplicate', duplicate_of_run_id: first.body.importRunId });
  });

  it('revised reports with different values need review; approval replaces values and keeps history', async () => {
    const { token } = await signIn(USER.hvFinance);
    const revised = `${HEADER}\nHV-SEA,2024-12-31,220,2,212,2,53000,12000,3000,68000`;
    const res = await upload(token, csvFile('flash-2024-12-31-revised.csv', revised));
    const r = await run(res.body.importRunId);
    expect(r).toMatchObject({ status: 'needs_review', conflicts: 1 });
    const { data: unchanged } = await serviceDb().from('daily_performance').select('rooms_sold').eq('property_id', PROPERTY.sea).eq('business_date', '2024-12-31').single();
    expect(unchanged!.rooms_sold).toBe(210);

    // Owners cannot approve; ingestion managers can.
    const owner = await signIn(USER.olivia);
    expect((await call(`/imports/${res.body.importRunId}/approve`, { method: 'POST', token: owner.token })).status).toBe(404);
    const approve = await call(`/imports/${res.body.importRunId}/approve`, { method: 'POST', token, body: JSON.stringify({ note: 'Night audit correction' }), headers: { 'content-type': 'application/json' } });
    expect(approve.status).toBe(202);
    const done = await run(res.body.importRunId);
    expect(done).toMatchObject({ status: 'completed', rows_updated: 1, replace_existing: true });
    const { data: row } = await serviceDb().from('daily_performance').select('rooms_sold, revision, import_run_id').eq('property_id', PROPERTY.sea).eq('business_date', '2024-12-31').single();
    expect(row).toMatchObject({ rooms_sold: 212, revision: 2, import_run_id: res.body.importRunId });
    const { data: hist } = await serviceDb().from('daily_performance_revisions').select('revision, previous_values, replaced_by_import_run_id').eq('property_id', PROPERTY.sea).eq('business_date', '2024-12-31');
    expect(hist).toHaveLength(1);
    expect(hist![0]).toMatchObject({ revision: 1, replaced_by_import_run_id: res.body.importRunId });
    expect((hist![0]!.previous_values as { rooms_sold: number }).rooms_sold).toBe(210);
  });

  it('explicit replace_existing applies revisions immediately (with history)', async () => {
    const { token } = await signIn(USER.hvFinance);
    const res = await upload(token, csvFile('flash-replace.csv', `${HEADER}\nHV-SEA,2024-12-30,220,2,151,2,30200,6000,1500,37700`), { replace_existing: 'true' });
    expect(await run(res.body.importRunId)).toMatchObject({ status: 'completed', rows_updated: 1 });
  });

  it('parses XLSX workbooks through the same validation', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Flash');
    ws.addRow(HEADER.split(','));
    ws.addRow(['HV-PDX', new Date(Date.UTC(2017, 0, 1)), 148, 0, 10, 0, 1000, '', '', '']);
    const buf = await wb.xlsx.writeBuffer();
    const { token } = await signIn(USER.hvFinance);
    const res = await upload(token, new File([buf], 'flash.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const r = await run(res.body.importRunId);
    expect(r.status).toBe('rejected');
    expect((await issues(res.body.importRunId)).map((i) => i.code)).toEqual(['before_opening']);
  });

  it('failed runs can be retried; retries are idempotent', async () => {
    const { token } = await signIn(USER.hvFinance);
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date = '2024-12-29'", [PROPERTY.pdx]);
    const res = await upload(token, csvFile('retry.csv', `${HEADER}\nHV-PDX,2024-12-29,148,0,90,0,15000,,,`));
    await run(res.body.importRunId);
    await sql().query("update public.import_runs set status = 'failed', last_error = 'simulated outage' where id = $1", [res.body.importRunId]);
    const owner = await signIn(USER.olivia);
    expect((await call(`/imports/${res.body.importRunId}/retry`, { method: 'POST', token: owner.token })).status).toBe(404);
    expect((await call(`/imports/${res.body.importRunId}/retry`, { method: 'POST', token })).status).toBe(202);
    const r = await run(res.body.importRunId);
    expect(r).toMatchObject({ status: 'completed', rows_inserted: 0, rows_unchanged: 1 });
  });

  it('honours revocation at processing time (background job re-checks the requester)', async () => {
    const gm = await signIn(USER.hvGm);
    // Give the GM ingestion.manage temporarily, enqueue, then revoke before processing.
    const admin = await signIn(USER.hvAdmin);
    await admin.db.rpc('set_permission_override', { p_membership_id: '50000000-0000-4000-8000-000000000014', p_permission: 'ingestion.manage', p_effect: 'allow' });
    const q = localQueue();
    const original = q.send.bind(q);
    const held: Array<Parameters<typeof q.send>[0]> = [];
    q.send = async (job) => void held.push(job);
    const res = await upload(gm.token, csvFile('gm.csv', `${HEADER}\nHV-SEA,2024-12-28,220,0,100,0,20000,,,`));
    q.send = original;
    await admin.db.rpc('set_permission_override', { p_membership_id: '50000000-0000-4000-8000-000000000014', p_permission: 'ingestion.manage', p_effect: null });
    for (const job of held) await q.send(job);
    const r = await run(res.body.importRunId);
    expect(r.status).toBe('rejected');
    expect((await issues(res.body.importRunId)).map((i) => i.code)).toContain('not_authorized');
  });
});

describe('monthly actuals and budget imports', () => {
  it('importing over a published period requires review and creates a traceable revision', async () => {
    const { token } = await signIn(USER.hvFinance);
    const csv = 'property_code,period,account_code,account_name,amount\nHV-PDX,2026-03,4000,Room Revenue,"1,000,000.00"\nHV-PDX,2026-03,5000,Rooms Expense,(240000)';
    const res = await upload(token, csvFile('gl-2026-03.csv', csv), { report_type: 'monthly_actuals' });
    const r = await run(res.body.importRunId);
    expect(r.status).toBe('needs_review');
    await call(`/imports/${res.body.importRunId}/approve`, { method: 'POST', token });
    expect((await run(res.body.importRunId)).status).toBe('completed');
    const { data: reports } = await serviceDb().from('financial_reports').select('revision, status, supersedes_id, correction_reason').eq('property_id', PROPERTY.pdx).eq('period_month', '2026-03-01').order('revision');
    expect(reports!.map((x) => `${x.revision}:${x.status}`)).toEqual(['1:published', '2:draft']);
    expect(reports![1]!.correction_reason).toMatch(/Revised figures imported/);
    const { data: lines } = await serviceDb().from('financial_report_lines').select('source_account_code, amount, source_value').eq('import_run_id', res.body.importRunId).order('source_account_code');
    expect(lines).toEqual([
      { source_account_code: '4000', amount: 1000000, source_value: '1,000,000.00' },
      { source_account_code: '5000', amount: -240000, source_value: '(240000)' },
    ]);
  });

  it('unmapped source accounts block the import', async () => {
    const { token } = await signIn(USER.hvFinance);
    const res = await upload(token, csvFile('gl-bad.csv', 'property_code,period,account_code,amount\nHV-SEA,2026-02,9999,100'), { report_type: 'monthly_actuals' });
    expect((await run(res.body.importRunId)).status).toBe('rejected');
    expect((await issues(res.body.importRunId)).map((i) => i.code)).toEqual(['unmapped_account']);
  });

  it('budget imports create a new draft version without touching the approved budget', async () => {
    const { token } = await signIn(USER.hvFinance);
    const csv = ['property_code,fiscal_year,account_code,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec',
      'HV-PDX,2027,REV_ROOMS,900000,880000,950000,1000000,1100000,1200000,1300000,1300000,1150000,1050000,950000,900000',
      'HV-PDX,2027,ROOMS_SOLD,3600,3500,3800,3900,4100,4300,4500,4500,4100,3900,3600,3500'].join('\n');
    const res = await upload(token, csvFile('budget-2027.csv', csv), { report_type: 'budget' });
    expect((await run(res.body.importRunId)).status).toBe('completed');
    const { data } = await serviceDb().from('budget_versions').select('status, version_number, import_run_id').eq('property_id', PROPERTY.pdx).eq('fiscal_year', 2027);
    expect(data).toEqual([{ status: 'draft', version_number: 1, import_run_id: res.body.importRunId }]);
  });
});

describe('scheduled email ingestion', () => {
  function mime(opts: { from: string; to: string; filename: string; csv: string }) {
    const b = 'BOUNDARY42';
    return new TextEncoder().encode(
      [`From: Night Audit <${opts.from}>`, `To: ${opts.to}`, 'Subject: Daily flash', 'Message-ID: <flash-1@pms.harborview.example>', 'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain', '', 'Attached.', `--${b}`,
        `Content-Type: text/csv; name="${opts.filename}"`, `Content-Disposition: attachment; filename="${opts.filename}"`, 'Content-Transfer-Encoding: base64', '',
        Buffer.from(opts.csv).toString('base64'), `--${b}--`, ''].join('\r\n'),
    );
  }
  const to = 'reports+hvflash7k2m9@inbound.portal.example';
  const csv = `${HEADER.replace('property_code', 'property_code')}\nSEA01,2024-12-27,220,0,120,1,24000,,,`;

  it('accepts mail on an approved route from an allowed, authenticated sender and maps external codes', async () => {
    await sql().query("delete from public.daily_performance where property_id = $1 and business_date = '2024-12-27'", [PROPERTY.sea]);
    const out = await handleInboundEmail(mime({ from: 'nightaudit@harborview.example', to, filename: 'flash.csv', csv }), { recipients: [to], spfVerdict: 'PASS', dkimVerdict: 'PASS', messageId: 'm1' });
    expect(out.accepted).toBe(true);
    const r = await run(out.runs[0]!.importRunId);
    expect(r).toMatchObject({ status: 'completed', rows_inserted: 1, requested_by: null, source_id: '90000000-0000-4000-8000-000000000001' });
    const { data: file } = await serviceDb().from('source_files').select('received_via, sender').eq('id', r.source_file_id as string).single();
    expect(file).toEqual({ received_via: 'email', sender: 'nightaudit@harborview.example' });
  });

  it('rejects unknown senders, failed authentication and unknown routes', async () => {
    const spoof = await handleInboundEmail(mime({ from: 'attacker@evil.example', to, filename: 'flash.csv', csv }), { recipients: [to], spfVerdict: 'PASS', dkimVerdict: 'PASS' });
    expect(spoof).toMatchObject({ accepted: false, reason: 'sender_not_allowed' });
    const unauth = await handleInboundEmail(mime({ from: 'nightaudit@harborview.example', to, filename: 'flash.csv', csv }), { recipients: [to], spfVerdict: 'FAIL', dkimVerdict: 'FAIL' });
    expect(unauth).toMatchObject({ accepted: false, reason: 'authentication_failed' });
    const unknown = await handleInboundEmail(mime({ from: 'nightaudit@harborview.example', to: 'reports+nosuchroute1@inbound.portal.example', filename: 'flash.csv', csv }), { recipients: ['reports+nosuchroute1@inbound.portal.example'], spfVerdict: 'PASS', dkimVerdict: 'PASS' });
    expect(unknown).toMatchObject({ accepted: false, reason: 'inactive_or_unknown_route' });
  });

  it('routed sources accept only their mapped codes (internal codes and other hotels are rejected)', async () => {
    const out = await handleInboundEmail(
      mime({ from: 'ops@pms.harborview.example', to, filename: 'flash2.csv', csv: `${HEADER}\nHV-SEA,2024-12-26,220,0,120,1,24000,,,\nDEN01,2024-12-26,250,0,120,1,24000,,,` }),
      { recipients: [to], spfVerdict: 'PASS', dkimVerdict: 'PASS' },
    );
    expect(out.accepted).toBe(true);
    const r = await run(out.runs[0]!.importRunId);
    expect(r.status).toBe('rejected');
    expect((await issues(out.runs[0]!.importRunId)).map((i) => i.code)).toEqual(['unmapped_property', 'unmapped_property']);
  });
});

describe('missing-report alerts', () => {
  it('raises a de-duplicated alert for properties without yesterday’s report after the deadline', async () => {
    const svc = serviceDb();
    // Late in the evening Honolulu time — after the 11:00 deadline everywhere.
    const now = new Date();
    const hnlToday = localToday('Pacific/Honolulu', now);
    const evening = new Date(`${hnlToday}T23:30:00-10:00`);
    const first = await checkMissingReports(evening);
    expect(first.created).toBeGreaterThanOrEqual(1);
    const { data } = await svc.from('ingestion_alerts').select('property_id, expected_for, status').eq('property_id', PROPERTY.hnl).eq('status', 'open');
    expect(data!.map((a) => a.expected_for)).toContain(addDays(hnlToday, -1));
    const second = await checkMissingReports(evening);
    const { count } = await svc.from('ingestion_alerts').select('id', { count: 'exact', head: true }).eq('property_id', PROPERTY.hnl).eq('expected_for', addDays(hnlToday, -1));
    expect(count).toBe(1);
    expect(second.created).toBe(0);
    const { data: notes } = await svc.from('notifications').select('kind').eq('kind', 'missing_report').eq('company_id', COMPANY.harborview).limit(1);
    expect(notes).toHaveLength(1);
  });
});
