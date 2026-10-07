import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { buildStatement } from '../lib/statement';
import { useAccounts, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate, fmtMonth } from '../components/ui';
import { StatementTable } from '../components/StatementTable';

type Tab = 'statements' | 'variance' | 'budgets' | 'mappings';

export function FinancialsPage() {
  const { canAny, can } = usePortal();
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'statements', label: 'Financial statements', show: canAny('financials.view') || canAny('financials.view_draft') },
    { id: 'variance', label: 'Actual vs budget', show: canAny('financials.view') },
    { id: 'budgets', label: 'Budgets', show: canAny('budgets.view') || canAny('budgets.edit') },
    { id: 'mappings', label: 'Account mappings', show: can('financials.edit') },
  ];
  const visible = tabs.filter((t) => t.show);
  const [chosen, setTab] = useState<Tab | null>(null);
  const tab: Tab = chosen && visible.some((t) => t.id === chosen) ? chosen : visible[0]?.id ?? 'statements';
  if (visible.length === 0) return <Empty title="No financial access">Your access does not include financial information.</Empty>;
  return (
    <div className="stack">
      <PageHeader title="Budgets & Financials" subtitle="Published accounting figures. Uploading a PDF does not change structured data — figures come from validated imports." />
      <div className="tabs" role="tablist">
        {visible.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'statements' && <Statements />}
      {tab === 'variance' && <VarianceView />}
      {tab === 'budgets' && <Budgets />}
      {tab === 'mappings' && <Mappings />}
    </div>
  );
}

interface ReportRow {
  id: string;
  property_id: string;
  period_month: string;
  title: string;
  revision: number;
  status: string;
  published_at: string | null;
  correction_reason: string | null;
}

