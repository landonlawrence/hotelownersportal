import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { usePortal, useCompany, type Property } from '../state/portal';
import { Card, Modal, Notice, StatusBadge, confirmAction, dbErrorMessage, fmtDate, fmtExclusiveEnd, localToday } from '../components/ui';

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
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const setConfig = async (propertyId: string, patch: Partial<Config>) => {
    setCfgErr(null);
    const { error } = await supabase.from('property_reporting_config').update(patch).eq('property_id', propertyId);
    if (error) setCfgErr(dbErrorMessage(error));
    await refresh();
  };
  return (
    <Card flush title="Properties" actions={<button className="btn btn-primary" style={{ marginRight: 16 }} onClick={() => setEditing('new')}>Add property</button>}>
      {cfgErr && <div style={{ padding: '0 16px' }}><Notice tone="bad">{cfgErr}</Notice></div>}
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
                    <button className="btn btn-sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>Edit</button>
                    <button className="btn btn-sm" aria-label={`Room inventory for ${p.name}`} onClick={() => setInventoryFor(p)}>Room inventory</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ padding: '8px 16px' }}>KPI conventions apply to all dashboards, exports and reports. Changing them recalculates history; the PMS-reported values are always preserved alongside.</p>
      {editing && <PropertyForm property={editing === 'new' ? null : editing} inventory={editing === 'new' ? [] : (inv.data ?? []).filter((i) => i.property_id === editing.id)} onClose={() => { setEditing(null); void refresh(); }} />}
      {inventoryFor && <InventoryModal property={inventoryFor} history={(inv.data ?? []).filter((i) => i.property_id === inventoryFor.id)} onClose={() => { setInventoryFor(null); void refresh(); }} />}
    </Card>
  );
}

