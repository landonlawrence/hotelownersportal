import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import type { AppEnv } from '../context.js';
import { badRequest, forbidden, fromPostgrest, notFound, conflict } from '../errors.js';
import { intakeFile } from '../ingestion/intake.js';
import { IMPORT_PERMISSION } from '../ingestion/pipeline.js';
import { requireUser } from '../middleware.js';
import { queue } from '../queue/index.js';
import { serviceClient } from '../supabase.js';

export const imports = new Hono<AppEnv>();
imports.use('*', requireUser);

const reportTypes = z.enum(['daily_performance', 'monthly_actuals', 'budget']);

async function can(c: { get: (k: 'db') => import('@supabase/supabase-js').SupabaseClient }, perm: string, companyId: string, propertyId: string | null = null) {
  const { data, error } = await c.get('db').rpc('check_permission', { p_perm: perm, p_company_id: companyId, p_property_id: propertyId });
  if (error) throw fromPostgrest(error);
  return data === true;
}

/** Manual upload of a standardized CSV/XLSX file. Processing happens asynchronously. */
imports.post('/', async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) throw badRequest('multipart/form-data body expected');
  const companyId = z.string().uuid().safeParse(form.company_id);
  const reportType = reportTypes.safeParse(form.report_type);
  if (!companyId.success || !reportType.success) throw badRequest('company_id and report_type are required');
  const file = form.file;
  if (!(file instanceof File)) throw badRequest('file is required');
  if (file.size > config().MAX_IMPORT_BYTES) throw badRequest('File is too large');
  const perm = IMPORT_PERMISSION[reportType.data];
  if (!(await can(c, perm, companyId.data))) throw forbidden(`Missing permission ${perm}`);
  let sourceId: string | null = null;
  if (typeof form.source_id === 'string' && form.source_id) {
    const parsed = z.string().uuid().safeParse(form.source_id);
    if (!parsed.success) throw badRequest('invalid source_id');
    // The source must be visible to the user and belong to the same company (RLS-scoped read).
    const { data } = await c.get('db').from('ingestion_sources').select('id, company_id, report_type').eq('id', parsed.data).maybeSingle();
    const src = data as { id: string; company_id: string; report_type: string } | null;
    if (!src || src.company_id !== companyId.data || src.report_type !== reportType.data) throw badRequest('Unknown ingestion source for this company and report type');
    sourceId = src.id;
  }
  try {
    const result = await intakeFile({
      companyId: companyId.data,
      sourceId,
      reportType: reportType.data,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      receivedVia: 'upload',
      requestedBy: c.get('auth').userId,
      replaceExisting: form.replace_existing === 'true',
    });
    return c.json(result, 202);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
});

async function loadRun(c: Parameters<typeof can>[0], id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  // RLS-scoped read: users only see runs they are allowed to see.
  const { data } = await c.get('db').from('import_runs').select('id, company_id, report_type, status, property_ids').eq('id', id).maybeSingle();
  if (!data) throw notFound();
  return data as { id: string; company_id: string; report_type: 'daily_performance' | 'monthly_actuals' | 'budget'; status: string; property_ids: string[] };
}

imports.post('/:id/retry', async (c) => {
  const run = await loadRun(c, c.req.param('id'));
  if (!(await can(c, 'ingestion.manage', run.company_id))) throw forbidden('Missing permission ingestion.manage');
  if (run.status !== 'failed') throw conflict(`Only failed imports can be retried (current: ${run.status})`);
  const svc = await serviceClient();
  await svc.from('import_runs').update({ status: 'queued', attempts: 0, last_error: null }).eq('id', run.id).eq('status', 'failed');
  await svc.rpc('svc_audit', { p_company_id: run.company_id, p_action: 'import.retried', p_entity_type: 'import_run', p_entity_id: run.id, p_metadata: {}, p_property_id: null, p_actor: c.get('auth').userId });
  await queue().send({ type: 'import.process', importRunId: run.id });
  return c.json({ id: run.id, status: 'queued' }, 202);
});

/** Approve replacing previously loaded values (revised report). History is retained. */
imports.post('/:id/approve', async (c) => {
  const run = await loadRun(c, c.req.param('id'));
  const perm = run.report_type === 'daily_performance' ? 'ingestion.manage' : IMPORT_PERMISSION[run.report_type];
  if (!(await can(c, perm, run.company_id))) throw forbidden(`Missing permission ${perm}`);
  if (run.status !== 'needs_review') throw conflict(`Only imports awaiting review can be approved (current: ${run.status})`);
  const note = (await c.req.json().catch(() => ({})))?.note ?? null;
  const svc = await serviceClient();
  const { data: updated } = await svc
    .from('import_runs')
    .update({ status: 'queued', replace_existing: true, reviewed_by: c.get('auth').userId, reviewed_at: new Date().toISOString(), review_note: note })
    .eq('id', run.id)
    .eq('status', 'needs_review')
    .select('id');
  if (!updated?.length) throw conflict('Import was changed by someone else');
  await svc.rpc('svc_audit', { p_company_id: run.company_id, p_action: 'import.revision_approved', p_entity_type: 'import_run', p_entity_id: run.id, p_metadata: { note }, p_property_id: null, p_actor: c.get('auth').userId });
  await queue().send({ type: 'import.process', importRunId: run.id });
  return c.json({ id: run.id, status: 'queued' }, 202);
});

imports.post('/:id/reject', async (c) => {
  const run = await loadRun(c, c.req.param('id'));
  if (!(await can(c, 'ingestion.manage', run.company_id))) throw forbidden('Missing permission ingestion.manage');
  if (!['needs_review', 'failed'].includes(run.status)) throw conflict(`Import cannot be rejected (current: ${run.status})`);
  const note = (await c.req.json().catch(() => ({})))?.note ?? null;
  const svc = await serviceClient();
  await svc.from('import_runs').update({ status: 'rejected', reviewed_by: c.get('auth').userId, reviewed_at: new Date().toISOString(), review_note: note }).eq('id', run.id);
  await svc.rpc('svc_audit', { p_company_id: run.company_id, p_action: 'import.rejected', p_entity_type: 'import_run', p_entity_id: run.id, p_metadata: { note }, p_property_id: null, p_actor: c.get('auth').userId });
  return c.json({ id: run.id, status: 'rejected' });
});