function Statements() {
  const { properties, can, canAny } = usePortal();
  const company = useCompany();
  const [propertyId, setPropertyId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['financial-reports', company.company_id, propertyId],
    queryFn: async () => {
      let qb = supabase.from('financial_reports').select('id, property_id, period_month, title, revision, status, published_at, correction_reason').eq('company_id', company.company_id).order('period_month', { ascending: false }).order('revision', { ascending: false }).limit(200);
      if (propertyId) qb = qb.eq('property_id', propertyId);
      return unwrap(await qb) as ReportRow[];
    },
  });
  const name = (id: string) => properties.find((p) => p.id === id)?.name ?? '—';
  return (
    <Card
      flush
      title={
        <div className="row">
          <label className="field">
            Property
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">All properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
      }
      actions={canAny('financials.edit') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New statement</button>}
    >
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (q.data ?? []).length === 0 ? <Empty title="No financial statements available" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Period</th><th>Property</th><th>Statement</th><th>Revision</th><th>Status</th><th>Published</th></tr></thead>
            <tbody>
              {q.data!.map((r) => (
                <tr key={r.id}>
                  <td>{fmtMonth(r.period_month)}</td>
                  <td>{name(r.property_id)}</td>
                  <td><Link to={`/financials/reports/${r.id}`}>{r.title}</Link></td>
                  <td>{r.revision}{r.correction_reason && <span className="small muted" title={r.correction_reason}> · corrected</span>}</td>
                  <td><StatusBadge status={r.status} label={r.status === 'in_review' ? 'in review' : undefined} /></td>
                  <td>{fmtDate(r.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewStatement onClose={() => setCreating(false)} canEdit={(id) => can('financials.edit', id)} />}
    </Card>
  );
}

function NewStatement({ onClose, canEdit }: { onClose: () => void; canEdit: (id: string) => boolean }) {
  const { properties } = usePortal();
  const navigate = useNavigate();
  const create = useRpc('create_financial_report');
  const eligible = properties.filter((p) => canEdit(p.id));
  const [pid, setPid] = useState(eligible[0]?.id ?? '');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  return (
    <Modal title="New financial statement" onClose={onClose}>
      <p className="muted">Creates an empty draft for manual entry. Use Data Imports for standardized spreadsheet actuals.</p>
      {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
      <label className="field">Property<select value={pid} onChange={(e) => setPid(e.target.value)}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Period<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={!pid || create.isPending} onClick={async () => { const id = await create.mutateAsync({ p_property_id: pid, p_period_month: `${month}-01`, p_title: null }); navigate(`/financials/reports/${id}`); }}>Create draft</button>
    </Modal>
  );
}

function VarianceView() {
  const { properties } = usePortal();
  const company = useCompany();
  const accounts = useAccounts(company.company_id);
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const lastMonth = useMemo(() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 7); }, []);
  const [month, setMonth] = useState(lastMonth);
  const [ytd, setYtd] = useState(false);
  const qc = useQueryClient();
  const [commentFor, setCommentFor] = useState<{ accountId: string; label: string } | null>(null);
  const { can } = usePortal();
  const from = ytd ? `${month.slice(0, 4)}-01-01` : `${month}-01`;
  const to = `${month}-01`;
  const pyFrom = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
  const pyTo = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  const data = useQuery({
    queryKey: ['variance', company.company_id, from, to],
    queryFn: async () => {
      const [a, b, p, c] = await Promise.all([
        supabase.rpc('financial_actuals_monthly', { p_company_id: company.company_id, p_from: from, p_to: to, p_include_drafts: false }),
        supabase.rpc('budget_monthly', { p_company_id: company.company_id, p_from: from, p_to: to }),
        supabase.rpc('financial_actuals_monthly', { p_company_id: company.company_id, p_from: pyFrom, p_to: pyTo, p_include_drafts: false }),
        supabase.from('management_commentary').select('id, account_id, body, visibility, property_id, period_month, status').eq('company_id', company.company_id).eq('section', 'variance').gte('period_month', from).lte('period_month', to),
      ]);
      return {
        actuals: unwrap(a) as Array<{ property_id: string; period_month: string; account_id: string; amount: number }>,
        budget: unwrap(b) as Array<{ property_id: string; period_month: string; account_id: string; amount: number }>,
        prior: unwrap(p) as Array<{ property_id: string; period_month: string; account_id: string; amount: number }>,
        comments: unwrap(c) as Array<{ id: string; account_id: string | null; body: string; visibility: string; property_id: string | null; status: string }>,
      };
    },
  });
  const statement = useMemo(() => {
    if (!data.data || !accounts.data) return null;
    const agg = (rows: Array<{ property_id: string; account_id: string; amount: number }>) => {
      const m = new Map<string, number>();
      rows.filter((r) => r.property_id === propertyId).forEach((r) => m.set(r.account_id, (m.get(r.account_id) ?? 0) + Number(r.amount)));
      return m;
    };
    const actualMonths = new Set(data.data.actuals.filter((r) => r.property_id === propertyId).map((r) => r.period_month));
    return { ...buildStatement(accounts.data, agg(data.data.actuals), agg(data.data.budget), agg(data.data.prior)), monthsWithActuals: actualMonths.size };
  }, [data.data, accounts.data, propertyId]);
  const expectedMonths = ytd ? Number(month.slice(5, 7)) : 1;
  const property = properties.find((p) => p.id === propertyId);
  const comments = (data.data?.comments ?? []).filter((c) => c.property_id === propertyId);
  return (
    <div className="stack">
      <div className="filter-bar">
        <label className="field">Property<select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field">Month<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={ytd} onChange={(e) => setYtd(e.target.checked)} /> Year to date</label>
      </div>
      {data.isLoading || accounts.isLoading ? <Loading /> : data.error ? <ErrorState error={data.error} /> : statement && (
        <Card title={`${property?.name} — ${ytd ? `YTD through ${fmtMonth(`${month}-01`)}` : fmtMonth(`${month}-01`)}`} flush>
          {statement.monthsWithActuals < expectedMonths && (
            <div style={{ padding: '0 16px' }}>
              <Notice tone="warn">Published actuals are available for {statement.monthsWithActuals} of {expectedMonths} month(s). Unpublished periods are excluded, so totals are incomplete.</Notice>
            </div>
          )}
          <StatementTable rows={statement.rows} statistics={statement.statistics} currency={property?.currency ?? 'USD'} onComment={can('commentary.edit', propertyId) ? (r) => setCommentFor({ accountId: r.accountId!, label: r.label }) : undefined} />
          {comments.length > 0 && (
            <div style={{ padding: 16 }}>
              <h3>Variance commentary</h3>
              <ul className="timeline">
                {comments.map((c) => (
                  <li key={c.id}>
                    <strong>{accounts.data?.find((a) => a.id === c.account_id)?.name ?? 'General'}</strong>{' '}
                    {c.visibility === 'internal' && <StatusBadge status="draft" label="internal" />} {c.status === 'draft' && <StatusBadge status="draft" />}
                    <p style={{ margin: '4px 0 0' }}>{c.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
      {commentFor && (
        <CommentModal
          title={`Variance comment — ${commentFor.label}`}
          onClose={() => setCommentFor(null)}
          onSave={async (body, visibility, publish) => {
            unwrap(await supabase.from('management_commentary').insert({ company_id: company.company_id, property_id: propertyId, period_month: `${month}-01`, section: 'variance', account_id: commentFor.accountId, body, visibility, status: publish ? 'published' : 'draft', published_at: publish ? new Date().toISOString() : null }).select('id'));
            await qc.invalidateQueries({ queryKey: ['variance'] });
            setCommentFor(null);
          }}
        />
      )}
    </div>
  );
}

export function CommentModal({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (body: string, visibility: 'owner' | 'internal', publish: boolean) => Promise<void> }) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'owner' | 'internal'>('owner');
  const [err, setErr] = useState<string | null>(null);
  const save = (publish: boolean) => onSave(body, visibility, publish).catch((e) => setErr(errorMessage(e)));
  return (
    <Modal title={title} onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Comment<textarea value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field">Visibility<select value={visibility} onChange={(e) => setVisibility(e.target.value as 'owner' | 'internal')}><option value="owner">Owner-facing</option><option value="internal">Internal only</option></select></label>
      <div className="row">
        <button className="btn" disabled={!body.trim()} onClick={() => save(false)}>Save draft</button>
        <button className="btn btn-primary" disabled={!body.trim()} onClick={() => save(true)}>Publish</button>
      </div>
    </Modal>
  );
}

function Budgets() {
  const { properties, canAny } = usePortal();
  const company = useCompany();
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['budget-versions', company.company_id],
    queryFn: async () => unwrap(await supabase.from('budget_versions').select('id, property_id, fiscal_year, version_number, name, status, approved_at, import_run_id').eq('company_id', company.company_id).order('fiscal_year', { ascending: false }).order('version_number', { ascending: false })) as Array<{ id: string; property_id: string; fiscal_year: number; version_number: number; name: string; status: string; approved_at: string | null; import_run_id: string | null }>,
  });
  return (
    <Card flush title="Budget versions" actions={canAny('budgets.edit') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New budget version</button>}>
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <Empty title="No budgets available" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Fiscal year</th><th>Property</th><th>Version</th><th>Status</th><th>Approved</th><th>Source</th></tr></thead>
            <tbody>
              {q.data!.map((v) => (
                <tr key={v.id}>
                  <td>{v.fiscal_year}</td>
                  <td>{properties.find((p) => p.id === v.property_id)?.name}</td>
                  <td><Link to={`/financials/budgets/${v.id}`}>v{v.version_number} · {v.name}</Link></td>
                  <td><StatusBadge status={v.status} /></td>
                  <td>{fmtDate(v.approved_at)}</td>
                  <td className="small muted">{v.import_run_id ? 'Imported' : 'Manual'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewBudget onClose={() => setCreating(false)} existing={q.data ?? []} />}
    </Card>
  );
}

function NewBudget({ onClose, existing }: { onClose: () => void; existing: Array<{ id: string; property_id: string; fiscal_year: number; version_number: number; name: string }> }) {
  const { properties, can } = usePortal();
  const navigate = useNavigate();
  const create = useRpc('create_budget_version');
  const eligible = properties.filter((p) => can('budgets.edit', p.id));
  const [pid, setPid] = useState(eligible[0]?.id ?? '');
  const [fy, setFy] = useState(new Date().getFullYear() + 1);
  const [name, setName] = useState('');
  const [copy, setCopy] = useState('');
  return (
    <Modal title="New budget version" onClose={onClose}>
      {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
      <label className="field">Property<select value={pid} onChange={(e) => setPid(e.target.value)}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Fiscal year<input type="number" min={2000} max={2100} value={fy} onChange={(e) => setFy(Number(e.target.value))} /></label>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`FY${fy} Operating budget`} /></label>
      <label className="field">Copy lines from<select value={copy} onChange={(e) => setCopy(e.target.value)}><option value="">— start empty —</option>{existing.filter((v) => v.property_id === pid).map((v) => <option key={v.id} value={v.id}>FY{v.fiscal_year} v{v.version_number} {v.name}</option>)}</select></label>
      <button className="btn btn-primary" disabled={!pid} onClick={async () => { const id = await create.mutateAsync({ p_property_id: pid, p_fiscal_year: fy, p_name: name, p_copy_from: copy || null }); navigate(`/financials/budgets/${id}`); }}>Create draft</button>
    </Modal>
  );
}

function Mappings() {
  const company = useCompany();
  const { properties } = usePortal();
  const accounts = useAccounts(company.company_id);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['mappings', company.company_id],
    queryFn: async () => unwrap(await supabase.from('source_account_mappings').select('id, property_id, source_system, source_account_code, source_account_name, account_id').eq('company_id', company.company_id).order('source_account_code')) as Array<{ id: string; property_id: string | null; source_system: string; source_account_code: string; source_account_name: string | null; account_id: string }>,
  });
  const [form, setForm] = useState({ code: '', name: '', account: '', property: '' });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    const { error } = await supabase.from('source_account_mappings').insert({ company_id: company.company_id, property_id: form.property || null, source_account_code: form.code.trim(), source_account_name: form.name || null, account_id: form.account });
    if (error) setErr(error.message);
    else {
      setForm({ code: '', name: '', account: '', property: '' });
      await qc.invalidateQueries({ queryKey: ['mappings'] });
    }
  };
  return (
    <Card title="Source account mappings" flush>
      <p className="small muted" style={{ padding: '0 16px' }}>Imported GL accounts are mapped to the company reporting structure. Original account codes and values are preserved on every line. Property-specific mappings override company defaults.</p>
      <div className="filter-bar" style={{ margin: '0 16px' }}>
        <label className="field">Source code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label className="field">Source name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field">Reporting account<select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })}><option value="">Select…</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
        <label className="field">Scope<select value={form.property} onChange={(e) => setForm({ ...form, property: e.target.value })}><option value="">All properties</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></label>
        <button className="btn btn-primary" disabled={!form.code || !form.account} onClick={add}>Add mapping</button>
      </div>
      {err && <div style={{ padding: 16 }}><Notice tone="bad">{err}</Notice></div>}
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data">
          <thead><tr><th>Source code</th><th>Source name</th><th>Reporting account</th><th>Scope</th></tr></thead>
          <tbody>
            {(q.data ?? []).map((m) => {
              const a = accounts.data?.find((x) => x.id === m.account_id);
              return <tr key={m.id}><td>{m.source_account_code}</td><td>{m.source_account_name}</td><td>{a ? `${a.code} — ${a.name}` : '—'}</td><td>{m.property_id ? properties.find((p) => p.id === m.property_id)?.code : 'All properties'}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

