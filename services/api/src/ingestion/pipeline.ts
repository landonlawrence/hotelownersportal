/**
 * Import pipeline (runs in the worker, never in an interactive request):
 *
 *   1. claim the run (idempotent: only queued runs are processed)
 *   2. load the original source file from private storage
 *   3. identify company / source / property mappings (approved routes only)
 *   4. re-verify the requesting user's permissions for every property
 *   5. parse deterministically and validate
 *   6. record validation issues; reject on errors
 *   7. dry-run the write to detect revisions/conflicts → needs_review unless replacement is allowed
 *   8. write idempotently with history, record counts and lineage
 */
import {
  getParser,
  hasErrors,
  localToday,
  type ParseContext,
  type PropertyRef,
  type ReportType,
  type ValidationIssue,
} from '@hop/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { serviceClient } from '../supabase.js';
import { storage } from '../storage/index.js';
import { fileKind, toTable } from './tables.js';

export const IMPORT_PERMISSION: Record<ReportType, string> = {
  daily_performance: 'ingestion.manage',
  monthly_actuals: 'financials.edit',
  budget: 'budgets.edit',
};

const APPLY_RPC: Record<ReportType, string> = {
  daily_performance: 'svc_apply_daily_performance',
  monthly_actuals: 'svc_apply_monthly_actuals',
  budget: 'svc_apply_budget',
};

interface ImportRun {
  id: string;
  company_id: string;
  source_id: string | null;
  source_file_id: string;
  report_type: ReportType;
  parser_key: string;
  status: string;
  replace_existing: boolean;
  attempts: number;
  max_attempts: number;
  requested_by: string | null;
}

export class TransientImportError extends Error {}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new TransientImportError(`${what}: ${error.message}`);
  return data as T;
}

/** Build the parse context strictly from the run's company (and route mappings for routed sources). */
export async function buildContext(svc: SupabaseClient, run: ImportRun): Promise<ParseContext> {
  const props = await must<Array<{ id: string; code: string; opened_on: string | null; timezone: string }>>(
    svc.from('properties').select('id, code, opened_on, timezone').eq('company_id', run.company_id),
    'load properties',
  );
  const inventory = await must<Array<{ property_id: string; effective_from: string; effective_to: string | null; room_count: number }>>(
    svc.from('room_inventory_history').select('property_id, effective_from, effective_to, room_count').eq('company_id', run.company_id),
    'load inventory',
  );
  const refs = new Map<string, PropertyRef>();
  for (const p of props) {
    const inv = inventory.filter((i) => i.property_id === p.id);
    refs.set(p.id, {
      id: p.id,
      code: p.code,
      openedOn: p.opened_on,
      timeZone: p.timezone,
      roomsOn: (d) => inv.find((i) => i.effective_from <= d && (i.effective_to === null || i.effective_to > d))?.room_count ?? null,
    });
  }

  const propertyByCode = new Map<string, PropertyRef>();
  let routed = false;
  if (run.source_id) {
    const mappings = await must<Array<{ external_code: string; property_id: string }>>(
      svc.from('ingestion_property_mappings').select('external_code, property_id').eq('source_id', run.source_id).eq('company_id', run.company_id),
      'load mappings',
    );
    if (mappings.length > 0) {
      routed = true;
      for (const m of mappings) {
        const ref = refs.get(m.property_id);
        if (ref) propertyByCode.set(m.external_code, ref);
      }
    }
  }
  if (!routed) {
    for (const ref of refs.values()) propertyByCode.set(ref.code, ref);
  }

  const accounts = await must<Array<{ id: string; code: string }>>(
    svc.from('financial_accounts').select('id, code').eq('company_id', run.company_id),
    'load accounts',
  );
  const mappings = await must<Array<{ property_id: string | null; source_account_code: string; account_id: string }>>(
    svc.from('source_account_mappings').select('property_id, source_account_code, account_id').eq('company_id', run.company_id),
    'load account mappings',
  );
  return {
    propertyByCode,
    todayFor: (p) => localToday(p.timeZone),
    reportingAccounts: new Map(accounts.map((a) => [a.code, a])),
    accountMapping: (code, propertyId) =>
      mappings.find((m) => m.property_id === propertyId && m.source_account_code === code)?.account_id ??
      mappings.find((m) => m.property_id === null && m.source_account_code === code)?.account_id ??
      null,
  };
}

async function writeIssues(svc: SupabaseClient, run: ImportRun, issues: ValidationIssue[]) {
  await svc.from('import_validation_issues').delete().eq('import_run_id', run.id);
  for (let i = 0; i < issues.length; i += 500) {
    const chunk = issues.slice(i, i + 500).map((x) => ({
      company_id: run.company_id,
      import_run_id: run.id,
      severity: x.severity,
      row_number: x.row,
      field: x.field,
      code: x.code,
      message: x.message,
    }));
    const { error } = await svc.from('import_validation_issues').insert(chunk);
    if (error) throw new TransientImportError(`write issues: ${error.message}`);
  }
}

