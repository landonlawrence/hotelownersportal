import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { capexFunds, formatCurrency, REMAINING_FUNDS_DEFINITION } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { downloadDocumentVersion, uploadDocument } from '../lib/api';
import { useDisplayNames, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, confirmAction, dbErrorMessage, errorMessage, fmtDate, localToday, parseAmount } from '../components/ui';
import { MfaLockedNotice, verifyLink } from '../components/RequirePermission';
import { DownloadButton } from '../components/DownloadButton';
import { ScanStatus } from './Documents';
import { OtherCompanyNotice } from '../components/OtherCompanyNotice';

const PRIORITIES: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

/** Manual status changes the database allows (others go through the approval workflow). */
const NEXT_STATUSES: Record<string, string[]> = {
  draft: ['cancelled'],
  rejected: ['cancelled'],
  approved: ['in_progress', 'on_hold', 'completed', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'completed', 'cancelled'],
};

const CATEGORIES: Record<string, string> = {
  guest_rooms: 'Guest rooms', public_areas: 'Public areas', building_systems: 'Building systems', life_safety: 'Life safety', technology: 'Technology',
  food_beverage: 'Food & beverage', exterior: 'Exterior', brand_standards: 'Brand standards', other: 'Other',
};

interface Project {
  id: string; property_id: string; project_number: string; title: string; category: string; description: string | null; status: string; priority: string;
  requested_budget: number; approved_budget: number; target_start: string | null; target_completion: string | null; actual_completion: string | null; percent_complete: number;
  updated_at: string;
}

interface Tx {
  id: string; kind: string; status: string; reference: string | null; description: string | null; amount: number; transaction_date: string;
  document_id: string | null; related_commitment_id: string | null; capex_vendors: { name: string } | null;
}

function useSummary(companyId: string) {
  return useQuery({
    queryKey: ['capex-summary-rows', companyId],
    queryFn: async () => unwrap(await supabase.rpc('capex_project_summary', { p_company_id: companyId })) as Array<{ project_id: string; approved_budget: number; actual_spend: number; open_commitments: number; remaining: number }>,
  });
}

