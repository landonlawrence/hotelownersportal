import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listParsers } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { apiFetch } from '../lib/api';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate } from '../components/ui';

interface Run {
  id: string; source_id: string | null; report_type: string; status: string; created_at: string; completed_at: string | null; attempts: number; last_error: string | null;
  rows_total: number | null; rows_valid: number | null; rows_inserted: number | null; rows_updated: number | null; rows_unchanged: number | null; conflicts: number | null;
  issues_errors: number; issues_warnings: number; period_start: string | null; period_end: string | null; duplicate_of_run_id: string | null; replace_existing: boolean;
  result: { preview?: { conflictDetails?: Array<Record<string, unknown>> } } | null; review_note: string | null;
  source_files: { original_filename: string; received_via: string; sender: string | null; sha256: string } | null;
  ingestion_sources: { name: string } | null;
}

const TYPE_LABEL: Record<string, string> = { daily_performance: 'Daily performance', monthly_actuals: 'Monthly actuals', budget: 'Budget' };

export function ImportsPage() {
  const { can } = usePortal();
  const company = useCompany();
  const [uploading, setUploading] = useState(false);
  const runs = useQuery({
    queryKey: ['import-runs', company.company_id],
    refetchInterval: (q) => ((q.state.data as Run[] | undefined)?.some((r) => ['queued', 'processing'].includes(r.status)) ? 2000 : false),
    queryFn: async () => unwrap(await supabase.from('import_runs').select('id, source_id, report_type, status, created_at, completed_at, attempts, last_error, rows_total, rows_valid, rows_inserted, rows_updated, rows_unchanged, conflicts, issues_errors, issues_warnings, period_start, period_end, duplicate_of_run_id, replace_existing, result, review_note, source_files(original_filename, received_via, sender, sha256), ingestion_sources(name)').eq('company_id', company.company_id).order('created_at', { ascending: false }).limit(100)) as unknown as Run[],
  });
  const alerts = useQuery({
    queryKey: ['ingestion-alerts', company.company_id],
    queryFn: async () => unwrap(await supabase.from('ingestion_alerts').select('id, message, expected_for, created_at').eq('company_id', company.company_id).eq('status', 'open').order('expected_for', { ascending: false }).limit(20)) as Array<{ id: string; message: string; expected_for: string; created_at: string }>,
  });
  const sources = useQuery({
    queryKey: ['ingestion-sources', company.company_id],
    queryFn: async () => unwrap(await supabase.from('ingestion_sources').select('id, name, channel, report_type, parser_key, revision_policy, expected_cadence, active').eq('company_id', company.company_id).order('name')) as Array<{ id: string; name: string; channel: string; report_type: string; parser_key: string; revision_policy: string; expected_cadence: string; active: boolean }>,
  });
  const canUpload = can('ingestion.manage') || can('financials.edit') || can('budgets.edit');
  return (
    <div className="stack">
      <PageHeader title="Data imports" subtitle="Standardized CSV/XLSX uploads and scheduled report emails. Files are validated before anything is written." actions={canUpload && <button className="btn btn-primary" onClick={() => setUploading(true)}>Upload file</button>} />
      {(alerts.data ?? []).length > 0 && (
        <Card title={`Missing reports (${alerts.data!.length})`}>
          <ul className="timeline">{alerts.data!.map((a) => <li key={a.id}><StatusBadge status="late" label="missing" /> {a.message}</li>)}</ul>
        </Card>
      )}
      <Card flush title="Import history">
        {runs.isLoading ? <Loading /> : runs.error ? <ErrorState error={runs.error} /> : (runs.data ?? []).length === 0 ? <Empty title="No imports yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Received</th><th>File</th><th>Type</th><th>Source</th><th>Status</th><th className="num">Rows</th><th className="num">New / revised / same</th><th className="num">Issues</th></tr></thead>
              <tbody>
                {runs.data!.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td><Link to={`/imports/${r.id}`}>{r.source_files?.original_filename ?? '—'}</Link></td>
                    <td>{TYPE_LABEL[r.report_type]}</td>
                    <td className="small">{r.ingestion_sources?.name ?? 'Manual upload'}{r.source_files?.received_via === 'email' && ` · ${r.source_files.sender}`}</td>
                    <td><StatusBadge status={r.status} label={r.status.replace('_', ' ')} /></td>
                    <td className="num">{r.rows_valid ?? '—'}</td>
                    <td className="num">{r.status === 'completed' ? `${r.rows_inserted ?? 0} / ${r.rows_updated ?? 0} / ${r.rows_unchanged ?? 0}` : '—'}</td>
                    <td className="num">{r.issues_errors > 0 ? <span className="delta-bad">{r.issues_errors} errors</span> : r.issues_warnings > 0 ? `${r.issues_warnings} warnings` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card flush title="Ingestion sources & supported formats">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Source</th><th>Channel</th><th>Report</th><th>Revisions</th><th>Expected</th><th>Active</th></tr></thead>
            <tbody>
              {(sources.data ?? []).map((s) => (
                <tr key={s.id}><td>{s.name}</td><td>{s.channel}</td><td>{TYPE_LABEL[s.report_type]}</td><td>{s.revision_policy === 'replace' ? 'Replace (history kept)' : 'Require review'}</td><td>{s.expected_cadence}</td><td>{s.active ? 'Yes' : 'No'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: 16 }} className="small muted">
          Supported formats: {listParsers().map((p) => p.label).join('; ')}. PMS-specific formats are added only after verification against real sample reports.
        </div>
      </Card>
      {uploading && <UploadImport onClose={() => setUploading(false)} sources={sources.data ?? []} />}
    </div>
  );
}

function UploadImport({ onClose, sources }: { onClose: () => void; sources: Array<{ id: string; name: string; report_type: string; channel: string }> }) {
  const company = useCompany();
  const { can } = usePortal();
  const qc = useQueryClient();
  const types = [
    { v: 'daily_performance', ok: can('ingestion.manage') },
    { v: 'monthly_actuals', ok: can('financials.edit') },
    { v: 'budget', ok: can('budgets.edit') },
  ].filter((t) => t.ok);
  const [type, setType] = useState(types[0]?.v ?? 'daily_performance');
  const [source, setSource] = useState('');
  const [replace, setReplace] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const parser = listParsers().find((p) => p.reportType === type)!;
  const go = async () => {
    if (!file) return;
    const form = new FormData();
    form.set('company_id', company.company_id);
    form.set('report_type', type);
    if (source) form.set('source_id', source);
    form.set('replace_existing', String(replace));
    form.set('file', file);
    try {
      const res = await apiFetch('/imports', { method: 'POST', body: form });
      const body = (await res.json()) as { status: string };
      setMsg(body.status === 'duplicate' ? { tone: 'warn', text: 'This exact file was already imported. Nothing was changed.' } : { tone: 'good', text: 'File received. Validation and loading run in the background — check the import history.' });
      await qc.invalidateQueries({ queryKey: ['import-runs'] });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  };
  return (
    <Modal title="Upload data file" onClose={onClose}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <label className="field">Report type<select value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t.v} value={t.v}>{TYPE_LABEL[t.v]}</option>)}</select></label>
      <label className="field">Source (optional)<select value={source} onChange={(e) => setSource(e.target.value)}><option value="">Manual upload (property codes)</option>{sources.filter((s) => s.report_type === type).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <input type="file" aria-label="Data file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <p className="small muted">Required columns: {parser.requiredColumns.join(', ')}{parser.optionalColumns.length > 0 && `. Optional: ${parser.optionalColumns.join(', ')}`}.</p>
      {type !== 'budget' && (
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace previously loaded values for the same dates/periods (history is kept). Otherwise conflicts go to review.</label>
      )}
      <button className="btn btn-primary" disabled={!file} onClick={go}>Upload & validate</button>
    </Modal>
  );
}

export function ImportDetailPage() {
  const { id } = useParams();
  const { can } = usePortal();
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ['import-run', id],
    refetchInterval: (q) => (['queued', 'processing'].includes((q.state.data as Run | null)?.status ?? '') ? 1500 : false),
    queryFn: async () => unwrap(await supabase.from('import_runs').select('*, source_files(original_filename, received_via, sender, sha256), ingestion_sources(name)').eq('id', id!).maybeSingle()) as unknown as (Run & { company_id: string }) | null,
  });
  const issues = useQuery({
    queryKey: ['import-issues', id],
    queryFn: async () => unwrap(await supabase.from('import_validation_issues').select('id, severity, row_number, field, code, message').eq('import_run_id', id!).order('row_number', { nullsFirst: true }).limit(500)) as Array<{ id: number; severity: string; row_number: number | null; field: string | null; code: string; message: string }>,
  });
  const [err, setErr] = useState<string | null>(null);
  const act = async (path: string) => {
    setErr(null);
    try {
      await apiFetch(`/imports/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      await qc.invalidateQueries();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  if (run.isLoading) return <Loading />;
  if (!run.data) return <Empty title="Import not found" />;
  const r = run.data;
  const manage = can('ingestion.manage') || (r.report_type === 'monthly_actuals' && can('financials.edit'));
  const conflicts = r.result?.preview?.conflictDetails ?? [];
  return (
    <div className="stack">
      <div className="small"><Link to="/imports">← Data imports</Link></div>
      <PageHeader title={r.source_files?.original_filename ?? 'Import'} subtitle={<>{TYPE_LABEL[r.report_type]} · <StatusBadge status={r.status} label={r.status.replace('_', ' ')} /></>}
        actions={
          <>
            {r.status === 'needs_review' && manage && <button className="btn btn-primary" onClick={() => act('approve')}>Approve revision</button>}
            {['needs_review', 'failed'].includes(r.status) && can('ingestion.manage') && <button className="btn btn-danger" onClick={() => act('reject')}>Reject</button>}
            {r.status === 'failed' && can('ingestion.manage') && <button className="btn" onClick={() => act('retry')}>Retry</button>}
          </>
        } />
      {err && <Notice tone="bad">{err}</Notice>}
      {r.status === 'needs_review' && <Notice tone="warn">{r.conflicts} value(s) differ from data already loaded. Approving replaces them and keeps the previous values in revision history{r.report_type === 'monthly_actuals' ? ' (published statements receive a new draft revision)' : ''}.</Notice>}
      {r.status === 'duplicate' && <Notice tone="info">Identical to a previously imported file — nothing was changed. {r.duplicate_of_run_id && <Link to={`/imports/${r.duplicate_of_run_id}`}>View original import</Link>}</Notice>}
      {r.last_error && <Notice tone="bad">Processing error (attempt {r.attempts}): {r.last_error}</Notice>}
      <Card title="Details">
        <dl className="kv">
          <dt>Source</dt><dd>{r.ingestion_sources?.name ?? 'Manual upload'} ({r.source_files?.received_via}{r.source_files?.sender ? `, ${r.source_files.sender}` : ''})</dd>
          <dt>Received</dt><dd>{fmtDate(r.created_at, { dateStyle: 'medium', timeStyle: 'short' } as Intl.DateTimeFormatOptions)}</dd>
          <dt>Period</dt><dd>{r.period_start ? `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` : '—'}</dd>
          <dt>Rows</dt><dd>{r.rows_valid ?? 0} valid of {r.rows_total ?? 0}</dd>
          <dt>Result</dt><dd>{r.status === 'completed' ? `${r.rows_inserted ?? 0} new, ${r.rows_updated ?? 0} revised, ${r.rows_unchanged ?? 0} unchanged` : '—'}</dd>
          <dt>Replacement rule</dt><dd>{r.replace_existing ? 'Replace existing values (history kept)' : 'Review required for changed values'}</dd>
          <dt>File fingerprint</dt><dd className="small muted">{r.source_files?.sha256}</dd>
          {r.review_note && <><dt>Review note</dt><dd>{r.review_note}</dd></>}
        </dl>
      </Card>
      {conflicts.length > 0 && (
        <Card title="Changed values" flush>
          <div className="table-wrap"><table className="data"><thead><tr><th>Property / period</th><th>Existing</th><th>Incoming</th></tr></thead><tbody>
            {conflicts.slice(0, 100).map((c, i) => <tr key={i}><td className="small">{String(c.businessDate ?? c.periodMonth ?? '')}</td><td className="small muted">{c.existing ? JSON.stringify(c.existing) : String(c.reason ?? '')}</td><td className="small">{c.incoming ? JSON.stringify(c.incoming) : ''}</td></tr>)}
          </tbody></table></div>
        </Card>
      )}
      <Card title={`Validation issues (${issues.data?.length ?? 0})`} flush>
        {(issues.data ?? []).length === 0 ? <Empty title="No issues" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Severity</th><th>Row</th><th>Field</th><th>Issue</th></tr></thead><tbody>
            {issues.data!.map((i) => <tr key={i.id}><td><StatusBadge status={i.severity === 'error' ? 'error' : 'pending'} label={i.severity} /></td><td>{i.row_number ?? 'file'}</td><td>{i.field ?? '—'}</td><td>{i.message}<div className="small muted">{i.code}</div></td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