async function finish(svc: SupabaseClient, runId: string, patch: Record<string, unknown>) {
  const { error } = await svc.from('import_runs').update({ ...patch, completed_at: new Date().toISOString() }).eq('id', runId);
  if (error) throw new TransientImportError(`update run: ${error.message}`);
}

export async function processImportRun(importRunId: string): Promise<{ status: string }> {
  const cfg = config();
  const svc = await serviceClient();

  // Claim atomically: only a queued run moves to processing.
  const { data: claimed, error: claimErr } = await svc
    .from('import_runs')
    .update({ status: 'processing', started_at: new Date().toISOString(), last_error: null })
    .eq('id', importRunId)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle();
  if (claimErr) throw new TransientImportError(claimErr.message);
  if (!claimed) {
    const { data: cur } = await svc.from('import_runs').select('status').eq('id', importRunId).maybeSingle();
    return { status: (cur as { status?: string } | null)?.status ?? 'missing' };
  }
  const run = claimed as ImportRun;
  await svc.from('import_runs').update({ attempts: run.attempts + 1 }).eq('id', run.id);

  try {
    const file = await must<{ storage_key: string; original_filename: string; content_type: string; company_id: string }>(
      svc.from('source_files').select('storage_key, original_filename, content_type, company_id').eq('id', run.source_file_id).single(),
      'load source file',
    );
    if (file.company_id !== run.company_id) throw new Error('Source file belongs to another company');

    const parser = getParser(run.parser_key);
    if (!parser || parser.reportType !== run.report_type) {
      await writeIssues(svc, run, [{ severity: 'error', row: null, field: null, code: 'unsupported_parser', message: `Parser ${run.parser_key} is not supported for ${run.report_type}` }]);
      await finish(svc, run.id, { status: 'rejected', issues_errors: 1 });
      return { status: 'rejected' };
    }

    const issues: ValidationIssue[] = [];
    let source: { active: boolean; revision_policy: string } | null = null;
    if (run.source_id) {
      source = await must(svc.from('ingestion_sources').select('active, revision_policy').eq('id', run.source_id).eq('company_id', run.company_id).single(), 'load source');
      if (!source.active) issues.push({ severity: 'error', row: null, field: null, code: 'source_inactive', message: 'Ingestion source is inactive' });
    }

    // Manual uploads: the requester must still hold the import permission (revocation is honoured).
    if (run.requested_by) {
      const perm = IMPORT_PERMISSION[run.report_type];
      const { data: allowed } = await svc.rpc('svc_user_has_permission', { p_user: run.requested_by, p_perm: perm, p_company_id: run.company_id, p_property_id: null });
      if (!allowed) issues.push({ severity: 'error', row: null, field: null, code: 'not_authorized', message: `Requester no longer holds ${perm}` });
    } else if (!run.source_id) {
      issues.push({ severity: 'error', row: null, field: null, code: 'no_authority', message: 'Import has neither an authorized requester nor an approved route' });
    }

    const kind = fileKind(file.original_filename, file.content_type);
    if (!kind) {
      issues.push({ severity: 'error', row: null, field: null, code: 'unsupported_file', message: 'Only CSV and XLSX files are supported' });
    }

    let records: Array<{ propertyId: string }> = [];
    let result: Awaited<ReturnType<typeof parser.parse>> | null = null;
    if (!hasErrors(issues) && kind) {
      const bytes = await storage().get(cfg.SOURCE_FILES_BUCKET, file.storage_key);
      let table;
      try {
        table = await toTable(bytes, kind);
      } catch (e) {
        issues.push({ severity: 'error', row: null, field: null, code: 'unreadable_file', message: `File could not be read: ${(e as Error).message}` });
      }
      if (table) {
        const ctx = await buildContext(svc, run);
        result = parser.parse(table, ctx);
        issues.push(...result.issues);
        records = result.records as Array<{ propertyId: string }>;
      }
    }

    // Property-level authorization for manual uploads.
    const propertyIds = [...new Set(records.map((r) => r.propertyId))];
    if (run.requested_by && propertyIds.length > 0 && !hasErrors(issues)) {
      const perm = IMPORT_PERMISSION[run.report_type];
      for (const pid of propertyIds) {
        const { data: ok } = await svc.rpc('svc_user_has_permission', { p_user: run.requested_by, p_perm: perm, p_company_id: run.company_id, p_property_id: pid });
        if (!ok) issues.push({ severity: 'error', row: null, field: 'property_code', code: 'unauthorized_property', message: `Requester is not authorized to import data for property ${pid}` });
      }
    }

    await writeIssues(svc, run, issues);
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.length - errors;
    const base = {
      issues_errors: errors,
      issues_warnings: warnings,
      rows_total: result ? result.records.length + new Set(issues.filter((i) => i.row !== null && i.severity === 'error').map((i) => i.row)).size : null,
      rows_valid: result?.records.length ?? 0,
      period_start: result?.periodStart ?? null,
      period_end: result?.periodEnd ?? null,
      property_ids: propertyIds,
    };
    if (errors > 0 || !result) {
      await finish(svc, run.id, { ...base, status: 'rejected' });
      await notifyRequester(svc, run, 'Import rejected', `${errors} validation error(s) must be fixed before this file can be loaded.`);
      return { status: 'rejected' };
    }

    const replace = run.replace_existing || source?.revision_policy === 'replace';
    const rpc = APPLY_RPC[run.report_type];
    const args = (dry: boolean) =>
      run.report_type === 'budget'
        ? { p_import_run_id: run.id, p_records: result!.records, p_dry_run: dry }
        : { p_import_run_id: run.id, p_records: result!.records, p_replace: replace, p_dry_run: dry };

    const { data: preview, error: previewErr } = await svc.rpc(rpc, args(true));
    if (previewErr) throw new TransientImportError(`${rpc} dry run: ${previewErr.message}`);
    const pv = preview as { conflicts: number; conflictDetails?: unknown };
    if (pv.conflicts > 0) {
      await finish(svc, run.id, {
        ...base,
        status: 'needs_review',
        conflicts: pv.conflicts,
        result: { preview: pv },
      });
      await notifyManagers(svc, run, `Import needs review: ${pv.conflicts} revised value(s)`);
      return { status: 'needs_review' };
    }

    const { data: applied, error: applyErr } = await svc.rpc(rpc, args(false));
    if (applyErr) throw new TransientImportError(`${rpc}: ${applyErr.message}`);
    const ap = applied as { inserted: number; updated: number; unchanged: number; conflicts: number };
    await finish(svc, run.id, {
      ...base,
      status: 'completed',
      rows_inserted: ap.inserted,
      rows_updated: ap.updated,
      rows_unchanged: ap.unchanged,
      conflicts: 0,
      result: applied,
    });
    if (run.report_type === 'daily_performance') await resolveAlerts(svc, run.company_id, result.records as Array<{ propertyId: string; businessDate: string }>);
    await svc.rpc('svc_audit', {
      p_company_id: run.company_id,
      p_action: 'import.completed',
      p_entity_type: 'import_run',
      p_entity_id: run.id,
      p_metadata: { report_type: run.report_type, inserted: ap.inserted, updated: ap.updated, unchanged: ap.unchanged },
      p_property_id: null,
      p_actor: run.requested_by,
    });
    await notifyRequester(svc, run, 'Import completed', `${ap.inserted} new, ${ap.updated} revised, ${ap.unchanged} unchanged.`);
    return { status: 'completed' };
  } catch (e) {
    const exhausted = run.attempts + 1 >= run.max_attempts;
    await svc
      .from('import_runs')
      .update({ status: exhausted ? 'failed' : 'queued', last_error: (e as Error).message.slice(0, 1000) })
      .eq('id', run.id);
    throw e;
  }
}

