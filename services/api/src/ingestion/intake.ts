import { createHash, randomUUID } from 'node:crypto';
import { defaultParserFor, type ReportType } from '@hop/core';
import { config } from '../config.js';
import { queue } from '../queue/index.js';
import { serviceClient } from '../supabase.js';
import { storage } from '../storage/index.js';
import { fileKind, IMPORT_CONTENT_TYPES } from './tables.js';

export interface IntakeInput {
  companyId: string;
  sourceId: string | null;
  reportType: ReportType;
  parserKey?: string;
  filename: string;
  bytes: Uint8Array;
  receivedVia: 'upload' | 'email' | 'integration';
  sender?: string | null;
  emailMessageId?: string | null;
  requestedBy: string | null;
  replaceExisting?: boolean;
}

export interface IntakeResult {
  importRunId: string;
  status: 'queued' | 'duplicate';
  duplicateOfRunId?: string;
}

interface DupCandidate {
  id: string;
  status: string;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
  property_ids: string[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeName(filename: string): string {
  return filename.replace(/[^\w.-]+/g, '_').slice(-120);
}

/**
 * Store the original file privately, record lineage, detect exact duplicates
 * (same company + report type + SHA-256 already loaded or in progress) and
 * enqueue processing. Authorization must be checked by the caller.
 */
export async function intakeFile(input: IntakeInput): Promise<IntakeResult> {
  const cfg = config();
  const kind = fileKind(input.filename);
  if (!kind) throw new Error('Only CSV and XLSX files are supported');
  if (input.bytes.byteLength === 0) throw new Error('File is empty');
  if (input.bytes.byteLength > cfg.MAX_IMPORT_BYTES) throw new Error(`File is too large (max ${Math.floor(cfg.MAX_IMPORT_BYTES / 1048576)} MB)`);
  const svc = await serviceClient();
  const hash = sha256Hex(input.bytes);
  const now = new Date();
  const key = `sources/${input.companyId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}-${safeName(input.filename)}`;
  const contentType = IMPORT_CONTENT_TYPES[kind];
  await storage().put(cfg.SOURCE_FILES_BUCKET, key, input.bytes, contentType);

  const { data: file, error: fileErr } = await svc
    .from('source_files')
    .insert({
      company_id: input.companyId,
      source_id: input.sourceId,
      storage_key: key,
      original_filename: input.filename.slice(0, 200),
      content_type: contentType,
      size_bytes: input.bytes.byteLength,
      sha256: hash,
      received_via: input.receivedVia,
      sender: input.sender ?? null,
      email_message_id: input.emailMessageId ?? null,
      uploaded_by: input.requestedBy,
    })
    .select('id')
    .single();
  if (fileErr) throw new Error(`record source file: ${fileErr.message}`);

  // Duplicate detection: an identical file of the same type already loaded / in
  // flight. A completed earlier import only counts while it is still the latest
  // word on its data: if a later import changed the same properties and dates,
  // re-sending the original is a revision (restore) and goes through review.
  const { data: dupes } = await svc
    .from('import_runs')
    .select('id, status, created_at, period_start, period_end, property_ids, source_files!inner(sha256)')
    .eq('company_id', input.companyId)
    .eq('report_type', input.reportType)
    .eq('source_files.sha256', hash)
    .in('status', ['queued', 'processing', 'needs_review', 'completed'])
    .order('created_at', { ascending: false })
    .limit(1);
  const prior = (dupes as Array<DupCandidate> | null)?.[0];
  let dup: DupCandidate | undefined = prior;
  if (prior && prior.status === 'completed' && prior.period_start && prior.period_end) {
    const { data: later } = await svc
      .from('import_runs')
      .select('id, property_ids, rows_inserted, rows_updated')
      .eq('company_id', input.companyId)
      .eq('report_type', input.reportType)
      .eq('status', 'completed')
      .gt('created_at', prior.created_at)
      .lte('period_start', prior.period_end)
      .gte('period_end', prior.period_start);
    const changed = ((later ?? []) as Array<{ property_ids: string[]; rows_inserted: number | null; rows_updated: number | null }>).some(
      (r) => (r.rows_updated ?? 0) + (r.rows_inserted ?? 0) > 0 && r.property_ids.some((p) => prior.property_ids.includes(p)),
    );
    if (changed) dup = undefined;
  }

  const { data: run, error: runErr } = await svc
    .from('import_runs')
    .insert({
      company_id: input.companyId,
      source_id: input.sourceId,
      source_file_id: (file as { id: string }).id,
      report_type: input.reportType,
      parser_key: input.parserKey ?? defaultParserFor(input.reportType),
      status: dup ? 'duplicate' : 'queued',
      duplicate_of_run_id: dup?.id ?? null,
      replace_existing: input.replaceExisting ?? false,
      requested_by: input.requestedBy,
      completed_at: dup ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (runErr) throw new Error(`create import run: ${runErr.message}`);
  const runId = (run as { id: string }).id;
  await svc.rpc('svc_audit', {
    p_company_id: input.companyId,
    p_action: dup ? 'import.duplicate_detected' : 'import.received',
    p_entity_type: 'import_run',
    p_entity_id: runId,
    p_metadata: { filename: input.filename, sha256: hash, via: input.receivedVia, sender: input.sender ?? null, duplicate_of: dup?.id ?? null },
    p_property_id: null,
    p_actor: input.requestedBy,
  });
  if (dup) return { importRunId: runId, status: 'duplicate', duplicateOfRunId: dup.id };
  await queue().send({ type: 'import.process', importRunId: runId });
  return { importRunId: runId, status: 'queued' };
}
