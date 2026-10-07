import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { capexFunds, formatCurrency, REMAINING_FUNDS_DEFINITION } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { downloadDocumentVersion, uploadDocument } from '../lib/api';
import { useDisplayNames, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate } from '../components/ui';

const CATEGORIES: Record<string, string> = {
  guest_rooms: 'Guest rooms', public_areas: 'Public areas', building_systems: 'Building systems', life_safety: 'Life safety', technology: 'Technology',
  food_beverage: 'Food & beverage', exterior: 'Exterior', brand_standards: 'Brand standards', other: 'Other',
};

interface Project {
  id: string; property_id: string; project_number: string; title: string; category: string; description: string | null; status: string; priority: string;
  requested_budget: number; approved_budget: number; target_start: string | null; target_completion: string | null; actual_completion: string | null; percent_complete: number;
}

function useSummary(companyId: string) {
  return useQuery({
    queryKey: ['capex-summary-rows', companyId],
    queryFn: async () => unwrap(await supabase.rpc('capex_project_summary', { p_company_id: companyId })) as Array<{ project_id: string; approved_budget: number; actual_spend: number; open_commitments: number; remaining: number }>,
  });
}

export function CapexPage() {
  const { properties, canAny } = usePortal();
  const company = useCompany();
  const [status, setStatus] = useState('');
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
  return (
    <div className="stack">
      <PageHeader title="Capital expenditures" subtitle={REMAINING_FUNDS_DEFINITION} actions={canAny('capex.edit') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New project</button>} />
      <div className="grid grid-kpi">
        <div className="card kpi"><span className="label">Approved budget</span><span className="value">{formatCurrency(f.approvedBudget)}</span></div>
        <div className="card kpi"><span className="label">Actual spend</span><span className="value">{formatCurrency(f.actualSpend)}</span></div>
        <div className="card kpi"><span className="label">Open commitments</span><span className="value">{formatCurrency(f.openCommitments)}</span></div>
        <div className="card kpi"><span className="label">Remaining funds</span><span className="value">{formatCurrency(f.remaining)}</span></div>
      </div>
      <Card flush title={<label className="field">Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['draft', 'pending_approval', 'approved', 'in_progress', 'on_hold', 'completed', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>}>
        {projects.isLoading ? <Loading /> : projects.error ? <ErrorState error={projects.error} /> : rows.length === 0 ? <Empty title="No projects" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Project</th><th>Property</th><th>Category</th><th>Status</th><th className="num">Approved</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Remaining</th><th>Progress</th><th>Target</th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const s = summary.data?.find((x) => x.project_id === p.id);
                  const remaining = s ? Number(s.remaining) : null;
                  return (
                    <tr key={p.id}>
                      <td><Link to={`/capex/${p.id}`}>{p.title}</Link><div className="small muted">{p.project_number}</div></td>
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
  return (
    <Modal title="New CapEx project" onClose={onClose}>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">Property<select value={f.property} onChange={(e) => setF({ ...f, property: e.target.value })}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field">Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Description<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="field">Requested budget<input inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></label>
      <div className="row">
        <label className="field">Target start<input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label className="field">Target completion<input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
      </div>
      <button className="btn btn-primary" disabled={!f.title || !(Number(f.budget) > 0)} onClick={async () => {
        const id = await rpc.mutateAsync({ p_property_id: f.property, p_title: f.title, p_category: f.category, p_description: f.description || null, p_requested_budget: Number(f.budget), p_target_start: f.start || null, p_target_completion: f.end || null, p_priority: f.priority });
        navigate(`/capex/${id}`);
      }}>Create draft project</button>
    </Modal>
  );
}

export function CapexProjectPage() {
  const { id } = useParams();
  const { properties, can, ctx } = usePortal();
  const company = useCompany();
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ['capex-project', id], queryFn: async () => unwrap(await supabase.from('capex_projects').select('*').eq('id', id!).maybeSingle()) as Project | null });
  const tx = useQuery({ queryKey: ['capex-tx', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_transactions').select('id, kind, status, reference, description, amount, transaction_date, document_id, capex_vendors(name)').eq('project_id', id!).order('transaction_date', { ascending: false })) as unknown as Array<{ id: string; kind: string; status: string; reference: string | null; description: string | null; amount: number; transaction_date: string; document_id: string | null; capex_vendors: { name: string } | null }> });
  const requests = useQuery({ queryKey: ['capex-requests', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_approval_requests').select('id, request_type, amount, new_approved_budget, previous_approved_budget, justification, status, required_steps, requested_by, created_at, decided_at, capex_approval_decisions(id, approver_type, decision, comment, decided_by, decided_at)').eq('project_id', id!).order('created_at', { ascending: false })) as unknown as Array<{ id: string; request_type: string; amount: number; new_approved_budget: number; previous_approved_budget: number; justification: string; status: string; required_steps: Array<{ approver_type: string; approvals_required: number }>; requested_by: string; created_at: string; decided_at: string | null; capex_approval_decisions: Array<{ id: string; approver_type: string; decision: string; comment: string | null; decided_by: string; decided_at: string }> }> });
  const updates = useQuery({ queryKey: ['capex-updates', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('capex_updates').select('id, body, percent_complete, visibility, created_by, created_at').eq('project_id', id!).order('created_at', { ascending: false })) as Array<{ id: string; body: string; percent_complete: number | null; visibility: string; created_by: string; created_at: string }> });
  const docs = useQuery({ queryKey: ['capex-docs', id], enabled: !!p.data, queryFn: async () => unwrap(await supabase.from('documents').select('id, title, category_key, current_version_id, created_at').eq('linked_entity_type', 'capex_project').eq('linked_entity_id', id!)) as Array<{ id: string; title: string; current_version_id: string | null; created_at: string }> });
  const summary = useSummary(company.company_id);
  const names = useDisplayNames([...(requests.data ?? []).flatMap((r) => [r.requested_by, ...r.capex_approval_decisions.map((d) => d.decided_by)]), ...(updates.data ?? []).map((u) => u.created_by)]);
  const [modal, setModal] = useState<null | 'request' | 'tx' | 'update' | 'upload' | { decide: string }>(null);
  if (p.isLoading) return <Loading />;
  if (!p.data) return <Empty title="Project not found">It may not exist or you may not have access.</Empty>;
  const proj = p.data;
  const s = summary.data?.find((x) => x.project_id === proj.id);
  const f = capexFunds(Number(proj.approved_budget), Number(s?.actual_spend ?? 0), Number(s?.open_commitments ?? 0));
  const canEdit = can('capex.edit', proj.property_id);
  const canApprove = can('capex.approve', proj.property_id);
  const pending = requests.data?.find((r) => r.status === 'pending');
  const refresh = () => qc.invalidateQueries();
  return (
    <div className="stack">
      <div className="small"><Link to="/capex">← CapEx</Link></div>
      <PageHeader
        title={proj.title}
        subtitle={<>{proj.project_number} · {properties.find((x) => x.id === proj.property_id)?.name} · {CATEGORIES[proj.category]} · <StatusBadge status={proj.status} /></>}
        actions={
          <>
            {canEdit && !pending && ['draft', 'rejected', 'approved', 'in_progress', 'on_hold'].includes(proj.status) && <button className="btn btn-primary" onClick={() => setModal('request')}>{['draft', 'rejected'].includes(proj.status) ? 'Request approval' : 'Request budget change'}</button>}
            {canEdit && <button className="btn" onClick={() => setModal('tx')}>Add spend / commitment</button>}
            {canEdit && <button className="btn" onClick={() => setModal('update')}>Post update</button>}
            {can('documents.upload', proj.property_id) && <button className="btn" onClick={() => setModal('upload')}>Attach file</button>}
          </>
        }
      />
      {proj.description && <p>{proj.description}</p>}
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
                    {r.status === 'pending' && canApprove && !myDecision && r.requested_by !== ctx?.user_id && <button className="btn btn-primary" onClick={() => setModal({ decide: r.id })}>Review & decide</button>}
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
                <thead><tr><th>Date</th><th>Type</th><th>Vendor</th><th>Reference</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {tx.data!.map((t) => (
                    <tr key={t.id}>
                      <td>{fmtDate(t.transaction_date)}</td>
                      <td>{t.kind}{t.kind === 'commitment' && <> <StatusBadge status={t.status === 'open' ? 'pending' : 'completed'} label={t.status} /></>}</td>
                      <td>{t.capex_vendors?.name ?? '—'}</td>
                      <td>{t.reference}<div className="small muted">{t.description}</div></td>
                      <td className="num">{formatCurrency(Number(t.amount))}</td>
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
              <ul>{docs.data!.map((d) => <li key={d.id}>{d.current_version_id ? <button className="btn btn-ghost btn-sm" onClick={() => downloadDocumentVersion(d.current_version_id!)}>{d.title}</button> : <span>{d.title} <StatusBadge status="pending" label="scanning" /></span>}</li>)}</ul>
            </>
          )}
        </Card>
      </div>
      {modal === 'request' && <RequestModal project={proj} onClose={() => setModal(null)} />}
      {modal === 'tx' && <TxModal project={proj} onClose={() => { setModal(null); void refresh(); }} />}
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
      <button className="btn btn-primary" disabled={rpc.isPending || why.trim().length < 10} onClick={() => rpc.mutateAsync({ p_project_id: project.id, p_new_total: Number(total), p_justification: why }).then(onClose).catch(() => undefined)}>Submit request</button>
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

function TxModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { ctx } = usePortal();
  const company = useCompany();
  const vendors = useQuery({ queryKey: ['vendors', company.company_id], queryFn: async () => unwrap(await supabase.from('capex_vendors').select('id, name').eq('company_id', company.company_id).order('name')) as Array<{ id: string; name: string }> });
  const [f, setF] = useState({ kind: 'actual', vendor: '', reference: '', description: '', amount: '', date: new Date().toISOString().slice(0, 10) });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const { error } = await supabase.from('capex_transactions').insert({ company_id: company.company_id, property_id: project.property_id, project_id: project.id, kind: f.kind, status: f.kind === 'actual' ? 'closed' : 'open', vendor_id: f.vendor || null, reference: f.reference || null, description: f.description || null, amount: Number(f.amount), transaction_date: f.date, created_by: ctx!.user_id });
    if (error) setErr(error.message);
    else onClose();
  };
  return (
    <Modal title="Add spend, commitment or quote" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="actual">Actual spend (invoice/receipt)</option><option value="commitment">Commitment (PO/contract)</option><option value="quote">Quote</option></select></label>
      <label className="field">Vendor<select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })}><option value="">—</option>{vendors.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="field">Reference<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
      <label className="field">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="row">
        <label className="field">Amount<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="field">Date<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      </div>
      <button className="btn btn-primary" disabled={!Number(f.amount)} onClick={save}>Save</button>
    </Modal>
  );
}

function UpdateModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { ctx } = usePortal();
  const company = useCompany();
  const [body, setBody] = useState('');
  const [pct, setPct] = useState(String(project.percent_complete));
  const [vis, setVis] = useState('owner');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const { error } = await supabase.from('capex_updates').insert({ company_id: company.company_id, property_id: project.property_id, project_id: project.id, body, percent_complete: Number(pct), visibility: vis, created_by: ctx!.user_id });
    if (error) return setErr(error.message);
    if (Number(pct) !== project.percent_complete) await supabase.from('capex_projects').update({ percent_complete: Number(pct) }).eq('id', project.id);
    onClose();
  };
  return (
    <Modal title="Post management update" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Update<textarea value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field">Percent complete<input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} /></label>
      <label className="field">Visibility<select value={vis} onChange={(e) => setVis(e.target.value)}><option value="owner">Owner-facing</option><option value="internal">Internal</option></select></label>
      <button className="btn btn-primary" disabled={!body.trim()} onClick={save}>Post</button>
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
      <input type="file" accept=".pdf,.xlsx,.docx,.csv,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Visibility<select value={vis} onChange={(e) => setVis(e.target.value)}><option value="owner">Owners only</option><option value="general">Owners & investors</option><option value="internal">Internal</option></select></label>
      <p className="small muted">Files are scanned before anyone else can open them.</p>
      <button className="btn btn-primary" disabled={!file || busy} onClick={go}>{busy ? 'Uploading…' : 'Upload'}</button>
    </Modal>
  );
}
