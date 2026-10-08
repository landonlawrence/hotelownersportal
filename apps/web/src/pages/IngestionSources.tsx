import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listParsers } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, Loading, Modal, Notice, StatusBadge, errorMessage } from '../components/ui';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const TYPE_LABEL: Record<string, string> = { daily_performance: 'Daily performance', monthly_actuals: 'Monthly actuals', budget: 'Budget' };

interface Source {
  id: string; name: string; channel: string; report_type: string; parser_key: string; revision_policy: string;
  expected_cadence: string; expected_by_local: string | null; expected_by_day: number | null; active: boolean;
}

/** Ingestion source, email route and property-mapping management (ingestion.manage). */
export function IngestionSourcesCard() {
  const { can } = usePortal();
  const company = useCompany();
  const manage = can('ingestion.manage');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const sources = useQuery({
    queryKey: ['ingestion-sources-full', company.company_id],
    queryFn: async () => unwrap(await supabase.from('ingestion_sources').select('id, name, channel, report_type, parser_key, revision_policy, expected_cadence, expected_by_local, expected_by_day, active').eq('company_id', company.company_id).order('name')) as Source[],
  });
  return (
    <Card flush title="Ingestion sources" actions={manage && <button className="btn btn-primary" style={{ marginRight: 16 }} onClick={() => setCreating(true)}>New source</button>}>
      {sources.isLoading ? <Loading /> : (sources.data ?? []).length === 0 ? <Empty title="No ingestion sources" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Source</th><th>Channel</th><th>Report</th><th>Revisions</th><th>Expected</th><th>Status</th><th /></tr></thead>
            <tbody>
              {sources.data!.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td><td>{s.channel}</td><td>{TYPE_LABEL[s.report_type]}</td>
                  <td>{s.revision_policy === 'replace' ? 'Replace (history kept)' : 'Require review'}</td>
                  <td>{s.expected_cadence === 'daily' ? `Daily by ${s.expected_by_local?.slice(0, 5) ?? '11:00'} local` : s.expected_cadence === 'monthly' ? `Monthly by day ${s.expected_by_day ?? 15}` : '—'}</td>
                  <td><StatusBadge status={s.active ? 'active' : 'cancelled'} label={s.active ? 'active' : 'paused'} /></td>
                  <td>{manage && <button className="btn btn-sm" onClick={() => setOpen(s.id)}>Configure</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ padding: 16 }} className="small muted">
        Supported formats: {listParsers().map((p) => p.label).join('; ')}. PMS-specific formats are added only after verification against real sample reports.
      </div>
      {creating && <NewSource onClose={() => setCreating(false)} />}
      {open && sources.data && <SourceConfig source={sources.data.find((s) => s.id === open)!} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function NewSource({ onClose }: { onClose: () => void }) {
  const company = useCompany();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', channel: 'email', report_type: 'daily_performance', revision_policy: 'require_review', expected_cadence: 'daily', expected_by_local: '11:00', expected_by_day: 15 });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const parser = listParsers().find((p) => p.reportType === f.report_type)!.key;
    const { data, error } = await supabase.from('ingestion_sources').insert({
      company_id: company.company_id, name: f.name.trim(), channel: f.channel, report_type: f.report_type, parser_key: parser,
      revision_policy: f.revision_policy, expected_cadence: f.expected_cadence,
      expected_by_local: f.expected_cadence === 'daily' ? f.expected_by_local : null,
      expected_by_day: f.expected_cadence === 'monthly' ? f.expected_by_day : null,
    }).select('id').single();
    if (error) return setErr(error.message);
    if (f.channel === 'email') await supabase.rpc('rotate_ingestion_route_token', { p_source_id: (data as { id: string }).id });
    await qc.invalidateQueries({ queryKey: ['ingestion-sources-full'] });
    onClose();
  };
  return (
    <Modal title="New ingestion source" onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Nightly PMS flash" /></label>
      <label className="field">Channel<select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="email">Scheduled email</option><option value="manual">Manual upload</option></select></label>
      <label className="field">Report type<select value={f.report_type} onChange={(e) => setF({ ...f, report_type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">When values for already-loaded dates change<select value={f.revision_policy} onChange={(e) => setF({ ...f, revision_policy: e.target.value })}><option value="require_review">Hold for review</option><option value="replace">Replace automatically (history kept)</option></select></label>
      <label className="field">Expected cadence (missing-report alerts)<select value={f.expected_cadence} onChange={(e) => setF({ ...f, expected_cadence: e.target.value })}><option value="none">None</option><option value="daily">Daily</option><option value="monthly">Monthly</option></select></label>
      {f.expected_cadence === 'daily' && <label className="field">Due by (property-local time)<input type="time" value={f.expected_by_local} onChange={(e) => setF({ ...f, expected_by_local: e.target.value })} /></label>}
      {f.expected_cadence === 'monthly' && <label className="field">Due by day of following month<input type="number" min={1} max={28} value={f.expected_by_day} onChange={(e) => setF({ ...f, expected_by_day: Number(e.target.value) })} /></label>}
      <button className="btn btn-primary" disabled={f.name.trim().length < 3} onClick={save}>Create source</button>
    </Modal>
  );
}

function SourceConfig({ source, onClose }: { source: Source; onClose: () => void }) {
  const company = useCompany();
  const { properties } = usePortal();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const meta = useQuery({ queryKey: ['api-meta'], staleTime: Infinity, queryFn: async () => (await fetch(`${API}/meta`)).json() as Promise<{ inboundEmailDomain: string }> });
  const route = useQuery({
    queryKey: ['route', source.id],
    queryFn: async () => unwrap(await supabase.from('ingestion_source_routes').select('inbound_token, allowed_senders, require_spf_dkim_pass').eq('source_id', source.id).maybeSingle()) as { inbound_token: string; allowed_senders: string[]; require_spf_dkim_pass: boolean } | null,
  });
  const mappings = useQuery({
    queryKey: ['mappings-src', source.id],
    queryFn: async () => unwrap(await supabase.from('ingestion_property_mappings').select('id, external_code, property_id').eq('source_id', source.id).order('external_code')) as Array<{ id: string; external_code: string; property_id: string }>,
  });
  const [sender, setSender] = useState('');
  const [map, setMap] = useState({ code: '', property: properties[0]?.id ?? '' });
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['route', 'mappings-src', 'ingestion-sources-full'].includes(String(q.queryKey[0])) });
  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setErr(null);
    const { error } = await p;
    if (error) setErr(error.message);
    await refresh();
  };
  const senders = route.data?.allowed_senders ?? [];
  const validSender = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[a-z0-9.-]+\.[a-z]{2,})$/i.test(sender.trim());
  return (
    <Modal title={`Configure: ${source.name}`} onClose={onClose}>
      {err && <Notice tone="bad">{errorMessage(err)}</Notice>}
      <div className="row">
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={source.active} onChange={(e) => run(supabase.from('ingestion_sources').update({ active: e.target.checked }).eq('id', source.id))} /> Active</label>
        <select aria-label="Revision policy" value={source.revision_policy} onChange={(e) => run(supabase.from('ingestion_sources').update({ revision_policy: e.target.value }).eq('id', source.id))}>
          <option value="require_review">Hold revisions for review</option><option value="replace">Replace revisions automatically</option>
        </select>
      </div>
      {source.channel === 'email' && (
        <>
          <h3>Email route</h3>
          {route.data ? (
            <div className="stack" style={{ gap: 8 }}>
              <div><span className="small muted">Inbound address</span><br /><code>reports+{route.data.inbound_token}@{meta.data?.inboundEmailDomain ?? '…'}</code></div>
              <button className="btn btn-sm" style={{ width: 'fit-content' }} onClick={() => window.confirm('Rotate the address? The old address stops working immediately.') && run(supabase.rpc('rotate_ingestion_route_token', { p_source_id: source.id }))}>Rotate address</button>
              <div>
                <span className="small muted">Allowed senders (an email must match one of these and pass SPF or DKIM)</span>
                <ul className="timeline">
                  {senders.map((s) => (
                    <li key={s} className="spread"><code>{s}</code><button className="btn btn-sm btn-danger" onClick={() => run(supabase.from('ingestion_source_routes').update({ allowed_senders: senders.filter((x) => x !== s) }).eq('source_id', source.id))}>Remove</button></li>
                  ))}
                  {senders.length === 0 && <li className="muted">No senders allowed — all email to this address is rejected.</li>}
                </ul>
                <div className="row">
                  <input aria-label="Allowed sender" placeholder="nightaudit@hotel.com or @pms.vendor.com" value={sender} onChange={(e) => setSender(e.target.value)} />
                  <button className="btn btn-sm" disabled={!validSender} onClick={() => run(supabase.from('ingestion_source_routes').update({ allowed_senders: [...new Set([...senders, sender.trim().toLowerCase()])] }).eq('source_id', source.id)).then(() => setSender(''))}>Add sender</button>
                </div>
              </div>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={route.data.require_spf_dkim_pass} onChange={(e) => run(supabase.from('ingestion_source_routes').update({ require_spf_dkim_pass: e.target.checked }).eq('source_id', source.id))} /> Require SPF or DKIM pass (recommended)</label>
            </div>
          ) : <button className="btn btn-sm" onClick={() => run(supabase.rpc('rotate_ingestion_route_token', { p_source_id: source.id }))}>Create inbound address</button>}
        </>
      )}
      <h3>Property code mappings</h3>
      <p className="small muted">Report property codes must map to a property of {company.company_name}. With mappings in place, unmapped codes are rejected — including internal codes and other companies’ hotels.</p>
      <table className="data">
        <tbody>
          {(mappings.data ?? []).map((m) => (
            <tr key={m.id}><td><code>{m.external_code}</code></td><td>{properties.find((p) => p.id === m.property_id)?.name ?? '—'}</td><td><button className="btn btn-sm btn-danger" onClick={() => run(supabase.from('ingestion_property_mappings').delete().eq('id', m.id))}>Remove</button></td></tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input aria-label="External code" placeholder="Code in report" value={map.code} onChange={(e) => setMap({ ...map, code: e.target.value })} />
        <select aria-label="Property" value={map.property} onChange={(e) => setMap({ ...map, property: e.target.value })}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="btn btn-sm" disabled={!map.code.trim()} onClick={() => run(supabase.from('ingestion_property_mappings').insert({ company_id: company.company_id, source_id: source.id, external_code: map.code.trim(), property_id: map.property })).then(() => setMap({ ...map, code: '' }))}>Add mapping</button>
      </div>
    </Modal>
  );
}
