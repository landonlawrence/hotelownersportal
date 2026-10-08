import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { usePortal, useCompany, type Property } from '../state/portal';
import { Card, Modal, Notice, StatusBadge, fmtDate } from '../components/ui';

const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC'];

interface Inventory { property_id: string; room_count: number; effective_from: string; effective_to: string | null; reason: string | null }
interface Config { property_id: string; ooo_treatment: string; comp_treatment: string; daily_report_deadline_local: string }

/** Property administration (admin.company): details, room inventory changes, KPI conventions. */
export function AdminProperties() {
  const company = useCompany();
  const { properties } = usePortal();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Property | 'new' | null>(null);
  const [inventoryFor, setInventoryFor] = useState<Property | null>(null);
  const inv = useQuery({ queryKey: ['admin-inventory', company.company_id], queryFn: async () => unwrap(await supabase.from('room_inventory_history').select('property_id, room_count, effective_from, effective_to, reason').eq('company_id', company.company_id).order('effective_from')) as Inventory[] });
  const cfg = useQuery({ queryKey: ['admin-config', company.company_id], queryFn: async () => unwrap(await supabase.from('property_reporting_config').select('property_id, ooo_treatment, comp_treatment, daily_report_deadline_local').eq('company_id', company.company_id)) as Config[] });
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['admin-inventory', 'admin-config', 'properties', 'inventory', 'inventory-history', 'reporting-config'].includes(String(q.queryKey[0])) });
  const setConfig = async (propertyId: string, patch: Partial<Config>) => {
    await supabase.from('property_reporting_config').update(patch).eq('property_id', propertyId);
    await refresh();
  };
  return (
    <Card flush title="Properties" actions={<button className="btn btn-primary" style={{ marginRight: 16 }} onClick={() => setEditing('new')}>Add property</button>}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Property</th><th>Status</th><th className="num">Rooms</th><th>Out-of-order rooms</th><th>Comp rooms</th><th>Daily report due</th><th /></tr></thead>
          <tbody>
            {properties.map((p) => {
              const current = inv.data?.find((i) => i.property_id === p.id && i.effective_to === null);
              const c = cfg.data?.find((x) => x.property_id === p.id);
              return (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><div className="small muted">{p.code} · {p.city} · {p.timezone}</div></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="num">{current?.room_count ?? '—'}<div className="small muted">since {fmtDate(current?.effective_from)}</div></td>
                  <td>{c && <select aria-label={`${p.code} out-of-order treatment`} value={c.ooo_treatment} onChange={(e) => setConfig(p.id, { ooo_treatment: e.target.value })}><option value="exclude">Excluded from available</option><option value="include">Included in available</option></select>}</td>
                  <td>{c && <select aria-label={`${p.code} comp treatment`} value={c.comp_treatment} onChange={(e) => setConfig(p.id, { comp_treatment: e.target.value })}><option value="exclude">Excluded from sold</option><option value="include">Included in sold</option></select>}</td>
                  <td>{c && <input aria-label={`${p.code} report deadline`} type="time" value={c.daily_report_deadline_local.slice(0, 5)} onChange={(e) => setConfig(p.id, { daily_report_deadline_local: e.target.value })} />}</td>
                  <td className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => setInventoryFor(p)}>Room inventory</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ padding: '8px 16px' }}>KPI conventions apply to all dashboards, exports and reports. Changing them recalculates history; the PMS-reported values are always preserved alongside.</p>
      {editing && <PropertyForm property={editing === 'new' ? null : editing} onClose={() => { setEditing(null); void refresh(); }} />}
      {inventoryFor && <InventoryModal property={inventoryFor} history={(inv.data ?? []).filter((i) => i.property_id === inventoryFor.id)} onClose={() => { setInventoryFor(null); void refresh(); }} />}
    </Card>
  );
}