function PropertyForm({ property, inventory, onClose }: { property: Property | null; inventory: Inventory[]; onClose: () => void }) {
  const company = useCompany();
  const [f, setF] = useState({
    code: property?.code ?? '', name: property?.name ?? '', brand: property?.brand ?? '', city: property?.city ?? '', region: property?.region ?? '',
    timezone: property?.timezone ?? 'America/New_York', status: property?.status ?? 'onboarding', opened_on: property?.opened_on ?? '', rooms: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  // The row as stored now: the baseline for the diff and the updated_at precondition (R3-10).
  const stored = useQuery({
    queryKey: ['property-row', property?.id],
    enabled: !!property,
    gcTime: 0,
    queryFn: async () =>
      unwrap(await supabase.from('properties').select('name, brand, city, region, timezone, status, opened_on, updated_at').eq('id', property!.id).single()) as {
        name: string; brand: string | null; city: string | null; region: string | null; timezone: string; status: string; opened_on: string | null; updated_at: string;
      },
  });
  const [baseline, setBaseline] = useState<typeof stored.data>(undefined);
  useEffect(() => {
    if (stored.data && stored.data.updated_at !== baseline?.updated_at) {
      const b = stored.data;
      setBaseline(b);
      setF((prev) => ({ ...prev, name: b.name, brand: b.brand ?? '', city: b.city ?? '', region: b.region ?? '', timezone: b.timezone, status: b.status, opened_on: b.opened_on ?? '' }));
    }
  }, [stored.data, baseline?.updated_at]);
  const [extendInventory, setExtendInventory] = useState(true);
  const firstData = useQuery({
    queryKey: ['first-business-date', property?.id],
    enabled: !!property,
    queryFn: async () => unwrap(await supabase.from('daily_performance').select('business_date').eq('property_id', property!.id).order('business_date').limit(1)) as Array<{ business_date: string }>,
  });
  const roomsValid = f.rooms.trim() === '' || /^[1-9]\d{0,4}$/.test(f.rooms.trim());
  const codeValid = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(f.code.trim());
  const nameValid = f.name.trim().length >= 2 && f.name.trim().length <= 200;
  const earliestRow = [...inventory].sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
  const earliestInventory = earliestRow?.effective_from;
  // Moving the opening date before the first inventory period: offer to start inventory then (R3-04).
  // An untouched opening inventory moves with the opening date automatically.
  const offerExtend = !!property && !!f.opened_on && !!earliestRow && f.opened_on < earliestRow.effective_from && earliestRow.reason !== 'Opening inventory';
  const earliestData = firstData.data?.[0]?.business_date;
  const today = localToday();
  const twoYears = `${Number(today.slice(0, 4)) + 2}${today.slice(4)}`;
  const openedTooLate = !!f.opened_on && !!earliestData && f.opened_on > earliestData;
  const openedFarFuture = !!f.opened_on && f.status === 'active' && f.opened_on > twoYears;
  const save = async () => {
    setErr(null);
    if (!roomsValid) return setErr('Rooms must be a whole number between 1 and 99,999.');
    if (property && f.opened_on && earliestInventory && f.opened_on > earliestInventory && f.opened_on !== property.opened_on
        && !confirmAction(`Room inventory exists from ${fmtDate(earliestInventory)}, before the new opening date. Save anyway?`)) return;
    setBusy(true);
    const row = { name: f.name.trim(), brand: f.brand.trim() || null, city: f.city.trim() || null, region: f.region.trim() || null, timezone: f.timezone, status: f.status, opened_on: f.opened_on || null };
    if (property) {
      if (!baseline) {
        setBusy(false);
        return setErr('Still loading the current details — try again in a moment.');
      }
      // Send only what changed, and only if nobody saved in between.
      const changed = Object.fromEntries(Object.entries(row).filter(([k, v]) => (baseline as Record<string, unknown>)[k] !== v));
      if (Object.keys(changed).length > 0) {
        const { data, error } = await supabase.from('properties').update(changed).eq('id', property.id).eq('updated_at', baseline.updated_at).select('id');
        if (error) {
          setBusy(false);
          return setErr(dbErrorMessage(error));
        }
        if (!data || data.length === 0) {
          setBusy(false);
          setConflict(true);
          return;
        }
      }
      if (offerExtend && extendInventory) {
        const { error } = await supabase.rpc('set_room_inventory', {
          p_property_id: property.id, p_effective_from: f.opened_on, p_room_count: earliestRow!.room_count, p_reason: `Opening date moved to ${f.opened_on}`,
        });
        if (error) {
          setBusy(false);
          return setErr(`Details saved, but room inventory was not extended: ${dbErrorMessage(error)}`);
        }
      }
      setBusy(false);
    } else {
      // One transaction: the property and its opening inventory are created together.
      const { error } = await supabase.rpc('create_property', {
        p_company_id: company.company_id, p_code: f.code.trim(), p_name: row.name, p_timezone: row.timezone, p_status: row.status,
        p_brand: row.brand, p_city: row.city, p_region: row.region, p_opened_on: row.opened_on,
        p_room_count: f.rooms.trim() ? Number(f.rooms.trim()) : null,
      });
      setBusy(false);
      if (error) return setErr(dbErrorMessage(error));
    }
    onClose();
  };
  return (
    <Modal title={property ? `Edit ${property.name}` : 'Add property'} onClose={onClose}>
      {conflict && (
        <Notice tone="bad">
          This property was changed by someone else. Reload to see the latest.{' '}
          <button className="btn btn-sm" onClick={() => { setConflict(false); void stored.refetch(); }}>Reload</button>
        </Notice>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      {!property && <label className="field">Code (unique, e.g. HV-BOS)<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />{f.code && !codeValid && <span className="field-error">2–32 letters, numbers, dashes or underscores.</span>}</label>}
      <label className="field">Name<input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="row">
        <label className="field">Brand<input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></label>
        <label className="field">Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['onboarding', 'active', 'sold', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      </div>
      <div className="row">
        <label className="field">City<input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
        <label className="field">Region<input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></label>
      </div>
      <label className="field">Time zone (defines the property-local business date)<select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <label className="field">
        Opened on
        <input type="date" value={f.opened_on} onChange={(e) => setF({ ...f, opened_on: e.target.value })} />
        {openedTooLate && <span className="field-error">Daily data exists from {fmtDate(earliestData)}; the opening date must be on or before it.</span>}
        {openedFarFuture && <span className="field-error">An active property can’t open more than two years from now.</span>}
      </label>
      {offerExtend && (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={extendInventory} onChange={(e) => setExtendInventory(e.target.checked)} />
          Also start room inventory on {fmtDate(f.opened_on)} ({earliestRow!.room_count} rooms, as from {fmtDate(earliestRow!.effective_from)})
        </label>
      )}
      {!property && (
        <label className="field">
          Rooms at opening
          <input inputMode="numeric" value={f.rooms} onChange={(e) => setF({ ...f, rooms: e.target.value })} />
          {!roomsValid && <span className="field-error">Enter a whole number of rooms (1–99,999), or leave blank to set later.</span>}
        </label>
      )}
      <button className="btn btn-primary" disabled={busy || conflict || (!!property && !baseline) || !nameValid || (!property && !codeValid) || !roomsValid || openedTooLate || openedFarFuture} onClick={() => void save()}>{busy ? 'Saving…' : property ? 'Save changes' : 'Add property'}</button>
      {!property && <p className="small muted">New properties are visible to company-wide roles immediately. Grant owners and investors access under Users & access.</p>}
    </Modal>
  );
}

function InventoryModal({ property, history, onClose }: { property: Property; history: Inventory[]; onClose: () => void }) {
  const [f, setF] = useState({ from: localToday(), rooms: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useQuery({
    queryKey: ['latest-business-date', property.id],
    queryFn: async () => unwrap(await supabase.from('daily_performance').select('business_date').eq('property_id', property.id).order('business_date', { ascending: false }).limit(1)) as Array<{ business_date: string }>,
  });
  const latestDate = latest.data?.[0]?.business_date;
  const retroactive = !!latestDate && f.from <= latestDate;
  const roomsValid = /^[1-9]\d{0,4}$/.test(f.rooms.trim());
  const save = async () => {
    setErr(null);
    setBusy(true);
    const { error } = await supabase.rpc('set_room_inventory', { p_property_id: property.id, p_effective_from: f.from, p_room_count: Number(f.rooms.trim()), p_reason: f.reason.trim() });
    setBusy(false);
    if (error) setErr(dbErrorMessage(error));
    else onClose();
  };
  return (
    <Modal title={`Room inventory — ${property.name}`} onClose={onClose}>
      <table className="data">
        <thead><tr><th>From</th><th>To</th><th className="num">Rooms</th><th>Reason</th></tr></thead>
        <tbody>{history.map((h) => <tr key={h.effective_from}><td>{fmtDate(h.effective_from)}</td><td>{h.effective_to ? fmtExclusiveEnd(h.effective_to) : 'Current'}</td><td className="num">{h.room_count}</td><td>{h.reason}</td></tr>)}</tbody>
      </table>
      <h3>Change room count</h3>
      <p className="small muted">The current period ends the day before the new count takes effect. Days imported from now on use the count in effect on their business date (unless the PMS report supplies rooms available).</p>
      {retroactive && <Notice tone="warn">Days already imported keep the room count they were loaded with (data exists through {fmtDate(latestDate)}). Re-import those days to apply the new count.</Notice>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <label className="field">Effective from<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="field">Rooms<input inputMode="numeric" value={f.rooms} onChange={(e) => setF({ ...f, rooms: e.target.value })} /></label>
      </div>
      <label className="field">Reason<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. 12-room wing opened" /></label>
      {f.rooms.trim() && !roomsValid && <span className="field-error">Enter a whole number of rooms (1–99,999).</span>}
      <button className="btn btn-primary" disabled={busy || !roomsValid || !f.reason.trim() || !f.from} onClick={() => void save()}>{busy ? 'Saving…' : 'Save inventory change'}</button>
    </Modal>
  );
}
