import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCurrency } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { downloadDocumentVersion, downloadFromApi } from '../lib/api';
import { buildStatement } from '../lib/statement';
import { useAccounts, useDisplayNames, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate, fmtMonth } from '../components/ui';
import { StatementTable } from '../components/StatementTable';

interface Report {
  id: string;
  company_id: string;
  property_id: string;
  period_month: string;
  title: string;
  revision: number;
  status: string;
  supersedes_id: string | null;
  correction_reason: string | null;
  internal_notes?: string | null;
  document_id: string | null;
  submitted_by: string | null;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
}

export function FinancialReportPage() {
  const { id } = useParams();
  const { properties, can } = usePortal();
  const company = useCompany();
  const accounts = useAccounts(company.company_id);
  const qc = useQueryClient();
  const report = useQuery({
    queryKey: ['financial-report', id],
    queryFn: async () => unwrap(await supabase.from('financial_reports').select('id, company_id, property_id, period_month, title, revision, status, supersedes_id, correction_reason, document_id, submitted_by, published_by, published_at, created_at').eq('id', id!).maybeSingle()) as Report | null,
  });
  const r = report.data;
  const lines = useQuery({
    queryKey: ['financial-report-lines', id],
    enabled: !!r,
    queryFn: async () => unwrap(await supabase.from('financial_report_lines').select('id, account_id, amount, source_account_code, source_account_name, source_value, import_run_id').eq('financial_report_id', id!).order('source_account_code')) as Array<{ id: string; account_id: string; amount: number; source_account_code: string; source_account_name: string | null; source_value: string | null; import_run_id: string | null }>,
  });
  const budget = useQuery({
    queryKey: ['report-budget', r?.property_id, r?.period_month],
    enabled: !!r,
    queryFn: async () => unwrap(await supabase.rpc('budget_monthly', { p_company_id: r!.company_id, p_from: r!.period_month, p_to: r!.period_month })) as Array<{ property_id: string; account_id: string; amount: number }>,
  });
  const history = useQuery({
    queryKey: ['publication-history', r?.property_id, r?.period_month],
    enabled: !!r,
    queryFn: async () => {
      const revs = unwrap(await supabase.from('financial_reports').select('id, revision, status, correction_reason, published_at').eq('property_id', r!.property_id).eq('period_month', r!.period_month).order('revision')) as Array<{ id: string; revision: number; status: string; correction_reason: string | null; published_at: string | null }>;
      const events = unwrap(await supabase.from('publication_events').select('id, entity_id, revision, from_status, to_status, comment, actor_user_id, created_at').eq('entity_type', 'financial_report').in('entity_id', revs.map((x) => x.id)).order('created_at')) as Array<{ id: number; entity_id: string; revision: number | null; from_status: string | null; to_status: string; comment: string | null; actor_user_id: string | null; created_at: string }>;
      return { revs, events };
    },
  });
  const pdf = useQuery({
    queryKey: ['report-pdf', r?.document_id],
    enabled: !!r?.document_id,
    queryFn: async () => unwrap(await supabase.from('documents').select('id, title, current_version_id').eq('id', r!.document_id!).maybeSingle()) as { id: string; title: string; current_version_id: string | null } | null,
  });
  const names = useDisplayNames((history.data?.events ?? []).map((e) => e.actor_user_id));
  const [action, setAction] = useState<null | 'return' | 'revise' | 'publish' | 'submit'>(null);
  const [showLineage, setShowLineage] = useState(false);

  const statement = useMemo(() => {
    if (!accounts.data || !lines.data || !r) return null;
    const actual = new Map<string, number>();
    lines.data.forEach((l) => actual.set(l.account_id, (actual.get(l.account_id) ?? 0) + Number(l.amount)));
    const bud = new Map<string, number>();
    (budget.data ?? []).filter((b) => b.property_id === r.property_id).forEach((b) => bud.set(b.account_id, Number(b.amount)));
    return buildStatement(accounts.data, actual, bud, new Map());
  }, [accounts.data, lines.data, budget.data, r]);

  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorState error={report.error} />;
  if (!r) return <Empty title="Statement not found">It may not exist, may not be published yet, or you may not have access.</Empty>;
  const property = properties.find((p) => p.id === r.property_id);
  const canEdit = can('financials.edit', r.property_id);
  const canPublish = can('financials.publish', r.property_id);
  const currency = property?.currency ?? 'USD';
  const isLatestPublished = r.status === 'published';

  return (
    <div className="stack">
      <div className="small"><Link to="/financials">← Budgets & Financials</Link></div>
      <PageHeader
        title={`${property?.name ?? ''} — ${fmtMonth(r.period_month)}`}
        subtitle={<>{r.title} · revision {r.revision} · <StatusBadge status={r.status} label={r.status === 'in_review' ? 'in review' : undefined} />{r.published_at && ` · published ${fmtDate(r.published_at)}`}</>}
        actions={
          <>
            {pdf.data?.current_version_id && <button className="btn" onClick={() => downloadDocumentVersion(pdf.data!.current_version_id!)}>Published P&L (PDF)</button>}
            <button className="btn" onClick={() => downloadFromApi(`/exports/financial-reports/${r.id}.csv`, 'statement.csv')}>Export CSV</button>
            {r.status === 'draft' && canEdit && <button className="btn btn-primary" onClick={() => setAction('submit')}>Submit for review</button>}
            {r.status === 'in_review' && canPublish && <button className="btn" onClick={() => setAction('return')}>Return to draft</button>}
            {r.status === 'in_review' && canPublish && <button className="btn btn-primary" onClick={() => setAction('publish')}>Publish</button>}
            {isLatestPublished && canEdit && <button className="btn" onClick={() => setAction('revise')}>Create correction</button>}
          </>
        }
      />
      {r.status !== 'published' && r.status !== 'superseded' && <Notice tone="warn">Draft — not visible to owners or investors until published.</Notice>}
      {r.status === 'superseded' && <Notice tone="info">This revision was superseded by a later correction. See publication history below.</Notice>}
      {r.correction_reason && <Notice tone="info">Correction: {r.correction_reason}</Notice>}
      <Card title="Statement" flush actions={<label className="row small" style={{ gap: 6, paddingRight: 16 }}><input type="checkbox" checked={showLineage} onChange={(e) => setShowLineage(e.target.checked)} /> Show source accounts</label>}>
        {!statement ? <Loading /> : lines.data!.length === 0 ? <Empty title="No lines yet">Import monthly actuals or add lines while in draft.</Empty> : <StatementTable rows={statement.rows} statistics={statement.statistics} currency={currency} showPrior={false} />}
        {showLineage && lines.data && (
          <div className="table-wrap" style={{ borderTop: '1px solid var(--hairline)' }}>
            <table className="data">
              <thead><tr><th>Source account</th><th>Source name</th><th>Reporting account</th><th className="num">Amount</th><th>Original value</th><th>Import</th></tr></thead>
              <tbody>
                {lines.data.map((l) => (
                  <tr key={l.id}>
                    <td>{l.source_account_code}</td><td>{l.source_account_name}</td>
                    <td>{accounts.data?.find((a) => a.id === l.account_id)?.name}</td>
                    <td className="num">{formatCurrency(Number(l.amount), currency, { cents: true })}</td>
                    <td className="small muted">{l.source_value}</td>
                    <td className="small">{l.import_run_id ? <Link to={`/imports/${l.import_run_id}`}>run</Link> : 'manual'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {r.status === 'draft' && canEdit && <DraftLineEditor reportId={r.id} companyId={r.company_id} propertyId={r.property_id} onSaved={() => qc.invalidateQueries({ queryKey: ['financial-report-lines', id] })} />}
      <Card title="Publication history">
        {history.data && (
          <div className="grid grid-2">
            <div>
              <h3>Revisions</h3>
              <ul className="timeline">
                {history.data.revs.map((x) => (
                  <li key={x.id}>
                    <Link to={`/financials/reports/${x.id}`}>Revision {x.revision}</Link> <StatusBadge status={x.status} />
                    {x.correction_reason && <div className="small muted">{x.correction_reason}</div>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Events</h3>
              <ul className="timeline">
                {history.data.events.map((e) => (
                  <li key={e.id}>
                    <strong>{e.from_status ? `${e.from_status.replace('_', ' ')} → ` : ''}{e.to_status.replace('_', ' ')}</strong> <span className="small muted">rev {e.revision ?? '—'} · {fmtDate(e.created_at)} · {names.data?.get(e.actor_user_id ?? '') ?? 'system'}</span>
                    {e.comment && <div className="small">{e.comment}</div>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
      {action && <ReportAction action={action} report={r} onClose={() => setAction(null)} />}
    </div>
  );
}

function ReportAction({ action, report, onClose }: { action: 'return' | 'revise' | 'publish' | 'submit'; report: Report; onClose: () => void }) {
  const fn = { return: 'return_financial_report', revise: 'create_financial_report_revision', publish: 'publish_financial_report', submit: 'submit_financial_report' }[action];
  const rpc = useRpc(fn);
  const [text, setText] = useState('');
  const titles = { return: 'Return to draft', revise: 'Create a correction', publish: 'Publish statement', submit: 'Submit for review' };
  const requires = action === 'return' || action === 'revise';
  const run = async () => {
    const args: Record<string, unknown> = { p_report_id: report.id };
    if (action === 'revise') args.p_reason = text;
    else args.p_comment = text || null;
    const res = await rpc.mutateAsync(args);
    if (action === 'revise' && typeof res === 'string') window.location.assign(`/financials/reports/${res}`);
    else onClose();
  };
  return (
    <Modal title={titles[action]} onClose={onClose}>
      {action === 'publish' && <p>Publishing makes this statement visible to authorized owners and investors and notifies them. {report.revision > 1 && 'The previously published revision will be marked superseded.'}</p>}
      {action === 'revise' && <p>Creates a new draft revision copied from the published statement. Owners keep seeing the published version until the correction is published.</p>}
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">{action === 'revise' ? 'Correction reason (required)' : requires ? 'Comment (required)' : 'Comment (optional)'}<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={rpc.isPending || (requires && !text.trim())} onClick={() => run().catch(() => undefined)}>{titles[action]}</button>
    </Modal>
  );
}

function DraftLineEditor({ reportId, companyId, propertyId, onSaved }: { reportId: string; companyId: string; propertyId: string; onSaved: () => void }) {
  const accounts = useAccounts(companyId);
  const [account, setAccount] = useState('');
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const n = Number(amount);
    if (!Number.isFinite(n)) return setErr('Amount must be a number');
    const { error } = await supabase.from('financial_report_lines').upsert(
      { company_id: companyId, property_id: propertyId, financial_report_id: reportId, account_id: account, amount: n, source_account_code: code || `MANUAL-${accounts.data?.find((a) => a.id === account)?.code}`, source_account_name: 'Manual entry', source_value: amount },
      { onConflict: 'financial_report_id,source_account_code' },
    );
    if (error) setErr(error.message);
    else { setAmount(''); setCode(''); onSaved(); }
  };
  return (
    <Card title="Manual line entry (draft only)">
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="filter-bar">
        <label className="field">Reporting account<select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Select…</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
        <label className="field">Source code (optional)<input value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label className="field">Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={!account || !amount} onClick={save}>Save line</button>
      </div>
    </Card>
  );
}