function PropertyForm({ property, onClose }: { property: Property | null; onClose: () => void }) {
  const company = useCompany();
  const [f, setF] = useState({
    code: property?.code ?? '', name: property?.name ?? '', brand: property?.brand ?? '', city: property?.city ?? '', region: property?.region ?? '',
    timezone: property?.timezone ?? 'America/New_York', status: property?.status ?? 'onboarding', opened_on: property?.opened_on ?? '', rooms: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const row = { name: f.name.trim(), brand: f.brand || null, city: f.city || null, region: f.region || null, timezone: f.timezone, status: f.status, opened_on: f.opened_on || null };
    if (property) {
      const { error } = await supabase.from('properties').update(row).eq('id', property.id);
      if (error) return setErr(error.message);
    } else {
      const { data: newId, error } = await supabase.rpc('create_property', {
        p_company_id: company.company_id, p_code: f.code, p_name: row.name, p_timezone: row.timezone, p_status: row.status,
        p_brand: row.brand, p_city: row.city, p_region: row.region, p_opened_on: row.opened_on,
      });
      if (error) return setErr(error.message);
      if (Number(f.rooms) > 0) {
        const { error: e2 } = await supabase.rpc('set_room_inventory', { p_property_id: newId as string, p_effective_from: f.opened_on || new Date().toISOString().slice(0, 10), p_room_count: Number(f.rooms), p_reason: 'Opening inventory' });
        if (e2) return setErr(e2.message);
      }
    }
    onClose();
  };
  return (
    <Modal title={property ? `Edit ${property.name}` : 'Add property'} onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      {!property && <label className="field">Code (unique, e.g. HV-BOS)<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>}
      <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="row">
        <label className="field">Brand<input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></label>
        <label className="field">Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['onboarding', 'active', 'sold', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      </div>
      <div className="row">
        <label className="field">City<input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
        <label className="field">Region<input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></label>
      </div>
      <label className="field">Time zone (defines the property-local business date)<select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <label className="field">Opened on<input type="date" value={f.opened_on} onChange={(e) => setF({ ...f, opened_on: e.target.value })} /></label>
      {!property && <label className="field">Rooms at opening<input inputMode="numeric" value={f.rooms} onChange={(e) => setF({ ...f, rooms: e.target.value })} /></label>}
      <button className="btn btn-primary" disabled={!f.name.trim() || (!property && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(f.code.trim()))} onClick={save}>{property ? 'Save changes' : 'Add property'}</button>
      {!property && <p className="small muted">New properties are visible to company-wide roles immediately. Grant owners and investors access under Users & access.</p>}
    </Modal>
  );
}

function InventoryModal({ property, history, onClose }: { property: Property; history: Inventory[]; onClose: () => void }) {
  const [f, setF] = useState({ from: new Date().toISOString().slice(0, 10), rooms: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const { error } = await supabase.rpc('set_room_inventory', { p_property_id: property.id, p_effective_from: f.from, p_room_count: Number(f.rooms), p_reason: f.reason });
    if (error) setErr(error.message);
    else onClose();
  };
  return (
    <Modal title={`Room inventory — ${property.name}`} onClose={onClose}>
      <table className="data">
        <thead><tr><th>From</th><th>To</th><th className="num">Rooms</th><th>Reason</th></tr></thead>
        <tbody>{history.map((h) => <tr key={h.effective_from}><td>{fmtDate(h.effective_from)}</td><td>{h.effective_to ? fmtDate(h.effective_to) : 'Current'}</td><td className="num">{h.room_count}</td><td>{h.reason}</td></tr>)}</tbody>
      </table>
      <h3>Change room count</h3>
      <p className="small muted">The current period ends the day before the new count takes effect. Available room nights for each business date use the count in effect on that date (unless the PMS report supplies rooms available).</p>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <label className="field">Effective from<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="field">Rooms<input inputMode="numeric" value={f.rooms} onChange={(e) => setF({ ...f, rooms: e.target.value })} /></label>
      </div>
      <label className="field">Reason<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. 12-room wing opened" /></label>
      <button className="btn btn-primary" disabled={!(Number(f.rooms) > 0) || !f.reason.trim()} onClick={save}>Save inventory change</button>
    </Modal>
  );
}
