import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import type { AppEnv } from '../context.js';
import { badRequest, forbidden, fromPostgrest, notFound } from '../errors.js';
import { sha256Hex } from '../ingestion/intake.js';
import { queue } from '../queue/index.js';
import { storage } from '../storage/index.js';
import { requireUser } from '../middleware.js';
import { serviceClient } from '../supabase.js';

export const documents = new Hono<AppEnv>();
documents.use('*', requireUser);

const uploadSchema = z.object({
  company_id: z.string().uuid(),
  property_id: z.string().uuid().nullable(),
  document_id: z.string().uuid().nullable().optional(),
  category_key: z.string().min(2).max(40),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  visibility: z.enum(['general', 'owner', 'internal', 'confidential']),
  period_month: z.string().regex(/^\d{4}-\d{2}-01$/).nullable().optional(),
  filename: z.string().min(3).max(200),
  content_type: z.string().min(3).max(120),
  size_bytes: z.number().int().positive(),
  linked_entity_type: z.enum(['financial_report', 'capex_project', 'reporting_package', 'capex_transaction']).nullable().optional(),
  linked_entity_id: z.string().uuid().nullable().optional(),
});

/** Step 1: authorize and register an upload; returns a short-lived upload URL into quarantine. */
documents.post('/uploads', async (c) => {
  const body = uploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw badRequest(body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const b = body.data;
  const db = c.get('db');
  // The RPC re-checks permissions, file type/size and visibility in the database as the user.
  const { data, error } = await db.rpc('create_document_upload', {
    p_company_id: b.company_id,
    p_property_id: b.property_id,
    p_document_id: b.document_id ?? null,
    p_category_key: b.category_key,
    p_title: b.title,
    p_description: b.description ?? null,
    p_visibility: b.visibility,
    p_period_month: b.period_month ?? null,
    p_filename: b.filename,
    p_content_type: b.content_type,
    p_size_bytes: b.size_bytes,
    p_linked_entity_type: b.linked_entity_type ?? null,
    p_linked_entity_id: b.linked_entity_id ?? null,
  });
  if (error) throw fromPostgrest(error);
  const created = data as { document_id: string; version_id: string; max_bytes: number };
  const svc = await serviceClient();
  const { data: v } = await svc.from('document_versions').select('storage_key').eq('id', created.version_id).single();
  const cfg = config();
  const upload = await storage().presignUpload(
    cfg.DOCUMENTS_BUCKET,
    (v as { storage_key: string }).storage_key,
    b.content_type,
    Math.min(created.max_bytes, b.size_bytes),
    cfg.UPLOAD_URL_TTL_SECONDS,
  );
  return c.json({ document_id: created.document_id, version_id: created.version_id, upload }, 201);
});

/** Step 2: the uploader confirms; the object is verified and queued for scanning. */
documents.post('/versions/:id/complete', async (c) => {
  const versionId = c.req.param('id');
  if (!z.string().uuid().safeParse(versionId).success) throw notFound();
  const auth = c.get('auth');
  const svc = await serviceClient();
  const { data } = await svc
    .from('document_versions')
    .select('id, company_id, property_id, storage_key, size_bytes, uploaded_by, scan_status')
    .eq('id', versionId)
    .maybeSingle();
  const v = data as { id: string; company_id: string; property_id: string | null; storage_key: string; size_bytes: number; uploaded_by: string; scan_status: string } | null;
  if (!v || v.uploaded_by !== auth.userId) throw notFound();
  if (v.scan_status !== 'awaiting_upload') return c.json({ version_id: v.id, scan_status: v.scan_status });
  const cfg = config();
  const head = await storage().head(cfg.DOCUMENTS_BUCKET, v.storage_key);
  if (!head) throw badRequest('Upload not found; upload the file before completing');
  const bytes = await storage().get(cfg.DOCUMENTS_BUCKET, v.storage_key);
  const { error } = await svc.rpc('svc_complete_document_upload', { p_version_id: v.id, p_size_bytes: head.size, p_sha256: sha256Hex(bytes) });
  if (error) throw fromPostgrest(error);
  await queue().send({ type: 'document.scan', versionId: v.id });
  const { data: after } = await svc.from('document_versions').select('scan_status').eq('id', v.id).single();
  return c.json({ version_id: v.id, scan_status: (after as { scan_status: string }).scan_status });
});

/**
 * Download: authorized as the user (RLS + explicit visibility + scan checks,
 * audited in the database), then a ≤60s signed URL is issued. Unauthorized and
 * nonexistent versions are indistinguishable (404).
 */
documents.get('/versions/:id/download', async (c) => {
  const versionId = c.req.param('id');
  if (!z.string().uuid().safeParse(versionId).success) throw notFound();
  const db = c.get('db');
  const { data: allowed, error } = await db.rpc('authorize_document_download', { p_version_id: versionId });
  if (error) throw fromPostgrest(error);
  if (allowed !== true) throw notFound('Document not found or not available');
  const svc = await serviceClient();
  const { data } = await svc.from('document_versions').select('storage_key, original_filename, content_type').eq('id', versionId).single();
  const v = data as { storage_key: string; original_filename: string; content_type: string };
  if (!v.storage_key.startsWith('clean/')) throw forbidden('File has not passed security scanning');
  const cfg = config();
  const signed = await storage().presignDownload(cfg.DOCUMENTS_BUCKET, v.storage_key, {
    filename: v.original_filename,
    contentType: v.content_type,
    ttlSeconds: cfg.DOWNLOAD_URL_TTL_SECONDS,
  });
  return c.json({ url: signed.url, expires_at: signed.expiresAt, filename: v.original_filename });
});

/**
 * Manual release (scanning not configured): the database authorizes the
 * document manager and records the release; the API then promotes the object
 * out of quarantine so it can be signed for download.
 */
documents.post('/versions/:id/release', async (c) => {
  const versionId = c.req.param('id');
  if (!z.string().uuid().safeParse(versionId).success) throw notFound();
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const { error } = await c.get('db').rpc('release_document_version', { p_version_id: versionId, p_note: body.note ?? '' });
  if (error) throw fromPostgrest(error);
  const svc = await serviceClient();
  const { data } = await svc.from('document_versions').select('storage_key').eq('id', versionId).single();
  const key = (data as { storage_key: string }).storage_key;
  if (key.startsWith('quarantine/')) {
    const cleanKey = key.replace(/^quarantine\//, 'clean/');
    await storage().move(config().DOCUMENTS_BUCKET, key, cleanKey);
    await svc.from('document_versions').update({ storage_key: cleanKey }).eq('id', versionId);
  }
  return c.json({ version_id: versionId, released: true });
});
