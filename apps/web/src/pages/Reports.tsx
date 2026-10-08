import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { computeKpis, formatCurrency, formatPercent, REMAINING_FUNDS_DEFINITION } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { downloadDocumentVersion, downloadFromApi } from '../lib/api';
import { useRpc } from '../lib/hooks';
import { buildStatement, type Account } from '@hop/core';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate, fmtMonth } from '../components/ui';
import { KpiCard } from '../components/kpi';
import { StatementTable } from '../components/StatementTable';

export function ReportsPage() {
  const { properties, canAny, can } = usePortal();
  const company = useCompany();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['packages', company.company_id],
    queryFn: async () => unwrap(await supabase.from('reporting_packages').select('id, property_id, period_month, title, revision, status, published_at, correction_reason').eq('company_id', company.company_id).order('period_month', { ascending: false }).order('revision', { ascending: false })) as Array<{ id: string; property_id: string; period_month: string; title: string; revision: number; status: string; published_at: string | null; correction_reason: string | null }>,
  });
  const create = useRpc('create_reporting_package');
  const [f, setF] = useState({ property: properties.find((p) => can('reports.edit', p.id))?.id ?? '', month: '' });
  return (
    <div className="stack">
      <PageHeader title="Owner reports" subtitle="Monthly reporting packages: performance, budget variances, financial statements, commentary, CapEx and supporting documents." actions={canAny('reports.edit') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New package</button>} />
      <Card flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (q.data ?? []).length === 0 ? <Empty title="No reports published yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Period</th><th>Property</th><th>Report</th><th>Status</th><th>Published</th></tr></thead>
              <tbody>
                {q.data!.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtMonth(r.period_month)}</td>
                    <td>{properties.find((p) => p.id === r.property_id)?.name}</td>
                    <td><Link to={`/reports/${r.id}`}>{r.title}</Link>{r.revision > 1 && <span className="small muted"> · revision {r.revision}</span>}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{fmtDate(r.published_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && (
        <Modal title="New reporting package" onClose={() => setCreating(false)}>
          {create.error && <Notice tone="bad">{errorMessage(create.error)}</Notice>}
          <label className="field">Property<select value={f.property} onChange={(e) => setF({ ...f, property: e.target.value })}>{properties.filter((p) => can('reports.edit', p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field">Period<input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></label>
          <p className="small muted">The package includes the published financial statement for the period (if any), performance, budget variances, owner-facing commentary and CapEx. A snapshot is frozen when it is published.</p>
          <button className="btn btn-primary" disabled={!f.property || !f.month} onClick={async () => { const id = await create.mutateAsync({ p_property_id: f.property, p_period_month: `${f.month}-01`, p_title: null }); navigate(`/reports/${id}`); }}>Create draft</button>
        </Modal>
      )}
    </div>
  );
}

interface Snapshot {
  property: { name: string; code: string };
  period_month: string;
  generated_at: string;
  performance?: Perf;
  performance_prior_year?: Perf;
  financial_report?: { id: string; title: string; revision: number; published_at: string } | null;
  budget_variance?: Array<{ account_id: string; code: string; name: string; nature: Account['nature']; section: string; sort_order: number; actual: number | null; budget: number | null }>;
  commentary?: Array<{ section: string; title: string | null; body: string }>;
  capex?: Array<{ project_id: string; number: string; title: string; status: string; approved_budget: number; actual_spend: number; open_commitments: number; remaining: number; percent_complete: number; latest_update: string | null }>;
  documents?: Array<{ document_id: string; title: string }>;
  definitions?: Record<string, string>;
}
interface Perf { available_room_nights: number | null; rooms_sold: number | null; room_revenue: number | null; total_revenue: number | null; reported_days: number; expected_days: number }

const perfKpis = (p?: Perf) => (p && p.reported_days > 0 ? computeKpis({ availableRoomNights: Number(p.available_room_nights), roomsSold: Number(p.rooms_sold), roomRevenue: Number(p.room_revenue), totalRevenue: p.total_revenue === null ? null : Number(p.total_revenue) }) : computeKpis(null));

export function ReportPackagePage() {
  const { id } = useParams();
  const { can } = usePortal();
  const q = useQuery({ queryKey: ['package', id], queryFn: async () => unwrap(await supabase.rpc('get_reporting_package', { p_package_id: id })) as { package: { id: string; property_id: string; title: string; status: string; revision: number; published_at: string | null; correction_reason: string | null; period_month: string }; snapshot: Snapshot | null; is_preview: boolean } | null });
  const docs = useQuery({
    queryKey: ['package-docs', id, q.data?.snapshot?.documents?.length],
    enabled: !!q.data?.snapshot?.documents?.length,
    queryFn: async () => unwrap(await supabase.from('documents').select('id, title, current_version_id').in('id', q.data!.snapshot!.documents!.map((d) => d.document_id))) as Array<{ id: string; title: string; current_version_id: string | null }>,
  });
  const [action, setAction] = useState<null | 'publish' | 'revise'>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Empty title="Report not found">It may not exist, may not be published yet, or you may not have access.</Empty>;
  const { package: pkg, snapshot: s } = q.data;
  const cur = perfKpis(s?.performance);
  const py = perfKpis(s?.performance_prior_year);
  const partial = s?.performance ? s.performance.reported_days < s.performance.expected_days : false;
  const statement = s?.budget_variance ? buildStatement(s.budget_variance.map((b) => ({ id: b.account_id, code: b.code, name: b.name, nature: b.nature, section: b.section, sort_order: b.sort_order })), new Map(s.budget_variance.filter((b) => b.actual !== null).map((b) => [b.account_id, Number(b.actual)])), new Map(s.budget_variance.filter((b) => b.budget !== null).map((b) => [b.account_id, Number(b.budget)])), new Map()) : null;
  return (
    <div className="stack">
      <div className="small"><Link to="/reports">← Owner reports</Link></div>
      <PageHeader
        title={`${s?.property.name ?? ''} — ${fmtMonth(pkg.period_month)}`}
        subtitle={<>{pkg.title} · revision {pkg.revision} · <StatusBadge status={pkg.status} />{pkg.published_at && ` · published ${fmtDate(pkg.published_at)}`}</>}
        actions={
          <>
            <button className="btn" onClick={() => downloadFromApi(`/exports/packages/${pkg.id}.pdf`, 'owner-report.pdf')}>Download PDF</button>
            {['draft', 'in_review'].includes(pkg.status) && can('reports.publish', pkg.property_id) && <button className="btn btn-primary" onClick={() => setAction('publish')}>Publish to owners</button>}
            {pkg.status === 'published' && can('reports.edit', pkg.property_id) && <button className="btn" onClick={() => setAction('revise')}>Create revision</button>}
          </>
        }
      />
      {q.data.is_preview && <Notice tone="warn">Preview — this draft is not visible to owners. Figures will be frozen when published.</Notice>}
      {pkg.correction_reason && <Notice tone="info">Revision note: {pkg.correction_reason}</Notice>}
      {pkg.status === 'superseded' && <Notice tone="info">A revised version of this report has been published.</Notice>}
      {s?.performance && (
        <Card title="Performance summary" actions={<span className="small muted">Provisional daily figures · {s.performance.reported_days}/{s.performance.expected_days} days reported</span>}>
          <div className="grid grid-kpi">
            <KpiCard label="Occupancy" value={cur.occupancyPct} kind="pct" priorYear={py.occupancyPct} partial={partial} />
            <KpiCard label="ADR" value={cur.adr} kind="money_cents" priorYear={py.adr} partial={partial} />
            <KpiCard label="RevPAR" value={cur.revpar} kind="money_cents" priorYear={py.revpar} partial={partial} />
            <KpiCard label="Total revenue" value={cur.totalRevenue} kind="money" priorYear={py.totalRevenue} partial={partial} />
          </div>
        </Card>
      )}
      {s?.commentary && s.commentary.length > 0 && (
        <Card title="Management commentary">
          <div className="prose">{s.commentary.map((c, i) => <div key={i}><h3>{c.title ?? c.section.replace('_', ' ')}</h3><p>{c.body}</p></div>)}</div>
        </Card>
      )}
      {statement && (
        <Card title="Budget variances" flush actions={s?.financial_report ? <Link className="small" to={`/financials/reports/${s.financial_report.id}`} style={{ paddingRight: 16 }}>Financial statement (rev {s.financial_report.revision})</Link> : <span className="small muted" style={{ paddingRight: 16 }}>No published statement for this period</span>}>
          <StatementTable rows={statement.rows} statistics={statement.statistics} currency="USD" showPrior={false} />
        </Card>
      )}
      {s?.capex && s.capex.length > 0 && (
        <Card title="CapEx update" flush>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Project</th><th>Status</th><th className="num">Approved</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Remaining</th><th>Latest update</th></tr></thead>
              <tbody>
                {s.capex.map((c) => (
                  <tr key={c.project_id}>
                    <td>{c.title}<div className="small muted">{c.number} · {c.percent_complete}%</div></td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="num">{formatCurrency(Number(c.approved_budget))}</td>
                    <td className="num">{formatCurrency(Number(c.actual_spend))}</td>
                    <td className="num">{formatCurrency(Number(c.open_commitments))}</td>
                    <td className="num">{formatCurrency(Number(c.remaining))}</td>
                    <td className="small">{c.latest_update ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ padding: '8px 16px' }}>{REMAINING_FUNDS_DEFINITION}</p>
        </Card>
      )}
      {(docs.data ?? []).length > 0 && (
        <Card title="Supporting documents">
          <ul>{docs.data!.map((d) => <li key={d.id}>{d.current_version_id ? <button className="btn btn-ghost btn-sm" onClick={() => downloadDocumentVersion(d.current_version_id!)}>{d.title}</button> : d.title}</li>)}</ul>
        </Card>
      )}
      {s?.definitions && <p className="small muted">Definitions: {Object.entries(s.definitions).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}. Occupancy {formatPercent(cur.occupancyPct)} is based on reported days only.</p>}
      {action && <PackageAction action={action} id={pkg.id} onClose={() => setAction(null)} />}
    </div>
  );
}

function PackageAction({ action, id, onClose }: { action: 'publish' | 'revise'; id: string; onClose: () => void }) {
  const rpc = useRpc(action === 'publish' ? 'publish_reporting_package' : 'create_reporting_package_revision');
  const navigate = useNavigate();
  const [text, setText] = useState('');
  return (
    <Modal title={action === 'publish' ? 'Publish package' : 'Create revision'} onClose={onClose}>
      <p>{action === 'publish' ? 'Freezes a snapshot and notifies authorized owners and investors (no financial attachments are emailed).' : 'Creates a new draft. The published version stays visible until the revision is published.'}</p>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">{action === 'revise' ? 'Reason (required)' : 'Comment'}<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={rpc.isPending || (action === 'revise' && !text.trim())} onClick={async () => {
        const res = await rpc.mutateAsync(action === 'publish' ? { p_package_id: id, p_comment: text || null } : { p_package_id: id, p_reason: text }).catch(() => undefined);
        if (action === 'revise' && typeof res === 'string') navigate(`/reports/${res}`);
        else if (res !== undefined || action === 'publish') onClose();
      }}>{action === 'publish' ? 'Publish' : 'Create revision'}</button>
    </Modal>
  );
}
