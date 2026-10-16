import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { buildStatement } from '@hop/core';
import { useAccounts, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, TabPanel, Tabs, confirmAction, currentMonthValue, dbErrorMessage, errorMessage, fmtDate, fmtMonth, lastClosedMonthValue } from '../components/ui';
import { StatementTable } from '../components/StatementTable';
import { MfaLockedNotice } from '../components/RequirePermission';

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
  const [params, setParams] = useSearchParams();
  const chosen = params.get('tab') as Tab | null;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const tab: Tab = chosen && visible.some((t) => t.id === chosen) ? chosen : visible[0]?.id ?? 'statements';
  if (visible.length === 0) return <Empty title="No financial access">Your access does not include financial information.</Empty>;
  return (
    <div className="stack">
      <PageHeader title="Budgets & financials" subtitle="Published accounting figures. Uploading a PDF does not change structured data — figures come from validated imports." />
      <MfaLockedNotice perms={['financials.view_draft', 'financials.edit', 'financials.publish', 'budgets.edit', 'budgets.approve']}>
        Some data and actions need a 2FA-verified session: draft statements, new statements and budgets, approvals and account mappings.
      </MfaLockedNotice>
      <Tabs label="Financial sections" idPrefix="fin" tabs={visible} value={tab} onChange={setTab} />
      <TabPanel idPrefix="fin" value={tab}>
        {tab === 'statements' && <Statements />}
        {tab === 'variance' && <VarianceView />}
        {tab === 'budgets' && <Budgets />}
        {tab === 'mappings' && <Mappings />}
      </TabPanel>
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
  const { properties, can, canAny, mfaLocked } = usePortal();
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
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (q.data ?? []).length === 0 ? <Empty title="No financial statements available">{mfaLocked('financials.view_draft') && 'Verify with 2FA to see draft statements.'}</Empty> : (
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
  // Default to the last closed month; future months cannot have statements.
  const [month, setMonth] = useState(lastClosedMonthValue());
  const maxMonth = currentMonthValue();
  const monthError = !month ? 'Choose a period.' : month > maxMonth ? 'Statements can’t be created for a future month.' : null;
  const go = async () => {
    try {
      const id = await create.mutateAsync({ p_property_id: pid, p_period_month: `${month}-01`, p_title: null });
      navigate(`/financials/reports/${id}`);
    } catch {
      /* shown above */
    }
  };
  return (
    <Modal title="New financial statement" onClose={onClose}>
      <p className="muted">Creates an empty draft for manual entry. Use Data imports for standardized spreadsheet actuals.</p>
      {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
      <label className="field">Property<select value={pid} onChange={(e) => setPid(e.target.value)}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Period<input type="month" max={maxMonth} value={month} onChange={(e) => setMonth(e.target.value)} />{monthError && <span className="field-error">{monthError}</span>}</label>
      <button className="btn btn-primary" disabled={!pid || create.isPending || !!monthError} onClick={() => void go()}>{create.isPending ? 'Creating…' : 'Create draft'}</button>
    </Modal>
  );
}

function VarianceView() {
  const { properties } = usePortal();
  const company = useCompany();
  const accounts = useAccounts(company.company_id);
  // Open on a reporting hotel (not onboarding/archived) and its latest published statement (R3-38).
  const [propertyId, setPropertyId] = useState(
    () => (properties.find((p) => p.status === 'active') ?? properties.find((p) => !['onboarding', 'archived'].includes(p.status)) ?? properties[0])?.id ?? '',
  );
  // Fallback: the last closed month, from the local calendar so every viewer gets the same month.
  const lastMonth = useMemo(() => lastClosedMonthValue(1), []);
  const [month, setMonthState] = useState(lastMonth);
  const [monthChosen, setMonthChosen] = useState(false);
  const setMonth = (m: string) => {
    setMonthChosen(true);
    setMonthState(m);
  };
  const latestPublished = useQuery({
    queryKey: ['latest-published-pnl', propertyId],
    enabled: !!propertyId && !monthChosen,
    queryFn: async () =>
      (unwrap(await supabase.from('financial_reports').select('period_month').eq('property_id', propertyId).eq('report_type', 'monthly_pnl').eq('status', 'published').order('period_month', { ascending: false }).limit(1)) as Array<{ period_month: string }>)[0]?.period_month ?? null,
  });
  useEffect(() => {
    if (!monthChosen && latestPublished.data) setMonthState(latestPublished.data.slice(0, 7));
  }, [latestPublished.data, monthChosen]);
  const [ytd, setYtd] = useState(false);
  const qc = useQueryClient();
  const [commentFor, setCommentFor] = useState<{ accountId: string; label: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string; visibility: string } | null>(null);
  const [commentErr, setCommentErr] = useState<string | null>(null);
  const { can } = usePortal();
  const accountLabel = (id: string | null) => accounts.data?.find((a) => a.id === id)?.name ?? 'General';
  const commentAction = async (fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>) => {
    setCommentErr(null);
    const { error } = await fn();
    if (error) setCommentErr(dbErrorMessage(error));
    await qc.invalidateQueries({ queryKey: ['variance'] });
  };
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
    const actualMonths = new Set(data.data.actuals.filter((r) => r.property_id === propertyId).map((r) => r.period_month.slice(0, 7)));
    // Compare like-for-like: budget and prior year only for months that have published actuals.
    const inActualMonths = <T extends { period_month: string }>(rows: T[], shiftYears = 0) =>
      rows.filter((r) => actualMonths.has(`${Number(r.period_month.slice(0, 4)) + shiftYears}${r.period_month.slice(4, 7)}`));
    return {
      ...buildStatement(accounts.data, agg(data.data.actuals), agg(inActualMonths(data.data.budget)), agg(inActualMonths(data.data.prior, 1))),
      monthsWithActuals: actualMonths.size,
      actualMonthList: [...actualMonths].sort(),
    };
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
              <Notice tone="warn">
                Published actuals are available for {statement.monthsWithActuals} of {expectedMonths} month(s)
                {statement.actualMonthList.length > 0 && ` (${statement.actualMonthList.map((m) => fmtDate(`${m}-01`, { month: 'short' })).join(', ')} compared)`}. Budget and prior year cover the same months only; unpublished periods are excluded.
              </Notice>
            </div>
          )}
          <StatementTable rows={statement.rows} statistics={statement.statistics} currency={property?.currency ?? 'USD'} onComment={can('commentary.edit', propertyId) ? (r) => setCommentFor({ accountId: r.accountId!, label: r.label }) : undefined} />
          {comments.length > 0 && (
            <div style={{ padding: 16 }}>
              <h3>Variance commentary</h3>
              {commentErr && <Notice tone="bad">{commentErr}</Notice>}
              <ul className="timeline">
                {comments.map((c) => (
                  <li key={c.id}>
                    <div className="spread">
                      <span>
                        <strong>{accountLabel(c.account_id)}</strong>{' '}
                        {c.visibility === 'internal' && <StatusBadge status="draft" label="internal" />} {c.status === 'draft' && <StatusBadge status="draft" />}
                      </span>
                      {can('commentary.edit', propertyId) && c.status === 'draft' && (
                        <span className="row" style={{ gap: 4 }}>
                          <button className="btn btn-sm" aria-label={`Edit comment on ${accountLabel(c.account_id)}`} onClick={() => setEditing(c)}>Edit</button>
                          {/* Author and publication time are set by the database. */}
                          <button className="btn btn-sm" aria-label={`Publish comment on ${accountLabel(c.account_id)}`} onClick={() => void commentAction(() => supabase.from('management_commentary').update({ status: 'published' }).eq('id', c.id))}>Publish</button>
                          <button className="btn btn-sm btn-ghost" aria-label={`Delete comment on ${accountLabel(c.account_id)}`} onClick={() => confirmAction('Delete this draft comment?') && void commentAction(() => supabase.from('management_commentary').delete().eq('id', c.id))}>Delete</button>
                        </span>
                      )}
                    </div>
                    <p style={{ margin: '4px 0 0' }}>{c.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
      {editing && (
        <CommentModal
          title="Edit draft comment"
          initial={{ body: editing.body, visibility: editing.visibility as 'owner' | 'internal' }}
          onClose={() => setEditing(null)}
          onSave={async (body, visibility, publish) => {
            unwrap(await supabase.from('management_commentary').update({ body, visibility, ...(publish ? { status: 'published' } : {}) }).eq('id', editing.id).select('id'));
            await qc.invalidateQueries({ queryKey: ['variance'] });
            setEditing(null);
          }}
        />
      )}
      {commentFor && (
        <CommentModal
          title={`Variance comment — ${commentFor.label}`}
          onClose={() => setCommentFor(null)}
          onSave={async (body, visibility, publish) => {
            unwrap(await supabase.from('management_commentary').insert({ company_id: company.company_id, property_id: propertyId, period_month: `${month}-01`, section: 'variance', account_id: commentFor.accountId, body, visibility, status: publish ? 'published' : 'draft' }).select('id'));
            await qc.invalidateQueries({ queryKey: ['variance'] });
            setCommentFor(null);
          }}
        />
      )}
    </div>
  );
}

export function CommentModal({ title, onClose, onSave, initial }: { title: string; onClose: () => void; onSave: (body: string, visibility: 'owner' | 'internal', publish: boolean) => Promise<void>; initial?: { body: string; visibility: 'owner' | 'internal' } }) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [visibility, setVisibility] = useState<'owner' | 'internal'>(initial?.visibility ?? 'owner');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (publish: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(body, visibility, publish);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Comment<textarea value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field">Visibility<select value={visibility} onChange={(e) => setVisibility(e.target.value as 'owner' | 'internal')}><option value="owner">Owner-facing</option><option value="internal">Internal only</option></select></label>
      <div className="row">
        <button className="btn" disabled={busy || !body.trim()} onClick={() => void save(false)}>Save draft</button>
        <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={() => void save(true)}>Publish</button>
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
  const [fy, setFy] = useState(String(new Date().getFullYear() + 1));
  const fyNum = Number(fy);
  const fyError = !Number.isInteger(fyNum) || fyNum < 2000 || fyNum > 2100 ? 'Enter a fiscal year between 2000 and 2100.' : null;
  const go = async () => {
    try {
      const id = await create.mutateAsync({ p_property_id: pid, p_fiscal_year: fyNum, p_name: name, p_copy_from: copy || null });
      navigate(`/financials/budgets/${id}`);
    } catch {
      /* shown above */
    }
  };
  const [name, setName] = useState('');
  const [copy, setCopy] = useState('');
  return (
    <Modal title="New budget version" onClose={onClose}>
      {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
      <label className="field">Property<select value={pid} onChange={(e) => setPid(e.target.value)}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Fiscal year<input type="number" min={2000} max={2100} step={1} value={fy} onChange={(e) => setFy(e.target.value)} />{fyError && <span className="field-error">{fyError}</span>}</label>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`FY${fy} Operating budget`} /></label>
      <label className="field">Copy lines from<select value={copy} onChange={(e) => setCopy(e.target.value)}><option value="">— start empty —</option>{existing.filter((v) => v.property_id === pid).map((v) => <option key={v.id} value={v.id}>FY{v.fiscal_year} v{v.version_number} {v.name}</option>)}</select></label>
      <button className="btn btn-primary" disabled={!pid || !!fyError || create.isPending} onClick={() => void go()}>{create.isPending ? 'Creating…' : 'Create draft'}</button>
    </Modal>
  );
}

const NO_MAPPING_ACCESS = 'You can’t change this mapping: company-wide mappings need access to every property, and property mappings need financial edit access to that property.';

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
  const [editing, setEditing] = useState<{ id: string; account: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['mappings'] });
  const add = async () => {
    setErr(null);
    const code = form.code.trim();
    if (!code) return setErr('Enter a source account code.');
    const { error } = await supabase.from('source_account_mappings').insert({ company_id: company.company_id, property_id: form.property || null, source_account_code: code, source_account_name: form.name.trim() || null, account_id: form.account });
    if (error) setErr(error.code === '23505' ? `Code ${code} is already mapped${form.property ? ' for that property' : ''}. Edit the existing mapping instead.` : dbErrorMessage(error));
    else {
      setForm({ code: '', name: '', account: '', property: '' });
      await refresh();
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    setErr(null);
    const { data, error } = await supabase.from('source_account_mappings').update({ account_id: editing.account }).eq('id', editing.id).select('id');
    if (error) setErr(dbErrorMessage(error));
    else if (!data || data.length === 0) setErr(NO_MAPPING_ACCESS);
    else setEditing(null);
    await refresh();
  };
  const remove = async (id: string, code: string) => {
    if (!confirmAction(`Delete the mapping for ${code}? Future imports with this code will be rejected until it is mapped again.`)) return;
    setErr(null);
    const { data, error } = await supabase.from('source_account_mappings').delete().eq('id', id).select('id');
    if (error) setErr(dbErrorMessage(error));
    else if (!data || data.length === 0) setErr(NO_MAPPING_ACCESS);
    await refresh();
  };
  return (
    <Card title="Source account mappings" flush>
      <p className="small muted" style={{ padding: '0 16px' }}>Imported GL accounts are mapped to the company reporting structure. Original account codes and values are preserved on every line. Property-specific mappings override company defaults. Monthly actuals may also use reporting account codes directly (e.g. REV_ROOMS) when no mapping exists. Changing a mapping affects future imports only.</p>
      <div className="filter-bar" style={{ margin: '0 16px' }}>
        <label className="field">Source code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label className="field">Source name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field">Reporting account<select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })}><option value="">Select…</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
        <label className="field">Scope<select value={form.property} onChange={(e) => setForm({ ...form, property: e.target.value })}><option value="">All properties</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></label>
        <button className="btn btn-primary" disabled={!form.code.trim() || !form.account} onClick={() => void add()}>Add mapping</button>
      </div>
      {err && <div style={{ padding: 16 }}><Notice tone="bad">{err}</Notice></div>}
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data">
          <thead><tr><th>Source code</th><th>Source name</th><th>Reporting account</th><th>Scope</th><th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((m) => {
              const a = accounts.data?.find((x) => x.id === m.account_id);
              const isEditing = editing?.id === m.id;
              return (
                <tr key={m.id}>
                  <td>{m.source_account_code}</td>
                  <td>{m.source_account_name}</td>
                  <td>
                    {isEditing ? (
                      <select aria-label={`Reporting account for ${m.source_account_code}`} value={editing.account} onChange={(e) => setEditing({ id: m.id, account: e.target.value })}>
                        {accounts.data?.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}
                      </select>
                    ) : a ? `${a.code} — ${a.name}` : '—'}
                  </td>
                  <td>{m.property_id ? properties.find((p) => p.id === m.property_id)?.code : 'All properties'}</td>
                  <td className="row" style={{ gap: 4 }}>
                    {isEditing ? (
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => void saveEdit()}>Save</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-sm" aria-label={`Edit mapping ${m.source_account_code}`} onClick={() => setEditing({ id: m.id, account: m.account_id })}>Edit</button>
                        <button className="btn btn-sm btn-ghost" aria-label={`Delete mapping ${m.source_account_code}`} onClick={() => void remove(m.id, m.source_account_code)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