export function CapexPage() {
  const { properties, canAny, mfaLocked } = usePortal();
  const company = useCompany();
  const [status, setStatus] = useState('');
  const draftsLocked = mfaLocked('capex.edit') || mfaLocked('capex.approve');
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: ['capex-projects', company.company_id],
    queryFn: async () => unwrap(await supabase.from('capex_projects').select('*').eq('company_id', company.company_id).order('project_number', { ascending: false })) as Project[],
  });
  const summary = useSummary(company.company_id);
  const rows = (projects.data ?? []).filter((p) => !status || p.status === status);
  const totals = rows.reduce((a, p) => {
    const s = summary.data?.find((x) => x.project_id === p.id);
    return { approved: a.approved + Number(p.approved_budget), actual: a.actual + Number(s?.actual_spend ?? 0), committed: a.committed + Number(s?.open_commitments ?? 0) };
  }, { approved: 0, actual: 0, committed: 0 });
  const f = capexFunds(totals.approved, totals.actual, totals.committed);
  // Totals are only meaningful when both the projects and their funds summary loaded.
  const fundsReady = !!projects.data && !!summary.data;
  const tile = (v: number) => (fundsReady ? formatCurrency(v) : '—');
  return (
    <div className="stack">
      <PageHeader title="Capital expenditures" subtitle={REMAINING_FUNDS_DEFINITION} actions={canAny('capex.edit') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New project</button>} />
      <MfaLockedNotice perms={['capex.edit', 'capex.approve']} />
      <div className="grid grid-kpi">
        <div className="card kpi"><span className="label">Approved budget</span><span className="value">{tile(f.approvedBudget)}</span></div>
        <div className="card kpi"><span className="label">Actual spend</span><span className="value">{tile(f.actualSpend)}</span></div>
        <div className="card kpi"><span className="label">Open commitments</span><span className="value">{tile(f.openCommitments)}</span></div>
        <div className="card kpi"><span className="label">Remaining funds</span><span className="value">{tile(f.remaining)}</span></div>
      </div>
      {summary.error && !projects.error && <ErrorState error={summary.error} retry={() => void summary.refetch()} />}
      <Card flush title={<label className="field">Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['draft', 'pending_approval', 'approved', 'in_progress', 'on_hold', 'completed', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>}>
        {projects.isLoading ? <Loading /> : projects.error ? <ErrorState error={projects.error} retry={() => void projects.refetch()} /> : rows.length === 0 ? <Empty title="No projects">{draftsLocked && 'Verify with 2FA to see drafts and projects awaiting your approval.'}</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Project</th><th>Property</th><th>Category</th><th>Status</th><th className="num">Approved</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Remaining</th><th>Progress</th><th>Target</th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const s = summary.data?.find((x) => x.project_id === p.id);
                  const remaining = s ? Number(s.remaining) : null;
                  return (
                    <tr key={p.id}>
                      <td className="cell-title"><Link to={`/capex/${p.id}`}>{p.title}</Link><div className="small muted">{p.project_number}</div></td>
                      <td>{properties.find((x) => x.id === p.property_id)?.code}</td>
                      <td>{CATEGORIES[p.category]}</td>
                      <td><StatusBadge status={p.status} /></td>
                      <td className="num">{formatCurrency(Number(p.approved_budget))}</td>
                      <td className="num">{formatCurrency(s ? Number(s.actual_spend) : null)}</td>
                      <td className="num">{formatCurrency(s ? Number(s.open_commitments) : null)}</td>
                      <td className={`num ${remaining !== null && remaining < 0 ? 'delta-bad' : ''}`}>{formatCurrency(remaining)}</td>
                      <td style={{ minWidth: 90 }}><div className="progress" aria-label={`${p.percent_complete}% complete`}><div style={{ width: `${p.percent_complete}%` }} /></div><span className="small muted">{p.percent_complete}%</span></td>
                      <td>{fmtDate(p.target_completion)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const { properties, can } = usePortal();
  const navigate = useNavigate();
  const rpc = useRpc('create_capex_project');
  const eligible = properties.filter((p) => can('capex.edit', p.id));
  const [f, setF] = useState({ property: eligible[0]?.id ?? '', title: '', category: 'guest_rooms', description: '', budget: '', start: '', end: '', priority: 'normal' });
  const budget = parseAmount(f.budget);
  const problems = [
    f.title.trim().length > 0 && (f.title.trim().length < 3 || f.title.trim().length > 200) ? 'Titles are 3–200 characters.' : null,
    f.budget.trim() && (budget === null || budget <= 0) ? 'Enter a requested budget greater than zero (e.g. 45,000).' : null,
    f.start && f.end && f.end < f.start ? 'Target completion must be on or after the start.' : null,
  ].filter(Boolean) as string[];
  const create = async () => {
    try {
      const id = await rpc.mutateAsync({ p_property_id: f.property, p_title: f.title.trim(), p_category: f.category, p_description: f.description || null, p_requested_budget: budget, p_target_start: f.start || null, p_target_completion: f.end || null, p_priority: f.priority });
      navigate(`/capex/${id}`);
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal title="New CapEx project" onClose={onClose}>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">Property<select value={f.property} onChange={(e) => setF({ ...f, property: e.target.value })}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Title<input value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <div className="row">
        <label className="field">Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="field">Description<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="field">Requested budget<input inputMode="decimal" placeholder="e.g. 45,000" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></label>
      <div className="row">
        <label className="field">Target start<input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label className="field">Target completion<input type="date" min={f.start || undefined} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
      </div>
      {problems.map((x) => <span key={x} className="field-error">{x}</span>)}
      <button className="btn btn-primary" disabled={rpc.isPending || !f.property || f.title.trim().length < 3 || budget === null || budget <= 0 || problems.length > 0} onClick={() => void create()}>{rpc.isPending ? 'Creating…' : 'Create draft project'}</button>
    </Modal>
  );
}

export function CapexProjectPage() {
  const { id } = useParams();
  const { properties, can, ctx, mfaLocked } = usePortal();
  const company = useCompany();
  const qc = useQueryClient();
  const location = useLocation();
  const p = useQuery({ queryKey: ['capex-project', id], queryFn: async () => unwrap(await supabase.from('capex_projects').select('*').eq('id', id!).maybeSingle()) as Project | null });
  const tx = useQuery({ queryKey: ['capex-tx', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_transactions').select('id, kind, status, reference, description, amount, transaction_date, document_id, related_commitment_id, capex_vendors(name)').eq('project_id', id!).order('transaction_date', { ascending: false })) as unknown as Array<Tx> });
  const requests = useQuery({ queryKey: ['capex-requests', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_approval_requests').select('id, request_type, amount, new_approved_budget, previous_approved_budget, justification, status, required_steps, requested_by, created_at, decided_at, capex_approval_decisions(id, approver_type, decision, comment, decided_by, decided_at)').eq('project_id', id!).order('created_at', { ascending: false })) as unknown as Array<{ id: string; request_type: string; amount: number; new_approved_budget: number; previous_approved_budget: number; justification: string; status: string; required_steps: Array<{ approver_type: string; approvals_required: number }>; requested_by: string; created_at: string; decided_at: string | null; capex_approval_decisions: Array<{ id: string; approver_type: string; decision: string; comment: string | null; decided_by: string; decided_at: string }> }> });
  const updates = useQuery({ queryKey: ['capex-updates', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_updates').select('id, body, percent_complete, visibility, created_by, created_at').eq('project_id', id!).order('created_at', { ascending: false })) as Array<{ id: string; body: string; percent_complete: number | null; visibility: string; created_by: string; created_at: string }> });
  const docs = useQuery({ queryKey: ['capex-docs', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('documents').select('id, title, category_key, current_version_id, created_at, document_versions!document_versions_document_id_company_id_fkey(version_number, scan_status, scan_detail)').eq('linked_entity_type', 'capex_project').eq('linked_entity_id', id!)) as unknown as Array<{ id: string; title: string; current_version_id: string | null; created_at: string; document_versions: Array<{ version_number: number; scan_status: string; scan_detail: string | null }> }> });
  const summary = useSummary(company.company_id);
  const names = useDisplayNames([...(requests.data ?? []).flatMap((r) => [r.requested_by, ...r.capex_approval_decisions.map((d) => d.decided_by)]), ...(updates.data ?? []).map((u) => u.created_by)]);
  const [modal, setModal] = useState<null | 'request' | 'tx' | 'update' | 'upload' | 'edit' | { decide: string }>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  if (p.isLoading) return <Loading />;
  if (!p.data) return <Empty page title="Project not found">It may not exist or you may not have access.</Empty>;
  const proj = p.data as Project & { company_id: string };
  if (proj.company_id !== company.company_id) return <OtherCompanyNotice companyId={proj.company_id} propertyId={proj.property_id} fallbackName={proj.title} />;
  const s = summary.data?.find((x) => x.project_id === proj.id);
  const f = capexFunds(Number(proj.approved_budget), Number(s?.actual_spend ?? 0), Number(s?.open_commitments ?? 0));
  const canEdit = can('capex.edit', proj.property_id);
  const canApprove = can('capex.approve', proj.property_id);
  // The role can approve, but only in a 2FA-verified session.
  const approveLocked = !canApprove && mfaLocked('capex.approve');
  const pending = requests.data?.find((r) => r.status === 'pending');
  const refresh = () => qc.invalidateQueries();
  // Owners and investors approve as owners; everyone else as corporate.
  const viewerType = company.role === 'owner' || company.role === 'investor' ? 'owner' : 'corporate';
  const stepOpenFor = (r: { required_steps: Array<{ approver_type: string; approvals_required: number }>; capex_approval_decisions: Array<{ approver_type: string; decision: string }> }) => {
    const step = r.required_steps.find((x) => x.approver_type === viewerType);
    if (!step) return false;
    return r.capex_approval_decisions.filter((d) => d.approver_type === viewerType && d.decision === 'approved').length < step.approvals_required;
  };
  const act = async (fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>) => {
    setActing(true);
    setActionErr(null);
    const { error } = await fn();
    setActing(false);
    if (error) setActionErr(dbErrorMessage(error));
    await refresh();
  };
  const changeStatus = (next: string) => {
    if (next === 'cancelled' && !confirmAction('Cancel this project? It will no longer count toward CapEx totals.')) return;
    const patch: Record<string, unknown> = { status: next };
    if (next === 'completed') {
      patch.actual_completion = localToday();
      patch.percent_complete = 100;
    }
    void act(() => supabase.from('capex_projects').update(patch).eq('id', proj.id));
  };
  const nextStatuses = pending ? [] : NEXT_STATUSES[proj.status] ?? [];
  return (
    <div className="stack">
      <div className="small"><Link to="/capex">← CapEx</Link></div>
      <PageHeader
        title={proj.title}
        subtitle={<>{proj.project_number} · {properties.find((x) => x.id === proj.property_id)?.name} · {CATEGORIES[proj.category]} · <StatusBadge status={proj.status} /></>}
        actions={
          <>
            {canEdit && !pending && ['draft', 'rejected', 'approved', 'in_progress', 'on_hold'].includes(proj.status) && <button className="btn btn-primary" onClick={() => setModal('request')}>{['draft', 'rejected'].includes(proj.status) ? 'Request approval' : 'Request budget change'}</button>}
            {canEdit && <button className="btn" onClick={() => setModal('edit')}>Edit details</button>}
            {canEdit && nextStatuses.length > 0 && (
              <select aria-label="Change status" className="btn" value="" disabled={acting} onChange={(e) => e.target.value && changeStatus(e.target.value)}>
                <option value="">Change status…</option>
                {nextStatuses.map((x) => <option key={x} value={x}>{x === 'completed' ? 'Mark completed' : x === 'cancelled' ? 'Cancel project' : `Set ${x.replace('_', ' ')}`}</option>)}
              </select>
            )}
            {canEdit && <button className="btn" onClick={() => setModal('tx')}>Add spend / commitment</button>}
            {canEdit && <button className="btn" onClick={() => setModal('update')}>Post update</button>}
            {can('documents.upload', proj.property_id) && <button className="btn" onClick={() => setModal('upload')}>Attach file</button>}
          </>
        }
      />
      {actionErr && <Notice tone="bad">{actionErr}</Notice>}
      <MfaLockedNotice perms={['capex.edit', 'capex.approve']} />
      {proj.description && <p className="prewrap">{proj.description}</p>}
      <p className="small muted">
        Priority: {PRIORITIES[proj.priority] ?? proj.priority}
        {(proj.target_start || proj.target_completion) && ` · Target ${proj.target_start ? fmtDate(proj.target_start) : 'not set'} – ${proj.target_completion ? fmtDate(proj.target_completion) : 'not set'}`}
        {proj.actual_completion && ` · Completed ${fmtDate(proj.actual_completion)}`}
      </p>
      <div className="grid grid-kpi">
        <div className="card kpi"><span className="label">Requested</span><span className="value">{formatCurrency(Number(proj.requested_budget))}</span></div>
        <div className="card kpi"><span className="label">Approved budget</span><span className="value">{formatCurrency(f.approvedBudget)}</span></div>
        <div className="card kpi"><span className="label">Actual spend</span><span className="value">{formatCurrency(f.actualSpend)}</span></div>
        <div className="card kpi"><span className="label">Open commitments</span><span className="value">{formatCurrency(f.openCommitments)}</span></div>
        <div className="card kpi"><span className="label">Remaining funds</span><span className={`value ${f.overBudget ? 'delta-bad' : ''}`}>{formatCurrency(f.remaining)}</span><span className="small muted">{f.overBudget ? 'Over budget' : `${proj.percent_complete}% complete`}</span></div>
      </div>
      <p className="small muted">{REMAINING_FUNDS_DEFINITION}</p>
      <Card title="Approvals">
        {(requests.data ?? []).length === 0 ? <Empty title="No approval requests yet" /> : (
          <ul className="timeline">
            {requests.data!.map((r) => {
              const myDecision = r.capex_approval_decisions.some((d) => d.decided_by === ctx?.user_id);
              return (
                <li key={r.id}>
                  <div className="spread">
                    <div>
                      <strong>{r.request_type === 'initial' ? 'Initial approval' : 'Change order'}</strong> — {formatCurrency(Number(r.new_approved_budget))}
                      {r.request_type === 'change_order' && <span className="muted"> (from {formatCurrency(Number(r.previous_approved_budget))}, +{formatCurrency(Number(r.amount))})</span>} <StatusBadge status={r.status} />
                      <div className="small muted">Requested by {names.data?.get(r.requested_by) ?? '—'} on {fmtDate(r.created_at)} · required: {r.required_steps.map((s) => `${s.approver_type} ×${s.approvals_required}`).join(', ')}</div>
                      <div className="small">{r.justification}</div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      {r.status === 'pending' && canApprove && !myDecision && r.requested_by !== ctx?.user_id && stepOpenFor(r) && <button className="btn btn-primary" onClick={() => setModal({ decide: r.id })}>Review & decide</button>}
                      {r.status === 'pending' && approveLocked && !myDecision && r.requested_by !== ctx?.user_id && stepOpenFor(r) && (
                        <>
                          <button className="btn btn-primary" disabled title="Approvals need a 2FA-verified session">Review & decide (verify 2FA)</button>
                          <Link className="btn btn-sm" to={verifyLink(location.pathname + location.search)}>Verify with 2FA</Link>
                        </>
                      )}
                      {r.status === 'pending' && canEdit && (
                        <button className="btn btn-sm" disabled={acting} onClick={() => confirmAction('Withdraw this approval request? Approvals already recorded on it are kept in the history.') && void act(() => supabase.rpc('cancel_capex_request', { p_request_id: r.id }))}>Withdraw request</button>
                      )}
                    </div>
                  </div>
                  {r.capex_approval_decisions.map((d) => (
                    <div key={d.id} className="small" style={{ marginTop: 4 }}>
                      <StatusBadge status={d.decision} /> {d.approver_type} — {names.data?.get(d.decided_by) ?? '—'}, {fmtDate(d.decided_at)}{d.comment && `: “${d.comment}”`}
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <div className="grid grid-2">
        <Card title="Spending, commitments & quotes" flush>
          {(tx.data ?? []).length === 0 ? <Empty title="No transactions" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th>Type</th><th>Vendor</th><th>Reference</th><th className="num">Amount</th>{canEdit && <th />}</tr></thead>
                <tbody>
                  {tx.data!.map((t) => (
                    <tr key={t.id}>
                      <td>{fmtDate(t.transaction_date)}</td>
                      <td>{t.kind}{t.kind === 'commitment' && <> <StatusBadge status={t.status === 'open' ? 'pending' : 'completed'} label={t.status} /></>}</td>
                      <td>{t.capex_vendors?.name ?? '—'}</td>
                      <td>{t.reference}<div className="small muted">{t.description}</div></td>
                      <td className="num">{formatCurrency(Number(t.amount))}</td>
                      {canEdit && (
                        <td className="row" style={{ gap: 4 }}>
                          {t.kind === 'commitment' && t.status === 'open' && (
                            <>
                              <button className="btn btn-sm" disabled={acting} title="Invoiced in full or otherwise finished; stops counting as open" onClick={() => void act(() => supabase.from('capex_transactions').update({ status: 'closed' }).eq('id', t.id))}>Close</button>
                              <button className="btn btn-sm btn-ghost" disabled={acting} onClick={() => confirmAction('Void this commitment? It will no longer count toward remaining funds.') && void act(() => supabase.from('capex_transactions').update({ status: 'void' }).eq('id', t.id))}>Void</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Management updates">
          {(updates.data ?? []).length === 0 ? <Empty title="No updates yet" /> : (
            <ul className="timeline">
              {updates.data!.map((u) => (
                <li key={u.id}>
                  <div className="small muted">{fmtDate(u.created_at)} · {names.data?.get(u.created_by) ?? '—'}{u.percent_complete !== null && ` · ${u.percent_complete}% complete`} {u.visibility === 'internal' && <StatusBadge status="draft" label="internal" />}</div>
                  <p style={{ margin: '2px 0 0' }}>{u.body}</p>
                </li>
              ))}
            </ul>
          )}
          {(docs.data ?? []).length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Files</h3>
              <ul>
                {docs.data!.map((d) => {
                  const latest = [...d.document_versions].sort((a, b) => b.version_number - a.version_number)[0];
                  return (
                    <li key={d.id}>
                      {d.current_version_id ? <DownloadButton className="btn btn-ghost btn-sm" label={d.title} run={() => downloadDocumentVersion(d.current_version_id!)} /> : <span>{d.title}</span>}{' '}
                      {latest && latest.scan_status !== 'clean' && <ScanStatus status={latest.scan_status} detail={latest.scan_detail} />}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      </div>
      {modal === 'request' && <RequestModal project={proj} onClose={() => setModal(null)} />}
      {modal === 'tx' && <TxModal project={proj} openCommitments={(tx.data ?? []).filter((t) => t.kind === 'commitment' && t.status === 'open')} onClose={() => { setModal(null); void refresh(); }} />}
      {modal === 'edit' && <EditProjectModal project={proj} onClose={() => { setModal(null); void refresh(); }} />}
      {modal === 'update' && <UpdateModal project={proj} onClose={() => { setModal(null); void refresh(); }} />}
      {modal === 'upload' && <AttachModal project={proj} onClose={() => { setModal(null); void refresh(); }} />}
      {modal && typeof modal === 'object' && <DecideModal requestId={modal.decide} onClose={() => setModal(null)} />}
    </div>
  );
}

function RequestModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const rpc = useRpc('submit_capex_request');
  const initial = ['draft', 'rejected'].includes(project.status);
  const [total, setTotal] = useState(String(initial ? project.requested_budget : Number(project.approved_budget)));
  const [why, setWhy] = useState('');
  return (
    <Modal title={initial ? 'Request approval' : 'Request budget change (change order)'} onClose={onClose}>
      <p className="muted">Approval routing is determined by the company’s thresholds{initial ? '' : ' applied to the increase'}. Amounts cannot be changed after submission.</p>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">{initial ? 'Budget to approve' : 'New total approved budget'}<input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></label>
      <label className="field">Justification<textarea value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      {why.trim().length > 0 && why.trim().length < 10 && <span className="field-error">Write at least 10 characters.</span>}
      <button className="btn btn-primary" disabled={rpc.isPending || why.trim().length < 10 || !(parseAmount(total)! > 0)} onClick={() => rpc.mutateAsync({ p_project_id: project.id, p_new_total: parseAmount(total), p_justification: why }).then(onClose).catch(() => undefined)}>{rpc.isPending ? 'Submitting…' : 'Submit request'}</button>
    </Modal>
  );
}

function DecideModal({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const rpc = useRpc('decide_capex_request');
  const [comment, setComment] = useState('');
  return (
    <Modal title="Approval decision" onClose={onClose}>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">Comment (required to reject)<textarea value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      <div className="row">
        <button className="btn btn-danger" disabled={rpc.isPending || !comment.trim()} onClick={() => rpc.mutateAsync({ p_request_id: requestId, p_decision: 'rejected', p_comment: comment }).then(onClose).catch(() => undefined)}>Reject</button>
        <button className="btn btn-primary" disabled={rpc.isPending} onClick={() => rpc.mutateAsync({ p_request_id: requestId, p_decision: 'approved', p_comment: comment || null }).then(onClose).catch(() => undefined)}>Approve</button>
      </div>
    </Modal>
  );
}

function TxModal({ project, openCommitments, onClose }: { project: Project; openCommitments: Tx[]; onClose: () => void }) {
  const { ctx } = usePortal();
  const company = useCompany();
  const vendors = useQuery({ queryKey: ['vendors', company.company_id], queryFn: async () => unwrap(await supabase.from('capex_vendors').select('id, name').eq('company_id', company.company_id).order('name')) as Array<{ id: string; name: string }> });
  const [f, setF] = useState({ kind: 'actual', vendor: '', reference: '', description: '', amount: '', date: localToday(), commitment: '', closes: true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = parseAmount(f.amount);
  const amountError = f.amount.trim() === '' ? null : amount === null ? 'Enter a number, e.g. 12,500' : amount <= 0 ? 'Enter a positive amount' : null;
  const save = async () => {
    if (busy || amount === null || amount <= 0) return;
    setBusy(true);
    setErr(null);
    const related = f.kind === 'actual' && f.commitment ? f.commitment : null;
    const { error } = await supabase.from('capex_transactions').insert({ company_id: company.company_id, property_id: project.property_id, project_id: project.id, kind: f.kind, status: f.kind === 'actual' ? 'closed' : 'open', vendor_id: f.vendor || null, reference: f.reference || null, description: f.description || null, amount, transaction_date: f.date, related_commitment_id: related, created_by: ctx!.user_id });
    if (!error && related && f.closes) {
      // The invoice settles the commitment, so it no longer counts as open (avoids double-counting remaining funds).
      const { error: e2 } = await supabase.from('capex_transactions').update({ status: 'closed' }).eq('id', related);
      if (e2) {
        setBusy(false);
        return setErr(`Saved, but the commitment could not be closed: ${dbErrorMessage(e2)}`);
      }
    }
    setBusy(false);
    if (error) setErr(dbErrorMessage(error));
    else onClose();
  };
  return (
    <Modal title="Add spend, commitment or quote" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="actual">Actual spend (invoice/receipt)</option><option value="commitment">Commitment (PO/contract)</option><option value="quote">Quote</option></select></label>
      <label className="field">Vendor<select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })}><option value="">—</option>{vendors.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {f.kind === 'actual' && openCommitments.length > 0 && (
        <>
          <label className="field">Against commitment (optional)<select value={f.commitment} onChange={(e) => setF({ ...f, commitment: e.target.value })}><option value="">—</option>{openCommitments.map((c) => <option key={c.id} value={c.id}>{c.reference ?? c.description ?? 'Commitment'} · {formatCurrency(Number(c.amount))}</option>)}</select></label>
          {f.commitment && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.closes} onChange={(e) => setF({ ...f, closes: e.target.checked })} /> This invoice closes the commitment</label>}
        </>
      )}
      <label className="field">Reference<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
      <label className="field">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="row">
        <label className="field">Amount<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />{amountError && <span className="field-error">{amountError}</span>}</label>
        <label className="field">Date<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      </div>
      <button className="btn btn-primary" disabled={busy || amount === null || amount <= 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </Modal>
  );
}

function UpdateModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { ctx } = usePortal();
  const company = useCompany();
  const [body, setBody] = useState('');
  // Blank means "no change to progress"; defaults to the project's current value.
  const [pct, setPct] = useState(String(project.percent_complete));
  const [vis, setVis] = useState('owner');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pctValue = pct.trim() === '' ? null : Number(pct);
  const pctError = pctValue !== null && (!Number.isInteger(pctValue) || pctValue < 0 || pctValue > 100) ? 'Enter a whole number from 0 to 100, or leave blank.' : null;
  const save = async () => {
    if (busy || pctError) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('capex_updates').insert({ company_id: company.company_id, property_id: project.property_id, project_id: project.id, body, percent_complete: pctValue, visibility: vis, created_by: ctx!.user_id });
    if (error) {
      setBusy(false);
      return setErr(dbErrorMessage(error));
    }
    // Only owner-facing updates move the progress owners see.
    if (pctValue !== null && vis === 'owner' && pctValue !== project.percent_complete) {
      const { error: e2 } = await supabase.from('capex_projects').update({ percent_complete: pctValue }).eq('id', project.id);
      if (e2) {
        setBusy(false);
        return setErr(dbErrorMessage(e2));
      }
    }
    setBusy(false);
    onClose();
  };
  return (
    <Modal title="Post management update" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Update<textarea value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field">
        Project progress, % (visible to owners)
        <input type="number" min={0} max={100} step={1} value={pct} onChange={(e) => setPct(e.target.value)} />
        {pctError ? <span className="field-error">{pctError}</span> : <span className="small muted">Leave blank to keep {project.percent_complete}%. Internal updates never change owner-visible progress.</span>}
      </label>
      <label className="field">Visibility<select value={vis} onChange={(e) => setVis(e.target.value)}><option value="owner">Owner-facing</option><option value="internal">Internal</option></select></label>
      <button className="btn btn-primary" disabled={busy || !body.trim() || !!pctError} onClick={() => void save()}>{busy ? 'Posting…' : 'Post'}</button>
    </Modal>
  );
}

function EditProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [f, setF] = useState({
    title: project.title, description: project.description ?? '', category: project.category, priority: project.priority,
    start: project.target_start ?? '', end: project.target_completion ?? '', budget: String(project.requested_budget),
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = project.status === 'draft' || project.status === 'rejected';
  const budget = parseAmount(f.budget);
  const problems = [
    f.title.trim().length < 3 || f.title.trim().length > 200 ? 'Titles are 3–200 characters.' : null,
    f.start && f.end && f.end < f.start ? 'Target completion must be on or after the start.' : null,
    draft && (budget === null || budget <= 0) ? 'Enter a requested budget greater than zero.' : null,
  ].filter(Boolean) as string[];
  const qc = useQueryClient();
  // The project as it was when the dialog opened: only fields changed here are sent, and the
  // update applies only if nobody else saved the project in the meantime.
  const [original] = useState(project);
  const save = async () => {
    if (busy) return;
    const next: Record<string, unknown> = { title: f.title.trim(), description: f.description || null, category: f.category, priority: f.priority, target_start: f.start || null, target_completion: f.end || null };
    if (original.status === 'draft') next.requested_budget = budget;
    const before: Record<string, unknown> = { title: original.title, description: original.description, category: original.category, priority: original.priority, target_start: original.target_start, target_completion: original.target_completion, requested_budget: original.requested_budget === null ? null : Number(original.requested_budget) };
    const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== before[k]));
    if (Object.keys(patch).length === 0) return onClose();
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.from('capex_projects').update(patch).eq('id', original.id).eq('updated_at', original.updated_at).select('id');
    setBusy(false);
    if (error) return setErr(dbErrorMessage(error));
    if (!data || data.length === 0) {
      setErr('This project was changed by someone else since you opened it. Reload to see the latest version.');
      await qc.invalidateQueries({ queryKey: ['capex-project', original.id] });
      return;
    }
    onClose();
  };
  return (
    <Modal title="Edit project details" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Title<input value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <div className="row">
        <label className="field">Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="field">Description<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      {project.status === 'draft' && <label className="field">Requested budget<input inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></label>}
      <div className="row">
        <label className="field">Target start<input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label className="field">Target completion<input type="date" min={f.start || undefined} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
      </div>
      {problems.map((x) => <span key={x} className="field-error">{x}</span>)}
      <button className="btn btn-primary" disabled={busy || problems.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
    </Modal>
  );
}

function AttachModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const company = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [vis, setVis] = useState('owner');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadDocument({ company_id: company.company_id, property_id: project.property_id, category_key: 'capex', title: title || file.name, visibility: vis, linked_entity_type: 'capex_project', linked_entity_id: project.id }, file);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Attach quote, invoice, receipt or photo" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <input type="file" aria-label="File" accept=".pdf,.xlsx,.docx,.csv,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Visibility<select value={vis} onChange={(e) => setVis(e.target.value)}><option value="owner">Owners only</option><option value="general">Owners & investors</option><option value="internal">Internal</option></select></label>
      <p className="small muted">Files are scanned before anyone else can open them.</p>
      <button className="btn btn-primary" disabled={!file || busy} onClick={go}>{busy ? 'Uploading…' : 'Upload'}</button>
    </Modal>
  );
}