async function resolveAlerts(svc: SupabaseClient, companyId: string, records: Array<{ propertyId: string; businessDate: string }>) {
  for (const r of records) {
    await svc
      .from('ingestion_alerts')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('property_id', r.propertyId)
      .eq('expected_for', r.businessDate)
      .eq('status', 'open');
  }
}

async function notifyRequester(svc: SupabaseClient, run: ImportRun, title: string, body: string) {
  if (!run.requested_by) return;
  await svc.from('notifications').insert({
    company_id: run.company_id,
    user_id: run.requested_by,
    kind: 'import_status',
    title,
    body,
    link_path: `/imports/${run.id}`,
    entity_type: 'import_run',
    entity_id: run.id,
  });
}

async function notifyManagers(svc: SupabaseClient, run: ImportRun, title: string) {
  const { data: members } = await svc.from('company_memberships').select('user_id').eq('company_id', run.company_id).eq('status', 'active');
  for (const m of (members ?? []) as Array<{ user_id: string }>) {
    const { data: ok } = await svc.rpc('svc_user_has_permission', { p_user: m.user_id, p_perm: 'ingestion.manage', p_company_id: run.company_id, p_property_id: null });
    if (ok) {
      await svc.from('notifications').insert({
        company_id: run.company_id,
        user_id: m.user_id,
        kind: 'import_review',
        title,
        link_path: `/imports/${run.id}`,
        entity_type: 'import_run',
        entity_id: run.id,
      });
    }
  }
}
